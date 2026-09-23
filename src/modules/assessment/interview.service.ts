import { randomBytes } from 'node:crypto';
import { tokenLookupWhere } from '../../common/crypto/action-token';
import {
  daysSince,
  delegationProgress,
  NOT_LIVE,
  type DelegationStage,
} from './delegation-progress';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EvaluationRecommendation,
  InterviewKind,
  InterviewMode,
  InterviewStatus,
  Prisma,
} from '@prisma/client';

import type { Response } from 'express';

import { FileGrantService } from '../../common/files/file-grant.service';
import { SecureFileService } from '../../common/files/secure-file.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CandidatesService } from '../candidates/candidates.service';
import { buildCandidateBrief } from './candidate-brief';
import { rejectBlocker } from './reject-guard';
import {
  PermissionsService,
  type RecruitmentSubject,
} from '../rbac/permissions.service';
import { sameUnit } from '../../common/util/normalize-unit';
import { NotificationsService } from '../realtime/notifications.service';
import { MailService } from '../integrations/mail/mail.service';
import { SettingsService } from '../settings/settings.service';
import {
  CRITERIA as EVALUATION_CRITERIA,
  scoreCriteria,
} from '../salary-fixation/salary-fixation.constants';
import {
  CalendarService,
  type CalendarEventInput,
} from '../integrations/google/calendar.service';
import { listTests, unmarkedTests } from './tests-gate';
import { benefitsConflict, normaliseBenefits } from './candidate-benefits';
import {
  formatSlotShort,
  panelNotice,
  type PanelEmailInput,
} from './interview-panel-email';
import {
  BulkScheduleInterviewDto,
  DelegationTestsDto,
  ScheduleInterviewDto,
  SubmitEvaluationDto,
  UpdateInterviewDto,
  AddPanelistsDto,
  CandidatePackageDto,
  RejectAtInterviewDto,
} from './dto/interview.dto';
import type { EvaluationRecommendationKey } from './recommendation';

/**
 * The interviewer's suggestion, across the wire in the frontend's lowercase
 * vocabulary and in the database as an uppercase Prisma enum — the same
 * convention the requisition serializer uses for status.
 */
function toRecommendation(
  key: EvaluationRecommendationKey | undefined,
): EvaluationRecommendation | null {
  if (!key) return null;
  return key.toUpperCase() as EvaluationRecommendation;
}

function fromRecommendation(
  value: EvaluationRecommendation | null,
): EvaluationRecommendationKey | null {
  return value ? (value.toLowerCase() as EvaluationRecommendationKey) : null;
}

const roundInclude = {
  panelists: { include: { user: { include: { employee: true } } } },
  evaluations: { include: { evaluator: { select: { name: true } } } },
  candidate: { select: { id: true, name: true, email: true } },
  evaluationTokens: {
    select: { panelistUserId: true, token: true, status: true },
  },
} satisfies Prisma.InterviewRoundInclude;

type RoundFull = Prisma.InterviewRoundGetPayload<{
  include: typeof roundInclude;
}>;

/** The requisition fields a panel notice prints. */
const PANEL_REQ_SELECT = {
  code: true,
  designation: true,
  department: true,
  unitFactory: true,
} satisfies Prisma.RequisitionSelect;

/**
 * A panelist's own marking sheet. Falls back to the in-app list only if no
 * token was minted, which would itself be a bug — but a link to something is
 * better than a notification with nowhere to go.
 */
const evaluatePath = (token: string | null | undefined) =>
  token ? `/evaluate/${token}` : '/my-interviews';

/**
 * How long an emailed evaluation link stays usable.
 *
 * Measured from the interview itself where one is scheduled, so the clock
 * starts when the panelist actually has something to write up, and from now
 * when it is not.
 *
 * It was 48 hours, which assumed panelists write up the same day or the next.
 * Senior interviewers write up when they get to it — a Sunday interview
 * reviewed on Wednesday found a dead link, which reads as a broken system
 * rather than an expired one. Seven days covers a normal working week off.
 *
 * Used in both places an expiry is set: minting the token, and re-dating
 * pending tokens when a round is rescheduled. Keeping it in one constant is
 * the point — when these were two literals, changing one silently left the
 * other, so rescheduling an interview quietly reverted the link to 48 hours.
 */
