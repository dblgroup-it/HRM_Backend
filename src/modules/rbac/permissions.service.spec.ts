import { ForbiddenException } from '@nestjs/common';

import {
  PermissionsService,
  type UserPermissions,
} from './permissions.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MemoryCacheService } from '../../common/cache/memory-cache.service';

/**
 * Unit isolation and the recruitment gate, which together decide who can reach
 * a candidate's CV, salary fixation and onboarding record.
 */
describe('PermissionsService — access boundaries', () => {
  function build(perms: UserPermissions) {
    const prisma = {
      interviewDelegation: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    // Pass-through cache so each call re-reads the stubbed permission set.
    const cache = {
      wrap: (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
      delete: jest.fn(),
      deleteByPrefix: jest.fn(),
    } as unknown as MemoryCacheService;
    const service = new PermissionsService(prisma, cache);
    jest.spyOn(service, 'getUserPermissions').mockResolvedValue(perms);
    return service;
  }

  const unitRole = (key: string, unitName: string): UserPermissions => ({
    isSuperUser: false,
    roles: [
      { key, name: key, scope: 'UNIT', unitId: 'u-' + unitName, unitName },
    ],
    unitIds: ['u-' + unitName],
  });

  it('does not let a unit-scoped role holder act in another unit', async () => {
    const svc = build(unitRole('corporate_hr', 'Unit A'));
    await expect(
      svc.hasRoleForUnitName('u1', 'corporate_hr', 'Unit B'),
    ).resolves.toBe(false);
  });

  it('matches the same unit across trailing-punctuation spellings', async () => {
    const svc = build(unitRole('corporate_hr', 'Jinnat Textile Mills Ltd.'));
    await expect(
      svc.hasRoleForUnitName('u1', 'corporate_hr', 'Jinnat Textile Mills Ltd'),
    ).resolves.toBe(true);
  });

  it('refuses recruitment access to a user with an unrelated role', async () => {
    const svc = build(unitRole('unit_approver', 'Unit A'));
    await expect(svc.canRunRecruitment('u1', 'Unit A', null)).resolves.toBe(
      false,
    );
    await expect(
      svc.requireRecruitmentAccess('u1', 'Unit A', null),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a recruiter assigned to a DIFFERENT requisition', async () => {
    const svc = build({ isSuperUser: false, roles: [], unitIds: [] });
    // 'someone-else' owns this requisition, not the caller.
    await expect(
      svc.canRunRecruitment('u1', 'Unit A', 'someone-else'),
    ).resolves.toBe(false);
  });

  it('admits the recruiter actually assigned to this requisition', async () => {
    const svc = build({ isSuperUser: false, roles: [], unitIds: [] });
    await expect(svc.canRunRecruitment('u1', 'Unit A', 'u1')).resolves.toBe(
      true,
    );
  });

  it('admits a super user anywhere', async () => {
    const svc = build({ isSuperUser: true, roles: [], unitIds: [] });
    await expect(
      svc.hasRoleForUnitName('root', 'corporate_hr', 'Any Unit'),
    ).resolves.toBe(true);
  });

  it("restricts requisition visibility to the user's own business", async () => {
    const svc = build(unitRole('requisition_raiser', 'Unit A'));
    const where = await svc.requisitionVisibility('u1');
    expect(where).toBeDefined();
    // Never an unrestricted query for a unit-scoped user.
    const json = JSON.stringify(where);
    expect(json).toContain('raisedById');
    expect(json).toContain('recruiterId');
  });

  it('places no restriction on CHRO / all-unit scope', async () => {
    const svc = build({
      isSuperUser: false,
      roles: [
        {
          key: 'chro',
          name: 'CHRO',
          scope: 'GLOBAL',
          unitId: null,
          unitName: null,
        },
      ],
      unitIds: [],
    });
    await expect(svc.requisitionVisibility('u1')).resolves.toBeUndefined();
  });
});
