import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
        panelists: {
          create: [...new Set(dto.panelistUserIds)].map((uid) => ({
            userId: uid,
          })),
        },
      },
      include: roundInclude,
    });

    // Advance the candidate to the Interview stage if they haven't passed it yet.
    const PRE_INTERVIEW: string[] = ['APPLIED', 'AI_SHORTLISTED', 'SHORTLISTED'];
    if (PRE_INTERVIEW.includes(cand.stage)) {
      await this.prisma.candidate.update({
        where: { id: cand.id },
        data: { stage: 'INTERVIEW' },
      });
    }

    // Best-effort Google Calendar event (+ Meet link for online interviews):
    // invites land in panelists' and the candidate's own calendars.
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
    return serializeRound(round);
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
      },
    });
    if (!round) throw new NotFoundException('Interview not found');
    await this.requireRecruitmentAccess(round.requisition.unitFactory, userId);

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
        ...(dto.panelistUserIds
          ? {
              panelists: {
                deleteMany: {},
                create: [...new Set(dto.panelistUserIds)].map((uid) => ({
                  userId: uid,
                })),
              },
            }
          : {}),
      },
    });
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

    // Marks are final once submitted — a panelist cannot change them afterwards.
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
    this.notifications.broadcastChange('candidate', round.requisitionId, {
      action: 'evaluation_submitted',
    });
    return this.myInterviews(userId);
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
      return { sent: 0, total: round.panelists.length, note: 'Mail not configured' };
    }

    // Format questions grouped by category
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

    // Stamp the round so the UI can show "Questions sent" instead of the button.
    if (sent > 0) {
      await this.prisma.interviewRound.update({
        where: { id: roundId },
        data: { questionsSentAt: new Date() },
      });
    }

    return { sent, total: round.panelists.length };
  }

  // --- helpers -------------------------------------------------------------

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
        // Online rounds with no venue get the Meet link as their location.
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
    // No event yet (e.g. a time was added later) — create one now.
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

    // In-app notification for each panelist (committee member).
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

    // Email the candidate (if requested and an address is on file).
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
    panelists: r.panelists.map((p) => ({
      id: p.id,
      userId: p.userId,
      name: p.user.name,
      designation: p.user.employee?.designation ?? null,
      hasMarked: evaluated.has(p.userId),
    })),
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

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
