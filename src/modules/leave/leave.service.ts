import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { StartLeaveDto } from './dto/leave.dto';
import { leaveDaysLeft, resolveLeaveEnd } from './leave-dates';

/** Requisition states where a Corporate Recruiter is actually running one. */
const RECRUITING_STATUSES = [
  'APPROVED',
  'PROFILE_GENERATED',
  'POSTED',
] as const;

const leaveSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  endedAt: true,
  note: true,
  createdAt: true,
} satisfies Prisma.LeavePeriodSelect;

type LeaveRow = Prisma.LeavePeriodGetPayload<{ select: typeof leaveSelect }>;

/**
 * Being away, and who picks up the work.
 *
 * Leave is kept as a dated period rather than a flag on the user: it says until
 * when, it keeps the history, and it stops applying by itself, so nothing has
 * to run at midnight to put anybody back on duty.
 *
 * Marking leave is not just a status. It moves work:
 *  - every job analysis addressed to this person goes to the next Factory HR in
 *    that unit's HR layering — there is nothing to choose, so it is automatic;
 *  - the requisitions they are recruiting go to the stand-in they nominate,
 *    per requisition, because each is at a different point and there is no
 *    sensible default.
 */
@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
  ) {}

  // --- read ---------------------------------------------------------------

  /** The user's own availability, as the header button shows it. */
  async status(userId: string) {
    const active = await this.activePeriod(userId);
    return {
      onLeave: Boolean(active),
      leave: active ? serializeLeave(active) : null,
    };
  }

  /**
   * What would move if this person went on leave right now.
   *
   * Read before the leave is set, so the panel can show the job analyses that
   * will reroute themselves and ask who covers each requisition being
   * recruited. Asked of the server so the page never has to work out a
   * layering for itself.
   */
  async handover(userId: string) {
    const [jobAnalyses, recruiting] = await Promise.all([
      this.prisma.requisition.findMany({
        where: {
          deletedAt: null,
          status: 'PENDING_JOB_ANALYSIS',
          jobAnalysisAssigneeId: userId,
        },
        select: {
          id: true,
          code: true,
          designation: true,
          unitFactory: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.requisition.findMany({
        where: {
          deletedAt: null,
          status: { in: [...RECRUITING_STATUSES] },
          recruiterId: userId,
        },
        select: {
          id: true,
          code: true,
          designation: true,
          unitFactory: true,
          status: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Who each one would go to. Computed per unit, not per requisition — a
    // recruiter on leave usually has several in the same place.
    const units = [...new Set(jobAnalyses.map((r) => r.unitFactory))];
    const nextByUnit = new Map<string, { id: string; name: string } | null>();
    for (const unit of units) {
      const queue = await this.permissions.factoryHrQueue(unit);
      const next = queue.find((h) => !h.onLeave && h.id !== userId) ?? null;
      nextByUnit.set(unit, next ? { id: next.id, name: next.name } : null);
    }

    const coverUnits = [...new Set(recruiting.map((r) => r.unitFactory))];
    const coversByUnit = new Map<
      string,
      { id: string; name: string; employeeCode: string; onLeave: boolean }[]
    >();
    const onLeave = await this.permissions.onLeaveUserIds();
    for (const unit of coverUnits) {
      const holders = await this.permissions.roleHolders(
        'corporate_recruiter',
        unit,
      );
      coversByUnit.set(
        unit,
        holders
          .filter((h) => h.id !== userId)
          .map((h) => ({ ...h, onLeave: onLeave.has(h.id) })),
      );
    }

    return {
      jobAnalyses: jobAnalyses.map((r) => ({
        ...r,
        // Null means nobody is left in that unit's queue, so it falls to Head
        // of Talent Acquisition and the Corporate Recruiters.
        nextAssignee: nextByUnit.get(r.unitFactory) ?? null,
      })),
      recruiting: recruiting.map((r) => ({
        ...r,
        status: r.status.toLowerCase(),
        candidates: coversByUnit.get(r.unitFactory) ?? [],
      })),
    };
  }

  // --- write --------------------------------------------------------------

  async start(
    dto: StartLeaveDto,
    actor: { id: string; name: string },
  ): Promise<ReturnType<LeaveService['status']>> {
    const existing = await this.activePeriod(actor.id);
    if (existing) {
      throw new BadRequestException(
        'You are already marked on leave — end that first if you need to change it',
      );
    }

    const endsAt = resolveLeaveEnd(dto);
    const leave = await this.prisma.leavePeriod.create({
      data: {
        userId: actor.id,
        startsAt: new Date(),
        endsAt,
        note: dto.note?.trim() || null,
        setById: actor.id,
      },
      select: leaveSelect,
    });

    // Before anything is rerouted: routing asks who is away, and this person
    // now is. Without this the next Factory HR would be worked out from a
    // cached answer that still has them on duty.
    this.permissions.invalidateLeave();

    await this.rerouteJobAnalyses(actor, leave);
    await this.applyCovers(dto, actor, leave);

    return { onLeave: true, leave: serializeLeave(leave) };
  }

  /**
   * Back early (or back at all, for an open-ended absence).
   *
   * Recruitment covers lapse with the leave, because that is what they were
   * for. Job analyses that moved on do NOT come back: the next Factory HR may
   * already be halfway through writing one, and taking it off them would be
   * worse than leaving it where it is.
   */
  async end(actor: { id: string; name: string }) {
    const active = await this.activePeriod(actor.id);
    if (!active) throw new BadRequestException('You are not marked on leave');

    const covered = await this.prisma.requisition.findMany({
      where: { coverLeaveId: active.id, coverRecruiterId: { not: null } },
      select: {
        id: true,
        code: true,
        designation: true,
        coverRecruiterId: true,
      },
    });

    await this.prisma.$transaction([
      this.prisma.leavePeriod.update({
        where: { id: active.id },
        data: { endedAt: new Date() },
      }),
      this.prisma.requisition.updateMany({
        where: { coverLeaveId: active.id },
        data: { coverRecruiterId: null, coverLeaveId: null, coverUntil: null },
      }),
    ]);
    this.permissions.invalidateLeave();

    for (const req of covered) {
      if (!req.coverRecruiterId) continue;
      await this.notifications.notifyMany([req.coverRecruiterId], {
        type: 'requisition_info',
        title: 'Cover ended',
        message: `${actor.name} is back — ${req.code} · ${req.designation} is theirs again.`,
        link: `/requisitions/${req.id}`,
      });
      this.notifications.broadcastChange('requisition', req.id, {
        action: 'cover_ended',
      });
    }

    return { onLeave: false, leave: null };
  }

  // --- internals ----------------------------------------------------------

  private activePeriod(userId: string): Promise<LeaveRow | null> {
    const now = new Date();
    return this.prisma.leavePeriod.findFirst({
      where: {
        userId,
        endedAt: null,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      orderBy: { startsAt: 'desc' },
      select: leaveSelect,
    });
  }

  /** Hand every job analysis on to the next Factory HR in the unit's order. */
  private async rerouteJobAnalyses(
    actor: { id: string; name: string },
    leave: LeaveRow,
  ): Promise<void> {
    const pending = await this.prisma.requisition.findMany({
      where: {
        deletedAt: null,
        status: 'PENDING_JOB_ANALYSIS',
        jobAnalysisAssigneeId: actor.id,
      },
      select: { id: true, code: true, designation: true, unitFactory: true },
    });

    for (const req of pending) {
      const owners = await this.permissions.jobAnalysisOwners(req.unitFactory);
      const to = owners.assigneeId
        ? await this.prisma.user.findUnique({
            where: { id: owners.assigneeId },
            select: { name: true },
          })
        : null;
      const destination = to
        ? to.name
        : owners.viaFactoryHr
          ? `Factory HR for ${req.unitFactory}`
          : 'Head of Talent Acquisition / the Corporate Recruiters';

      await this.prisma.requisition.update({
        where: { id: req.id },
        data: {
          jobAnalysisAssigneeId: owners.assigneeId,
          activities: {
            create: {
              actor: actor.name,
              action: 'EDITED',
              note: `Job analysis moved to ${destination} — ${actor.name} is on leave${
                leave.endsAt ? ` until ${formatDay(leave.endsAt)}` : ''
              }.`,
            },
          },
        },
      });

      if (owners.userIds.length) {
        await this.notifications.notifyMany(owners.userIds, {
          type: 'requisition_pending',
          title: 'Job analysis passed to you',
          message: `${req.code} · ${req.designation} (${req.unitFactory}) — ${actor.name} is on leave.`,
          link: `/requisitions/${req.id}`,
        });
      } else {
        this.logger.warn(
          `${req.code}: ${actor.name} went on leave and nobody is left to write the job analysis for ${req.unitFactory}`,
        );
      }
      this.notifications.broadcastChange('requisition', req.id, {
        action: 'job_analysis_reassigned',
      });
    }
  }

  /** Hand each nominated requisition to its stand-in for the leave. */
  private async applyCovers(
    dto: StartLeaveDto,
    actor: { id: string; name: string },
    leave: LeaveRow,
  ): Promise<void> {
    const covers = dto.covers ?? [];
    if (!covers.length) return;
    const onLeave = await this.permissions.onLeaveUserIds();

    for (const choice of covers) {
      const req = await this.prisma.requisition.findFirst({
        where: { id: choice.requisitionId, deletedAt: null },
        select: {
          id: true,
          code: true,
          designation: true,
          unitFactory: true,
          recruiterId: true,
        },
      });
      if (!req) {
        throw new NotFoundException(
          `Requisition ${choice.requisitionId} not found`,
        );
      }
      if (req.recruiterId !== actor.id) {
        throw new BadRequestException(
          `You are not the recruiter on ${req.code}, so you cannot hand it over`,
        );
      }
      if (choice.coverRecruiterId === actor.id) {
        throw new BadRequestException(
          `Pick someone else to cover ${req.code} — you are the one going on leave`,
        );
      }
      const holders = await this.permissions.roleHolderUserIds(
        'corporate_recruiter',
        req.unitFactory,
      );
      if (!holders.includes(choice.coverRecruiterId)) {
        throw new BadRequestException(
          `Whoever covers ${req.code} has to be a Corporate Recruiter for ${req.unitFactory}`,
        );
      }
      if (onLeave.has(choice.coverRecruiterId)) {
        throw new BadRequestException(
          `The person you picked for ${req.code} is on leave themselves — pick someone who is available`,
        );
      }

      const cover = await this.prisma.user.findUnique({
        where: { id: choice.coverRecruiterId },
        select: { name: true },
      });
      await this.prisma.requisition.update({
        where: { id: req.id },
        data: {
          coverRecruiterId: choice.coverRecruiterId,
          coverLeaveId: leave.id,
          coverUntil: leave.endsAt,
          activities: {
            create: {
              actor: actor.name,
              action: 'EDITED',
              note: `${cover?.name ?? 'A Corporate Recruiter'} is covering recruitment while ${actor.name} is on leave${
                leave.endsAt ? ` until ${formatDay(leave.endsAt)}` : ''
              }.`,
            },
          },
        },
      });

      await this.notifications.notifyMany([choice.coverRecruiterId], {
        type: 'requisition_pending',
        title: 'Covering a requisition',
        message: `${req.code} · ${req.designation} — ${actor.name} is on leave${
          leave.endsAt ? ` until ${formatDay(leave.endsAt)}` : ''
        } and asked you to carry on.`,
        link: `/requisitions/${req.id}`,
      });
      this.notifications.broadcastChange('requisition', req.id, {
        action: 'cover_assigned',
      });
    }
  }
}

function serializeLeave(leave: LeaveRow) {
  return {
    id: leave.id,
    startsAt: leave.startsAt.toISOString(),
    endsAt: leave.endsAt?.toISOString() ?? null,
    note: leave.note ?? null,
    daysLeft: leaveDaysLeft(leave.endsAt),
  };
}

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
