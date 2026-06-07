import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateAssignmentDto,
  CreateRoleDto,
  UpdateRoleDto,
} from './dto/rbac.dto';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Roles --------------------------------------------------------------

  listRoles() {
    return this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { assignments: true } } },
    });
  }

  async createRole(dto: CreateRoleDto) {
    const key = slugify(dto.name);
    if (!key) throw new BadRequestException('Invalid role name');
    try {
      return await this.prisma.role.create({
        data: {
          key,
          name: dto.name,
          description: dto.description,
          scope: dto.scope,
        },
      });
    } catch (e) {
      throw this.handleUnique(e, 'A role with that name already exists');
    }
  }

  async updateRole(id: string, dto: UpdateRoleDto) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found');
    try {
      return await this.prisma.role.update({
        where: { id },
        data: {
          ...(dto.name ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.scope ? { scope: dto.scope } : {}),
        },
      });
    } catch (e) {
      throw this.handleUnique(e, 'A role with that name already exists');
    }
  }

  async deleteRole(id: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) {
      throw new ForbiddenException('System roles cannot be deleted');
    }
    await this.prisma.role.delete({ where: { id } });
    return { id };
  }

  // --- Assignments --------------------------------------------------------

  listAssignments(filters: { roleId?: string; unitId?: string }) {
    return this.prisma.roleAssignment.findMany({
      where: {
        ...(filters.roleId ? { roleId: filters.roleId } : {}),
        ...(filters.unitId ? { unitId: filters.unitId } : {}),
      },
      include: {
        role: true,
        unit: true,
        user: {
          select: {
            id: true,
            name: true,
            employeeCode: true,
            employee: { select: { designation: true, department: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createAssignment(dto: CreateAssignmentDto) {
    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role) throw new NotFoundException('Role not found');

    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!user) throw new NotFoundException('Employee (user) not found');

    if (role.scope === 'UNIT' && !dto.unitId) {
      throw new BadRequestException(
        `Role "${role.name}" is unit-scoped — a unit is required`,
      );
    }
    const unitId = role.scope === 'GLOBAL' ? null : (dto.unitId ?? null);

    if (unitId) {
      const unit = await this.prisma.unit.findUnique({ where: { id: unitId } });
      if (!unit) throw new NotFoundException('Unit not found');
    }

    try {
      return await this.prisma.roleAssignment.create({
        data: { roleId: dto.roleId, userId: dto.userId, unitId },
        include: { role: true, unit: true, user: { select: { name: true } } },
      });
    } catch (e) {
      throw this.handleUnique(e, 'This person already holds that role here');
    }
  }

  async deleteAssignment(id: string) {
    await this.prisma.roleAssignment.delete({ where: { id } });
    return { id };
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
