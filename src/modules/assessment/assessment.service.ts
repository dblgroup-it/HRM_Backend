import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AssessmentType, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import {
  AddCommitteeMemberDto,
  SetPlanDto,
  SetRubricDto,
} from './dto/assessment.dto';

@Injectable()
export class AssessmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly ai: AiGraderService,
  ) {}

  async getSetup(reqId: string, userId: string) {
    const req = await this.loadReq(reqId, userId);
    const [committee, rubric, plan, aiSetting] = await Promise.all([
      this.prisma.committeeMember.findMany({
        where: { requisitionId: reqId },
        include: { user: { include: { employee: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.rubricCriterion.findMany({
        where: { requisitionId: reqId },
        orderBy: { orderIndex: 'asc' },
      }),
      this.prisma.assessmentComponent.findMany({
        where: { requisitionId: reqId },
        orderBy: { orderIndex: 'asc' },
      }),
      this.prisma.setting.findUnique({ where: { key: 'ai' } }),
    ]);

    return {
      committee: committee.map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.user.name,
        employeeCode: m.user.employeeCode,
        designation: m.user.employee?.designation ?? null,
        department: m.user.employee?.department ?? null,
        role: m.role,
      })),
      rubric: rubric.map((c) => ({
        id: c.id,
        label: c.label,
        maxScore: c.maxScore,
      })),
      plan: plan.map((p) => ({
        id: p.id,
        type: p.type.toLowerCase(),
        maxScore: p.maxScore,
      })),
      aiEnabled: this.ai.isConfigured(),
      autoEvalSummary:
        (aiSetting?.value as { autoEvalSummary?: boolean } | null)
          ?.autoEvalSummary ?? false,
      interviewQuestions: Array.isArray(req.interviewQuestions)
        ? (req.interviewQuestions as { category: string; question: string }[])
        : [],
      deliberationNotes: req.deliberationNotes ?? null,
    };
  }

  async getScorecard(reqId: string, userId: string) {
    await this.loadReq(reqId, userId);

    const [rubric, candidates] = await Promise.all([
      this.prisma.rubricCriterion.findMany({ where: { requisitionId: reqId } }),
      this.prisma.candidate.findMany({
        where: {
          requisitionId: reqId,
          stage: {
            in: [
              'AI_SHORTLISTED',
              'SHORTLISTED',
              'INTERVIEW',
              'FINAL',
              'SELECTED',
              'REJECTED',
            ],
          },
          deletedAt: null,
        },
        include: {
          examAttempts: { where: { status: 'graded' } },
          interviews: { include: { evaluations: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const rubricMax = rubric.reduce((s, r) => s + r.maxScore, 0);

    return candidates.map((c) => {
      // matchScore of 0 means "not screened" (default), not a genuine 0% match.
      const cvScore: number | null =
        c.matchScore !== null && c.matchScore > 0 ? c.matchScore : null;

      // Best graded exam score per type, normalised to 0-100
      const examScores: Record<string, number> = {};
      for (const attempt of c.examAttempts) {
        const raw = attempt.totalScore ?? attempt.autoScore;
        if (raw === null || attempt.maxScore === 0) continue;
        const pct = Math.round((raw / attempt.maxScore) * 100);
        const key = attempt.examType.toLowerCase();
        if (examScores[key] === undefined || examScores[key] < pct) {
          examScores[key] = pct;
        }
      }

      // Average of all panelist evaluation totals, normalised to 0-100
      const allEvals = c.interviews.flatMap((r) => r.evaluations);
      let interviewAvg: number | null = null;
      if (allEvals.length > 0 && rubricMax > 0) {
        const sum = allEvals.reduce((s, e) => s + e.total, 0);
        interviewAvg = Math.round((sum / allEvals.length / rubricMax) * 100);
      }

      // Simple average of non-null normalised components
      const components: number[] = [
        ...(cvScore !== null ? [cvScore] : []),
        ...Object.values(examScores),
        ...(interviewAvg !== null ? [interviewAvg] : []),
      ];
      const combined =
        components.length > 0
          ? Math.round(
              components.reduce((a, b) => a + b, 0) / components.length,
            )
          : null;

      return {
        candidateId: c.id,
        candidateName: c.name,
        stage: c.stage.toLowerCase(),
        cvScore,
        examScores,
        interviewAvg,
        combined,
      };
    });
  }

  async saveNotes(reqId: string, notes: string, userId: string) {
    await this.loadReq(reqId, userId);
    await this.prisma.requisition.update({
      where: { id: reqId },
      data: { deliberationNotes: notes },
    });
    return { ok: true };
  }

  async generateEvaluationSummary(candidateId: string, userId: string) {
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }

    const candidate = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');
    await this.requireRecruitmentAccess(
      candidate.requisition.unitFactory,
      userId,
    );

    const [rounds, rubric] = await Promise.all([
      this.prisma.interviewRound.findMany({
        where: { candidateId },
        include: {
          evaluations: { include: { evaluator: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.rubricCriterion.findMany({
        where: { requisitionId: candidate.requisitionId },
        orderBy: { orderIndex: 'asc' },
      }),
    ]);

    const allEvals = rounds.flatMap((r) => r.evaluations);
    if (allEvals.length === 0) {
      throw new BadRequestException(
        'No evaluations submitted yet — panelists must mark first',
      );
    }

    const rubricMax = rubric.reduce((s, r) => s + r.maxScore, 0);
    const rubricLine =
      rubric.length > 0
        ? rubric.map((c) => `${c.label} (max ${c.maxScore})`).join(', ')
        : 'No rubric defined';

    const roundLines = rounds
      .filter((r) => r.evaluations.length > 0)
      .map((r) => {
        const kindLabel =
          r.kind === 'FIRST'
            ? 'First'
            : r.kind === 'SECOND'
              ? 'Second'
              : 'Final';
        const evLines = r.evaluations.map((ev) => {
          const scores = rubric
            .map(
              (c) =>
                `${c.label}: ${(ev.scores as Record<string, number>)[c.id] ?? 0}/${c.maxScore}`,
            )
            .join(', ');
          const comment = ev.comments?.trim()
            ? ` — "${ev.comments.trim()}"`
            : '';
          return `    • ${ev.evaluator.name}: ${scores} | Total ${ev.total}/${rubricMax}${comment}`;
        });
        const avg =
          r.evaluations.length > 0
            ? Math.round(
                r.evaluations.reduce((s, e) => s + e.total, 0) /
                  r.evaluations.length,
              )
            : 0;
        return `${kindLabel} Interview (${r.evaluations.length} panelist${r.evaluations.length > 1 ? 's' : ''}, avg ${avg}/${rubricMax}):\n${evLines.join('\n')}`;
      })
      .join('\n\n');

    const prompt = `You are an experienced HR professional writing an internal assessment memo.

Candidate: ${candidate.name}
Role: ${candidate.requisition.designation} — ${candidate.requisition.department}, ${candidate.requisition.unitFactory}
Rubric criteria: ${rubricLine}

Panel evaluation data:
${roundLines}

Write a concise professional summary (3–4 sentences) for Corporate HR covering:
1. Overall panel impression and score trend
2. Key strengths observed by the panel
3. Any concerns or disagreements between panelists (if present)
4. A concluding hire/no-hire leaning based on the data

Be objective and specific. Reference actual scores and comments. Do not use bullet points — write in flowing paragraph form.`;

    const summary = await this.ai.complete(prompt, 400);
    return { summary: summary.trim() };
  }

  /** AI-generate role-specific interview questions and store them. */
  async generateInterviewQuestions(reqId: string, userId: string) {
    const req = await this.loadReq(reqId, userId);
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const rp =
      (req.roleProfile as {
        responsibilities?: string[];
        requirements?: string[];
      } | null) ?? null;
    const questions = await this.ai.generateInterviewQuestions({
      designation: req.designation,
      department: req.department,
      unitFactory: req.unitFactory,
      placeOfPosting: req.placeOfPosting,
      jobDescription: req.jobDescription,
      education: req.education,
      experience: req.experience,
      others: req.others,
      requiredPosts: req.requiredPosts,
      responsibilities: Array.isArray(rp?.responsibilities)
        ? rp?.responsibilities
        : undefined,
      requirements: Array.isArray(rp?.requirements)
        ? rp?.requirements
        : undefined,
    });
    await this.prisma.requisition.update({
      where: { id: reqId },
      data: {
        interviewQuestions: questions as unknown as Prisma.InputJsonValue,
      },
    });
    return this.getSetup(reqId, userId);
  }

  async addCommitteeMember(
    reqId: string,
    userId: string,
    dto: AddCommitteeMemberDto,
  ) {
    await this.loadReq(reqId, userId);
    const member = await this.prisma.user.findUnique({
      where: { id: dto.memberUserId },
    });
    if (!member) throw new NotFoundException('Selected employee not found');

    await this.prisma.committeeMember.upsert({
      where: {
        requisitionId_userId: {
          requisitionId: reqId,
          userId: dto.memberUserId,
        },
      },
      create: {
        requisitionId: reqId,
        userId: dto.memberUserId,
        role: dto.role ?? 'interviewer',
      },
      update: { role: dto.role ?? 'interviewer' },
    });
    return this.getSetup(reqId, userId);
  }

  async removeCommitteeMember(memberId: string, userId: string) {
    const member = await this.prisma.committeeMember.findUnique({
      where: { id: memberId },
      include: { requisition: true },
    });
    if (!member) throw new NotFoundException('Committee member not found');
    await this.requireRecruitmentAccess(member.requisition.unitFactory, userId);
    await this.prisma.committeeMember.delete({ where: { id: memberId } });
    return this.getSetup(member.requisitionId, userId);
  }

  async setRubric(reqId: string, userId: string, dto: SetRubricDto) {
    await this.loadReq(reqId, userId);
    await this.prisma.$transaction([
      this.prisma.rubricCriterion.deleteMany({
        where: { requisitionId: reqId },
      }),
      ...dto.criteria.map((c, i) =>
        this.prisma.rubricCriterion.create({
          data: {
            requisitionId: reqId,
            label: c.label.trim(),
            maxScore: c.maxScore,
            orderIndex: i,
          },
        }),
      ),
    ]);
    return this.getSetup(reqId, userId);
  }

  async setPlan(reqId: string, userId: string, dto: SetPlanDto) {
    await this.loadReq(reqId, userId);
    await this.prisma.$transaction([
      this.prisma.assessmentComponent.deleteMany({
        where: { requisitionId: reqId },
      }),
      ...dto.components.map((c, i) =>
        this.prisma.assessmentComponent.create({
          data: {
            requisitionId: reqId,
            type: c.type.toUpperCase() as AssessmentType,
            maxScore: c.maxScore ?? 100,
            orderIndex: i,
          },
        }),
      ),
    ]);
    return this.getSetup(reqId, userId);
  }

  // --- internals ----------------------------------------------------------

  private async loadReq(reqId: string, userId: string) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    await this.requireRecruitmentAccess(req.unitFactory, userId);
    return req;
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
        'Only Corporate HR, CHRO or a super user can manage assessments',
      );
    }
  }
}
