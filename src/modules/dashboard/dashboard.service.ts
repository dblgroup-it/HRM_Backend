import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';

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
  ) {}

  async getDashboard(userId: string): Promise<DashboardResponse> {
    const scope = await this.permissions.getUnitAccessScope(userId);
    const unitFilter = scope.all ? undefined : scope.unitNames;

    const [
      employees,
      requisitions,
      units,
      seats,
    ] = await Promise.all([
      this.prisma.employee.findMany({
        where: unitFilter?.length
          ? { unitName: { in: unitFilter } }
          : scope.all
            ? {}
            : { unitName: { in: [] } },
        select: {
          id: true,
          designation: true,
          department: true,
          joiningDate: true,
          createdAt: true,
          user: {
            select: {
              name: true,
              status: true,
            },
          },
        },
      }),
      this.prisma.requisition.findMany({
        where: unitFilter?.length
          ? { unitFactory: { in: unitFilter } }
          : scope.all
            ? {}
            : { unitFactory: { in: [] } },
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
        where: unitFilter?.length
          ? { name: { in: unitFilter } }
          : scope.all
            ? {}
            : { name: { in: [] } },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          isActive: true,
        },
      }),
      this.prisma.position.aggregate({
        where: unitFilter?.length
          ? { unit: { name: { in: unitFilter } } }
          : scope.all
            ? {}
            : { unit: { name: { in: [] } } },
        _sum: {
          sanctioned: true,
          filled: true,
        },
      }),
    ]);

    const totalEmployees = employees.length;
    const activeEmployees = employees.filter(
      (employee) => employee.user.status === 'ACTIVE',
    ).length;

    const departmentMap = new Map<string, number>();
    for (const employee of employees) {
      const key = employee.department?.trim() || 'Unassigned';
      departmentMap.set(key, (departmentMap.get(key) ?? 0) + 1);
    }

    const departments = [...departmentMap.entries()]
      .map(([department, headcount]) => ({
        department,
        headcount,
        percentage: totalEmployees > 0 ? (headcount / totalEmployees) * 100 : 0,
      }))
      .sort((a, b) => b.headcount - a.headcount)
      .slice(0, 7);

    const recentHires = [...employees]
      .sort((a, b) => {
        const left = a.joiningDate ?? a.createdAt;
        const right = b.joiningDate ?? b.createdAt;
        return +new Date(right) - +new Date(left);
      })
      .slice(0, 5)
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
        { key: 'employees', label: 'Total Workforce', value: summary.totalEmployees },
        { key: 'activeEmployees', label: 'Active Employees', value: summary.activeEmployees },
        { key: 'openRequisitions', label: 'Open Requisitions', value: summary.openRequisitions },
        { key: 'vacantSeats', label: 'Vacant Seats', value: summary.vacantSeats },
      ],
      summary,
      departments,
      recentHires,
      requisitions: requisitionRows.slice(0, 5),
    };
  }
}
