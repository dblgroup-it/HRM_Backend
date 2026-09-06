import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { MailService } from '../integrations/mail/mail.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import { SalaryFixationService } from '../salary-fixation/salary-fixation.service';
import { NotificationsService } from '../realtime/notifications.service';
import {
  AddQuestionDto,
  AssignTestDto,
  BulkAddQuestionsDto,
  BulkDeleteQuestionsDto,
  GenerateQuestionsDto,
  RecordViolationDto,
  SubmitAiProficiencyDto,
  UpdateQuestionDto,
} from './dto/ai-proficiency.dto';

const PAGE_SIZE = 20;
/** HR may re-issue a fresh (reshuffled) test up to this many times per candidate — e.g. after a fail. */
const MAX_ATTEMPTS = 3;

@Injectable()
export class AiProficiencyService {
  private readonly logger = new Logger(AiProficiencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly mail: MailService,
    private readonly salaryFixation: SalaryFixationService,
    private readonly config: ConfigService,
    private readonly aiGrader: AiGraderService,
    private readonly notifications: NotificationsService,
  ) {}

  // --- global question bank (admin/HR) -------------------------------------

  async getBank(userId: string, opts: { search?: string; grade?: string; page?: number }) {
    await this.requireRecruitmentRole(userId);
    const page = Math.max(1, opts.page ?? 1);
    const where = {
      ...(opts.search ? { prompt: { contains: opts.search, mode: 'insensitive' as const } } : {}),
      ...(opts.grade ? { grades: { has: opts.grade } } : {}),
    };
    const [total, questions] = await Promise.all([
      this.prisma.aiProficiencyQuestion.count({ where }),
      this.prisma.aiProficiencyQuestion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return {
      questions: questions.map(serializeQuestion),
      meta: { total, page, pageSize: PAGE_SIZE, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) },
    };
  }

  async addQuestion(userId: string, dto: AddQuestionDto) {
    await this.requireRecruitmentRole(userId);
    const q = await this.prisma.aiProficiencyQuestion.create({
      data: {
        prompt: dto.prompt.trim(),
        options: dto.options,
        answer: dto.answer.trim(),
        marks: dto.marks ?? 1,
        grades: dto.grades,
      },
    });
    return serializeQuestion(q);
  }

  /** AI-generate a batch of candidate questions for review — nothing is saved yet. */
  async generateQuestions(userId: string, dto: GenerateQuestionsDto) {
    await this.requireRecruitmentRole(userId);
    const items = await this.aiGrader.generateProficiencyQuestions({
      grade: dto.grade,
      count: dto.count,
      topic: dto.topic,
    });
    if (items.length === 0) {
      throw new BadRequestException(
        'The AI did not return any usable questions — try again or lower the count.',
      );
    }
    return { items: items.map((q) => ({ ...q, grades: [dto.grade] })) };
  }

  /** Persist a batch of (typically AI-generated, HR-reviewed) questions in one go. */
  async bulkAddQuestions(userId: string, dto: BulkAddQuestionsDto) {
    await this.requireRecruitmentRole(userId);
    const created = await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.aiProficiencyQuestion.create({
          data: {
            prompt: item.prompt.trim(),
            options: item.options,
            answer: item.answer.trim(),
            marks: item.marks ?? 1,
            grades: item.grades,
          },
        }),
      ),
    );
    return { questions: created.map(serializeQuestion), count: created.length };
  }

  async updateQuestion(userId: string, id: string, dto: UpdateQuestionDto) {
    await this.requireRecruitmentRole(userId);
    const q = await this.prisma.aiProficiencyQuestion.update({
      where: { id },
      data: {
        ...(dto.prompt !== undefined ? { prompt: dto.prompt.trim() } : {}),
        ...(dto.options !== undefined ? { options: dto.options } : {}),
        ...(dto.answer !== undefined ? { answer: dto.answer.trim() } : {}),
        ...(dto.marks !== undefined ? { marks: dto.marks } : {}),
        ...(dto.grades !== undefined ? { grades: dto.grades } : {}),
      },
    });
    return serializeQuestion(q);
  }

  async removeQuestion(userId: string, id: string) {
    await this.requireRecruitmentRole(userId);
    await this.prisma.aiProficiencyQuestion.delete({ where: { id } });
    return { ok: true };
  }

  async bulkRemoveQuestions(userId: string, dto: BulkDeleteQuestionsDto) {
    await this.requireRecruitmentRole(userId);
    const { count } = await this.prisma.aiProficiencyQuestion.deleteMany({
      where: { id: { in: dto.ids } },
    });
    return { ok: true, count };
  }

  // --- per-candidate assignment (HR) ---------------------------------------

  async getStatus(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const attempts = await this.prisma.aiProficiencyAttempt.findMany({
      where: { candidateId: cand.id },
      orderBy: { createdAt: 'desc' },
    });
    if (attempts.length === 0) return null;
    return serializeAttempt(attempts[0], this.publicLink(attempts[0].token), attempts.length);
  }

  /** Per-question breakdown of the latest submitted attempt — what HR sees
   * when they want to know *why* a candidate scored what they scored. */
  async getReview(candidateId: string, userId: string) {
    const cand = await this.requireCandidate(candidateId, userId);
    const attempts = await this.prisma.aiProficiencyAttempt.findMany({
      where: { candidateId: cand.id },
      orderBy: { createdAt: 'desc' },
    });
    const latest = attempts[0];
    if (!latest || latest.status !== 'submitted') {
      throw new BadRequestException('No submitted attempt to review yet.');
    }

    const questions = await this.prisma.aiProficiencyQuestion.findMany({
      where: { id: { in: latest.questionIds } },
      select: { id: true, prompt: true, options: true, marks: true, answer: true },
    });
    const byId = new Map(questions.map((q) => [q.id, q]));
    const answers = (latest.answers as Record<string, string> | null) ?? {};
    const ordered = latest.questionIds
      .map((id) => byId.get(id))
      .filter((q): q is NonNullable<typeof q> => Boolean(q));

    return {
      jobGrade: latest.jobGrade,
      submittedAt: latest.submittedAt?.toISOString() ?? null,
      totalScore: latest.totalScore,
      maxScore: latest.maxScore,
      terminationReason: latest.terminationReason,
      violations:
        (latest.violations as { leftAt: string; returnedAt: string | null; endedTest: boolean }[] | null) ?? [],
      questions: ordered.map((q) => {
        const given = answers[q.id] ?? null;
        const isCorrect = given != null && given.trim().toLowerCase() === q.answer.trim().toLowerCase();
        return {
          id: q.id,
          prompt: q.prompt,
          options: q.options as string[],
          marks: q.marks,
          correctAnswer: q.answer,
          candidateAnswer: given,
          isCorrect,
        };
      }),
    };
  }

  async assignTest(candidateId: string, userId: string, dto: AssignTestDto) {
    const cand = await this.requireCandidate(candidateId, userId);

    const attempts = await this.prisma.aiProficiencyAttempt.findMany({
      where: { candidateId: cand.id },
      orderBy: { createdAt: 'desc' },
    });
    const latest = attempts[0];
    if (latest?.status === 'pending') {
      throw new BadRequestException(
        'A test link is already pending for this candidate — share the existing link or wait for it to be submitted.',
      );
    }
    if (attempts.length >= MAX_ATTEMPTS) {
      throw new BadRequestException(
        `This candidate has already used the maximum of ${MAX_ATTEMPTS} attempts.`,
      );
    }

    const pool = await this.prisma.aiProficiencyQuestion.findMany({
      where: { grades: { has: dto.jobGrade } },
      select: { id: true, marks: true },
    });
    if (pool.length === 0) {
      throw new BadRequestException(
        `No questions in the bank are tagged for grade ${dto.jobGrade} yet.`,
      );
    }

    const shuffled = shuffle([...pool]).slice(0, dto.questionCount);
    const maxScore = shuffled.reduce((sum, q) => sum + q.marks, 0);
    const token = randomBytes(16).toString('hex');

    const attempt = await this.prisma.aiProficiencyAttempt.create({
      data: {
        candidateId: cand.id,
        token,
        jobGrade: dto.jobGrade,
        questionIds: shuffled.map((q) => q.id),
        maxScore,
        timeLimitMinutes: dto.timeLimitMinutes ?? null,
      },
    });

    // First point in the pipeline a job grade is known — preset it so
    // Salary Fixation doesn't ask again later.
    await this.salaryFixation.presetJobGrade(cand.id, dto.jobGrade);

    const link = this.publicLink(token);
    if (dto.notifyCandidate && cand.email && this.mail.isConfigured()) {
      try {
        await this.mail.send({
          to: cand.email,
          subject: `Online screening test — ${cand.requisition.designation} | DBL Group`,
          text: `Dear ${cand.name},\n\nPlease complete your online screening test using the link below:\n\n${link}\n\nBest regards,\nDBL Group Recruitment`,
        });
      } catch (err) {
        this.logger.warn(`AI Proficiency Test email failed: ${(err as Error).message}`);
      }
    }

    return serializeAttempt(attempt, link, attempts.length + 1);
  }

  // --- candidate (public, token) -------------------------------------------

  async getByToken(token: string) {
    const attempt = await this.prisma.aiProficiencyAttempt.findUnique({
      where: { token },
    });
    if (!attempt) throw new NotFoundException('Test link not found');

    const questions = await this.prisma.aiProficiencyQuestion.findMany({
      where: { id: { in: attempt.questionIds } },
      select: { id: true, prompt: true, options: true, marks: true },
    });
    const byId = new Map(questions.map((q) => [q.id, q]));
    const ordered = attempt.questionIds
      .map((id) => byId.get(id))
      .filter((q): q is NonNullable<typeof q> => Boolean(q));

    return {
      status: attempt.status,
      alreadySubmitted: attempt.status === 'submitted',
      questions: ordered.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        options: q.options as string[],
        marks: q.marks,
      })),
      totalScore: attempt.totalScore,
      maxScore: attempt.maxScore,
      timeLimitMinutes: attempt.timeLimitMinutes,
      startedAt: attempt.startedAt?.toISOString() ?? null,
      // So a page refresh mid-test doesn't reset the violation count the
      // frontend enforces against — the server is the source of truth.
      violationCount: ((attempt.violations as unknown[] | null) ?? []).length,
    };
  }

  /**
   * Candidate clicks "Start Test" — this is what actually begins the
   * countdown (not just opening the link), so time isn't burned while they
   * read the instructions or leave the tab open unattended. Idempotent: a
   * page refresh mid-test calls this again but the stamp only happens once.
   */
  async startAttempt(token: string) {
    const attempt = await this.prisma.aiProficiencyAttempt.findUnique({
      where: { token },
    });
    if (!attempt) throw new NotFoundException('Test link not found');
    if (attempt.status !== 'pending') {
      throw new GoneException('This test has already been submitted.');
    }
    if (attempt.startedAt) {
      return { startedAt: attempt.startedAt.toISOString() };
    }
    const updated = await this.prisma.aiProficiencyAttempt.update({
      where: { id: attempt.id },
      data: { startedAt: new Date() },
    });
    return { startedAt: updated.startedAt!.toISOString() };
  }

  async submitByToken(token: string, dto: SubmitAiProficiencyDto) {
    const attempt = await this.prisma.aiProficiencyAttempt.findUnique({
      where: { token },
    });
    if (!attempt) throw new NotFoundException('Test link not found');
    if (attempt.status !== 'pending') {
      throw new GoneException('This test has already been submitted.');
    }

    const questions = await this.prisma.aiProficiencyQuestion.findMany({
      where: { id: { in: attempt.questionIds } },
      select: { id: true, answer: true, marks: true },
    });
    let totalScore = 0;
    for (const q of questions) {
      const given = dto.answers?.[q.id];
      if (
        typeof given === 'string' &&
        given.trim().toLowerCase() === q.answer.trim().toLowerCase()
      ) {
        totalScore += q.marks;
      }
    }

    await this.prisma.aiProficiencyAttempt.update({
      where: { id: attempt.id },
      data: {
        answers: dto.answers,
        totalScore,
        status: 'submitted',
        submittedAt: new Date(),
        terminationReason: dto.reason ?? 'candidate',
      },
    });

    await this.salaryFixation.recordAiProficiencyResult(attempt.candidateId, {
      maxScore: attempt.maxScore,
      totalScore,
    });

    return { ok: true, totalScore, maxScore: attempt.maxScore };
  }

  /**
   * Candidate left the test tab/window or exited fullscreen (or came back).
   * Logged for HR either way; HR is notified once per attempt — on the
   * first violation — so it's surfaced immediately without repeat noise.
   */
  async recordViolation(token: string, dto: RecordViolationDto) {
    const attempt = await this.prisma.aiProficiencyAttempt.findUnique({
      where: { token },
    });
    if (!attempt) throw new NotFoundException('Test link not found');
    if (attempt.status !== 'pending') {
      const existing = (attempt.violations as unknown[] | null) ?? [];
      return { violationCount: existing.length };
    }

    const existing =
      (attempt.violations as { leftAt: string; returnedAt: string | null; endedTest: boolean }[] | null) ?? [];
    const violations = [
      ...existing,
      { leftAt: dto.leftAt, returnedAt: dto.returnedAt ?? null, endedTest: dto.endedTest },
    ];

    await this.prisma.aiProficiencyAttempt.update({
      where: { id: attempt.id },
      data: { violations },
    });

    if (violations.length === 1) {
      const cand = await this.prisma.candidate.findUnique({
        where: { id: attempt.candidateId },
        include: {
          requisition: {
            select: {
              id: true,
              unitFactory: true,
              designation: true,
              recruiterId: true,
            },
          },
        },
      });
      if (cand) {
        const hrIds = await this.permissions.recruitmentRecipients(
          cand.requisition.unitFactory,
          cand.requisition.recruiterId,
        );
        await this.notifications.notifyMany(hrIds, {
          type: 'ai_proficiency_violation',
          title: 'Candidate left the screening test',
          message: `${cand.name} left the AI Proficiency Test screen during their exam (${cand.requisition.designation}).`,
          link: `/requisitions/${cand.requisition.id}`,
        });
      }
    }

    return { violationCount: violations.length };
  }

  // --- internals ------------------------------------------------------------

  private publicLink(token: string): string {
    const origin =
      this.config.get<string>('frontendUrl') || 'http://localhost:3000';
    return `${origin.split(',')[0].replace(/\/$/, '')}/ai-proficiency/${token}`;
  }

  private async requireCandidate(candidateId: string, userId: string) {
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: {
        requisition: {
          select: { unitFactory: true, designation: true, recruiterId: true },
        },
      },
    });
    if (!cand) throw new NotFoundException('Candidate not found');
    await this.permissions.requireRecruitmentAccess(
      userId,
      cand.requisition.unitFactory,
      cand.requisition.recruiterId,
      'manage the AI Proficiency Test',
    );
    return cand;
  }

  /** Bank management is global, not tied to a single unit/factory. */
  private async requireRecruitmentRole(userId: string) {
    const ok =
      (await this.permissions.isSuperUser(userId)) ||
      Boolean(
        await this.prisma.roleAssignment.findFirst({
          where: { userId, role: { key: { in: ['corporate_hr', 'chro'] } } },
        }),
      );
    if (!ok) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can manage the question bank.',
      );
    }
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function serializeQuestion(q: {
  id: string;
  prompt: string;
  options: unknown;
  answer: string;
  marks: number;
  grades: string[];
}) {
  return {
    id: q.id,
    prompt: q.prompt,
    options: q.options as string[],
    answer: q.answer,
    marks: q.marks,
    grades: q.grades,
  };
}

function serializeAttempt(
  attempt: {
    id: string;
    jobGrade: string;
    status: string;
    totalScore: number | null;
    maxScore: number;
    questionIds: string[];
    timeLimitMinutes: number | null;
    violations: unknown;
    terminationReason: string | null;
    submittedAt: Date | null;
    createdAt: Date;
  },
  link: string,
  attemptNumber: number,
) {
  return {
    id: attempt.id,
    jobGrade: attempt.jobGrade,
    status: attempt.status,
    totalScore: attempt.totalScore,
    maxScore: attempt.maxScore,
    // Marks and question count aren't the same number when a question is
    // worth more than 1 mark — expose both so the UI can show "2 questions"
    // alongside "4/4 marks" instead of leaving it read as 4 questions.
    questionCount: attempt.questionIds.length,
    timeLimitMinutes: attempt.timeLimitMinutes,
    violations: (attempt.violations as
      | { leftAt: string; returnedAt: string | null; endedTest: boolean }[]
      | null) ?? [],
    terminationReason: attempt.terminationReason,
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
    createdAt: attempt.createdAt.toISOString(),
    link,
    attemptNumber,
    maxAttempts: MAX_ATTEMPTS,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attemptNumber),
  };
}
