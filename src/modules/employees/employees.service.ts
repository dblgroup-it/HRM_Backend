import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { buildMeta, Paginated } from '../../common/dto/pagination.dto';
import { QueryEmployeesDto } from './dto/query-employees.dto';
import { buildAvatarUrl } from '../../common/avatar.util';

/**
 * Employee rows carry their login plus a count of role assignments, so callers
 * can tell whether the person can actually sign in — `auth.service.ts` refuses
 * login to any non-ADMIN user with zero roles.
 */
const employeeInclude = {
  user: { include: { _count: { select: { roleAssignments: true } } } },
} satisfies Prisma.EmployeeInclude;

/**
 * What the directory listing returns — organisational facts only.
 *
 * `dateOfBirth`, `phone` and `email` are absent by design: see findAll().
 */
export type EmployeeListView = Omit<
  EmployeeView,
  'dateOfBirth' | 'phone' | 'email'
>;

export interface EmployeeView {
  id: string;
  /** Login/user id — used when assigning roles to this employee. */
  userId: string;
  employeeCode: string;
  name: string;
  avatarUrl: string | null;
  email: string | null;
  phone: string | null;
  designation: string | null;
  department: string | null;
  section: string | null;
  grade: string | null;
  category: string | null;
  unitName: string | null;
  location: string | null;
  gender: string | null;
  dateOfBirth: Date | null;
  joiningDate: Date | null;
  exitDate: Date | null;
  lineManagerName: string | null;
  lineManagerCode: string | null;
  /** Resolved employee id of the line manager, if they exist in the system. */
  lineManagerId: string | null;
  source: string;
  status: string;
  /** False when this person has no login yet (no roles, not an admin). */
  hasSystemAccess: boolean;
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Who may correct an employee's identity details.
   *
   * These columns are the HR master — name, personal phone, personal email,
   * gender and date of birth for every synced employee — and the route had no
   * check at all, so any signed-in user could rewrite any of them. Editing an
   * employee record is an HR administration act, so it is gated the same way
   * every other administrative surface is.
   */
  private async requireEmployeeAdmin(userId: string): Promise<void> {
    if (await this.permissions.isSuperUser(userId)) return;
    const perms = await this.permissions.getUserPermissions(userId);
    const allowed = perms.roles.some(
      (r) => r.key === 'corporate_hr' || r.key === 'chro',
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Only Head of Talent Acquisition, CHRO or a super user can edit employee records',
      );
    }
  }

  /**
   * The directory listing.
   *
   * Deliberately narrower than the detail view. This endpoint backs people
   * pickers, dropdowns and the employee table — none of which need a date of
   * birth, a personal mobile number or a personal email address, and every
   * signed-in user can call it for all ~4,600 employees. Those three fields are
   * returned only by `findOne`, and only to someone who may administer
   * employee records.
   *
   * POLICY: which roles see personal contact details on the detail view is a
   * business decision (audit finding P-2). It is expressed in one place,
   * `canSeePersonalDetails()`.
   */
  async findAll(
    query: QueryEmployeesDto,
  ): Promise<Paginated<EmployeeListView>> {
    const { page, pageSize, search, department, unit } = query;

    const where: Prisma.EmployeeWhereInput = {
      ...(department
        ? { department: { equals: department, mode: 'insensitive' } }
        : {}),
      ...(unit ? { unitName: { equals: unit, mode: 'insensitive' } } : {}),
      ...(search
        ? {
            OR: [
              { employeeCode: { contains: search, mode: 'insensitive' } },
              { designation: { contains: search, mode: 'insensitive' } },
              { user: { name: { contains: search, mode: 'insensitive' } } },
              { user: { email: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        include: employeeInclude,
        // Latest employees first (most recent joiner, then most recently added).
        orderBy: [
          { joiningDate: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.employee.count({ where }),
    ]);

    return {
      items: rows.map((row) => toListView(this.toView(row))),
      meta: buildMeta(page, pageSize, total),
    };
  }

  /**
   * Department → Section → Designation hierarchy derived from the synced ZingHR
   * employee data, optionally scoped to a unit. Powers the cascading dropdowns
   * on the requisition form.
   */
  async getStructure(unit?: string) {
    const deptMap = new Map<string, Map<string, Set<string>>>();
    const ensureDept = (dept: string) => {
      const map = deptMap.get(dept) ?? new Map<string, Set<string>>();
      deptMap.set(dept, map);
      return map;
    };
    const addEntry = (dept: string, section: string, designation: string) => {
      const d = dept.trim();
      if (!d) return;
      const s = section.trim() || 'General';
      const sectionMap = ensureDept(d);
      const designations = sectionMap.get(s) ?? new Set<string>();
      sectionMap.set(s, designations);
      const desig = designation.trim();
      if (desig) designations.add(desig);
    };

    // 1) Department → Section → Designation from ZingHR employee data.
    const rows = await this.prisma.employee.findMany({
      where: {
        department: { not: null },
        ...(unit ? { unitName: { equals: unit, mode: 'insensitive' } } : {}),
      },
      select: { department: true, section: true, designation: true },
    });
    for (const r of rows) {
      addEntry(r.department ?? '', r.section ?? '', r.designation ?? '');
    }

    // 2) Merge the configured organogram (Unit Config) so manually-added
    //    departments/seats (which may have no synced employees yet) also show.
    //    Organogram has no sections, so its seats sit under "General".
    const units = await this.prisma.unit.findMany({
      where: unit ? { name: { equals: unit, mode: 'insensitive' } } : {},
      include: { departments: { include: { positions: true } } },
    });
    for (const u of units) {
      for (const dept of u.departments) {
        const name = dept.name.trim();
        if (!name) continue;
        ensureDept(name); // make the department selectable even with no seats
        for (const p of dept.positions) {
          addEntry(name, p.section ?? '', p.designation);
        }
      }
    }

    const departments = [...deptMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([department, sectionMap]) => ({
        department,
        sections: [...sectionMap.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([section, designations]) => ({
            section,
            designations: [...designations].sort((a, b) => a.localeCompare(b)),
          })),
      }));

    return { departments };
  }

  /**
   * One employee's full record.
   *
   * Personal contact details and date of birth are returned only to someone who
   * may administer employee records — the same gate as editing them. Everyone
   * else gets the organisational profile, which is what the "Reports to" chain
   * and the people pickers actually need.
   */
  async findOne(id: string, actorId?: string): Promise<EmployeeView> {
    const row = await this.prisma.employee.findUnique({
      where: { id },
      include: employeeInclude,
    });
    if (!row) throw new NotFoundException('Employee not found');

    const view = this.toView(row);

    // Resolve the line manager's profile id (by their employee code) so the
    // UI can link "Reports to" through to the manager.
    if (row.lineManagerCode) {
      const manager = await this.prisma.employee.findFirst({
        where: { employeeCode: row.lineManagerCode },
        select: { id: true },
      });
      view.lineManagerId = manager?.id ?? null;
    }
    if (actorId && !(await this.canSeePersonalDetails(actorId))) {
      view.dateOfBirth = null;
      view.phone = null;
      view.email = null;
    }
    return view;
  }

  /** May this user see an employee's personal contact details and DOB? */
  private async canSeePersonalDetails(userId: string): Promise<boolean> {
    if (await this.permissions.isSuperUser(userId)) return true;
    const perms = await this.permissions.getUserPermissions(userId);
    return perms.roles.some(
      (r) => r.key === 'corporate_hr' || r.key === 'chro',
    );
  }

  async update(
    id: string,
    dto: {
      name?: string;
      phone?: string;
      email?: string;
      gender?: string;
      dateOfBirth?: string;
    },
    actorId: string,
  ) {
    await this.requireEmployeeAdmin(actorId);

    const emp = await this.prisma.employee.findUnique({
      where: { id },
      include: employeeInclude,
    });
    if (!emp) throw new NotFoundException('Employee not found');

    if (dto.email !== undefined && dto.email) {
      // Same rule as self-service profile editing: an address is a sign-in
      // identifier and the email-2FA delivery target, so it must not be
      // pointed at an address another account already uses.
      const clash = await this.prisma.user.findFirst({
        where: {
          email: { equals: dto.email.trim(), mode: 'insensitive' },
          NOT: { id: emp.userId },
        },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException(
          'That email address is already registered to another account.',
        );
      }
    }

    await this.prisma.$transaction([
      // User fields
      ...(dto.name !== undefined ||
      dto.phone !== undefined ||
      dto.email !== undefined
        ? [
            this.prisma.user.update({
              where: { id: emp.userId },
              data: {
                ...(dto.name !== undefined ? { name: dto.name } : {}),
                ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
                ...(dto.email !== undefined ? { email: dto.email } : {}),
              },
            }),
          ]
        : []),
      // Employee fields
      ...(dto.gender !== undefined || dto.dateOfBirth !== undefined
        ? [
            this.prisma.employee.update({
              where: { id },
              data: {
                ...(dto.gender !== undefined ? { gender: dto.gender } : {}),
                ...(dto.dateOfBirth !== undefined
                  ? { dateOfBirth: new Date(dto.dateOfBirth) }
                  : {}),
              },
            }),
          ]
        : []),
    ]);

    return this.findOne(id);
  }

  private toView(
    row: Prisma.EmployeeGetPayload<{ include: typeof employeeInclude }>,
  ): EmployeeView {
    return {
      id: row.id,
      userId: row.userId,
      employeeCode: row.employeeCode,
      name: row.user.name,
      avatarUrl: buildAvatarUrl(row.user.id, row.user.avatarFileId),
      email: row.user.email,
      phone: row.user.phone,
      designation: row.designation,
      department: row.department,
      section: row.section,
      grade: row.grade,
      category: row.category,
      unitName: row.unitName,
      location: row.location,
      gender: row.gender,
      dateOfBirth: row.dateOfBirth,
      joiningDate: row.joiningDate,
      exitDate: row.exitDate,
      lineManagerName: row.lineManagerName,
      lineManagerCode: row.lineManagerCode,
      lineManagerId: null,
      source: row.source,
      status: row.user.status,
      hasSystemAccess:
        row.user.role === 'ADMIN' || row.user._count.roleAssignments > 0,
    };
  }
}

/**
 * Strip personal data from a directory row.
 *
 * Done as an explicit projection rather than by narrowing the Prisma select,
 * because `toView` is shared with the detail view — and because a field that
 * has to be deleted here is obvious in review, whereas one that quietly rides
 * along in a shared serializer is not.
 */
function toListView(view: EmployeeView): EmployeeListView {
  const { dateOfBirth, phone, email, ...rest } = view;
  void dateOfBirth;
  void phone;
  void email;
  return rest;
}
