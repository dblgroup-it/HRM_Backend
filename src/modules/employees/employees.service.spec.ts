import { ForbiddenException, BadRequestException } from '@nestjs/common';

import { EmployeesService } from './employees.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../rbac/permissions.service';
import type { FileGrantService } from '../../common/files/file-grant.service';

/** Signatures are serialized as signed grants; the value is irrelevant here. */
const grants = () =>
  ({
    url: jest.fn((fileId: string | null) =>
      fileId ? `/api/files/grant-for-${fileId}` : null,
    ),
  }) as unknown as FileGrantService;

/**
 * Regression cover for the authorization gap on `PATCH /employees/:id`.
 *
 * The route reached production with no check of any kind: any signed-in user
 * could rewrite any of ~4,600 employees' name, personal phone, personal email,
 * gender and date of birth. These tests exist so that never silently returns.
 */
describe('EmployeesService.update — authorization', () => {
  const employeeRow = {
    id: 'emp-1',
    userId: 'user-1',
    user: { name: 'Someone', email: null, _count: { roleAssignments: 1 } },
  };

  function build(perms: Partial<PermissionsService>) {
    const prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue(employeeRow),
        update: jest.fn(),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    } as unknown as PrismaService;
    const service = new EmployeesService(
      prisma,
      perms as PermissionsService,
      grants(),
    );
    // findOne re-reads after a successful write; stub it out.
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
    return { service, prisma };
  }

  /**
   * `isEmployeeAdmin` is the single question the service asks — one definition
   * shared with signature uploads (EMPLOYEE_ADMIN_ROLES). These fixtures answer
   * it directly rather than restating how it is computed, so a change to the
   * role list does not need every test rewritten.
   */
  const denies = {
    isEmployeeAdmin: jest.fn().mockResolvedValue(false),
    isSuperUser: jest.fn().mockResolvedValue(false),
    getUserPermissions: jest
      .fn()
      .mockResolvedValue({ isSuperUser: false, roles: [], unitIds: [] }),
  };
  const allows = {
    isEmployeeAdmin: jest.fn().mockResolvedValue(true),
    isSuperUser: jest.fn().mockResolvedValue(false),
    getUserPermissions: jest.fn(),
  };

  it('refuses a signed-in user who holds no administrative role', async () => {
    const { service, prisma } = build(denies);
    await expect(
      service.update('emp-1', { name: 'Attacker' }, 'user-2'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a unit-scoped approver — holding any role is not enough', async () => {
    const { service } = build(denies);
    await expect(
      service.update('emp-1', { phone: '000' }, 'approver'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a super user', async () => {
    const { service, prisma } = build({
      isEmployeeAdmin: jest.fn().mockResolvedValue(true),
      isSuperUser: jest.fn().mockResolvedValue(true),
      getUserPermissions: jest.fn(),
    });
    await service.update('emp-1', { name: 'Corrected Name' }, 'root');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('allows Head of Talent Acquisition', async () => {
    const { service, prisma } = build(allows);
    await service.update('emp-1', { name: 'Corrected Name' }, 'hr');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('allows a Corporate Recruiter', async () => {
    // Added to the list on 2026-09-15: recruiters correct contact details in
    // the course of hiring, and were previously bounced to HR to do it.
    const { service, prisma } = build(allows);
    await service.update('emp-1', { phone: '+880000000000' }, 'recruiter');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('refuses an email already registered to another account', async () => {
    const { service, prisma } = build({
      isEmployeeAdmin: jest.fn().mockResolvedValue(true),
      isSuperUser: jest.fn().mockResolvedValue(true),
      getUserPermissions: jest.fn(),
    });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'other' });
    await expect(
      service.update('emp-1', { email: 'victim@dbl-group.com' }, 'root'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

/**
 * The detail view returns personal contact details to any signed-in user.
 *
 * Audit finding P-2 redacted `phone`, `email` and `dateOfBirth` for everyone
 * outside Corporate HR / CHRO / super. That was reversed on 2026-09-15 at the
 * business's explicit instruction — the directory is treated as internal, and
 * a colleague's number is something any employee may look up.
 *
 * This test exists because the audit document still describes the redaction,
 * and someone reading it later would reasonably "restore" the check and think
 * they were fixing a regression. They would be removing a decision. Changing
 * this behaviour is a business call, not a code cleanup.
 */
describe('EmployeesService.findOne — personal details', () => {
  const row = {
    id: 'emp-1',
    userId: 'user-1',
    employeeCode: '15100000',
    designation: 'Officer',
    department: 'Admin',
    lineManagerCode: null,
    dateOfBirth: new Date('1990-01-01'),
    user: {
      name: 'Test Employee',
      email: 'test.employee@example.invalid',
      phone: '+880000000000',
      _count: { roleAssignments: 1 },
    },
  };

  function build() {
    const prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue(row),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService;
    // Deliberately a user with nothing: no roles, not a super user.
    const perms = {
      isSuperUser: jest.fn().mockResolvedValue(false),
      getUserPermissions: jest
        .fn()
        .mockResolvedValue({ isSuperUser: false, roles: [], unitIds: [] }),
    } as unknown as PermissionsService;
    return new EmployeesService(prisma, perms, grants());
  }

  it('returns phone, email and date of birth to a user holding no role', async () => {
    const view = await build().findOne('emp-1', 'some-other-user');
    expect(view.phone).toBe('+880000000000');
    expect(view.email).toBe('test.employee@example.invalid');
    expect(view.dateOfBirth).not.toBeNull();
  });

  it('returns them when no actor is supplied at all', async () => {
    const view = await build().findOne('emp-1');
    expect(view.phone).toBe('+880000000000');
    expect(view.email).toBe('test.employee@example.invalid');
  });
});

/**
 * A signature is only ever served to the person it belongs to.
 *
 * It shipped the other way: `findOne` took an `actorId` and deliberately
 * ignored it, so any signed-in user could read any colleague's signature off
 * the employee page, and the directory listing carried one for every employee
 * in the company on a single request. Unlike a phone number — which the
 * business decided is internal and lookupable, see the block above — a
 * signature is the mark that goes on someone's offer letter, and a picture of
 * it is most of what is needed to forge one.
 *
 * Note the split this pins: HR can still see *whether* a signature is on file
 * and still manage it. It just cannot look at it.
 */
describe('EmployeesService — signature confidentiality', () => {
  const row = {
    id: 'emp-1',
    userId: 'user-1',
    employeeCode: '15100000',
    designation: 'Officer',
    lineManagerCode: null,
    user: {
      id: 'user-1',
      name: 'Test Employee',
      email: null,
      phone: null,
      signatureFileId: 'sig-file-1',
      signatureUploadedById: 'user-1',
      _count: { roleAssignments: 1 },
    },
  };

  function build() {
    const prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue(row),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([row]),
        count: jest.fn().mockResolvedValue(1),
      },
    } as unknown as PrismaService;
    // A super user, to show that even bypassing every scope check does not
    // hand over somebody else's signature — this is not a permission.
    const perms = {
      isSuperUser: jest.fn().mockResolvedValue(true),
      isEmployeeAdmin: jest.fn().mockResolvedValue(true),
      getUserPermissions: jest
        .fn()
        .mockResolvedValue({ isSuperUser: true, roles: [], unitIds: [] }),
    } as unknown as PermissionsService;
    return new EmployeesService(prisma, perms, grants());
  }

  it('gives the owner their own signature', async () => {
    const view = await build().findOne('emp-1', 'user-1');
    expect(view.signatureUrl).toBe('/api/files/grant-for-sig-file-1');
    expect(view.hasSignature).toBe(true);
  });

  it('withholds it from a colleague, and from a super user', async () => {
    const view = await build().findOne('emp-1', 'someone-else');
    expect(view.signatureUrl).toBeNull();
    // Still told one exists, so HR's manage/replace controls work.
    expect(view.hasSignature).toBe(true);
  });

  it('withholds it when no actor is supplied', async () => {
    expect((await build().findOne('emp-1')).signatureUrl).toBeNull();
  });

  it('never puts one on the directory listing', async () => {
    const page = await build().findAll({ page: 1, pageSize: 20 } as never);
    expect(page.items[0]).not.toHaveProperty('signatureUrl');
    expect(page.items[0].hasSignature).toBe(true);
  });
});
