import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';

export interface SeatView {
  id: string;
  designation: string;
  category: string;
  grade: string | null;
  sanctioned: number;
  filled: number;
  vacant: number;
}

export interface DepartmentView {
  id: string;
  department: string;
  seats: SeatView[];
  sanctioned: number;
  filled: number;
  vacant: number;
}

export interface UnitView {
  id: string;
  unit: string;
  departments: DepartmentView[];
  sanctioned: number;
  filled: number;
  vacant: number;
}

export interface SeatLookupResult {
  inOrganogram: boolean;
  vacant: number;
  requirement: 'existing' | 'new';
  seat: {
    designation: string;
    sanctioned: number;
    filled: number;
    grade: string | null;
  } | null;
  /** Real grade(s) ZingHR-synced employees actually hold for this designation. */
  gradeReference: { grade: string; count: number }[];
}

@Injectable()
export class OrganogramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Full organogram with vacant = sanctioned − filled (filled is maintained manually). */
  async getOrganogram(userId: string): Promise<UnitView[]> {
    const scope = await this.permissions.getUnitAccessScope(userId);
    const units = await this.prisma.unit.findMany({
      orderBy: { name: 'asc' },
      include: {
        departments: {
          orderBy: { name: 'asc' },
          include: { positions: { orderBy: { designation: 'asc' } } },
        },
      },
    });

    const visibleUnits = scope.all
      ? units
      : units.filter((unit) =>
          scope.unitNames.some(
            (name) => name.toLowerCase() === unit.name.toLowerCase(),
          ),
        );

    return visibleUnits.map((unit) => {
      const departments: DepartmentView[] = unit.departments.map((dept) => {
        const seats: SeatView[] = dept.positions.map((p) => ({
          id: p.id,
          designation: p.designation,
          category: p.category,
          grade: p.grade ?? null,
          sanctioned: p.sanctioned,
          filled: p.filled,
          vacant: Math.max(0, p.sanctioned - p.filled),
        }));
        return {
          id: dept.id,
          department: dept.name,
          seats,
          ...rollup(seats),
        };
      });

      return {
        id: unit.id,
        unit: unit.name,
        departments,
        ...rollup(departments),
      };
    });
  }

  /** Decide New vs Existing (replacement) for a requested position. */
  async lookup(
    unit: string,
    department: string,
    designation: string,
    userId: string,
  ): Promise<SeatLookupResult> {
    const canAccess = await this.permissions.canAccessUnitName(userId, unit);
    if (!canAccess) {
      throw new ForbiddenException('You do not have access to this unit');
    }

    const position = await this.prisma.position.findFirst({
      where: {
        designation: { equals: designation, mode: 'insensitive' },
        department: { name: { equals: department, mode: 'insensitive' } },
        unit: { name: { equals: unit, mode: 'insensitive' } },
      },
    });

    const gradeReference = await this.gradeReferenceFor(designation, unit);

    if (!position) {
      return {
        inOrganogram: false,
        vacant: 0,
        requirement: 'new',
        seat: null,
        gradeReference,
      };
    }

    const vacant = Math.max(0, position.sanctioned - position.filled);
    return {
      inOrganogram: true,
      vacant,
      requirement: vacant > 0 ? 'existing' : 'new',
      seat: {
        designation: position.designation,
        sanctioned: position.sanctioned,
        filled: position.filled,
        grade: position.grade ?? null,
      },
      gradeReference,
    };
  }

  /**
   * What grade(s) ZingHR-synced employees with this exact designation actually
   * hold today — scoped to the unit first (more precise); if that's empty,
   * falls back to a global count so a brand-new seat still gets a sensible hint.
   */
  private async gradeReferenceFor(
    designation: string,
    unit: string,
  ): Promise<{ grade: string; count: number }[]> {
    const groupByGrade = async (where: Prisma.EmployeeWhereInput) => {
      const rows = await this.prisma.employee.groupBy({
        by: ['grade'],
        where: { ...where, grade: { not: null } },
        _count: { grade: true },
        orderBy: { _count: { grade: 'desc' } },
      });
      return rows
        .filter((r) => r.grade)
        .map((r) => ({ grade: r.grade as string, count: r._count.grade }));
    };

    const scoped = await groupByGrade({
      designation: { equals: designation, mode: 'insensitive' },
      unitName: { equals: unit, mode: 'insensitive' },
    });
    if (scoped.length > 0) return scoped;

    return groupByGrade({
      designation: { equals: designation, mode: 'insensitive' },
    });
  }

  /** Distinct grade values already in use — powers the grade input's suggestions. */
  async getGradeValues(): Promise<string[]> {
    const [fromEmployees, fromPositions] = await Promise.all([
      this.prisma.employee.findMany({
        where: { grade: { not: null } },
        select: { grade: true },
        distinct: ['grade'],
      }),
      this.prisma.position.findMany({
        where: { grade: { not: null } },
        select: { grade: true },
        distinct: ['grade'],
      }),
    ]);
    const values = new Set<string>();
    for (const e of fromEmployees) if (e.grade) values.add(e.grade);
    for (const p of fromPositions) if (p.grade) values.add(p.grade);
    return [...values].sort();
  }
}

function rollup(
  items: { sanctioned: number; filled: number; vacant: number }[],
) {
  const sanctioned = items.reduce((s, x) => s + x.sanctioned, 0);
  const filled = items.reduce((s, x) => s + x.filled, 0);
  return { sanctioned, filled, vacant: Math.max(0, sanctioned - filled) };
}
