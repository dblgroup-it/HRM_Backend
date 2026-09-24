import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { FileGrantService } from '../../common/files/file-grant.service';
import { sameUnit } from '../../common/util/normalize-unit';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { CRITERIA } from '../salary-fixation/salary-fixation.constants';
import {
  headDecisionNoteError,
  headScope,
  type HeadDecision,
} from './first-interview-approval';

/** Highest total a first-interview evaluation can reach. */
const MAX_TOTAL = CRITERIA.reduce((sum, c) => sum + c.max, 0);

/**
 * The Factory HR Head's queue — see first-interview-approval.ts.
 *
 * Kept apart from InterviewService, which is already the size of a module:
 * this is a different person's inbox, reading its own table.
 */
@Injectable()
export class FirstInterviewApprovalService {
  private readonly logger = new Logger(FirstInterviewApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly files: FileGrantService,
  ) {}

  /** Everything waiting on this Head, oldest first. */
  async queue(userId: string) {
    const scope = await this.requireHead(userId);
    const rows = await this.prisma.firstInterviewApproval.findMany({
      where: { status: 'PENDING', candidate: { deletedAt: null } },
      orderBy: { submittedAt: 'asc' },
      include: {
        submittedBy: { select: { name: true } },
        requisition: {
          select: {
            id: true,
            code: true,
            designation: true,
            department: true,
            unitFactory: true,
          },
        },
        candidate: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            cvFileId: true,
            cvUrl: true,
            matchScore: true,
            presentSalary: true,
            salaryExpectation: true,
            interviews: {
              where: {
                kind: 'FIRST',
                status: { notIn: ['CANCELLED', 'ABSENT'] },
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                scheduledAt: true,
                evaluations: {
                  select: {
                    total: true,
                    recommendation: true,
                    comments: true,
                    evaluator: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    return rows
      .filter(
        (r) =>
          scope.all ||
          scope.unitNames.some((u) => sameUnit(u, r.requisition.unitFactory)),
      )
      .map((r) => {
        const round = r.candidate.interviews[0];
        const evals = round?.evaluations ?? [];
        const avg = evals.length
          ? evals.reduce((s, e) => s + e.total, 0) / evals.length
          : null;
        return {
          candidateId: r.candidate.id,
          candidateName: r.candidate.name,
          email: r.candidate.email ?? '',
          phone: r.candidate.phone ?? '',
          // Minted only because the Head has passed the check above.
          cvUrl:
            this.files.url(r.candidate.cvFileId, 'cv', {
              filename: `${r.candidate.name} — CV`,
            }) ?? r.candidate.cvUrl,
          matchScore: r.candidate.matchScore,
          presentSalary: r.candidate.presentSalary,
          salaryExpectation: r.candidate.salaryExpectation,
          requisition: r.requisition,
          submittedBy: r.submittedBy?.name ?? null,
          submittedAt: r.submittedAt.toISOString(),
          note: r.submitNote,
          interview: {
            scheduledAt: round?.scheduledAt?.toISOString() ?? null,
            maxTotal: MAX_TOTAL,
            averageTotal: avg === null ? null : Math.round(avg * 10) / 10,
            panel: evals.map((e) => ({
              name: e.evaluator.name,
              total: e.total,
              recommendation: e.recommendation?.toLowerCase() ?? null,
              comments: e.comments ?? '',
            })),
          },
        };
      });
  }

  /**
   * One verdict across a selection. Always 200 with a per-candidate result:
   * another Head may have decided a row a moment earlier, and that must not
   * fail the rest.
   */
  async decideMany(
    userId: string,
    dto: { candidateIds: string[]; decision: HeadDecision; note?: string },
  ) {
    const scope = await this.requireHead(userId);
    const problem = headDecisionNoteError(dto.decision, dto.note);
    if (problem) throw new BadRequestException(problem);
    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });
    if (!actor) throw new ForbiddenException();

    const results: { candidateId: string; ok: boolean; error?: string }[] = [];
    for (const id of [...new Set(dto.candidateIds)]) {
      const error = await this.decideOne(id, actor, scope, dto).catch(
        (e: Error) => e.message || 'Could not record the decision',
      );
      results.push({
        candidateId: id,
        ok: !error,
        ...(error ? { error } : {}),
      });
    }
    return {
      decided: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /** Null on success, otherwise why this one did not go through. */
  private async decideOne(
    candidateId: string,
    actor: { id: string; name: string },
    scope: { all: boolean; unitNames: string[] },
    dto: { decision: HeadDecision; note?: string },
  ): Promise<string | null> {
    const row = await this.prisma.firstInterviewApproval.findUnique({
      where: { candidateId },
      include: {
        decidedBy: { select: { name: true } },
        candidate: {
          select: { id: true, name: true, stage: true, notes: true },
        },
        requisition: {
          select: {
            id: true,
            designation: true,
            unitFactory: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
      },
    });
    if (!row) return 'Nothing is waiting for approval on this candidate';
    const name = row.candidate.name;
    if (
      !scope.all &&
      !scope.unitNames.some((u) => sameUnit(u, row.requisition.unitFactory))
    ) {
      return `${name} is not in a unit you are Factory HR Head for`;
    }
    if (row.status !== 'PENDING') {
      return `${name} was already ${row.status.toLowerCase()}${
        row.decidedBy ? ` by ${row.decidedBy.name}` : ''
      }`;
    }
    if (row.candidate.stage !== 'INTERVIEW') {
      return `${name} is no longer at the interview stage`;
    }

    const note = dto.note?.trim() || null;
    const now = new Date();
    const decided = {
      decidedById: actor.id,
      decidedAt: now,
      decisionNote: note,
    };
    const finishDelegations = this.prisma.interviewDelegation.updateMany({
      where: { candidateId, revokedAt: null, completedAt: null },
      data: { completedAt: now },
    });
    const withNote = (label: string) =>
      note
        ? `${row.candidate.notes ? row.candidate.notes + '\n' : ''}${label} (${actor.name}): ${note}`
        : row.candidate.notes;

    if (dto.decision === 'approve') {
      await this.prisma.$transaction([
        this.prisma.firstInterviewApproval.update({
          where: { candidateId },
          data: { status: 'APPROVED', ...decided },
        }),
        this.prisma.candidate.update({
          where: { id: candidateId },
          data: {
            stage: 'FINAL',
            notes: withNote('Factory HR Head approved'),
            rejectedAt: null,
            rejectedById: null,
            rejectionStage: null,
            rejectionReason: null,
          },
        }),
        finishDelegations,
      ]);
    } else if (dto.decision === 'reject') {
      await this.prisma.$transaction([
        this.prisma.firstInterviewApproval.update({
          where: { candidateId },
          data: { status: 'REJECTED', ...decided },
        }),
        this.prisma.candidate.update({
          where: { id: candidateId },
          data: {
            stage: 'REJECTED',
            notes: withNote('Rejected by Factory HR Head'),
            rejectedAt: now,
            rejectedById: actor.id,
            rejectionStage: 'factory_hr_head',
            rejectionReason: note,
          },
        }),
        finishDelegations,
      ]);
    } else {
      // Returned: back with Factory HR, candidate still at Interview. They
      // may put them through again (which resubmits) or turn them down.
      await this.prisma.firstInterviewApproval.update({
        where: { candidateId },
        data: { status: 'RETURNED', ...decided },
      });
    }

    await this.notifyOutcome(row, actor, dto.decision, note);
    this.notifications.broadcastChange('candidate', row.requisition.id, {
      action: 'first_interview_head_decision',
    });
    return null;
  }

  private async notifyOutcome(
    row: {
      submittedById: string | null;
      candidate: { name: string };
      requisition: {
        id: string;
        designation: string;
        unitFactory: string;
        recruiterId: string | null;
        coverRecruiterId: string | null;
        coverUntil: Date | null;
      };
    },
    actor: { id: string; name: string },
    decision: HeadDecision,
    note: string | null,
  ) {
    const link = `/requisitions/${row.requisition.id}`;
    const verb =
      decision === 'approve'
        ? 'approved'
        : decision === 'reject'
          ? 'rejected'
          : 'returned';
    const tail = note ? ` — ${note}` : '';
    const send = async (userId: string, title: string, message: string) => {
      if (userId === actor.id) return;
      try {
        await this.notifications.notify(userId, {
          type: 'first_interview_head_decision',
          title,
          message,
          link: decision === 'return' ? '/assigned-candidates' : link,
        });
      } catch {
        this.logger.warn('Could not send a Factory HR Head decision notice');
      }
    };

    if (row.submittedById) {
      await send(
        row.submittedById,
        `Factory HR Head ${verb} ${row.candidate.name}`,
        `${actor.name} ${verb} ${row.candidate.name} for ${row.requisition.designation}${tail}`,
      );
    }
    // The recruiter only hears about it once it is theirs to act on, or gone.
    if (decision === 'return') return;
    const recipients = await this.permissions.recruitmentRecipients(
      row.requisition.unitFactory,
      row.requisition.recruiterId,
      {
        userId: row.requisition.coverRecruiterId,
        until: row.requisition.coverUntil,
      },
    );
    for (const id of recipients) {
      if (id === row.submittedById) continue;
      await send(
        id,
        decision === 'approve'
          ? `${row.candidate.name} is ready for the second interview`
          : `Factory HR Head rejected ${row.candidate.name}`,
        decision === 'approve'
          ? `${actor.name} approved ${row.candidate.name} after the first interview for ${row.requisition.designation}. Schedule the second interview.`
          : `${actor.name} rejected ${row.candidate.name} after the first interview for ${row.requisition.designation}${tail}`,
      );
    }
  }

  private async requireHead(userId: string) {
    const scope = headScope(await this.permissions.getUserPermissions(userId));
    if (!scope.all && !scope.unitNames.length) {
      throw new ForbiddenException(
        'Only a Factory HR Head can approve first-interview finalists',
      );
    }
    return scope;
  }
}
