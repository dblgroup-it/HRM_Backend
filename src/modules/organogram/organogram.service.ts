import { ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';

export interface SeatView {
  id: string;
  designation: string;
  category: string;
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
  } | null;
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

    if (!position) {
      return { inOrganogram: false, vacant: 0, requirement: 'new', seat: null };
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
      },
    };
  }
}

function rollup(
  items: { sanctioned: number; filled: number; vacant: number }[],
) {
  const sanctioned = items.reduce((s, x) => s + x.sanctioned, 0);
  const filled = items.reduce((s, x) => s + x.filled, 0);
  return { sanctioned, filled, vacant: Math.max(0, sanctioned - filled) };
}
