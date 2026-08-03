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
import { NotificationsService } from '../realtime/notifications.service';
import { MailService } from '../integrations/mail/mail.service';
import {
  CalendarService,
  type CalendarEventInput,
} from '../integrations/google/calendar.service';
import {
  BulkScheduleInterviewDto,
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
        requisition: { select: { unitFactory: true, designation: true } },
        panelists: { select: { userId: true } },
      },
    });
    if (!round) throw new NotFoundException('Interview not found');
    await this.requireRecruitmentAccess(round.requisition.unitFactory, userId);

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
      include: { requisition: { select: { unitFactory: true } } },
    });
    if (!round) throw new NotFoundException('Interview not found');
    await this.requireRecruitmentAccess(round.requisition.unitFactory, userId);
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
          select: { id: true, name: true, email: true, phone: true },
        },
        requisition: {
          select: {
            id: true,
            code: true,
            designation: true,
            unitFactory: true,
            rubricCriteria: true,
            interviewQuestions: true,
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
        },
        requisition: {
          id: r.requisition.id,
          code: r.requisition.code,
          designation: r.requisition.designation,
          unit: r.requisition.unitFactory,
        },
        rubric: [...r.requisition.rubricCriteria]
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((c) => ({ id: c.id, label: c.label, maxScore: c.maxScore })),
        interviewQuestions: Array.isArray(r.requisition.interviewQuestions)
          ? (r.requisition.interviewQuestions as {
              category: string;
              question: string;
            }[])
          : [],
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

  /** A panelist submits / updates their rubric marks for a candidate. */
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

    const criteria = await this.prisma.rubricCriterion.findMany({
      where: { requisitionId: round.requisitionId },
    });
    const cleanScores: Record<string, number> = {};
    let total = 0;
    for (const c of criteria) {
      const raw = Number(dto.scores?.[c.id] ?? 0);
      const score = Number.isFinite(raw)
        ? Math.max(0, Math.min(c.maxScore, Math.round(raw)))
        : 0;
      cleanScores[c.id] = score;
      total += score;
    }

    await this.prisma.evaluation.create({
      data: {
        roundId,
        evaluatorId: userId,
        scores: cleanScores,
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
            candidate: { select: { name: true } },
            requisition: {
              select: {
                designation: true,
                unitFactory: true,
                rubricCriteria: true,
                interviewQuestions: true,
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
      select: { scores: true, comments: true, total: true },
    });

    const rubric = [...et.round.requisition.rubricCriteria]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((c) => ({ id: c.id, label: c.label, maxScore: c.maxScore }));

    const questions = Array.isArray(et.round.requisition.interviewQuestions)
      ? (et.round.requisition.interviewQuestions as {
          category: string;
          question: string;
        }[])
      : [];

    return {
      status: et.status,
      alreadySubmitted: !!existingEval,
      panelistName: et.panelistUser.name,
      candidate: { name: et.round.candidate.name },
      interview: {
        kind: et.round.kind.toLowerCase(),
        mode: et.round.mode.toLowerCase(),
        scheduledAt: et.round.scheduledAt?.toISOString() ?? null,
        location: et.round.location ?? '',
        designation: et.round.requisition.designation,
        unit: et.round.requisition.unitFactory,
      },
      rubric,
      interviewQuestions: questions,
      submittedEval: existingEval
        ? {
            scores: existingEval.scores as Record<string, number>,
            comments: existingEval.comments ?? '',
            total: existingEval.total,
          }
        : null,
    };
  }

  /** Public: submit rubric marks via a one-click token (no login). */
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

    const criteria = await this.prisma.rubricCriterion.findMany({
      where: { requisitionId: et.round.requisitionId },
    });
    const cleanScores: Record<string, number> = {};
    let total = 0;
    for (const c of criteria) {
      const raw = Number(dto.scores?.[c.id] ?? 0);
      const score = Number.isFinite(raw)
        ? Math.max(0, Math.min(c.maxScore, Math.round(raw)))
        : 0;
      cleanScores[c.id] = score;
      total += score;
    }

    await this.prisma.$transaction([
      this.prisma.evaluation.create({
        data: {
          roundId: et.roundId,
          evaluatorId: et.panelistUserId,
          scores: cleanScores,
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
        requisition: { select: { unitFactory: true } },
        panelists: { select: { userId: true } },
      },
    });
    if (!round) throw new NotFoundException('Interview not found');
    await this.requireRecruitmentAccess(round.requisition.unitFactory, actorId);

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

  // --- send interview questions to panelists --------------------------------

  async sendQuestions(roundId: string, userId: string) {
    const round = await this.prisma.interviewRound.findUnique({
      where: { id: roundId },
      include: {
        panelists: { include: { user: true } },
        requisition: {
          select: {
            interviewQuestions: true,
            designation: true,
            unitFactory: true,
          },
        },
      },
    });
    if (!round) throw new NotFoundException('Interview not found');
    await this.requireRecruitmentAccess(round.requisition.unitFactory, userId);

    const questions = Array.isArray(round.requisition.interviewQuestions)
      ? (round.requisition.interviewQuestions as {
          category: string;
          question: string;
        }[])
      : [];

    if (questions.length === 0) {
      throw new BadRequestException(
        'No interview questions have been generated for this requisition yet',
      );
    }

    if (!this.mail.isConfigured()) {
      return {
        sent: 0,
        total: round.panelists.length,
        note: 'Mail not configured',
      };
    }

    const grouped = new Map<string, string[]>();
    for (const q of questions) {
      const arr = grouped.get(q.category) ?? [];
      arr.push(q.question);
      grouped.set(q.category, arr);
    }
    const body = [...grouped.entries()]
      .map(
        ([cat, qs]) =>
          `${cat}\n${qs.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}`,
      )
      .join('\n\n');

    let sent = 0;
    for (const p of round.panelists) {
      if (!p.user.email) continue;
      try {
        await this.mail.send({
          to: p.user.email,
          subject: `Interview Questions — ${round.requisition.designation} | DBL Group`,
          text: [
            `Dear ${p.user.name},`,
            '',
            `Here are the ${cap(round.kind.toLowerCase())} interview questions for the ${round.requisition.designation} position:`,
            '',
            body,
            '',
            'Please review these before the interview.',
            '',
            'Best regards,',
            'DBL Group Recruitment',
          ].join('\n'),
        });
        sent++;
      } catch (err) {
        this.logger.warn(
          `Failed to send questions to ${p.user.email}: ${(err as Error).message}`,
        );
      }
    }

    if (sent > 0) {
      await this.prisma.interviewRound.update({
        where: { id: roundId },
        data: { questionsSentAt: new Date() },
      });
    }

    return { sent, total: round.panelists.length };
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

  private async loadCandidate(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: {
        requisition: { select: { unitFactory: true, designation: true } },
      },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);
    return cand;
  }

  private async requireReq(reqId: string, userId: string) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
      select: { unitFactory: true },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    await this.requireRecruitmentAccess(req.unitFactory, userId);
  }

  private async requireRecruitmentAccess(unit: string, userId: string) {
    const ok =
      (await this.permissions.hasRoleForUnitName(
        userId,
        'corporate_hr',
        unit,
      )) || (await this.permissions.hasRoleForUnitName(userId, 'chro', unit));
    if (!ok) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can manage interviews',
      );
    }
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
    questionsSentAt: r.questionsSentAt?.toISOString() ?? null,
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