const EVAL_TOKEN_VALID_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly calendar: CalendarService,
    private readonly settings: SettingsService,
    private readonly files: FileGrantService,
    private readonly secureFiles: SecureFileService,
    private readonly candidates: CandidatesService,
  ) {}

  async listForRequisition(reqId: string, userId: string) {
    await this.requireReq(reqId, userId);
    const rounds = await this.prisma.interviewRound.findMany({
      where: { requisitionId: reqId },
      include: roundInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rounds.map(serializeRound);
  }

  async listForCandidate(candidateId: string, userId: string) {
    const cand = await this.loadCandidate(candidateId, userId);
    const rounds = await this.prisma.interviewRound.findMany({
      where: { candidateId: cand.id },
      include: roundInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rounds.map(serializeRound);
  }

  async schedule(
    candidateId: string,
    actor: { id: string; name: string },
    dto: ScheduleInterviewDto,
  ) {
    const cand = await this.loadCandidate(candidateId, actor.id);

    // A delegate is handed the first session only. Second and final rounds go
    // back to Head of Talent Acquisition / the recruiter, so they cannot schedule those.
    if (dto.kind.toUpperCase() !== 'FIRST') {
      const viaDelegation = await this.hasDelegation(cand.id, actor.id);
      if (viaDelegation) {
        const owns = await this.permissions
          .canRunRecruitment(
            actor.id,
            cand.requisition.unitFactory,
            cand.requisition.recruiterId,
            {
              userId: cand.requisition.coverRecruiterId,
              until: cand.requisition.coverUntil,
            },
          )
          .catch(() => false);
        if (!owns) {
          throw new ForbiddenException(
            'You were assigned the first interview for this candidate. Later rounds are arranged by Head of Talent Acquisition.',
          );
        }
      }
    }

    // Two people handed the same candidate would otherwise each arrange their
    // own session, and neither would know — the candidate ends up with two
    // conflicting invitations for the same round. A no-show does not count:
    // the absent round stays on record and a fresh one is booked beside it.
    const existingSameKind = await this.prisma.interviewRound.findFirst({
      where: {
        candidateId: cand.id,
        kind: dto.kind.toUpperCase() as InterviewKind,
        status: { notIn: [...NOT_LIVE] },
      },
      include: { createdBy: { select: { name: true } } },
    });
    if (existingSameKind) {
      const who = existingSameKind.createdBy?.name;
      const when = existingSameKind.scheduledAt
        ? ` for ${existingSameKind.scheduledAt.toISOString().slice(0, 10)}`
        : '';
      throw new BadRequestException(
        `A ${dto.kind.toLowerCase()} interview for ${cand.name} is already arranged${when}${
          who ? ` by ${who}` : ''
        }. Open that session to change it, or remove it first.`,
      );
    }

    let round = await this.prisma.interviewRound.create({
      data: {
        candidateId: cand.id,
        requisitionId: cand.requisitionId,
        kind: dto.kind.toUpperCase() as InterviewKind,
        mode: dto.mode.toUpperCase() as InterviewMode,
        scheduledAt: toDate(dto.scheduledAt),
        location: dto.location?.trim() || null,
        createdById: actor.id,
        panelists: {
          create: [...new Set(dto.panelistUserIds)].map((uid) => ({
            userId: uid,
          })),
        },
      },
      include: roundInclude,
    });

    // Advance the candidate to the Interview stage if they haven't passed it yet.
    const PRE_INTERVIEW: string[] = [
      'APPLIED',
      'AI_SHORTLISTED',
      'SHORTLISTED',
    ];
    if (PRE_INTERVIEW.includes(cand.stage)) {
      await this.prisma.candidate.update({
        where: { id: cand.id },
        data: { stage: 'INTERVIEW' },
      });
    }

    // Generate secure one-click evaluation links for each panelist.
    await this.generateEvalTokens(
      round.id,
      [...new Set(dto.panelistUserIds)],
      toDate(dto.scheduledAt),
    );

    // Best-effort Google Calendar event (+ Meet link for online interviews).
    const synced = await this.syncCalendarCreate(
      round,
      cand.requisition.designation,
      dto.notifyCandidate === true,
    );
    if (synced) round = synced;

    await this.notifyScheduled(round, cand.requisition, dto);
    // Read the CV into structured facts now, in the background, so the
    // panel's evaluation form already carries the candidate summary when
    // they open it. Best-effort by design — a CV that cannot be read must
    // never stop an interview being arranged.
    this.candidates.scheduleCvProfile(cand.id);
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'interview_scheduled',
    });

    // Re-fetch with tokens so the response includes evalLink per panelist.
    const fresh = await this.prisma.interviewRound.findUnique({
      where: { id: round.id },
      include: roundInclude,
    });
    return serializeRound(fresh ?? round);
  }

  /**
   * Schedule the same session for several candidates.
   *
   * The panel is told ONCE, about all of them. Previously each round notified
   * independently, so a panelist scheduled against eight candidates received
   * eight separate emails within a second of each other — each one a link and
   * a name, none of them a usable list of the day's interviews. They now get
   * a single message naming every candidate, in slot order, each with their
   * own evaluation link.
   *
   * Sequential rather than parallel: `schedule()` refuses a second round of
   * the same kind for one candidate, and two overlapping calls could both
   * pass that check before either wrote. It also keeps the candidates in the
   * order the recruiter chose, which is the order of the time slots.
   */
  async bulkSchedule(
    actor: { id: string; name: string },
    dto: BulkScheduleInterviewDto,
  ) {
    const results: Awaited<ReturnType<typeof this.schedule>>[] = [];
    for (const [i, candidateId] of dto.candidateIds.entries()) {
      results.push(
        await this.schedule(candidateId, actor, {
          kind: dto.kind,
          mode: dto.mode,
          scheduledAt: dto.scheduledAts?.[i],
          location: dto.location,
          panelistUserIds: dto.panelistUserIds,
          notifyCandidate: dto.notifyCandidate,
          // Held back and sent once below, covering the whole batch.
          notifyPanel: false,
        }),
      );
    }
    if (dto.notifyPanel !== false && results.length) {
      await this.notifyPanelOfBatch(
        [...new Set(dto.panelistUserIds)],
        results.map((r) => r.id),
        dto.kind,
      );
    }
    return results;
  }

  /**
   * One message per panelist covering every candidate in a bulk schedule.
   *
   * Each candidate's link is that panelist's own evaluation token — the links
   * differ per person, so this cannot be a single shared message to everyone.
   * What it collapses is the per-candidate fan-out, not the per-person one.
   */
  private async notifyPanelOfBatch(
    panelistUserIds: string[],
    roundIds: string[],
    kind: string,
  ) {
    const rounds = await this.prisma.interviewRound.findMany({
      where: { id: { in: roundIds } },
      include: {
        candidate: { select: { name: true } },
        requisition: { select: PANEL_REQ_SELECT },
        evaluationTokens: { select: { panelistUserId: true, token: true } },
      },
    });
    // Back into the order the recruiter scheduled them, which is slot order —
    // findMany does not promise to preserve the `in` list's order.
    const byId = new Map(rounds.map((r) => [r.id, r]));
    const ordered = roundIds
      .map((id) => byId.get(id))
      .filter((r): r is (typeof rounds)[number] => Boolean(r));
    if (!ordered.length) return;

    const req = ordered[0].requisition;
    const kindLabel = kind.toLowerCase();
    // The bell shows names and times; the per-candidate links live in the
    // email and on My Interviews, where they are clickable.
    const names = ordered
      .map((r) => `${r.candidate.name} (${formatSlotShort(r.scheduledAt)})`)
      .join(', ');

    for (const userId of panelistUserIds) {
      await this.notifications.notify(userId, {
        type: 'interview_assigned',
        title: `${ordered.length} interviews to conduct`,
        message: `${req.designation} — ${kindLabel} interviews: ${names}.`,
        link: '/my-interviews',
        email: panelNotice(
          kind,
          req,
          ordered.map((r) => ({
            round: r,
            path: evaluatePath(
              r.evaluationTokens.find((t) => t.panelistUserId === userId)
                ?.token,
            ),
          })),
        ),
      });
    }
  }

  /**
   * Add people to a panel that is already arranged.
   *
   * Separate from `update()`, which REPLACES the panel wholesale — passing a
   * grown list through that path deletes and recreates every panelist row,
   * and re-notifies people who were already invited and may already have
   * marked. This only ever appends, mints tokens for the newcomers, and tells
   * them alone. Allowed while a session is still running, which is the point:
   * a third interviewer walking into the room is normal. Once the round is
   * over it is not — the panel is the record of who was in that room, and
   * adding someone to it afterwards mints an evaluation link for an interview
   * they never attended.
   */
  async addPanelists(roundId: string, userIds: string[], actorId: string) {
    const round = await this.prisma.interviewRound.findUnique({
      where: { id: roundId },
      include: {
        requisition: {
          select: {
            ...PANEL_REQ_SELECT,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
        candidate: { select: { name: true } },
        panelists: { select: { userId: true } },
      },
    });
    if (!round) throw new NotFoundException('Interview not found');
    await this.requireInterviewAccess(
      round.candidateId,
      round.requisition,
      actorId,
    );
    if (round.status !== 'SCHEDULED') {
      throw new BadRequestException(
        round.status === 'CANCELLED'
          ? 'This interview was cancelled — reschedule it before adding anyone.'
          : round.status === 'ABSENT'
            ? 'The candidate did not attend this interview, so there is nobody to mark.'
            : 'This interview is already marked done — schedule another round rather than adding an interviewer to a finished one.',
      );
    }

    const already = new Set(round.panelists.map((p) => p.userId));
    const fresh = [...new Set(userIds)].filter((id) => !already.has(id));
    if (!fresh.length) {
      throw new BadRequestException(
        'Everyone you picked is already on this panel.',
      );
    }

    await this.prisma.interviewPanelist.createMany({
      data: fresh.map((userId) => ({ roundId, userId })),
      skipDuplicates: true,
    });
    await this.generateEvalTokens(roundId, fresh, round.scheduledAt);

    const tokens = await this.prisma.evaluationToken.findMany({
      where: { roundId, panelistUserId: { in: fresh } },
      select: { panelistUserId: true, token: true },
    });
    const tokenFor = new Map(tokens.map((t) => [t.panelistUserId, t.token]));
    const when = formatSlotShort(round.scheduledAt);

    // Only the new people. The ones already on the panel have their link.
    for (const userId of fresh) {
      const path = evaluatePath(tokenFor.get(userId));
      await this.notifications.notify(userId, {
        type: 'interview_assigned',
        title: 'Added to an interview panel',
        message: `${round.candidate.name} · ${round.requisition.designation} — ${round.kind.toLowerCase()} interview on ${when}.`,
        link: path,
        email: panelNotice(round.kind, round.requisition, [{ round, path }]),
      });
    }

    this.notifications.broadcastChange('candidate', round.requisitionId, {
      action: 'interview_updated',
    });
    const updated = await this.prisma.interviewRound.findUnique({
      where: { id: roundId },
      include: roundInclude,
    });
    return updated ? serializeRound(updated) : { id: roundId };
  }

  async update(roundId: string, userId: string, dto: UpdateInterviewDto) {
    const round = await this.prisma.interviewRound.findUnique({
      where: { id: roundId },
      include: {
        requisition: {
          select: {
            unitFactory: true,
            designation: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
        panelists: { select: { userId: true } },
      },
    });
    if (!round) throw new NotFoundException('Interview not found');
    await this.requireInterviewAccess(
      round.candidateId,
      round.requisition,
      userId,
    );

    // A mark from any interviewer means the candidate was in the room. The
    // button is hidden once marks exist; this is the same rule for a stale
    // tab or a direct call.
    if (dto.status === 'absent') {
      const marked = await this.prisma.evaluation.count({ where: { roundId } });
      if (marked > 0) {
        throw new BadRequestException(
          `${marked} interviewer${marked === 1 ? ' has' : 's have'} already marked this candidate, so they attended — they cannot be recorded absent.`,
        );
      }
    }

    // Undoing an absence (or a cancellation) once a replacement session has
    // been booked would leave two live rounds of the same kind — the thing
    // schedule() refuses.
    const reviving =
      NOT_LIVE.includes(round.status) &&
      dto.status !== undefined &&
      !NOT_LIVE.includes(dto.status.toUpperCase() as InterviewStatus);
    if (reviving) {
      const replacement = await this.prisma.interviewRound.findFirst({
        where: {
          candidateId: round.candidateId,
          kind: round.kind,
          id: { not: roundId },
          status: { notIn: [...NOT_LIVE] },
        },
        select: { id: true },
      });
      if (replacement) {
        throw new BadRequestException(
          `Another ${round.kind.toLowerCase()} interview has already been arranged for this candidate. Remove that one first if this session is the one that stands.`,
        );
      }
    }

    const newPanelistIds = dto.panelistUserIds
      ? [...new Set(dto.panelistUserIds)]
      : null;

    await this.prisma.interviewRound.update({
      where: { id: roundId },
      data: {
        ...(dto.kind ? { kind: dto.kind.toUpperCase() as InterviewKind } : {}),
        ...(dto.mode ? { mode: dto.mode.toUpperCase() as InterviewMode } : {}),
        ...(dto.scheduledAt !== undefined
          ? { scheduledAt: toDate(dto.scheduledAt) }
          : {}),
        ...(dto.location !== undefined
          ? { location: dto.location.trim() || null }
          : {}),
        ...(dto.status
          ? { status: dto.status.toUpperCase() as InterviewStatus }
          : {}),
        ...(newPanelistIds
          ? {
              panelists: {
                deleteMany: {},
                create: newPanelistIds.map((uid) => ({ userId: uid })),
              },
            }
          : {}),
      },
    });

    // Sync evaluation tokens when panelists change.
    if (newPanelistIds) {
      const oldIds = round.panelists.map((p) => p.userId);
      const removed = oldIds.filter((id) => !newPanelistIds.includes(id));
      if (removed.length) {
        await this.prisma.evaluationToken.deleteMany({
          where: { roundId, panelistUserId: { in: removed } },
        });
      }
      const scheduledAt =
        dto.scheduledAt !== undefined
          ? toDate(dto.scheduledAt)
          : round.scheduledAt;
      await this.generateEvalTokens(roundId, newPanelistIds, scheduledAt);
    } else if (dto.scheduledAt !== undefined) {
      // scheduledAt changed — update expiry on pending tokens.
      const newDate = toDate(dto.scheduledAt);
      if (newDate) {
        const newExpiry = new Date(newDate.getTime() + EVAL_TOKEN_VALID_MS);
        await this.prisma.evaluationToken.updateMany({
          where: { roundId, status: { not: 'submitted' } },
          data: { expiresAt: newExpiry },
        });
      }
    }

    this.notifications.broadcastChange('candidate', round.requisitionId, {
      action: 'interview_updated',
    });
    let fresh = await this.prisma.interviewRound.findUnique({
      where: { id: roundId },
      include: roundInclude,
    });
    if (fresh) {
      const synced = await this.syncCalendarUpdate(
        fresh,
        round.requisition.designation,
      );
      if (synced) fresh = synced;
    }
    return fresh ? serializeRound(fresh) : { id: roundId };
  }

  async remove(roundId: string, userId: string) {
    const round = await this.prisma.interviewRound.findUnique({
      where: { id: roundId },
      include: {
        requisition: {
          select: {
            unitFactory: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
      },
    });
    if (!round) throw new NotFoundException('Interview not found');
    await this.requireInterviewAccess(
      round.candidateId,
      round.requisition,
      userId,
    );
    if (round.calendarEventId) {
      await this.calendar.cancelEvent(round.calendarEventId);
    }
    await this.prisma.interviewRound.delete({ where: { id: roundId } });
    this.notifications.broadcastChange('candidate', round.requisitionId, {
      action: 'interview_removed',
    });
    return { id: roundId };
  }

  // --- committee marking ("My Interviews") --------------------------------

  /** Interview rounds the current user is a panelist on, with their own marks. */
  async myInterviews(userId: string) {
    const rounds = await this.prisma.interviewRound.findMany({
      where: { panelists: { some: { userId } } },
      include: {
        candidate: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            cvUrl: true,
            cvFileId: true,
            cvAddress: true,
            cvProfile: true,
          },
        },
        requisition: {
          select: {
            id: true,
            code: true,
            designation: true,
            unitFactory: true,
          },
        },
        evaluations: { where: { evaluatorId: userId } },
      },
      /**
       * Most recent first.
       *
       * This page is opened to mark a session that has just been run, so the
       * one at the top should be the one that just happened. Oldest-first put
       * last month's finished interviews above this morning's, and the row
       * somebody came to mark was several screens down. Rounds with no date
       * yet sort last: there is nothing to mark on them.
       */
      orderBy: [
        { scheduledAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
    });

    return rounds.map((r) => {
      const mine = r.evaluations[0];
      return {
        id: r.id,
        kind: r.kind.toLowerCase(),
        mode: r.mode.toLowerCase(),
        scheduledAt: r.scheduledAt?.toISOString() ?? null,
        location: r.location ?? '',
        meetLink: r.meetLink ?? null,
        status: r.status.toLowerCase(),
        candidate: {
          id: r.candidate.id,
          name: r.candidate.name,
          email: r.candidate.email ?? '',
          phone: r.candidate.phone ?? '',
          // Streamed by this API, not a public Drive link.
          cvUrl:
            this.files.url(r.candidate.cvFileId, 'cv', {
              filename: `${r.candidate.name} — CV`,
            }) ?? r.candidate.cvUrl,
          /** The same block the token form shows — see `candidate-brief`. */
          brief: buildCandidateBrief(r.candidate),
        },
        requisition: {
          id: r.requisition.id,
          code: r.requisition.code,
          designation: r.requisition.designation,
          unit: r.requisition.unitFactory,
        },
        criteria: EVALUATION_CRITERIA,
        myEvaluation: mine
          ? {
              scores: mine.scores as Record<string, number>,
              comments: mine.comments ?? '',
              total: mine.total,
              recommendation: fromRecommendation(mine.recommendation),
            }
          : null,
      };
    });
  }

  /** Validate + clamp a panelist's submission against the fixed evaluation criteria. */
  private buildScores(input: Record<string, number> | undefined) {
    try {
      return scoreCriteria(input);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /** A panelist submits / updates their marks for a candidate. */
  async submitEvaluation(
    roundId: string,
    userId: string,
    dto: SubmitEvaluationDto,
  ) {
    const round = await this.prisma.interviewRound.findUnique({
      where: { id: roundId },
      include: { panelists: true },
    });
    if (!round) throw new NotFoundException('Interview not found');
    if (!round.panelists.some((p) => p.userId === userId)) {
      throw new ForbiddenException('You are not on this interview panel');
    }
    if (round.status === 'ABSENT')
      throw new BadRequestException(ABSENT_NO_MARKS);

    const already = await this.prisma.evaluation.findUnique({
      where: { roundId_evaluatorId: { roundId, evaluatorId: userId } },
      select: { id: true },
    });
    if (already) {
      throw new ConflictException(
        'You have already submitted your marks for this interview — they cannot be changed.',
      );
    }

    const { scores, total } = this.buildScores(dto.scores);

    await this.prisma.evaluation.create({
      data: {
        roundId,
        evaluatorId: userId,
        scores,
        comments: dto.comments?.trim() || null,
        total,
        recommendation: toRecommendation(dto.recommendation),
      },
    });

    // Also mark the eval token as submitted if it exists.
    await this.prisma.evaluationToken.updateMany({
      where: { roundId, panelistUserId: userId, status: { not: 'submitted' } },
      data: { status: 'submitted', submittedAt: new Date() },
    });

    this.notifications.broadcastChange('candidate', round.requisitionId, {
      action: 'evaluation_submitted',
    });
    return this.myInterviews(userId);
  }

  // --- secure one-click evaluation (no login) --------------------------------

  /** Public: return the eval form data for a token. Marks as opened on first access. */
  /**
   * The CV of the candidate this evaluation link is for.
   *
   * A panelist marking an interview has no login; the evaluation token is their
   * credential. The candidate is resolved from the token, so the URL cannot be
   * edited to read anyone else's CV, and it stops working when the token
   * expires or the evaluation is submitted.
   */
  async streamEvalCv(token: string, res: Response): Promise<void> {
    const et = await this.prisma.evaluationToken.findFirst({
      where: tokenLookupWhere(token),
      include: {
        round: {
          include: { candidate: { select: { name: true, cvFileId: true } } },
        },
      },
    });
    if (!et) throw new NotFoundException('This evaluation link is invalid.');
    if (et.expiresAt < new Date()) {
      throw new BadRequestException('This evaluation link has expired.');
    }
    const candidate = et.round.candidate;
    if (!candidate.cvFileId) {
      throw new NotFoundException(
        'No CV document is on file for this candidate.',
      );
    }
    await this.secureFiles.stream(res, candidate.cvFileId, {
      filename: `${candidate.name} — CV`,
    });
  }

  async getEvalByToken(token: string) {
    const et = await this.prisma.evaluationToken.findFirst({
      where: tokenLookupWhere(token),
      include: {
        round: {
          include: {
            // The CV goes with the marks: a panelist scoring someone needs to
            // read their background, and on the token path they have no other
            // way in — there is no login and no candidate page for them.
            candidate: {
              select: {
                id: true,
                name: true,
                cvUrl: true,
                cvFileId: true,
                // The brief the panelist marks against — see `candidate-brief`.
                email: true,
                phone: true,
                cvAddress: true,
                cvProfile: true,
              },
            },
            requisition: {
              select: {
                designation: true,
                unitFactory: true,
              },
            },
          },
        },
        panelistUser: { select: { name: true } },
      },
    });

    if (!et) throw new NotFoundException('Evaluation link not found');

    if (et.status !== 'submitted' && et.expiresAt < new Date()) {
      throw new GoneException(
        'This evaluation link has expired. Please contact HR.',
      );
    }

    // Backstop for a CV that was never read — an interview arranged before
    // this existed, or an extraction that failed. It runs in the background,
    // so this first open shows whatever is on file and the next one is
    // complete; blocking the form on an AI call would be worse than a
    // summary that fills in a minute later.
    if (!et.round.candidate.cvProfile && et.round.candidate.cvFileId) {
      this.candidates.scheduleCvProfile(et.round.candidate.id);
    }

    // Mark as opened on first access.
    if (et.status === 'sent') {
      await this.prisma.evaluationToken.update({
        where: { id: et.id },
        data: { status: 'opened', openedAt: new Date() },
      });
    }

    // Check if already evaluated (could have been done via the login path).
    const existingEval = await this.prisma.evaluation.findUnique({
      where: {
        roundId_evaluatorId: {
          roundId: et.roundId,
          evaluatorId: et.panelistUserId,
        },
      },
      select: {
        scores: true,
        comments: true,
        total: true,
        recommendation: true,
      },
    });

    return {
      status: et.status,
      alreadySubmitted: !!existingEval,
      panelistName: et.panelistUser.name,
      candidate: {
        name: et.round.candidate.name,
        // Scoped to this evaluation token. The panelist has no login, so the
        // token is their credential — and it only ever reaches the CV of the
        // candidate they were asked to mark.
        cvUrl: et.round.candidate.cvFileId
          ? `/api/eval/${et.token}/cv`
          : et.round.candidate.cvUrl,
        /**
         * The CV as facts, not as a document.
         *
         * A panelist on the token path has no login and no candidate page,
         * and a PDF in another tab is not something anybody reads between two
         * interviews. The block they actually score against — age, education,
         * every post held and the total service — travels with the form.
         */
        brief: buildCandidateBrief(et.round.candidate),
      },
      interview: {
        kind: et.round.kind.toLowerCase(),
        mode: et.round.mode.toLowerCase(),
        scheduledAt: et.round.scheduledAt?.toISOString() ?? null,
        location: et.round.location ?? '',
        designation: et.round.requisition.designation,
        unit: et.round.requisition.unitFactory,
      },
      criteria: EVALUATION_CRITERIA,
      submittedEval: existingEval
        ? {
            scores: existingEval.scores as Record<string, number>,
            comments: existingEval.comments ?? '',
            total: existingEval.total,
            recommendation: fromRecommendation(existingEval.recommendation),
          }
        : null,
    };
  }

  /** Public: submit marks via a one-click token (no login). */
  async submitEvalByToken(token: string, dto: SubmitEvaluationDto) {
    const et = await this.prisma.evaluationToken.findFirst({
      where: tokenLookupWhere(token),
      include: {
        round: { select: { id: true, requisitionId: true, status: true } },
      },
    });

    if (!et) throw new NotFoundException('Evaluation link not found');
    if (et.expiresAt < new Date()) {
      throw new GoneException(
        'This evaluation link has expired. Please contact HR.',
      );
    }
    if (et.round.status === 'ABSENT') {
      throw new BadRequestException(ABSENT_NO_MARKS);
    }

    // Idempotency: if already in DB, mark token and return gracefully.
    const existing = await this.prisma.evaluation.findUnique({
      where: {
        roundId_evaluatorId: {
          roundId: et.roundId,
          evaluatorId: et.panelistUserId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.evaluationToken.updateMany({
        where: { id: et.id, status: { not: 'submitted' } },
        data: { status: 'submitted', submittedAt: new Date() },
      });
      throw new ConflictException(
        'You have already submitted your evaluation for this interview.',
      );
    }

    const { scores, total } = this.buildScores(dto.scores);

    await this.prisma.$transaction([
      this.prisma.evaluation.create({
        data: {
          roundId: et.roundId,
          evaluatorId: et.panelistUserId,
          scores,
          comments: dto.comments?.trim() || null,
          total,
          recommendation: toRecommendation(dto.recommendation),
        },
      }),
      this.prisma.evaluationToken.update({
        where: { id: et.id },
        data: { status: 'submitted', submittedAt: new Date() },
      }),
    ]);

    this.notifications.broadcastChange('candidate', et.round.requisitionId, {
      action: 'evaluation_submitted',
    });

    return { ok: true, total };
  }

  /** Regenerate the evaluation token for a specific panelist (Corp HR / super only). */
  async resendEvalToken(
    roundId: string,
    panelistUserId: string,
    actorId: string,
  ) {
    const round = await this.prisma.interviewRound.findUnique({
      where: { id: roundId },
      include: {
        requisition: {
          select: {
            unitFactory: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
        panelists: { select: { userId: true } },
      },
    });
    if (!round) throw new NotFoundException('Interview not found');
    await this.requireInterviewAccess(
      round.candidateId,
      round.requisition,
      actorId,
    );

    if (!round.panelists.some((p) => p.userId === panelistUserId)) {
      throw new BadRequestException('User is not on this panel');
    }

    const newToken = randomBytes(16).toString('hex');
    const expiresAt = new Date(
      (round.scheduledAt?.getTime() ?? Date.now()) + EVAL_TOKEN_VALID_MS,
    );

    await this.prisma.evaluationToken.upsert({
      where: { roundId_panelistUserId: { roundId, panelistUserId } },
      create: { token: newToken, roundId, panelistUserId, expiresAt },
      update: {
        token: newToken,
        expiresAt,
        status: 'sent',
        openedAt: null,
        submittedAt: null,
      },
    });

    return { evalLink: evalLink(newToken) };
  }

  // --- helpers -------------------------------------------------------------

  /** Generate (idempotent) one-click evaluation tokens for a list of panelists. */
  private async generateEvalTokens(
    roundId: string,
    panelistUserIds: string[],
    scheduledAt: Date | null,
  ) {
    const expiresAt = new Date(
      (scheduledAt?.getTime() ?? Date.now()) + EVAL_TOKEN_VALID_MS,
    );

    await Promise.all(
      panelistUserIds.map(async (panelistUserId) => {
        const token = randomBytes(16).toString('hex');
        // Upsert: create for new panelists; do nothing for existing (preserve status).
        await this.prisma.evaluationToken.upsert({
          where: { roundId_panelistUserId: { roundId, panelistUserId } },
          create: { token, roundId, panelistUserId, expiresAt },
          update: {},
        });
      }),
    );
  }

  /** Create the Calendar event for a new round; returns the updated round. */
  private async syncCalendarCreate(
    round: RoundFull,
    designation: string,
    inviteCandidate: boolean,
  ): Promise<RoundFull | null> {
    const input = this.eventInput(round, designation, inviteCandidate);
    if (!input || !this.calendar.isConfigured()) return null;
    const ev = await this.calendar.createEvent(input);
    if (!ev?.eventId) return null;
    return this.prisma.interviewRound.update({
      where: { id: round.id },
      data: {
        calendarEventId: ev.eventId,
        meetLink: ev.meetLink,
        ...(ev.meetLink && !round.location ? { location: ev.meetLink } : {}),
      },
      include: roundInclude,
    });
  }

  /** Patch / cancel / late-create the Calendar event after a round changes. */
  private async syncCalendarUpdate(
    round: RoundFull,
    designation: string,
  ): Promise<RoundFull | null> {
    if (!this.calendar.isConfigured()) return null;
    if (round.calendarEventId) {
      if (round.status === 'CANCELLED') {
        await this.calendar.cancelEvent(round.calendarEventId);
        return this.prisma.interviewRound.update({
          where: { id: round.id },
          data: { calendarEventId: null, meetLink: null },
          include: roundInclude,
        });
      }
      const input = this.eventInput(round, designation, true);
      if (input) await this.calendar.updateEvent(round.calendarEventId, input);
      return null;
    }
    if (round.status !== 'SCHEDULED') return null;
    return this.syncCalendarCreate(round, designation, true);
  }

  private eventInput(
    round: RoundFull,
    designation: string,
    inviteCandidate: boolean,
  ): CalendarEventInput | null {
    if (!round.scheduledAt) return null;
    const attendees = round.panelists
      .map((p) => p.user.email ?? '')
      .filter(Boolean);
    if (inviteCandidate && round.candidate.email) {
      attendees.push(round.candidate.email);
    }
    return {
      summary: `Interview — ${round.candidate.name} · ${designation}`,
      description: `${cap(round.kind.toLowerCase())} interview for the ${designation} position (DBL HRM).`,
      start: round.scheduledAt,
      attendees,
      location: round.location,
      withMeet: round.mode === 'ONLINE',
    };
  }

  private async notifyScheduled(
    round: RoundFull,
    req: PanelEmailInput['requisition'],
    dto: ScheduleInterviewDto,
  ) {
    const { designation } = req;
    const when = round.scheduledAt
      ? new Date(round.scheduledAt).toLocaleString('en-GB', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : 'a time to be confirmed';
    const kindLabel = round.kind.toLowerCase();
    const modeLabel = round.mode.toLowerCase();

    if (dto.notifyPanel !== false) {
      // Each panelist gets THEIR OWN evaluation link, not a link to the app.
      //
      // Every notification is mirrored to email, and the emailed copy turns
      // `link` into a URL. Pointing that at /my-interviews sends a panelist to
      // a sign-in page — but the whole point of the evaluation token is that it
      // already identifies them and needs no login. Panels routinely include
      // people who have never signed into this system.
      //
      // Notified one at a time because the link differs per person; notifyMany
      // would send everyone the same one, which would be worse than useless —
      // it would file their marks against another panelist.
      const tokens = await this.prisma.evaluationToken.findMany({
        where: {
          roundId: round.id,
          panelistUserId: { in: round.panelists.map((p) => p.userId) },
        },
        select: { panelistUserId: true, token: true },
      });
      const tokenFor = new Map(tokens.map((t) => [t.panelistUserId, t.token]));

      for (const p of round.panelists) {
        const path = evaluatePath(tokenFor.get(p.userId));
        await this.notifications.notify(p.userId, {
          type: 'interview_assigned',
          title: 'Interview to conduct',
          message: `${round.candidate.name} · ${designation} — ${kindLabel} interview on ${formatSlotShort(round.scheduledAt)}.`,
          link: path,
          email: panelNotice(round.kind, req, [{ round, path }]),
        });
      }
    }

    if (
      dto.notifyCandidate &&
      round.candidate.email &&
      this.mail.isConfigured()
    ) {
      try {
        await this.mail.send({
          to: round.candidate.email,
          subject: `Interview Invitation — ${designation} | DBL Group`,
          text: `Dear ${round.candidate.name},\n\nYou are invited to a ${kindLabel} interview for the ${designation} position.\n\nWhen: ${when}\nMode: ${modeLabel}${round.meetLink ? `\nGoogle Meet: ${round.meetLink}` : round.location ? `\nWhere: ${round.location}` : ''}\n\nA calendar invitation has also been sent to this address if scheduling is connected.\n\nBest regards,\nDBL Group Recruitment`,
        });
      } catch (err) {
        this.logger.warn(`Interview email failed: ${(err as Error).message}`);
      }
    }
  }

  // ── Delegation ───────────────────────────────────────────────────────────

  /**
   * Hand shortlisted candidates to people who will run their first interview.
   *
   * Bulk on both axes: several candidates to several people in one call, which
   * is how a recruiter actually works through a shortlist. Re-sending the same
   * pair reactivates rather than duplicating, so it is safe to repeat.
   */
  async delegate(
    candidateIds: string[],
    delegateUserIds: string[],
    actor: { id: string; name: string },
    note?: string,
    tests?: DelegationTestsDto,
  ) {
    if (!candidateIds.length) {
      throw new BadRequestException('Select at least one candidate');
    }
    if (!delegateUserIds.length) {
      throw new BadRequestException('Select at least one person to send to');
    }

    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: candidateIds }, deletedAt: null },
      include: {
        requisition: {
          select: {
            id: true,
            code: true,
            designation: true,
            unitFactory: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
      },
    });
    if (candidates.length !== candidateIds.length) {
      throw new NotFoundException('One or more candidates were not found');
    }

    // Delegating is a recruiter/HR act — a delegate cannot re-delegate onward.
    for (const cand of candidates) {
      await this.requireRecruitmentAccess(cand.requisition, actor.id);
    }

    const delegates = await this.prisma.user.findMany({
      where: { id: { in: delegateUserIds }, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    if (!delegates.length) {
      throw new NotFoundException('No valid people to send to');
    }

    // Being sent candidates IS the grant. A user with zero role assignments
    // cannot sign in at all (auth.service.ts), so without this HR hands work
    // to a factory colleague, they get the notification, and then bounce off
    // the login screen — the job invisible to the only person who can do it.
    // Same treatment Approval Paths gives a nominated raiser or approver.
    const unitNames = [
      ...new Set(candidates.map((c) => c.requisition.unitFactory)),
    ];
    for (const d of delegates) {
      for (const unitName of unitNames) {
        await this.grantInterviewerRole(d.id, unitName, actor.id);
      }
    }

    for (const cand of candidates) {
      for (const d of delegates) {
        await this.prisma.interviewDelegation.upsert({
          where: {
            candidateId_delegatedToId: {
              candidateId: cand.id,
              delegatedToId: d.id,
            },
          },
          create: {
            candidateId: cand.id,
            requisitionId: cand.requisitionId,
            delegatedToId: d.id,
            delegatedById: actor.id,
            note: note?.trim() || null,
          },
          // Re-sending a previously revoked delegation restores it — and is
          // now recorded. `createdAt` stays at the first hand-off while
          // `lastSentAt` moves, so the pair reads "assigned on the 3rd, chased
          // again on the 11th" instead of quietly looking like one send.
          update: {
            revokedAt: null,
            delegatedById: actor.id,
            note: note?.trim() || null,
            sendCount: { increment: 1 },
            lastSentAt: new Date(),
          },
        });
      }
    }

    // The testing brief travels with the hand-off: HR says which tests apply
    // and out of how many marks, so the interviewer opens their worklist and
    // finds the right boxes waiting. Only what was specified is written —
    // marks already recorded are never disturbed.
    if (tests && Object.keys(tests).length > 0) {
      const data = {
        ...(tests.writtenTestEnabled !== undefined
          ? { writtenTestEnabled: tests.writtenTestEnabled }
          : {}),
        ...(tests.writtenTestTotal !== undefined
          ? { writtenTestTotal: tests.writtenTestTotal }
          : {}),
        ...(tests.computerTestEnabled !== undefined
          ? { computerTestEnabled: tests.computerTestEnabled }
          : {}),
        ...(tests.computerTestTotal !== undefined
          ? { computerTestTotal: tests.computerTestTotal }
          : {}),
        ...(tests.aiTestEnabled !== undefined
          ? { aiTestEnabled: tests.aiTestEnabled }
          : {}),
      };
      for (const cand of candidates) {
        await this.prisma.salaryFixation.upsert({
          where: { candidateId: cand.id },
          create: { candidateId: cand.id, ...data },
          update: data,
        });
      }
    }

    for (const d of delegates) {
      const mine = candidates.length;
      try {
        await this.notifications.notify(d.id, {
          type: 'interview_delegated',
          title: 'Candidates assigned for interview',
          message: `${actor.name} assigned you ${mine} candidate${mine > 1 ? 's' : ''} to arrange the first interview for.`,
          link: '/assigned-candidates',
        });
      } catch {
        this.logger.warn(`Could not notify delegate ${d.name}`);
      }
    }

    return { delegated: candidates.length * delegates.length };
  }

  /**
   * Give a delegated interviewer the access the job needs.
   *
   * Deliberately its own role rather than reusing `unit_approver`: being asked
   * to run an interview should not quietly make someone eligible to be named
   * on approval chains. It grants sign-in and nothing else — which candidates
   * they can touch is decided by the delegation itself, not by this role.
   *
   * Additive, like every other auto-grant here: revoking a delegation does not
   * strip the role, since they may still hold others.
   */
  private async grantInterviewerRole(
    userId: string,
    unitName: string,
    grantedById: string,
  ): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { key: 'interviewer' },
    });
    if (!role) {
      this.logger.warn(
        'interviewer role missing — access was not auto-granted',
      );
      return;
    }

    // A requisition carries the unit's name, not its id, and those names drift
    // on trailing punctuation between ZingHR and hand-configured rows
    // (CLAUDE.md §10) — so match the way the rest of the codebase does.
    const units = await this.prisma.unit.findMany({
      select: { id: true, name: true },
    });
    const unit = units.find((u) => sameUnit(u.name, unitName));
    if (!unit) {
      this.logger.warn(
        `No unit matches "${unitName}" — interviewer access was not auto-granted`,
      );
      return;
    }

    const already = await this.prisma.roleAssignment.findFirst({
      where: { roleId: role.id, userId, unitId: unit.id },
    });
    if (already) return;

    await this.prisma.roleAssignment.create({
      data: {
        roleId: role.id,
        userId,
        unitId: unit.id,
        assignedById: grantedById,
      },
    });
    this.permissions.invalidate(userId);
    this.logger.log(`Granted interviewer on ${unit.name} to user ${userId}`);
  }

  /**
   * The first-interview verdict: does this candidate go forward or not?
   *
   * Open to whoever ran the session — the delegate as well as Head of Talent Acquisition —
   * but deliberately narrow: it moves the stage and nothing else, so a
   * delegate cannot edit the candidate's record through it.
   */
  /**
   * What the candidate earns now, what they want, and what comes with it.
   *
   * Recorded by whoever is running the session — in practice factory HR on
   * the first interview, which is the only time anybody asks. Kept on the
   * candidate rather than the round: the answers do not change between the
   * first interview and the second, and two copies would eventually differ.
   *
   * There is deliberately no field here for the salary DBL will pay. That is
   * settled by Corporate HR against the grade and the committee's marks on
   * the Salary Fixation screen; an interviewer writing a figure into this
   * form would be making a promise nobody authorised.
   */
  async setCandidatePackage(
    candidateId: string,
    actorId: string,
    dto: CandidatePackageDto,
  ) {
    const cand = await this.loadCandidate(candidateId, actorId);
    // `null` clears, `undefined` leaves alone — the form sends only what it
    // touched, so a blank benefits note must not wipe a salary figure.
    const data: Prisma.CandidateUpdateInput = {};
    if (dto.presentSalary !== undefined) data.presentSalary = dto.presentSalary;
    if (dto.salaryExpectation !== undefined) {
      data.salaryExpectation = dto.salaryExpectation;
    }
    if (dto.salaryBenefitsNote !== undefined) {
      data.salaryBenefitsNote = dto.salaryBenefitsNote?.trim() || null;
    }
    if (dto.salaryBenefits !== undefined) {
      const conflict = benefitsConflict(dto.salaryBenefits);
      if (conflict) throw new BadRequestException(conflict);
      data.salaryBenefits = normaliseBenefits(dto.salaryBenefits);
    }
    if (dto.transportPickup !== undefined) {
      data.transportPickup = dto.transportPickup?.trim() || null;
    }
    const updated = await this.prisma.candidate.update({
      where: { id: cand.id },
      data,
      select: {
        id: true,
        presentSalary: true,
        salaryExpectation: true,
        salaryBenefitsNote: true,
        salaryBenefits: true,
        transportPickup: true,
      },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'candidate_package',
    });
    return updated;
  }

  /**
   * Turn a candidate down from the interview screen, at any round.
   *
   * `recordFirstInterviewOutcome` covers the delegated first interview and
   * refuses once the candidate has moved past it. This is the other case:
   * Corporate HR sitting on the second or final round deciding not to
   * proceed. Same fields, so the rejection reads the same wherever it is
   * shown; `rejectionStage` records which screen it came from.
   */
  async rejectAtInterview(
    candidateId: string,
    actor: { id: string; name: string },
    reason?: string,
  ) {
    const cand = await this.loadCandidate(candidateId, actor.id);
    // One rule, in reject-guard.ts, so this cannot drift from what the
    // tests pin — it was got wrong in both directions before.
    const onboarding = await this.prisma.onboarding.findUnique({
      where: { candidateId: cand.id },
      select: { status: true, offerSentAt: true },
    });
    const blocker = rejectBlocker({
      name: cand.name,
      stage: cand.stage,
      onboarding,
    });
    if (blocker) throw new BadRequestException(blocker);

    const note = reason?.trim();
    const updated = await this.prisma.candidate.update({
      where: { id: cand.id },
      data: {
        stage: 'REJECTED',
        rejectedAt: new Date(),
        rejectedById: actor.id,
        rejectionStage: 'interview',
        rejectionReason: note || null,
        notes: note
          ? `${cand.notes ? cand.notes + '\n' : ''}Rejected at interview (${actor.name}): ${note}`
          : cand.notes,
      },
      select: { id: true, name: true, stage: true },
    });
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'candidate_rejected',
    });
    return updated;
  }

  async recordFirstInterviewOutcome(
    candidateId: string,
    outcome: 'final' | 'rejected',
    actor: { id: string; name: string },
    note?: string,
  ) {
    const cand = await this.loadCandidate(candidateId, actor.id);

    if (cand.stage !== 'INTERVIEW') {
      // Most often this is the other person on a shared assignment getting
      // there first, so say so rather than leaving them guessing.
      if (cand.stage === 'FINAL' || cand.stage === 'REJECTED') {
        const already = await this.prisma.candidate.findUnique({
          where: { id: cand.id },
          select: { rejectedBy: { select: { name: true } } },
        });
        const verdict =
          cand.stage === 'FINAL' ? 'moved to the final stage' : 'rejected';
        const who = already?.rejectedBy?.name;
        throw new BadRequestException(
          `${cand.name} has already been ${verdict}${who ? ` by ${who}` : ''}. Only one first-interview outcome is recorded per candidate.`,
        );
      }
      throw new BadRequestException(
        `${cand.name} is not at the interview stage, so a first-interview outcome cannot be recorded.`,
      );
    }

    // Every test HR assigned is marked or skipped before anyone decides —
    // either verdict, since a rejection is read downstream just the same.
    const fx = await this.prisma.salaryFixation.findUnique({
      where: { candidateId: cand.id },
      select: {
        writtenTestEnabled: true,
        writtenTestObtained: true,
        computerTestEnabled: true,
        computerTestObtained: true,
        aiTestEnabled: true,
        aiTestObtained: true,
      },
    });
    const unmarked = unmarkedTests(fx);
    if (unmarked.length) {
      const one = unmarked.length === 1;
      throw new BadRequestException(
        `Enter ${cand.name}'s ${listTests(unmarked)} test mark${one ? '' : 's'} — or skip ${one ? 'that test' : 'those tests'} under Test marks — before deciding.`,
      );
    }

    const rejected = outcome === 'rejected';
    const updated = await this.prisma.candidate.update({
      where: { id: cand.id },
      data: {
        stage: rejected ? 'REJECTED' : 'FINAL',
        notes: note?.trim()
          ? `${cand.notes ? cand.notes + '\n' : ''}First interview (${actor.name}): ${note.trim()}`
          : cand.notes,
        // Stamp who turned them down and where. 'first_interview' is what
        // separates a factory interviewer's call from a CV screening
        // rejection by Head of Talent Acquisition — the two used to be indistinguishable.
        ...(rejected
          ? {
              rejectedAt: new Date(),
              rejectedById: actor.id,
              rejectionStage: 'first_interview',
              rejectionReason: note?.trim() || null,
            }
          : {
              rejectedAt: null,
              rejectedById: null,
              rejectionStage: null,
              rejectionReason: null,
            }),
      },
      select: { id: true, name: true, stage: true },
    });

    // Tell whoever handed this over what the outcome was.
    const delegations = await this.prisma.interviewDelegation.findMany({
      where: { candidateId: cand.id, revokedAt: null },
      select: { delegatedById: true },
    });
    const notifyIds = [
      ...new Set(
        delegations
          .map((d) => d.delegatedById)
          .filter((id): id is string => Boolean(id) && id !== actor.id),
      ),
    ];
    for (const id of notifyIds) {
      try {
        await this.notifications.notify(id, {
          type: 'interview_outcome',
          title: `First interview: ${outcome === 'final' ? 'moved to final' : 'rejected'}`,
          message: `${actor.name} ${outcome === 'final' ? 'advanced' : 'rejected'} ${cand.name} after the first interview.`,
          link: `/requisitions/${cand.requisitionId}`,
        });
      } catch {
        this.logger.warn('Could not notify the delegating recruiter');
      }
    }

    return {
      id: updated.id,
      name: updated.name,
      stage: updated.stage.toLowerCase(),
    };
  }

  /** Withdraw a delegation. The audit row survives, marked revoked. */
  async revokeDelegation(
    candidateId: string,
    delegateUserId: string,
    userId: string,
  ) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: {
        requisition: {
          select: {
            unitFactory: true,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
      },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition, userId);

    await this.prisma.interviewDelegation.updateMany({
      where: { candidateId, delegatedToId: delegateUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  /** Who a candidate is currently delegated to. */
  /**
   * Who this candidate is with, and what has happened since.
   *
   * Previously this returned only who and when, which left the person who sent
   * the work unable to answer the two questions they actually have: have I sent
   * this before, and has anything happened?
   */
  async listDelegations(candidateId: string, userId: string) {
    const cand = await this.loadCandidate(candidateId, userId);
    const rows = await this.prisma.interviewDelegation.findMany({
      where: { candidateId: cand.id, revokedAt: null },
      include: {
        delegatedTo: { select: { id: true, name: true, employeeCode: true } },
        delegatedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // The candidate's rounds are shared by every delegation on them — one read.
    const progress = await this.progressFor([candidateId]);
    const p = progress.get(candidateId);

    return rows.map((r) => ({
      id: r.id,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      delegatedTo: r.delegatedTo,
      delegatedBy: r.delegatedBy,
      /** 1 on the first send; above that it has been chased. */
      sendCount: r.sendCount,
      lastSentAt: r.lastSentAt.toISOString(),
      resent: r.sendCount > 1,
      /** Whole days since the most recent send — "waiting 9 days". */
      waitingDays: daysSince(r.lastSentAt),
      stage: p?.stage ?? 'sent',
      stageLabel: p?.label ?? 'No action yet',
      complete: p?.complete ?? false,
      scheduledAt: p?.scheduledAt ?? null,
    }));
  }

  /**
   * Derive the delegation stage for a set of candidates in one pass.
   *
   * Shared by the per-candidate view, the requisition board and the workload
   * roll-up so all three agree; and batched because the board asks about every
   * candidate on a requisition at once.
   */
  private async progressFor(candidateIds: string[]) {
    if (candidateIds.length === 0) {
      return new Map<string, ReturnType<typeof delegationProgress>>();
    }
    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: candidateIds } },
      select: {
        id: true,
        stage: true,
        rejectedAt: true,
        interviews: {
          select: {
            status: true,
            scheduledAt: true,
            _count: { select: { evaluations: true } },
          },
        },
      },
    });
    const now = new Date();
    return new Map(
      candidates.map((c) => [
        c.id,
        delegationProgress(
          {
            candidateStage: c.stage,
            rejectedAt: c.rejectedAt,
            rounds: c.interviews.map((r) => ({
              status: r.status,
              scheduledAt: r.scheduledAt,
              evaluationCount: r._count.evaluations,
            })),
          },
          now,
        ),
      ]),
    );
  }

  /**
   * What each interviewer is currently carrying.
   *
   * Feeds the send dialog. Before this, picking someone to hand five CVs to
   * told you nothing about the twenty they were already sitting on, so work
   * piled onto whoever came first alphabetically.
   *
   * Counts every open delegation the person holds — not only on this
   * requisition — because their capacity is their whole load, not the slice
   * you happen to be looking at.
   */
  async delegateWorkload(userIds: string[], actorId: string) {
    if (userIds.length === 0) return [];

    // The caller is already inside a recruitment surface; this returns
    // workload counts for named people, never candidate detail.
    await this.requireAnyRecruitmentRole(actorId);

    const rows = await this.prisma.interviewDelegation.findMany({
      where: { delegatedToId: { in: userIds }, revokedAt: null },
      select: {
        delegatedToId: true,
        candidateId: true,
        lastSentAt: true,
        sendCount: true,
      },
    });
    if (rows.length === 0) {
      return userIds.map((id) => emptyWorkload(id));
    }

    const progress = await this.progressFor([
      ...new Set(rows.map((r) => r.candidateId)),
    ]);

    const byUser = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byUser.get(r.delegatedToId) ?? [];
      list.push(r);
      byUser.set(r.delegatedToId, list);
    }

    return userIds.map((userId) => {
      const mine = byUser.get(userId) ?? [];
      if (mine.length === 0) return emptyWorkload(userId);

      let waiting = 0;
      let scheduled = 0;
      let done = 0;
      let oldestWaitingDays = 0;

      for (const d of mine) {
        const stage: DelegationStage =
          progress.get(d.candidateId)?.stage ?? 'sent';
        if (stage === 'sent') {
          waiting++;
          // "Oldest waiting" counts from the last send, not the first: a chase
          // resets the clock on the person being chased.
          oldestWaitingDays = Math.max(
            oldestWaitingDays,
            daysSince(d.lastSentAt),
          );
        } else if (stage === 'scheduled' || stage === 'interviewed') {
          scheduled++;
        } else {
          done++;
        }
      }

      return {
        userId,
        holds: mine.length,
        /** Handed over and nothing arranged yet — the number that matters. */
        waiting,
        /** Arranged or already held, marks not in. */
        inProgress: scheduled,
        done,
        oldestWaitingDays,
        /** Anything chased at least once. */
        resent: mine.filter((d) => d.sendCount > 1).length,
      };
    });
  }

  /**
   * Every delegation on a requisition, with where each candidate has reached.
   *
   * The scoreboard: one place where whoever sent the work can see what came of
   * it, rather than opening candidates one at a time.
   */
  async requisitionDelegationBoard(reqId: string, userId: string) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
      select: {
        id: true,
        unitFactory: true,
        recruiterId: true,
        coverRecruiterId: true,
        coverUntil: true,
      },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    await this.requireRecruitmentAccess(req, userId);

    const rows = await this.prisma.interviewDelegation.findMany({
      where: { requisitionId: reqId, revokedAt: null },
      include: {
        delegatedTo: { select: { id: true, name: true, employeeCode: true } },
        delegatedBy: { select: { id: true, name: true } },
        candidate: { select: { id: true, name: true, stage: true } },
      },
      orderBy: [{ lastSentAt: 'desc' }],
    });

    const progress = await this.progressFor([
      ...new Set(rows.map((r) => r.candidateId)),
    ]);

    const items = rows.map((r) => {
      const p = progress.get(r.candidateId);
      return {
        id: r.id,
        candidate: {
          id: r.candidate.id,
          name: r.candidate.name,
          stage: r.candidate.stage.toLowerCase(),
        },
        delegatedTo: r.delegatedTo,
        delegatedBy: r.delegatedBy,
        note: r.note,
        firstSentAt: r.createdAt.toISOString(),
        lastSentAt: r.lastSentAt.toISOString(),
        sendCount: r.sendCount,
        resent: r.sendCount > 1,
        waitingDays: daysSince(r.lastSentAt),
        stage: p?.stage ?? 'sent',
        stageLabel: p?.label ?? 'No action yet',
        complete: p?.complete ?? false,
        scheduledAt: p?.scheduledAt ?? null,
      };
    });

    // A roll-up per interviewer, so the board reads as "who owes what".
    const byDelegate = new Map<string, (typeof items)[number][]>();
    for (const i of items) {
      const list = byDelegate.get(i.delegatedTo.id) ?? [];
      list.push(i);
      byDelegate.set(i.delegatedTo.id, list);
    }

    return {
      total: items.length,
      waiting: items.filter((i) => i.stage === 'sent').length,
      inProgress: items.filter(
        (i) => i.stage === 'scheduled' || i.stage === 'interviewed',
      ).length,
      done: items.filter((i) => i.complete).length,
      delegates: [...byDelegate.entries()].map(([id, list]) => ({
        delegate: list[0].delegatedTo,
        holds: list.length,
        waiting: list.filter((i) => i.stage === 'sent').length,
        done: list.filter((i) => i.complete).length,
        oldestWaitingDays: list
          .filter((i) => i.stage === 'sent')
          .reduce((max, i) => Math.max(max, i.waitingDays), 0),
        candidates: list,
        delegateId: id,
      })),
      items,
    };
  }

  /** Any recruitment-side role. Used where the answer names people, not data. */
  private async requireAnyRecruitmentRole(userId: string): Promise<void> {
    if (await this.permissions.isSuperUser(userId)) return;
    const perms = await this.permissions.getUserPermissions(userId);
    const ok = perms.roles.some((r) =>
      ['corporate_hr', 'chro', 'corporate_recruiter'].includes(r.key),
    );
    if (!ok) {
      throw new ForbiddenException(
        'Only Head of Talent Acquisition, CHRO, a recruiter or a super user can see interviewer workload',
      );
    }
  }

  /** Candidates handed to me — the delegate's own worklist. */
  async myDelegatedCandidates(userId: string) {
    const rows = await this.prisma.interviewDelegation.findMany({
      where: { delegatedToId: userId, revokedAt: null },
      include: {
        candidate: {
          include: {
            interviews: {
              // Oldest first, so the board can take the newest first round
              // as the one that stands after a no-show is rebooked.
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                kind: true,
                status: true,
                scheduledAt: true,
                mode: true,
                location: true,
                meetLink: true,
                _count: { select: { panelists: true } },
              },
            },
            rejectedBy: { select: { name: true } },
            interviewDelegations: {
              where: { revokedAt: null },
              select: {
                delegatedToId: true,
                delegatedTo: { select: { name: true } },
              },
            },
          },
        },
        requisition: {
          select: {
            id: true,
            code: true,
            designation: true,
            unitFactory: true,
            department: true,
          },
        },
        delegatedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // One query for the whole board rather than one dialog at a time: an
    // interviewer needs to know whether the marks are in *before* deciding
    // which candidate to call first.
    const fixations = rows.length
      ? await this.prisma.salaryFixation.findMany({
          where: { candidateId: { in: rows.map((r) => r.candidate.id) } },
          select: {
            candidateId: true,
            writtenTestEnabled: true,
            writtenTestTotal: true,
            writtenTestObtained: true,
            computerTestEnabled: true,
            computerTestTotal: true,
            computerTestObtained: true,
            aiTestEnabled: true,
            aiTestTotal: true,
            aiTestObtained: true,
          },
        })
      : [];
    const screening = await this.settings.getScreeningConfig();
    const byCandidate = new Map(fixations.map((f) => [f.candidateId, f]));

    const entry = (
      key: string,
      label: string,
      enabled: boolean,
      total: number | null,
      obtained: number | null,
      passPct: number,
    ) => {
      if (!enabled) return null;
      const scored = total != null && total > 0 && obtained != null;
      return {
        key,
        label,
        total,
        obtained,
        // Null means "not marked yet", which is not the same as failing.
        passed: scored ? (obtained / total) * 100 >= passPct : null,
      };
    };

    /** Enabled tests only, each marked pending / passed / failed. */
    const testsFor = (candidateId: string) => {
      const f = byCandidate.get(candidateId);
      if (!f) return [];
      return [
        entry(
          'written',
          'Written',
          f.writtenTestEnabled,
          f.writtenTestTotal,
          f.writtenTestObtained,
          screening.writtenTestPassPct,
        ),
        entry(
          'computer',
          'Computer literacy',
          f.computerTestEnabled,
          f.computerTestTotal,
          f.computerTestObtained,
          screening.computerTestPassPct,
        ),
        entry(
          'ai',
          'AI proficiency',
          f.aiTestEnabled,
          f.aiTestTotal,
          f.aiTestObtained,
          screening.aiTestPassPct,
        ),
      ].filter((t): t is NonNullable<typeof t> => t !== null);
    };

    return rows.map((r) => ({
      id: r.id,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      delegatedBy: r.delegatedBy,
      requisition: r.requisition,
      // Everyone else this candidate was handed to, so two interviewers don't
      // unknowingly arrange competing sessions.
      alsoAssignedTo: r.candidate.interviewDelegations
        .filter((d) => d.delegatedToId !== userId)
        .map((d) => d.delegatedTo.name),
      candidate: {
        id: r.candidate.id,
        name: r.candidate.name,
        email: r.candidate.email,
        phone: r.candidate.phone,
        stage: r.candidate.stage.toLowerCase(),
        cvUrl:
          this.files.url(r.candidate.cvFileId, 'cv', {
            filename: `${r.candidate.name} — CV`,
          }) ?? r.candidate.cvUrl,
        rejectedAt: r.candidate.rejectedAt?.toISOString() ?? null,
        rejectionStage: r.candidate.rejectionStage,
        rejectionReason: r.candidate.rejectionReason,
        rejectedByName: r.candidate.rejectedBy?.name ?? null,
        // What they earn now and want, as told to whoever interviewed them.
        // Shown on the card so the interviewer can see at a glance whether
        // anybody has asked yet.
        presentSalary: r.candidate.presentSalary,
        salaryExpectation: r.candidate.salaryExpectation,
        salaryBenefitsNote: r.candidate.salaryBenefitsNote,
        salaryBenefits: r.candidate.salaryBenefits,
        /** Where they are picked up from, if transport comes with the post. */
        transportPickup: r.candidate.transportPickup,
      },
      // So the worklist can show "not scheduled yet" versus an existing round.
      rounds: r.candidate.interviews.map((i) => ({
        id: i.id,
        kind: i.kind.toLowerCase(),
        status: i.status.toLowerCase(),
        scheduledAt: i.scheduledAt?.toISOString() ?? null,
        // A date alone does not tell an interviewer whether the session is
        // actually ready — where it is and who is on the panel does.
        mode: i.mode.toLowerCase(),
        location: i.location,
        online: Boolean(i.meetLink),
        panelists: i._count.panelists,
      })),
      tests: testsFor(r.candidate.id),
    }));
  }

  private async loadCandidate(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: {
        requisition: {
          select: {
            ...PANEL_REQ_SELECT,
            recruiterId: true,
            coverRecruiterId: true,
            coverUntil: true,
          },
        },
      },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireInterviewAccess(cand.id, cand.requisition, userId);
    return cand;
  }

  private async requireReq(reqId: string, userId: string) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
      select: {
        unitFactory: true,
        recruiterId: true,
        coverRecruiterId: true,
        coverUntil: true,
      },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    await this.requireRecruitmentAccess(req, userId);
  }

  /**
   * Post-approval work is Head of Talent Acquisition / CHRO / super — plus the Corporate
   * Recruiter assigned to this requisition. Takes the requisition (not just
   * its unit) so the assigned recruiter is always considered.
   */
  private async requireRecruitmentAccess(
    req: RecruitmentSubject,
    userId: string,
  ) {
    await this.permissions.requireRecruitmentAccess(
      userId,
      req.unitFactory,
      req.recruiterId,
      'manage interviews',
      // Whoever is standing in while the recruiter is on leave.
      { userId: req.coverRecruiterId, until: req.coverUntil },
    );
  }

  /** True when this candidate was delegated to this user and not revoked. */
  private async hasDelegation(
    candidateId: string,
    userId: string,
  ): Promise<boolean> {
    return this.permissions.hasInterviewDelegation(userId, { candidateId });
  }

  /**
   * May this user run this candidate's interviews?
   *
   * Head of Talent Acquisition / CHRO / super / the assigned recruiter as before, plus
   * anyone the recruiter delegated this specific candidate to. The delegation
   * is per candidate on purpose: it must not open the rest of the unit.
   */
  private async requireInterviewAccess(
    candidateId: string,
    req: RecruitmentSubject,
    userId: string,
  ): Promise<void> {
    if (await this.hasDelegation(candidateId, userId)) return;
    await this.requireRecruitmentAccess(req, userId);
  }
}

/**
 * The mirror of the rule in update(): marks mean the candidate attended, so a
 * round recorded absent takes none — the emailed links outlive the absence.
 */
const ABSENT_NO_MARKS =
  'This candidate was recorded absent for this interview, so there is nothing to mark. Ask whoever ran it to undo the absence if they did attend.';

function serializeRound(r: RoundFull) {
  const evaluated = new Set(r.evaluations.map((e) => e.evaluatorId));
  const tokenMap = new Map(
    r.evaluationTokens.map((t) => [t.panelistUserId, t]),
  );
  return {
    id: r.id,
    candidateId: r.candidateId,
    candidateName: r.candidate.name,
    kind: r.kind.toLowerCase(),
    mode: r.mode.toLowerCase(),
    scheduledAt: r.scheduledAt?.toISOString() ?? null,
    location: r.location ?? '',
    status: r.status.toLowerCase(),
    meetLink: r.meetLink ?? null,
    calendarSynced: Boolean(r.calendarEventId),
    criteria: EVALUATION_CRITERIA,
    panelists: r.panelists.map((p) => {
      const tok = tokenMap.get(p.userId);
      return {
        id: p.id,
        userId: p.userId,
        name: p.user.name,
        designation: p.user.employee?.designation ?? null,
        hasMarked: evaluated.has(p.userId),
        tokenStatus: tok?.status ?? null,
        evalLink: tok?.token ? evalLink(tok.token) : null,
      };
    }),
    evaluations: r.evaluations.map((e) => ({
      evaluatorId: e.evaluatorId,
      evaluatorName: e.evaluator.name,
      scores: e.scores as Record<string, number>,
      total: e.total,
      comments: e.comments ?? '',
      // Null on everything submitted before this was asked for — the UI shows
      // nothing rather than inventing a verdict nobody gave.
      recommendation: fromRecommendation(e.recommendation),
    })),
    evaluationCount: r.evaluations.length,
  };
}

function evalLink(token: string): string {
  const base = process.env.FRONTEND_URL || 'http://localhost:3000';
  return `${base}/evaluate/${token}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A person carrying nothing — still returned, so the picker shows a zero. */
function emptyWorkload(userId: string) {
  return {
    userId,
    holds: 0,
    waiting: 0,
    inProgress: 0,
    done: 0,
    oldestWaitingDays: 0,
    resent: 0,
  };
}
