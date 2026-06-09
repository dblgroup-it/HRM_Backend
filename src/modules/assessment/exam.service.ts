import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssessmentType,
  ExamQuestionKind,
  Prisma,
  ExamAttempt,
  ExamQuestion,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { MailService } from '../integrations/mail/mail.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import {
  AddExamQuestionDto,
  CreateAttemptDto,
  SubmitExamDto,
  UpdateExamQuestionDto,
} from './dto/exam.dto';

export interface Grade {
  score: number;
  feedback: string;
}

@Injectable()
export class ExamService {
  private readonly logger = new Logger(ExamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly ai: AiGraderService,
    private readonly config: ConfigService,
  ) {}

  // --- question bank (HR) --------------------------------------------------

  async getBank(reqId: string, userId: string) {
    await this.requireReq(reqId, userId);
    const questions = await this.prisma.examQuestion.findMany({
      where: { requisitionId: reqId },
      orderBy: [{ examType: 'asc' }, { orderIndex: 'asc' }],
    });
    return {
      aiProvider: this.ai.isConfigured() ? this.ai.provider : null,
      questions: questions.map(serializeQuestion),
    };
  }

  async addQuestion(reqId: string, userId: string, dto: AddExamQuestionDto) {
    await this.requireReq(reqId, userId);
    const count = await this.prisma.examQuestion.count({
      where: { requisitionId: reqId, examType: examTypeOf(dto.examType) },
    });
    await this.prisma.examQuestion.create({
      data: {
        requisitionId: reqId,
        examType: examTypeOf(dto.examType),
        kind: dto.kind.toUpperCase() as ExamQuestionKind,
        prompt: dto.prompt.trim(),
        options: dto.options ? (dto.options as Prisma.InputJsonValue) : Prisma.DbNull,
        answer: dto.answer?.trim() || null,
        marks: dto.marks,
        orderIndex: count,
      },
    });
    return this.getBank(reqId, userId);
  }

  async updateQuestion(qid: string, userId: string, dto: UpdateExamQuestionDto) {
    const q = await this.prisma.examQuestion.findUnique({
      where: { id: qid },
      include: { requisition: { select: { unitFactory: true } } },
    });
    if (!q) throw new NotFoundException('Question not found');
    await this.requireRecruitmentAccess(q.requisition.unitFactory, userId);
    await this.prisma.examQuestion.update({
      where: { id: qid },
      data: {
        ...(dto.kind ? { kind: dto.kind.toUpperCase() as ExamQuestionKind } : {}),
        ...(dto.prompt !== undefined ? { prompt: dto.prompt.trim() } : {}),
        ...(dto.options !== undefined
          ? { options: dto.options as Prisma.InputJsonValue }
          : {}),
        ...(dto.answer !== undefined ? { answer: dto.answer.trim() || null } : {}),
        ...(dto.marks !== undefined ? { marks: dto.marks } : {}),
      },
    });
    return this.getBank(q.requisitionId, userId);
  }

  async removeQuestion(qid: string, userId: string) {
    const q = await this.prisma.examQuestion.findUnique({
      where: { id: qid },
      include: { requisition: { select: { unitFactory: true } } },
    });
    if (!q) throw new NotFoundException('Question not found');
    await this.requireRecruitmentAccess(q.requisition.unitFactory, userId);
    await this.prisma.examQuestion.delete({ where: { id: qid } });
    return this.getBank(q.requisitionId, userId);
  }

  // --- attempts (HR) -------------------------------------------------------

