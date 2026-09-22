import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PermissionsService,
  type RecruitmentSubject,
} from '../rbac/permissions.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import {
  CRITERIA,
  TOTAL_MAX,
} from '../salary-fixation/salary-fixation.constants';
import { SettingsService } from '../settings/settings.service';
import { FileGrantService } from '../../common/files/file-grant.service';
import { AddCommitteeMemberDto } from './dto/assessment.dto';

@Injectable()
export class AssessmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly ai: AiGraderService,
    private readonly settings: SettingsService,
    private readonly files: FileGrantService,
  ) {}

  async getSetup(reqId: string, userId: string) {
    const req = await this.loadReq(reqId, userId, true);
    const committee = await this.prisma.committeeMember.findMany({
      where: { requisitionId: reqId },
      include: { user: { include: { employee: true } } },
      orderBy: { createdAt: 'asc' },
    });

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
      aiEnabled: this.ai.isConfigured(),
      deliberationNotes: req.deliberationNotes ?? null,
    };
  }

  async getScorecard(reqId: string, userId: string) {
    await this.loadReq(reqId, userId);

    const candidates = await this.prisma.candidate.findMany({
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
        interviews: {
          include: {
            evaluations: { include: { evaluator: { select: { name: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // The scorecard is read as "show me the working", so it carries every
    // component that made the number rather than the number alone.
    const salaryFixations = await this.prisma.salaryFixation.findMany({
      where: { candidateId: { in: candidates.map((c) => c.id) } },
    });
    const fxByCandidate = new Map(
      salaryFixations.map((s) => [s.candidateId, s]),
    );
    const screening = await this.settings.getScreeningConfig();
    const aiScoreByCandidate = new Map(
      salaryFixations
        .filter(
          (s) =>
            s.aiTestTotal !== null &&
            s.aiTestObtained !== null &&
            s.aiTestTotal > 0,
        )
        .map((s) => [
          s.candidateId,
          round1((s.aiTestObtained! / s.aiTestTotal!) * 100),
        ]),
    );

    return candidates.map((c) => {
      // matchScore of 0 means "not screened" (default), not a genuine 0% match.
      const cvScore: number | null =
        c.matchScore !== null && c.matchScore > 0 ? c.matchScore : null;

      // Average of all panelist evaluation totals, normalised to 0-100
      const allEvals = c.interviews.flatMap((r) => r.evaluations);
      let interviewAvg: number | null = null;
      if (allEvals.length > 0) {
        const sum = allEvals.reduce((s, e) => s + e.total, 0);
        interviewAvg = round1((sum / allEvals.length / TOTAL_MAX) * 100);
      }

      const aiProficiencyScore: number | null =
        aiScoreByCandidate.get(c.id) ?? null;

      // Simple average of non-null normalised components
      const components: number[] = [
        ...(cvScore !== null ? [cvScore] : []),
        ...(aiProficiencyScore !== null ? [aiProficiencyScore] : []),
        ...(interviewAvg !== null ? [interviewAvg] : []),
      ];
      const combined =
        components.length > 0
          ? round1(components.reduce((a, b) => a + b, 0) / components.length)
          : null;

      const fx = fxByCandidate.get(c.id);
      return {
        candidateId: c.id,
        candidateName: c.name,
        stage: c.stage.toLowerCase(),
        cvScore,
        aiProficiencyScore,
        interviewAvg,
        combined,
        // Each hand-marked test as its own line: the mark, what it was out of,
        // whether it passed, and the marked script if one was attached.
        written: this.testDetail(
          fx?.writtenTestEnabled ?? false,
          fx?.writtenTestTotal ?? null,
          fx?.writtenTestObtained ?? null,
          screening.writtenTestPassPct,
          fx?.writtenTestSheetId ?? null,
          'Written Test',
        ),
        computer: this.testDetail(
          fx?.computerTestEnabled ?? false,
          fx?.computerTestTotal ?? null,
          fx?.computerTestObtained ?? null,
          screening.computerTestPassPct,
          fx?.computerTestSheetId ?? null,
          'Computer Literacy',
        ),
        aiTest: this.testDetail(
          fx?.aiTestEnabled ?? true,
          fx?.aiTestTotal ?? null,
          fx?.aiTestObtained ?? null,
          screening.aiTestPassPct,
          null,
          'AI Proficiency',
        ),
        // Who marked, in which round, and what they gave — an average hides a
        // panel that disagreed, which is exactly what a reader wants to see.
        interviewers: allEvals
          .map((e) => ({
            evaluatorName: e.evaluator.name,
            roundKind:
              c.interviews
                .find((r) => r.evaluations.some((x) => x.id === e.id))
                ?.kind.toLowerCase() ?? null,
            total: round1(e.total),
            max: TOTAL_MAX,
            pct: round1((e.total / TOTAL_MAX) * 100),
            submittedAt: e.submittedAt.toISOString(),
          }))
          .sort((a, b) => a.evaluatorName.localeCompare(b.evaluatorName)),
      };
    });
  }

  /**
   * One screening test, as the scorecard shows it.
   *
   * `status` is the same three-way the marking panel uses — skipped, pending,
   * or a verdict — so the two surfaces cannot tell the reader different things
   * about the same mark.
   */
  private testDetail(
    enabled: boolean,
    total: number | null,
    obtained: number | null,
    passPct: number,
    sheetFileId: string | null,
    label: string,
  ) {
    const pct =
      total !== null && obtained !== null && total > 0
        ? round1((obtained / total) * 100)
        : null;
    const status = !enabled
      ? ('skipped' as const)
      : pct === null
        ? ('pending' as const)
        : pct >= passPct
          ? ('pass' as const)
          : ('fail' as const);
    return {
      enabled,
      total,
      obtained,
      pct,
      passPct,
      status,
      sheetUrl: this.files.url(sheetFileId, 'exam-sheet', { filename: label }),
    };
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
    if (
      !(await this.permissions.hasInterviewDelegation(userId, {
        candidateId,
      }))
    ) {
      await this.requireRecruitmentAccess(candidate.requisition, userId);
    }

    const rounds = await this.prisma.interviewRound.findMany({
      where: { candidateId },
      include: {
        evaluations: { include: { evaluator: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const allEvals = rounds.flatMap((r) => r.evaluations);
    if (allEvals.length === 0) {
      throw new BadRequestException(
        'No evaluations submitted yet — panelists must mark first',
      );
    }

    const criteriaLine = CRITERIA.map((c) => `${c.label} (max ${c.max})`).join(
      ', ',
    );

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
          const scores = CRITERIA.map(
            (c) =>
              `${c.label}: ${(ev.scores as Record<string, number>)[c.key] ?? 0}/${c.max}`,
          ).join(', ');
          const comment = ev.comments?.trim()
            ? ` — "${ev.comments.trim()}"`
            : '';
          return `    • ${ev.evaluator.name}: ${scores} | Total ${ev.total}/${TOTAL_MAX}${comment}`;
        });
        const avg =
          r.evaluations.length > 0
            ? Math.round(
                r.evaluations.reduce((s, e) => s + e.total, 0) /
                  r.evaluations.length,
              )
            : 0;
        return `${kindLabel} Interview (${r.evaluations.length} panelist${r.evaluations.length > 1 ? 's' : ''}, avg ${avg}/${TOTAL_MAX}):\n${evLines.join('\n')}`;
      })
      .join('\n\n');

    const prompt = `You are an experienced HR professional writing an internal assessment memo.

Candidate: ${candidate.name}
Role: ${candidate.requisition.designation} — ${candidate.requisition.department}, ${candidate.requisition.unitFactory}
Evaluation criteria: ${criteriaLine}

Panel evaluation data:
${roundLines}

Write a concise professional summary (3–4 sentences) for Head of Talent Acquisition covering:
1. Overall panel impression and score trend
2. Key strengths observed by the panel
3. Any concerns or disagreements between panelists (if present)
4. A concluding hire/no-hire leaning based on the data

Be objective and specific. Reference actual scores and comments. Do not use bullet points — write in flowing paragraph form.`;

    const summary = await this.ai.complete(prompt, 400);
    return { summary: summary.trim() };
  }

  async addCommitteeMember(
    reqId: string,
    userId: string,
    dto: AddCommitteeMemberDto,
  ) {
    await this.loadReq(reqId, userId, true);
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
    // Arranging a committee includes undoing a wrong pick.
    await this.loadReq(member.requisitionId, userId, true);
    await this.prisma.committeeMember.delete({ where: { id: memberId } });
    return this.getSetup(member.requisitionId, userId);
  }

  // --- internals ----------------------------------------------------------

  private async loadReq(reqId: string, userId: string, allowDelegate = false) {
    const req = await this.prisma.requisition.findUnique({
      where: { id: reqId },
    });
    if (!req) throw new NotFoundException('Requisition not found');
    // Someone handed candidates from this requisition to interview has to be
    // able to see and build the committee — that is the job they were given.
    // Off by default so the requisition-wide surfaces (scorecard across every
    // candidate, deliberation notes) stay with Head of Talent Acquisition.
    if (
      allowDelegate &&
      (await this.permissions.hasInterviewDelegation(userId, {
        requisitionId: reqId,
      }))
    ) {
      return req;
    }
    await this.requireRecruitmentAccess(req, userId);
    return req;
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
      'manage assessments',
      // Whoever is standing in while the recruiter is on leave.
      { userId: req.coverRecruiterId, until: req.coverUntil },
    );
  }
}

/** Round to 1 decimal place — scores keep fractional precision instead of collapsing to a whole number. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
