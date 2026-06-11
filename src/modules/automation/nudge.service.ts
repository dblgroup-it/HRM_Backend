import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../realtime/notifications.service';
import { PermissionsService } from '../rbac/permissions.service';
import { AutomationPauseService } from './automation-pause.service';
import { AutomationLogService } from './automation-log.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface NudgeReport {
  staleApprovals: number;
  approversNudged: number;
  unmarkedInterviews: number;
  panelistsNudged: number;
}

/**
 * Daily reminders that attack the two real-world bottlenecks: requisitions
 * sitting on an approver's desk and interview panels that haven't submitted
 * their marks. In-app + (per user preference) email, once per day.
 */
@Injectable()
export class NudgeService {
  private readonly logger = new Logger(NudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService,
    private readonly pauses: AutomationPauseService,
    private readonly console: AutomationLogService,
  ) {}

  @Cron('30 9 * * *') // every morning, after people sit down
  async daily(): Promise<void> {
    if (await this.pauses.isPaused('nudges')) return;
    try {
      const report = await this.run();
      if (report.approversNudged || report.panelistsNudged) {
        this.logger.log(
          `Nudges sent — approvals: ${report.approversNudged} user(s) on ${report.staleApprovals} requisition(s); marks: ${report.panelistsNudged} panelist(s) on ${report.unmarkedInterviews} interview(s)`,
        );
      }
    } catch (err) {
      this.logger.warn(`Nudge run failed: ${(err as Error).message}`);
    }
  }

  async run(): Promise<NudgeReport> {
    this.console.log(
      'nudges',
      '▶ Checking for stale approvals & pending marks…',
    );
    const [staleApprovals, approversNudged] = await this.nudgeApprovers();
    const [unmarkedInterviews, panelistsNudged] = await this.nudgePanelists();
    this.console.log(
      'nudges',
      staleApprovals || unmarkedInterviews
        ? `✓ Reminded ${approversNudged} approver(s) on ${staleApprovals} requisition(s), ${panelistsNudged} panelist(s) on ${unmarkedInterviews} interview(s)`
        : '✓ Nothing overdue — no reminders needed',
    );
    return {
      staleApprovals,
      approversNudged,
      unmarkedInterviews,
      panelistsNudged,
    };
  }

  /** Requisitions pending with no movement for N days → remind the holder(s). */
  private async nudgeApprovers(): Promise<[number, number]> {
    const days = Number(this.config.get('nudge.approvalDays') ?? 3);
    const cutoff = new Date(Date.now() - days * DAY_MS);
    const rows = await this.prisma.requisition.findMany({
      where: { status: 'PENDING_APPROVAL', updatedAt: { lt: cutoff } },
      include: {
        approvalSteps: {
          where: { status: 'PENDING' },
          orderBy: { orderIndex: 'asc' },
          take: 1,
        },
      },
    });

    let nudged = 0;
    for (const req of rows) {
      const step = req.approvalSteps[0];
      if (!step) continue;
      const holderIds = await this.permissions.roleHolderUserIds(
        step.role.toLowerCase(),
        req.unitFactory,
      );
      if (!holderIds.length) continue;
      const waitingDays = Math.floor(
        (Date.now() - req.updatedAt.getTime()) / DAY_MS,
      );
      this.console.log(
        'nudges',
        `⚙ ${req.code} waiting ${waitingDays}d on ${step.title} → nudging ${holderIds.length} user(s)`,
      );
      await this.notifications.notifyMany(holderIds, {
        type: 'requisition',
        title: 'Approval waiting on you',
        message: `${req.code} (${req.designation} · ${req.unitFactory}) has been waiting ${waitingDays} day${waitingDays === 1 ? '' : 's'} for ${step.title}.`,
        link: `/requisitions/${req.id}`,
      });
      nudged += holderIds.length;
    }
    return [rows.length, nudged];
  }

  /** Interviews held ≥2 days ago where panelists still haven't marked. */
  private async nudgePanelists(): Promise<[number, number]> {
    const rows = await this.prisma.interviewRound.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: {
          lt: new Date(Date.now() - 2 * DAY_MS),
          gt: new Date(Date.now() - 14 * DAY_MS), // stop nagging after 2 weeks
        },
      },
      include: {
        panelists: true,
        evaluations: { select: { evaluatorId: true } },
        candidate: { select: { name: true } },
        requisition: { select: { designation: true } },
      },
    });

    let interviews = 0;
    let nudged = 0;
    for (const round of rows) {
      const marked = new Set(round.evaluations.map((e) => e.evaluatorId));
      const pending = round.panelists
        .map((p) => p.userId)
        .filter((id) => !marked.has(id));
      if (!pending.length) continue;
      interviews++;
      this.console.log(
        'nudges',
        `⚙ ${round.candidate.name} (${round.kind.toLowerCase()} interview) — ${pending.length} panelist(s) yet to mark`,
      );
      await this.notifications.notifyMany(pending, {
        type: 'interview_assigned',
        title: 'Interview marks pending',
        message: `Your marks for ${round.candidate.name} (${round.requisition.designation}, ${round.kind.toLowerCase()} interview) are still pending — please submit them.`,
        link: '/my-interviews',
      });
      nudged += pending.length;
    }
    return [interviews, nudged];
  }
}
