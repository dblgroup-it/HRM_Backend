import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Unit } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import {
  CreateDepartmentDto,
  CreateUnitDto,
  UpdateUnitDto,
  UpdatePositionDto,
  UpsertPositionDto,
} from './dto/unit.dto';

/** Dynamic RBAC roles allowed to manage a unit's own configuration
 * (departments/seats) — corporate_hr and chro are global; sbu_head is scoped
 * to the unit(s) it is actually assigned to. */
const UNIT_CONFIG_ROLE_KEYS = ['corporate_hr', 'chro', 'sbu_head'];

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Can this user configure the named unit's departments/seats? Super users
   * always can; otherwise they need one of UNIT_CONFIG_ROLE_KEYS for it
   * (global roles match any unit, unit-scoped roles only their own). */
  private async requireUnitAccess(unitName: string, userId: string): Promise<void> {
    for (const key of UNIT_CONFIG_ROLE_KEYS) {
      if (await this.permissions.hasRoleForUnitName(userId, key, unitName)) return;
    }
    throw new ForbiddenException(
      'Only Corporate HR, CHRO or SBU Head for this unit can manage its configuration.',
    );
  }

  /** Creating a brand-new unit isn't scoped to any existing unit, so only the
   * global roles (or a super user) can do it — Factory HR/SBU Head manage the
   * unit(s) they're already assigned to, not spin up new ones. */
  private async requireGlobalAccess(userId: string): Promise<void> {
    const isSuper = await this.permissions.isSuperUser(userId);
    if (isSuper) return;
    const perms = await this.permissions.getUserPermissions(userId);
    const allowed = perms.roles.some(
      (r) => r.key === 'corporate_hr' || r.key === 'chro',
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Only Corporate HR or CHRO can create a new unit.',
      );
    }
  }

  private async unitNameOfDepartment(departmentId: string): Promise<string> {
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      include: { unit: { select: { name: true } } },
    });
    if (!dept) throw new NotFoundException('Department not found');
    return dept.unit.name;
  }

  private async unitNameOfPosition(positionId: string): Promise<string> {
    const pos = await this.prisma.position.findUnique({
      where: { id: positionId },
      include: { unit: { select: { name: true } } },
    });
    if (!pos) throw new NotFoundException('Position not found');
    return pos.unit.name;
  }

  findAll() {
    return this.prisma.unit.findMany({
      orderBy: { name: 'asc' },
      include: {
        departments: { include: { positions: true } },
        _count: { select: { employees: true } },
      },
    });
  }

  async findOne(id: string) {
    const unit = await this.prisma.unit.findUnique({
      where: { id },
      include: { departments: { include: { positions: true } } },
    });
    if (!unit) throw new NotFoundException('Unit not found');
    return unit;
  }

  async create(dto: CreateUnitDto, userId: string): Promise<Unit> {
    await this.requireGlobalAccess(userId);
    try {
      return await this.prisma.unit.create({
        data: { ...dto, createdById: userId, updatedById: userId },
      });
    } catch (e) {
      throw this.handleUnique(e, 'A unit with that name already exists');
    }
  }

  async update(id: string, dto: UpdateUnitDto, userId: string): Promise<Unit> {
    const unit = await this.ensureExists(id);
    await this.requireUnitAccess(unit.name, userId);
    try {
      return await this.prisma.unit.update({
        where: { id },
        data: { ...dto, updatedById: userId },
      });
    } catch (e) {
      throw this.handleUnique(e, 'A unit with that name already exists');
    }
  }

  async remove(id: string): Promise<{ id: string }> {
    await this.ensureExists(id);
    await this.prisma.unit.delete({ where: { id } });
    return { id };
  }

  async addDepartment(unitId: string, dto: CreateDepartmentDto, userId: string) {
    const unit = await this.ensureExists(unitId);
    await this.requireUnitAccess(unit.name, userId);
    try {
      return await this.prisma.department.create({
        data: { unitId, name: dto.name, createdById: userId, updatedById: userId },
      });
    } catch (e) {
      throw this.handleUnique(e, 'Department already exists in this unit');
    }
  }

  async updateDepartment(departmentId: string, name: string, userId: string) {
    await this.requireUnitAccess(await this.unitNameOfDepartment(departmentId), userId);
    try {
      return await this.prisma.department.update({
        where: { id: departmentId },
        data: { name, updatedById: userId },
      });
    } catch (e) {
      throw this.handleUnique(e, 'Department already exists in this unit');
    }
  }

  async removeDepartment(departmentId: string, userId: string): Promise<{ id: string }> {
    await this.requireUnitAccess(await this.unitNameOfDepartment(departmentId), userId);
    await this.prisma.department.delete({ where: { id: departmentId } });
    return { id: departmentId };
  }

  /** Create or update a sanctioned seat for a department. */
  async upsertPosition(departmentId: string, dto: UpsertPositionDto, userId: string) {
    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
      include: { unit: { select: { name: true } } },
    });
    if (!department) throw new NotFoundException('Department not found');
    await this.requireUnitAccess(department.unit.name, userId);

    return this.prisma.position.upsert({
      where: {
        unitId_departmentId_designation: {
          unitId: department.unitId,
          departmentId,
          designation: dto.designation,
        },
      },
      create: {
        unitId: department.unitId,
        departmentId,
        designation: dto.designation,
        section: dto.section?.trim() || null,
        category: dto.category ?? 'OFFICER',
        grade: dto.grade?.trim() || null,
        sanctioned: dto.sanctioned,
        filled: dto.filled ?? 0,
        createdById: userId,
        updatedById: userId,
      },
      update: {
        ...(dto.section !== undefined
          ? { section: dto.section.trim() || null }
          : {}),
        category: dto.category ?? 'OFFICER',
        ...(dto.grade !== undefined ? { grade: dto.grade.trim() || null } : {}),
        sanctioned: dto.sanctioned,
        filled: dto.filled ?? 0,
        updatedById: userId,
      },
    });
  }

  /** Edit an existing seat (designation, category and/or sanctioned) by id. */
  async updatePosition(positionId: string, dto: UpdatePositionDto, userId: string) {
    await this.requireUnitAccess(await this.unitNameOfPosition(positionId), userId);
    try {
      return await this.prisma.position.update({
        where: { id: positionId },
        data: {
          ...(dto.designation !== undefined
            ? { designation: dto.designation }
            : {}),
          ...(dto.section !== undefined
            ? { section: dto.section.trim() || null }
            : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.grade !== undefined ? { grade: dto.grade.trim() || null } : {}),
          ...(dto.sanctioned !== undefined
            ? { sanctioned: dto.sanctioned }
            : {}),
          ...(dto.filled !== undefined ? { filled: dto.filled } : {}),
          updatedById: userId,
        },
      });
    } catch (e) {
      throw this.handleUnique(
        e,
        'A seat with that designation already exists in this department',
      );
    }
  }

  async removePosition(positionId: string, userId: string): Promise<{ id: string }> {
    await this.requireUnitAccess(await this.unitNameOfPosition(positionId), userId);
    await this.prisma.position.delete({ where: { id: positionId } });
    return { id: positionId };
  }

  // --- helpers used by the ZingHR sync ------------------------------------

  /** Resolve a unit by name, creating it on first sight (dynamic config). */
  async findOrCreateUnitByName(
    tx: Prisma.TransactionClient,
    name: string,
  ): Promise<Unit> {
    const existing = await tx.unit.findUnique({ where: { name } });
    if (existing) return existing;
    return tx.unit.create({ data: { name } });
  }

  private async ensureExists(id: string): Promise<Unit> {
    const found = await this.prisma.unit.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Unit not found');
    return found;
  }

  private handleUnique(e: unknown, message: string): Error {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      return new ConflictException(message);
    }
    return e as Error;
  }
}
