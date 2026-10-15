import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  generateActionToken,
  hashActionToken,
} from '../../common/crypto/action-token';
import { FileGrantService } from '../../common/files/file-grant.service';
import { sameUnit } from '../../common/util/normalize-unit';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { CRITERIA } from '../salary-fixation/salary-fixation.constants';
import {
  FACTORY_HR_HEAD_ROLE_KEY,
  headDecisionNoteError,
  headScope,
  type HeadDecision,
} from './first-interview-approval';
import {
  CANDIDATE_APPROVAL_LINK_DAYS,
  candidateApprovalEmail,
  panelSummary,
} from './candidate-approval-email';
import { profileCvLink, ttlUntil } from '../candidates/cv/profile-cv-link';

/** What a Candidate Approval row shows, wherever it is shown. */
const APPROVAL_INCLUDE = {
  submittedBy: { select: { name: true } },
  decidedBy: { select: { name: true } },
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
      cvProfile: true,
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
} satisfies Prisma.FirstInterviewApprovalInclude;

type ApprovalRow = Prisma.FirstInterviewApprovalGetPayload<{
  include: typeof APPROVAL_INCLUDE;
}>;

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
      include: APPROVAL_INCLUDE,
    });

    return rows
      .filter(
        (r) =>
          scope.all ||
          scope.unitNames.some((u) => sameUnit(u, r.requisition.unitFactory)),
      )
      .map((r) => this.toRow(r));
  }

  /**
   * One row as the Head sees it — on the page or behind the emailed link.
   * The CV links are minted only because the caller passed that check, and
   * last as long as that access does.
   */
  private toRow(r: ApprovalRow, cvTtlSeconds?: number) {
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
      cvUrl:
        this.files.url(r.candidate.cvFileId, 'cv', {
          filename: `${r.candidate.name} — CV`,
          ttlSeconds: cvTtlSeconds,
        }) ?? r.candidate.cvUrl,
      ...profileCvLink(this.files, r.candidate, { ttlSeconds: cvTtlSeconds }),
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
  }

  // --- by email (2026-10-15) ------------------------------------------------

  /**
   * Ask the Factory HR Head(s) to approve candidates Factory HR just sent.
   *
   * ONE email per Head per send — a single candidate, or all of a batch —
   * with a personal link to decide without signing in (see
   * candidate-approval-email.ts for why the decisions live on that page and
   * not in the mail). The in-app notice carries the same email, so the
   * Head's email preference and the master switch apply as for any notice.
   * Never throws: the candidates are already with the Head, and a mail
   * problem must not undo that.
   */
  async askForApproval(
    candidateIds: string[],
    submitter: { id: string; name: string },
    note?: string | null,
  ): Promise<void> {
    try {
      const rows = await this.prisma.firstInterviewApproval.findMany({
        where: {
          candidateId: { in: [...new Set(candidateIds)] },
          status: 'PENDING',
        },
        include: APPROVAL_INCLUDE,
        orderBy: { submittedAt: 'asc' },
      });
      if (!rows.length) return;

      // Which Heads cover which of these candidates.
      const byHead = new Map<string, ApprovalRow[]>();
      for (const unit of new Set(rows.map((r) => r.requisition.unitFactory))) {
        const heads = await this.permissions.roleHolderUserIds(
          FACTORY_HR_HEAD_ROLE_KEY,
          unit,
        );
        for (const head of heads) {
          if (head === submitter.id) continue;
          const mine = byHead.get(head) ?? [];
          mine.push(...rows.filter((r) => r.requisition.unitFactory === unit));
          byHead.set(head, mine);
        }
      }

      const expiresAt = new Date(
        Date.now() + CANDIDATE_APPROVAL_LINK_DAYS * 86_400_000,
      );
      for (const [headId, mine] of byHead) {
        const token = generateActionToken();
        await this.prisma.candidateApprovalLink.create({
          data: {
            userId: headId,
            // Only the hash is kept; the raw token lives in the email alone.
            tokenHash: hashActionToken(token),
            candidateIds: mine.map((r) => r.candidateId),
            submittedByName: submitter.name.slice(0, 150),
            tokenExpiresAt: expiresAt,
          },
        });
        const one = mine.length === 1;
        await this.notifications.notify(headId, {
          type: 'first_interview_approval',
          title: one
            ? 'Candidate awaiting your approval'
            : `${mine.length} candidates awaiting your approval`,
          message: one
            ? `${submitter.name} put ${mine[0].candidate.name} through the first interview for ${mine[0].requisition.designation}.`
            : `${submitter.name} put ${mine.length} candidates through the first interview: ${mine.map((r) => r.candidate.name).join(', ')}.`,
          link: '/first-interview-approvals',
          email: ({ name, origin }) =>
            candidateApprovalEmail({
              headName: name,
              submittedBy: submitter.name,
              note,
              link: `${origin}/candidate-approval/${token}`,
              rows: mine.map((r) => {
                const row = this.toRow(r);
                return {
                  name: row.candidateName,
                  post: row.requisition.designation,
                  code: row.requisition.code,
                  unit: row.requisition.unitFactory,
                  score:
                    row.interview.averageTotal === null
                      ? null
                      : `${row.interview.averageTotal} / ${row.interview.maxTotal}`,
                  panel: panelSummary(
                    row.interview.panel.map(
                      (p) =>
                        p.recommendation as
                          | 'select'
                          | 'reject'
                          | 'talent_pool'
                          | null,
                    ),
                  ),
                };
              }),
            }),
        });
      }
    } catch (err) {
      this.logger.warn(
        `Could not ask the Factory HR Head for approval: ${(err as Error).message}`,
      );
    }
  }

  /** What the emailed link shows: every candidate it covers, decided or not. */
  async linkInfo(token: string) {
    const link = await this.findLink(token);
    const expired = link.tokenExpiresAt.getTime() < Date.now();
    const rows = await this.prisma.firstInterviewApproval.findMany({
      where: { candidateId: { in: link.candidateIds } },
      include: APPROVAL_INCLUDE,
      orderBy: { submittedAt: 'asc' },
    });
    const ttl = ttlUntil(link.tokenExpiresAt);
    return {
      headName: link.user.name,
      submittedBy: link.submittedByName,
      sentAt: link.createdAt.toISOString(),
      expiresAt: link.tokenExpiresAt.toISOString(),
      expired,
      candidates: rows.map((r) => ({
        ...(expired
          ? { ...this.toRow(r), cvUrl: null, profileCvUrl: null }
          : this.toRow(r, ttl)),
        status: r.status.toLowerCase(),
        decidedBy: r.decidedBy?.name ?? null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
      })),
    };
  }

  /**
   * A decision from the emailed link — the same as from the page, made as
   * the Head the link was sent to, and only on the candidates it covers.
   */
  async decideByLink(
    token: string,
    dto: { candidateIds: string[]; decision: HeadDecision; note?: string },
  ) {
    const link = await this.findLink(token);
    if (link.tokenExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException(
        'This approval link has expired. Open Candidate Approvals in DBL HRM instead.',
      );
    }
    const covered = new Set(link.candidateIds);
    const ids = dto.candidateIds.filter((id) => covered.has(id));
    if (!ids.length) {
      throw new BadRequestException(
        'None of these candidates are on this link.',
      );
    }
    return this.decideMany(link.userId, { ...dto, candidateIds: ids });
  }

  private async findLink(token: string) {
    const link = await this.prisma.candidateApprovalLink.findUnique({
      where: { tokenHash: hashActionToken(token) },
      include: { user: { select: { name: true } } },
    });
    if (!link) {
      throw new NotFoundException('This approval link is not valid.');
    }
    return link;
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
        'Only a Factory HR Head can approve candidates',
      );
    }
    return scope;
  }
}
