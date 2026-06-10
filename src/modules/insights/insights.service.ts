import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';

const DAY = 86_400_000;
const STUCK_DAYS = 3;

/** A compact, AI-friendly snapshot of the HR/recruitment data. */
interface HrContext {
  generatedAt: string;
  totals: Record<string, number>;
  requisitions: Array<{
    code: string;
    designation: string;
    unit: string;
    department: string;
    status: string;
    priority: string;
    requiredPosts: number;
    createdOn: string;
    daysOpen: number;
    currentStep: { role: string; assignee: string; daysWaiting: number } | null;
    candidatesByStage: Record<string, number>;
    candidatesTotal: number;
  }>;
  workforce: {
    total: number;
    active: number;
    byDepartment: { department: string; count: number }[];
    byUnit: { unit: string; count: number }[];
  };
  organogram: { unitCount: number; topVacancies: { unit: string; vacant: number; sanctioned: number; filled: number }[] };
  pipeline: Record<string, number>;
  activity7d: {
    newRequisitions: number;
    newCandidates: number;
    approvalActions: Record<string, number>;
  };
}

@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly ai: AiGraderService,
  ) {}

  aiConfigured(): boolean {
    return this.ai.isConfigured();
  }

  // --- features ------------------------------------------------------------

  /** Natural-language Q&A over the HR data. */
  async ask(question: string, userId: string) {
    await this.requireAccess(userId);
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const ctx = await this.gather();
    const prompt = `You are the HR data analyst assistant for DBL Group's HR Management System. Answer the user's question using ONLY the JSON data below. Be specific — cite the actual numbers, unit names, requisition codes and assignees from the data. If the data doesn't contain the answer, say so plainly. Keep it concise (a short paragraph or a tight bullet list). Today is ${new Date().toDateString()}.

HR DATA (JSON):
${JSON.stringify(ctx)}

QUESTION: ${question}`;
    const answer = await this.ai.complete(prompt, 900);
    return { answer: answer.trim() };
  }

  /** Weekly HR digest narrative. */
  async digest(userId: string) {
    await this.requireAccess(userId);
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const ctx = await this.gather();
    const prompt = `Write a concise weekly HR & recruitment digest for DBL Group management, based on the JSON data below. Use a friendly, executive tone with short bold section headers and tight bullets. Cover, where relevant: activity in the last 7 days (new requisitions, approvals, new candidates), the candidate pipeline movement, requisitions needing attention (stuck on approval, on whom), open vacancies by unit, and 2-3 things to focus on next week. Use real numbers/names from the data. Keep it under ~220 words.

HR DATA (JSON):
${JSON.stringify(ctx)}`;
    const summary = await this.ai.complete(prompt, 1000);
    return {
      summary: summary.trim(),
      stats: ctx.activity7d,
      generatedAt: ctx.generatedAt,
    };
  }

  /** Bottleneck + time-to-hire analysis (computed metrics + AI narrative). */
  async bottlenecks(userId: string) {
    await this.requireAccess(userId);
    const ctx = await this.gather();
    const metrics = await this.computeBottleneckMetrics(ctx);

    let summary = '';
    if (this.ai.isConfigured()) {
      const prompt = `You are a recruitment operations analyst. Using the metrics and requisition data below, identify the real bottlenecks: where candidates drop off in the funnel, which requisitions are stuck and on whom, and what is slow (time-to-hire, approvals). Then give 3-5 concrete, prioritised recommendations. Be specific with numbers and names. Keep it under ~200 words with short bullets.

METRICS (JSON):
${JSON.stringify(metrics)}

REQUISITIONS (JSON):
${JSON.stringify(ctx.requisitions)}`;
      summary = (await this.ai.complete(prompt, 900)).trim();
    }
    return { metrics, summary, generatedAt: ctx.generatedAt };
  }

  // --- data gathering ------------------------------------------------------

  private async gather(): Promise<HrContext> {
    const now = Date.now();
    const since = new Date(now - 7 * DAY);

    const reqs = await this.prisma.requisition.findMany({
      include: {
        approvalSteps: { orderBy: { orderIndex: 'asc' } },
        candidates: { select: { stage: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const requisitions = reqs.map((r) => {
      const pending = r.approvalSteps.find((s) => s.status === 'PENDING');
      let since2 = r.createdAt;
      if (pending) {
        const prev = r.approvalSteps
          .filter((s) => s.orderIndex < pending.orderIndex && s.actedAt)
          .sort((a, b) => b.orderIndex - a.orderIndex)[0];
        since2 = prev?.actedAt ?? r.createdAt;
      }
      const byStage: Record<string, number> = {};
      for (const c of r.candidates) {
        const k = c.stage.toLowerCase();
        byStage[k] = (byStage[k] ?? 0) + 1;
      }
      return {
        code: r.code,
        designation: r.designation,
        unit: r.unitFactory,
        department: r.department,
        status: r.status.toLowerCase(),
        priority: r.priority.toLowerCase(),
        requiredPosts: r.requiredPosts,
        createdOn: r.createdAt.toISOString().slice(0, 10),
        daysOpen: Math.round((now - +r.createdAt) / DAY),
        currentStep: pending
          ? {
              role: pending.role.toLowerCase(),
              assignee: pending.assignee || '(unassigned)',
              daysWaiting: Math.round((now - +since2) / DAY),
            }
          : null,
        candidatesByStage: byStage,
        candidatesTotal: r.candidates.length,
      };
    });

    // Workforce
    const [total, active, byDeptRaw, byUnitRaw] = await Promise.all([
      this.prisma.employee.count(),
      this.prisma.employee.count({ where: { exitDate: null } }),
      this.prisma.employee.groupBy({ by: ['department'], _count: { _all: true } }),
      this.prisma.employee.groupBy({ by: ['unitName'], _count: { _all: true } }),
    ]);
    const byDepartment = byDeptRaw
      .map((d) => ({ department: d.department ?? 'Unassigned', count: d._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
    const byUnit = byUnitRaw
      .map((u) => ({ unit: u.unitName ?? 'Unassigned', count: u._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Organogram vacancies
    const positions = await this.prisma.position.findMany({
      include: { unit: { select: { name: true } } },
    });
    const unitMap = new Map<string, { sanctioned: number; filled: number }>();
    for (const p of positions) {
      const k = p.unit.name;
      const cur = unitMap.get(k) ?? { sanctioned: 0, filled: 0 };
      cur.sanctioned += p.sanctioned;
      cur.filled += p.filled;
      unitMap.set(k, cur);
    }
    const unitsArr = [...unitMap.entries()].map(([unit, v]) => ({
      unit,
      sanctioned: v.sanctioned,
      filled: v.filled,
      vacant: v.sanctioned - v.filled,
    }));
    const topVacancies = unitsArr
      .filter((u) => u.vacant > 0)
      .sort((a, b) => b.vacant - a.vacant)
      .slice(0, 15);

    // Pipeline + activity
    const candByStage = await this.prisma.candidate.groupBy({
      by: ['stage'],
      _count: { _all: true },
    });
    const pipeline: Record<string, number> = {};
    for (const c of candByStage) pipeline[c.stage.toLowerCase()] = c._count._all;

    const [newReqs7d, newCands7d, acts7d] = await Promise.all([
      this.prisma.requisition.count({ where: { createdAt: { gte: since } } }),
      this.prisma.candidate.count({ where: { createdAt: { gte: since } } }),
      this.prisma.requisitionActivity.findMany({
        where: { at: { gte: since } },
        select: { action: true },
      }),
    ]);
    const approvalActions: Record<string, number> = {};
    for (const a of acts7d) {
      const k = a.action.toLowerCase();
      approvalActions[k] = (approvalActions[k] ?? 0) + 1;
    }

    const sanctioned = unitsArr.reduce((s, u) => s + u.sanctioned, 0);
    const filled = unitsArr.reduce((s, u) => s + u.filled, 0);

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        requisitions: reqs.length,
        openRequisitions: requisitions.filter((r) =>
          ['pending_approval', 'approved', 'profile_generated'].includes(r.status),
        ).length,
        postedRequisitions: requisitions.filter((r) => r.status === 'posted').length,
        employees: total,
        activeEmployees: active,
        sanctionedSeats: sanctioned,
        filledSeats: filled,
        vacantSeats: sanctioned - filled,
      },
      requisitions,
      workforce: { total, active, byDepartment, byUnit },
      organogram: { unitCount: unitMap.size, topVacancies },
      pipeline,
      activity7d: {
        newRequisitions: newReqs7d,
        newCandidates: newCands7d,
        approvalActions,
      },
    };
  }

  private async computeBottleneckMetrics(ctx: HrContext) {
    const open = ctx.requisitions.filter((r) =>
      ['pending_approval', 'approved', 'profile_generated', 'posted'].includes(
        r.status,
      ),
    );
    const avgDaysOpen = open.length
      ? Math.round(open.reduce((s, r) => s + r.daysOpen, 0) / open.length)
      : 0;

    const stuck = ctx.requisitions
      .filter((r) => r.currentStep && r.currentStep.daysWaiting >= STUCK_DAYS)
      .map((r) => ({
        code: r.code,
        designation: r.designation,
        unit: r.unit,
        waitingOn: `${r.currentStep!.role} (${r.currentStep!.assignee})`,
        daysWaiting: r.currentStep!.daysWaiting,
      }))
      .sort((a, b) => b.daysWaiting - a.daysWaiting);

    // Funnel + conversion
    const order = ['applied', 'ai_shortlisted', 'shortlisted', 'interview', 'final', 'selected'];
    const funnel = order.map((stage) => ({ stage, count: ctx.pipeline[stage] ?? 0 }));
    const applied = ctx.pipeline['applied'] ?? 0;
    const reachedInterview = (ctx.pipeline['interview'] ?? 0) + (ctx.pipeline['final'] ?? 0) + (ctx.pipeline['selected'] ?? 0);
    const selected = ctx.pipeline['selected'] ?? 0;
    const totalCandidates = Object.values(ctx.pipeline).reduce((s, n) => s + n, 0);

    // Time-to-fill: requisition.createdAt → its selected candidate (updatedAt)
    const selectedCands = await this.prisma.candidate.findMany({
      where: { stage: 'SELECTED' },
      select: { updatedAt: true, requisition: { select: { createdAt: true } } },
    });
    const fillDays = selectedCands
      .map((c) => Math.round((+c.updatedAt - +c.requisition.createdAt) / DAY))
      .filter((d) => d >= 0);
    const avgTimeToFillDays = fillDays.length
      ? Math.round(fillDays.reduce((s, d) => s + d, 0) / fillDays.length)
      : null;

    return {
      openRequisitions: open.length,
      avgDaysOpen,
      stuckRequisitions: stuck,
      funnel,
      conversion: {
        appliedToInterviewPct: applied ? Math.round((reachedInterview / applied) * 100) : 0,
        appliedToSelectedPct: applied ? Math.round((selected / applied) * 100) : 0,
        totalCandidates,
      },
      avgTimeToFillDays,
      hires: selectedCands.length,
    };
  }

  // --- access --------------------------------------------------------------

  private async requireAccess(userId: string) {
    if (await this.permissions.isSuperUser(userId)) return;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user && ['ADMIN', 'HR_MANAGER', 'MANAGEMENT'].includes(user.role)) return;
    const assignment = await this.prisma.roleAssignment.findFirst({
      where: { userId, role: { key: { in: ['corporate_hr', 'chro', 'super_user'] } } },
    });
    if (assignment) return;
    throw new ForbiddenException(
      'HR insights are available to management, Corporate HR/CHRO and super users.',
    );
  }
}
