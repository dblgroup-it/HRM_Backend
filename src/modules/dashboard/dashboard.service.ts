import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { MemoryCacheService } from '../../common/cache/memory-cache.service';

const OPEN_REQUISITION_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'PROFILE_GENERATED',
] as const;

interface DashboardStat {
  key: string;
  label: string;
  value: number;
}

interface DepartmentHeadcount {
  department: string;
  headcount: number;
  percentage: number;
}

interface RecentHire {
  id: string;
  name: string;
  jobTitle: string;
  department: string;
  joinedAt: string;
  avatarUrl: string | null;
}

interface RequisitionSnapshot {
  id: string;
  code: string;
  designation: string;
  unitFactory: string;
  department: string;
  status: string;
  requiredPosts: number;
  updatedAt: string;
}

interface DashboardSummary {
  totalEmployees: number;
  activeEmployees: number;
  activeUnits: number;
  totalUnits: number;
  sanctionedSeats: number;
  filledSeats: number;
  vacantSeats: number;
  openRequisitions: number;
}

export interface DashboardResponse {
  stats: DashboardStat[];
  summary: DashboardSummary;
  departments: DepartmentHeadcount[];
  recentHires: RecentHire[];
  requisitions: RequisitionSnapshot[];
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly cache: MemoryCacheService,
  ) {}

  /** Cached 45s — a dashboard is a summary, not a live feed. */
  getDashboard(userId: string): Promise<DashboardResponse> {
    return this.cache.wrap(`dashboard:${userId}`, 45_000, () =>
      this.buildDashboard(userId),
    );
  }

  private async buildDashboard(userId: string): Promise<DashboardResponse> {
    const scope = await this.permissions.getUnitAccessScope(userId);

    // Scope filters — `in: []` matches nothing (no access).
    const empWhere: Prisma.EmployeeWhereInput = scope.all
      ? {}
      : { unitName: { in: scope.unitNames } };
    const reqWhere: Prisma.RequisitionWhereInput = scope.all
      ? {}
      : { unitFactory: { in: scope.unitNames } };
    const seatWhere: Prisma.PositionWhereInput = scope.all
      ? {}
      : { unit: { name: { in: scope.unitNames } } };

    const recentSelect = {
      id: true,
      designation: true,
      department: true,
      joiningDate: true,
      createdAt: true,
      user: { select: { name: true } },
    } satisfies Prisma.EmployeeSelect;

    const [
      totalEmployees,
      activeEmployees,
      deptGroups,
      recentByJoin,
      recentByCreate,
      requisitions,
      units,
      seats,
    ] = await Promise.all([
      this.prisma.employee.count({ where: empWhere }),
      this.prisma.employee.count({
        where: { ...empWhere, user: { status: 'ACTIVE' } },
      }),
      this.prisma.employee.groupBy({
        by: ['department'],
        where: empWhere,
        _count: { _all: true },
      }),
      this.prisma.employee.findMany({
        where: empWhere,
        orderBy: { joiningDate: { sort: 'desc', nulls: 'last' } },
        take: 12,
        select: recentSelect,
      }),
      this.prisma.employee.findMany({
        where: empWhere,
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: recentSelect,
      }),
      this.prisma.requisition.findMany({
        where: reqWhere,
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          code: true,
          designation: true,
          unitFactory: true,
          department: true,
          status: true,
          requiredPosts: true,
          updatedAt: true,
        },
      }),
      this.prisma.unit.findMany({
        where: scope.all ? {} : { name: { in: scope.unitNames } },
        select: { isActive: true },
      }),
      this.prisma.position.aggregate({
        where: seatWhere,
        _sum: { sanctioned: true, filled: true },
      }),
    ]);

    const departments = deptGroups
      .map((g) => ({
        department: g.department?.trim() || 'Unassigned',
        headcount: g._count._all,
        percentage:
          totalEmployees > 0 ? (g._count._all / totalEmployees) * 100 : 0,
      }))
      .sort((a, b) => b.headcount - a.headcount)
      .slice(0, 7);

    const recentMap = new Map<string, (typeof recentByJoin)[number]>();
    for (const e of [...recentByJoin, ...recentByCreate])
      recentMap.set(e.id, e);
    const recentHires = [...recentMap.values()]
      .sort((a, b) => {
        const left = a.joiningDate ?? a.createdAt;
        const right = b.joiningDate ?? b.createdAt;
        return +new Date(right) - +new Date(left);
      })
      .slice(0, 7)
      .map((employee) => ({
        id: employee.id,
        name: employee.user.name,
        jobTitle: employee.designation?.trim() || 'Employee',
        department: employee.department?.trim() || 'Unassigned',
        joinedAt: (employee.joiningDate ?? employee.createdAt).toISOString(),
        avatarUrl: null,
      }));

    const requisitionRows = requisitions
      .sort((a, b) => +b.updatedAt - +a.updatedAt)
      .map((req) => ({
        id: req.id,
        code: req.code,
        designation: req.designation,
        unitFactory: req.unitFactory,
        department: req.department,
        status: req.status.toLowerCase(),
        requiredPosts: req.requiredPosts,
        updatedAt: req.updatedAt.toISOString(),
      }));

    const sanctionedSeats = seats._sum.sanctioned ?? 0;
    const filledSeats = seats._sum.filled ?? 0;
    const vacantSeats = Math.max(sanctionedSeats - filledSeats, 0);

    const openRequisitions = requisitions.filter((req) =>
      OPEN_REQUISITION_STATUSES.includes(
        req.status as (typeof OPEN_REQUISITION_STATUSES)[number],
      ),
    ).length;

    const summary: DashboardSummary = {
      totalEmployees,
      activeEmployees,
      activeUnits: units.filter((unit) => unit.isActive).length,
      totalUnits: units.length,
      sanctionedSeats,
      filledSeats,
      vacantSeats,
      openRequisitions,
    };

    return {
      stats: [
        {
          key: 'employees',
          label: 'Total Workforce',
          value: summary.totalEmployees,
        },
        {
          key: 'activeEmployees',
          label: 'Active Employees',
          value: summary.activeEmployees,
        },
        {
          key: 'openRequisitions',
          label: 'Open Requisitions',
          value: summary.openRequisitions,
        },
        {
          key: 'vacantSeats',
          label: 'Vacant Seats',
          value: summary.vacantSeats,
        },
      ],
      summary,
      departments,
      recentHires,
      requisitions: requisitionRows.slice(0, 5),
    };
  }
}
