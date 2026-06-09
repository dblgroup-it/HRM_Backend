import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssessmentType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
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
  ) {}

  async getSetup(reqId: string, userId: string) {
    await this.loadReq(reqId, userId);
    const [committee, rubric, plan] = await Promise.all([
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
    };
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
        requisitionId_userId: { requisitionId: reqId, userId: dto.memberUserId },
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
      this.prisma.rubricCriterion.deleteMany({ where: { requisitionId: reqId } }),
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
      (await this.permissions.hasRoleForUnitName(userId, 'corporate_hr', unit)) ||
      (await this.permissions.hasRoleForUnitName(userId, 'chro', unit));
    if (!ok) {
      throw new ForbiddenException(
        'Only Corporate HR, CHRO or a super user can manage assessments',
      );
    }
  }
}