  async createAttempt(
    candidateId: string,
    actor: { id: string; name: string },
    dto: CreateAttemptDto,
  ) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: {
        requisition: { select: { id: true, unitFactory: true, designation: true } },
      },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, actor.id);

    const examType = examTypeOf(dto.examType);
    const questions = await this.prisma.examQuestion.findMany({
      where: { requisitionId: cand.requisitionId, examType },
    });
    if (questions.length === 0) {
      throw new BadRequestException(
        `Add ${dto.examType} questions to the bank before sending the exam`,
      );
    }
    const maxScore = questions.reduce((s, q) => s + q.marks, 0);
    const token = randomBytes(16).toString('hex');
    const attempt = await this.prisma.examAttempt.create({
      data: { candidateId, requisitionId: cand.requisitionId, examType, token, maxScore },
    });

    const link = this.examLink(token);
    if (dto.notifyCandidate && cand.email && this.mail.isConfigured()) {
      try {
        await this.mail.send({
          to: cand.email,
          subject: `Online ${dto.examType} exam — ${cand.requisition.designation} | DBL Group`,
          text: `Dear ${cand.name},\n\nPlease complete your online ${dto.examType} exam using the link below:\n\n${link}\n\nBest regards,\nDBL Group Recruitment`,
        });
      } catch (err) {
        this.logger.warn(`Exam email failed: ${(err as Error).message}`);
      }
    }
    this.notifications.broadcastChange('candidate', cand.requisitionId, {
      action: 'exam_created',
    });
    return { ...serializeAttempt(attempt), link };
  }

  async listAttempts(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: { select: { unitFactory: true } } },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(cand.requisition.unitFactory, userId);
    const attempts = await this.prisma.examAttempt.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      aiProvider: this.ai.isConfigured() ? this.ai.provider : null,
      attempts: attempts.map((a) => ({
        ...serializeAttempt(a),
        link: this.examLink(a.token),
        grades: (a.grades as Record<string, Grade> | null) ?? null,
      })),
    };
  }

  /** (Re)grade a submitted attempt's written answers with the AI provider. */
  async gradeWithAi(attemptId: string, userId: string) {
    const attempt = await this.prisma.examAttempt.findUnique({
      where: { id: attemptId },
      include: { requisition: { select: { unitFactory: true } } },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    await this.requireRecruitmentAccess(attempt.requisition.unitFactory, userId);
    if (!attempt.answers) throw new BadRequestException('Not submitted yet');
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI grading is not configured');
    }
    const result = await this.scoreAttempt(
      attempt.requisitionId,
      attempt.examType,
      attempt.answers as Record<string, string>,
    );
    await this.prisma.examAttempt.update({
      where: { id: attemptId },
      data: {
        grades: result.grades as unknown as Prisma.InputJsonValue,
        autoScore: result.autoScore,
        totalScore: result.total,
        status: result.allGraded ? 'graded' : 'submitted',
        gradedAt: new Date(),
      },
    });
    this.notifications.broadcastChange('candidate', attempt.requisitionId, {
      action: 'exam_graded',
    });
    return this.listAttempts(attempt.candidateId, userId);
  }

  // --- candidate (public, token) ------------------------------------------

  async getByToken(token: string) {
    const attempt = await this.prisma.examAttempt.findUnique({ where: { token } });
    if (!attempt) throw new NotFoundException('Exam not found');
    const [questions, cand, req] = await Promise.all([
      this.prisma.examQuestion.findMany({
        where: { requisitionId: attempt.requisitionId, examType: attempt.examType },
        orderBy: { orderIndex: 'asc' },
      }),
      this.prisma.candidate.findUnique({
        where: { id: attempt.candidateId },
        select: { name: true },
      }),
      this.prisma.requisition.findUnique({
        where: { id: attempt.requisitionId },
        select: { designation: true, code: true },
      }),
    ]);
    return {
      status: attempt.status,
      examType: attempt.examType.toLowerCase(),
      candidateName: cand?.name ?? '',
      designation: req?.designation ?? '',
      code: req?.code ?? '',
      // Never expose the correct answers to the candidate.
      questions: questions.map((q) => ({
        id: q.id,
        kind: q.kind.toLowerCase(),
        prompt: q.prompt,
        options: (q.options as string[] | null) ?? null,
        marks: q.marks,
      })),
    };
  }

  async submitByToken(token: string, dto: SubmitExamDto) {
    const attempt = await this.prisma.examAttempt.findUnique({ where: { token } });
    if (!attempt) throw new NotFoundException('Exam not found');
    if (attempt.status !== 'pending') {
      throw new BadRequestException('This exam has already been submitted');
    }
    const result = await this.scoreAttempt(
      attempt.requisitionId,
      attempt.examType,
      dto.answers,
    );
    await this.prisma.examAttempt.update({
      where: { id: attempt.id },
      data: {
        answers: dto.answers as unknown as Prisma.InputJsonValue,
        grades: result.grades as unknown as Prisma.InputJsonValue,
        autoScore: result.autoScore,
        totalScore: result.total,
        status: result.allGraded ? 'graded' : 'submitted',
        submittedAt: new Date(),
        gradedAt: result.allGraded ? new Date() : null,
      },
    });
    this.notifications.broadcastChange('candidate', attempt.requisitionId, {
      action: 'exam_submitted',
    });
    return { ok: true };
  }

  // --- scoring -------------------------------------------------------------

  private async scoreAttempt(
    reqId: string,
    examType: AssessmentType,
    answers: Record<string, string>,
  ) {
    const questions = await this.prisma.examQuestion.findMany({
      where: { requisitionId: reqId, examType },
      orderBy: { orderIndex: 'asc' },
    });
    const aiOn = this.ai.isConfigured();
    const grades: Record<string, Grade> = {};
    let autoScore = 0;
    let total = 0;
    let allGraded = true;

    for (const q of questions) {
      const ans = String(answers[q.id] ?? '').trim();
      if (q.kind === 'MCQ') {
        const correct = (q.answer ?? '').trim().toLowerCase();
        const score = ans && ans.toLowerCase() === correct ? q.marks : 0;
        grades[q.id] = { score, feedback: '' };
        autoScore += score;
        total += score;
      } else {
        // TEXT — AI grade when available, else leave for manual marking.
        if (!ans) {
          grades[q.id] = { score: 0, feedback: 'No answer given' };
          continue;
        }
        if (aiOn) {
          try {
            const r = await this.ai.grade({
              prompt: q.prompt,
              modelAnswer: q.answer,
              candidateAnswer: ans,
              maxMarks: q.marks,
            });
            grades[q.id] = { score: r.score, feedback: r.feedback };
            total += r.score;
          } catch {
            grades[q.id] = { score: 0, feedback: '' };
            allGraded = false;
          }
        } else {
          grades[q.id] = { score: 0, feedback: '' };
          allGraded = false;
        }
      }
    }
    return { grades, autoScore, total, allGraded };
  }

  // --- helpers -------------------------------------------------------------

  private examLink(token: string): string {
    const base = (this.config.get<string>('corsOrigin') ?? '').replace(/\/$/, '');
    return `${base}/exam/${token}`;
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
      (await this.permissions.hasRoleForUnitName(userId, 'corporate_hr', unit)) ||
      (await this.permissions.hasRoleForUnitName(userId, 'chro', unit));
    if (!ok) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can manage exams',
      );
    }
  }
}

function examTypeOf(t: string): AssessmentType {
  return t.toUpperCase() as AssessmentType;
}

function serializeQuestion(q: ExamQuestion) {
  return {
    id: q.id,
    examType: q.examType.toLowerCase(),
    kind: q.kind.toLowerCase(),
    prompt: q.prompt,
    options: (q.options as string[] | null) ?? null,
    answer: q.answer ?? '',
    marks: q.marks,
  };
}

function serializeAttempt(a: ExamAttempt) {
  return {
    id: a.id,
    examType: a.examType.toLowerCase(),
    token: a.token,
    status: a.status,
    autoScore: a.autoScore,
    totalScore: a.totalScore,
    maxScore: a.maxScore,
    submittedAt: a.submittedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}
