import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { buildMeta, Paginated } from '../../common/dto/pagination.dto';
import { QueryEmployeesDto } from './dto/query-employees.dto';

export interface EmployeeView {
  id: string;
  /** Login/user id — used when assigning roles to this employee. */
  userId: string;
  employeeCode: string;
  name: string;
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
}

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryEmployeesDto): Promise<Paginated<EmployeeView>> {
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
        include: { user: true },
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
      items: rows.map((row) => this.toView(row)),
      meta: buildMeta(page, pageSize, total),
    };
  }

  async findOne(id: string): Promise<EmployeeView> {
    const row = await this.prisma.employee.findUnique({
      where: { id },
      include: { user: true },
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
    return view;
  }

  private toView(
    row: Prisma.EmployeeGetPayload<{ include: { user: true } }>,
  ): EmployeeView {
    return {
      id: row.id,
      userId: row.userId,
      employeeCode: row.employeeCode,
      name: row.user.name,
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
    };
  }
}
