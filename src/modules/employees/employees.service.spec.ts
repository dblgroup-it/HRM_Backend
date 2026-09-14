import { ForbiddenException, BadRequestException } from '@nestjs/common';

import { EmployeesService } from './employees.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../rbac/permissions.service';

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
    const service = new EmployeesService(prisma, perms as PermissionsService);
    // findOne re-reads after a successful write; stub it out.
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
    return { service, prisma };
  }

  const noRoles = {
    isSuperUser: jest.fn().mockResolvedValue(false),
    getUserPermissions: jest
      .fn()
      .mockResolvedValue({ isSuperUser: false, roles: [], unitIds: [] }),
  };

  it('refuses a signed-in user who holds no administrative role', async () => {
    const { service, prisma } = build(noRoles);
    await expect(
      service.update('emp-1', { name: 'Attacker' }, 'user-2'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a unit-scoped approver — holding any role is not enough', async () => {
    const { service } = build({
      isSuperUser: jest.fn().mockResolvedValue(false),
      getUserPermissions: jest.fn().mockResolvedValue({
        isSuperUser: false,
        roles: [{ key: 'unit_approver', unitId: 'u1', unitName: 'Unit A' }],
        unitIds: ['u1'],
      }),
    });
    await expect(
      service.update('emp-1', { phone: '000' }, 'approver'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a super user', async () => {
    const { service, prisma } = build({
      isSuperUser: jest.fn().mockResolvedValue(true),
      getUserPermissions: jest.fn(),
    });
    await service.update('emp-1', { name: 'Corrected Name' }, 'root');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('allows Head of Talent Acquisition', async () => {
    const { service, prisma } = build({
      isSuperUser: jest.fn().mockResolvedValue(false),
      getUserPermissions: jest.fn().mockResolvedValue({
        isSuperUser: false,
        roles: [{ key: 'corporate_hr', unitId: null, unitName: null }],
        unitIds: [],
      }),
    });
    await service.update('emp-1', { name: 'Corrected Name' }, 'hr');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('refuses an email already registered to another account', async () => {
    const { service, prisma } = build({
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
