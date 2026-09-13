import { randomBytes } from 'node:crypto';

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
  InterviewKind,
  InterviewMode,
  InterviewStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
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
import {
  BulkScheduleInterviewDto,
  DelegationTestsDto,
  ScheduleInterviewDto,
  SubmitEvaluationDto,
  UpdateInterviewDto,
} from './dto/interview.dto';

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
    // conflicting invitations for the same round.
    const existingSameKind = await this.prisma.interviewRound.findFirst({
      where: {
        candidateId: cand.id,
        kind: dto.kind.toUpperCase() as InterviewKind,
        status: { not: 'CANCELLED' },
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

    await this.notifyScheduled(round, cand.requisition.designation, dto);
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

  async bulkSchedule(
    actor: { id: string; name: string },
    dto: BulkScheduleInterviewDto,
  ) {
    const results = await Promise.all(
      dto.candidateIds.map((candidateId, i) =>
        this.schedule(candidateId, actor, {
          kind: dto.kind,
          mode: dto.mode,
          scheduledAt: dto.scheduledAts?.[i],
          location: dto.location,
          panelistUserIds: dto.panelistUserIds,
          notifyCandidate: dto.notifyCandidate,
          notifyPanel: dto.notifyPanel,
        }),
      ),
    );
    return results;
  }

  async update(roundId: string, userId: string, dto: UpdateInterviewDto) {
    const round = await this.prisma.interviewRound.findUnique({
      where: { id: roundId },
      include: {
        requisition: {
          select: { unitFactory: true, designation: true, recruiterId: true },
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
        const newExpiry = new Date(newDate.getTime() + 48 * 60 * 60 * 1000);
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
        requisition: { select: { unitFactory: true, recruiterId: true } },
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
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
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
          cvUrl: r.candidate.cvUrl,
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
  async getEvalByToken(token: string) {
    const et = await this.prisma.evaluationToken.findUnique({
      where: { token },
      include: {
        round: {
          include: {
            // The CV goes with the marks: a panelist scoring someone needs to
            // read their background, and on the token path they have no other
            // way in — there is no login and no candidate page for them.
            candidate: { select: { name: true, cvUrl: true } },
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
      },
    });

    return {
      status: et.status,
      alreadySubmitted: !!existingEval,
      panelistName: et.panelistUser.name,
      candidate: {
        name: et.round.candidate.name,
        cvUrl: et.round.candidate.cvUrl,
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
          }
        : null,
    };
  }

  /** Public: submit marks via a one-click token (no login). */
  async submitEvalByToken(token: string, dto: SubmitEvaluationDto) {
    const et = await this.prisma.evaluationToken.findUnique({
      where: { token },
      include: { round: { select: { id: true, requisitionId: true } } },
    });

    if (!et) throw new NotFoundException('Evaluation link not found');
    if (et.expiresAt < new Date()) {
      throw new GoneException(
        'This evaluation link has expired. Please contact HR.',
      );
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
        requisition: { select: { unitFactory: true, recruiterId: true } },
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
    const expiresAt = round.scheduledAt
      ? new Date(round.scheduledAt.getTime() + 48 * 60 * 60 * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

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
    const expiresAt = scheduledAt
      ? new Date(scheduledAt.getTime() + 48 * 60 * 60 * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

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
    designation: string,
    dto: ScheduleInterviewDto,
  ) {
    const when = round.scheduledAt
      ? new Date(round.scheduledAt).toLocaleString('en-GB', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : 'a time to be confirmed';
    const kindLabel = round.kind.toLowerCase();
    const modeLabel = round.mode.toLowerCase();

    if (dto.notifyPanel !== false) {
      await this.notifications.notifyMany(
        round.panelists.map((p) => p.userId),
        {
          type: 'interview_assigned',
          title: 'Interview to conduct',
          message: `${round.candidate.name} · ${designation} — ${kindLabel} interview on ${when}.`,
          link: '/my-interviews',
        },
      );
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
          // Re-sending a previously revoked delegation restores it.
          update: {
            revokedAt: null,
            delegatedById: actor.id,
            note: note?.trim() || null,
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
        requisition: { select: { unitFactory: true, recruiterId: true } },
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
    return rows.map((r) => ({
      id: r.id,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      delegatedTo: r.delegatedTo,
      delegatedBy: r.delegatedBy,
    }));
  }

  /** Candidates handed to me — the delegate's own worklist. */
  async myDelegatedCandidates(userId: string) {
    const rows = await this.prisma.interviewDelegation.findMany({
      where: { delegatedToId: userId, revokedAt: null },
      include: {
        candidate: {
          include: {
            interviews: {
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
        cvUrl: r.candidate.cvUrl,
        rejectedAt: r.candidate.rejectedAt?.toISOString() ?? null,
        rejectionStage: r.candidate.rejectionStage,
        rejectionReason: r.candidate.rejectionReason,
        rejectedByName: r.candidate.rejectedBy?.name ?? null,
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
          select: { unitFactory: true, designation: true, recruiterId: true },
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
      select: { unitFactory: true, recruiterId: true },
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
    req: { unitFactory: string; recruiterId: string | null },
    userId: string,
  ) {
    await this.permissions.requireRecruitmentAccess(
      userId,
      req.unitFactory,
      req.recruiterId,
      'manage interviews',
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
    req: { unitFactory: string; recruiterId: string | null },
    userId: string,
  ): Promise<void> {
    if (await this.hasDelegation(candidateId, userId)) return;
    await this.requireRecruitmentAccess(req, userId);
  }
}

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
        evalLink: tok ? evalLink(tok.token) : null,
      };
    }),
    evaluations: r.evaluations.map((e) => ({
      evaluatorId: e.evaluatorId,
      evaluatorName: e.evaluator.name,
      scores: e.scores as Record<string, number>,
      total: e.total,
      comments: e.comments ?? '',
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
