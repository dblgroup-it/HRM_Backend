import { ForbiddenException } from '@nestjs/common';

import {
  PermissionsService,
  type UserPermissions,
} from './permissions.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MemoryCacheService } from '../../common/cache/memory-cache.service';

/**
 * Who a requisition's job analysis belongs to.
 *
 * Two rules meet here and both are easy to get subtly wrong:
 *  - a unit's Factory HR holders are layered — first priority, unless
 *    they are away, then the next — and a requisition already addressed to
 *    someone stays theirs alone until they go on leave;
 *  - Head of Talent Acquisition and the Corporate Recruiters are a FALLBACK for
 *    a unit with nobody available, never a parallel route.
 */
describe('PermissionsService — the job-analysis gate', () => {
  type QueueMember = {
    id: string;
    name: string;
    employeeCode: string;
    priority: number | null;
    onLeave: boolean;
  };

  /**
   * @param perms    the caller's own roles
   * @param queue    the unit's Factory HR layering, in priority order
   * @param holders  role key -> user ids, for the corporate fallback
   */
  function build(
    perms: UserPermissions,
    queue: QueueMember[],
    holders: Record<string, string[]> = {},
  ) {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'HR One' }) },
      // Only reached by the recruiter's "units with nobody available" clause.
      roleAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const cache = {
      wrap: (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
      delete: jest.fn(),
      deleteByPrefix: jest.fn(),
    } as unknown as MemoryCacheService;
    const service = new PermissionsService(prisma, cache);
    jest.spyOn(service, 'getUserPermissions').mockResolvedValue(perms);
    jest.spyOn(service, 'factoryHrQueue').mockResolvedValue(queue);
    jest
      .spyOn(service, 'roleHolderUserIds')
      .mockImplementation((key: string) => Promise.resolve(holders[key] ?? []));
    jest
      .spyOn(service, 'onLeaveUserIds')
      .mockResolvedValue(
        new Set(queue.filter((h) => h.onLeave).map((h) => h.id)),
      );
    return service;
  }

  const hr = (
    id: string,
    priority: number | null,
    onLeave = false,
  ): QueueMember => ({
    id,
    name: id.toUpperCase(),
    employeeCode: `E-${id}`,
    priority,
    onLeave,
  });

  const role = (key: string, unitName: string): UserPermissions => ({
    isSuperUser: false,
    roles: [
      { key, name: key, scope: 'UNIT', unitId: 'u-' + unitName, unitName },
    ],
    unitIds: ['u-' + unitName],
  });

  const nobody: UserPermissions = {
    isSuperUser: false,
    roles: [],
    unitIds: [],
  };

  const corporate = { corporate_hr: ['hr1'], corporate_recruiter: ['rec1'] };

  // --- the layering ---------------------------------------------------------

  it('goes to every Factory HR on duty, not only the first in line', async () => {
    const svc = build(nobody, [hr('fh1', 1), hr('fh2', 2)]);
    const owners = await svc.jobAnalysisOwners('JTML');
    expect(owners.assigneeId).toBeNull();
    expect(owners.userIds).toEqual(['fh1', 'fh2']);
    expect(owners.viaFactoryHr).toBe(true);
  });

  it('leaves out whoever is on leave; the rest of the queue carries it', async () => {
    const svc = build(nobody, [hr('fh1', 1, true), hr('fh2', 2), hr('fh3', 3)]);
    const owners = await svc.jobAnalysisOwners('JTML');
    expect(owners.userIds).toEqual(['fh2', 'fh3']);
    await expect(svc.canCompleteJobAnalysis('fh1', 'JTML', null)).resolves.toBe(
      false,
    );
    await expect(svc.canCompleteJobAnalysis('fh3', 'JTML', null)).resolves.toBe(
      true,
    );
  });

  it('falls back to the corporate side when the whole queue is away', async () => {
    const svc = build(
      nobody,
      [hr('fh1', 1, true), hr('fh2', 2, true)],
      corporate,
    );
    const owners = await svc.jobAnalysisOwners('JTML');
    expect(owners.viaFactoryHr).toBe(false);
    expect(owners.assigneeId).toBeNull();
    expect(owners.userIds.sort()).toEqual(['hr1', 'rec1']);
  });

  it('addresses nothing on a unit that never set an order', async () => {
    // No priorities: the unit keeps the behaviour it had before layering
    // existed — everyone is told, and any of them may write it.
    const svc = build(nobody, [hr('fh1', null), hr('fh2', null)]);
    const owners = await svc.jobAnalysisOwners('JTML');
    expect(owners.assigneeId).toBeNull();
    expect(owners.userIds.sort()).toEqual(['fh1', 'fh2']);
    expect(owners.viaFactoryHr).toBe(true);
  });

  // --- acting on one -------------------------------------------------------

  it('keeps an addressed requisition to the person it is addressed to', async () => {
    const svc = build(nobody, [hr('fh1', 1), hr('fh2', 2)]);
    await expect(
      svc.canCompleteJobAnalysis('fh1', 'JTML', 'fh1'),
    ).resolves.toBe(true);
    // Second in line does not get to reach past the first.
    await expect(
      svc.canCompleteJobAnalysis('fh2', 'JTML', 'fh1'),
    ).resolves.toBe(false);
    await expect(
      svc.requireJobAnalysisAccess('fh2', 'JTML', 'fh1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets any Factory HR take an unaddressed one in their unit', async () => {
    const svc = build(nobody, [hr('fh1', null), hr('fh2', null)]);
    await expect(svc.canCompleteJobAnalysis('fh2', 'JTML', null)).resolves.toBe(
      true,
    );
  });

  it('keeps Corporate HR out while the unit has someone available', async () => {
    const svc = build(nobody, [hr('fh1', 1)], corporate);
    await expect(svc.canCompleteJobAnalysis('hr1', 'JTML', 'fh1')).resolves.toBe(
      false,
    );
    await expect(svc.canCompleteJobAnalysis('rec1', 'JTML', null)).resolves.toBe(
      false,
    );
  });

  it('lets Corporate HR and the recruiters cover a unit with nobody', async () => {
    const svc = build(nobody, [], corporate);
    await expect(svc.canCompleteJobAnalysis('hr1', 'JTML', null)).resolves.toBe(
      true,
    );
    await expect(svc.canCompleteJobAnalysis('rec1', 'JTML', null)).resolves.toBe(
      true,
    );
  });

  it('refuses a raiser in the same unit', async () => {
    const svc = build(role('requisition_raiser', 'JTML'), [hr('fh1', 1)]);
    await expect(svc.canCompleteJobAnalysis('r1', 'JTML', 'fh1')).resolves.toBe(
      false,
    );
  });

  it('admits a super user, addressed to them or not', async () => {
    const svc = build({ isSuperUser: true, roles: [], unitIds: [] }, [
      hr('fh1', 1),
    ]);
    await expect(
      svc.canCompleteJobAnalysis('root', 'JTML', 'fh1'),
    ).resolves.toBe(true);
  });

  // --- what a Factory HR sees ---------------------------------------------

  it('shows a Factory HR what is addressed to them, and nothing else', async () => {
    const svc = build(role('factory_hr', 'JTML'), [hr('fh1', 1)]);
    const json = JSON.stringify(await svc.requisitionVisibility('fh1'));
    // By name…
    expect(json).toContain('jobAnalysisAssigneeId');
    // …plus unaddressed ones in their own unit, never a colleague's.
    expect(json).toContain('JTML');
    // And the one they wrote stays visible once it moves into the chain.
    expect(json).toContain('jobAnalysisById');
  });

  it('keeps waiting job analyses out of the list of a Factory HR on leave', async () => {
    const svc = build(role('factory_hr', 'JTML'), [hr('fh1', 1, true), hr('fh2', 2)]);
    const json = JSON.stringify(await svc.requisitionVisibility('fh1'));
    expect(json).not.toContain('PENDING_JOB_ANALYSIS');
    // What they already wrote stays theirs to see.
    expect(json).toContain('jobAnalysisById');
  });

  it('shows a stand-in the requisitions they are covering', async () => {
    const svc = build(role('corporate_recruiter', 'JTML'), []);
    const json = JSON.stringify(await svc.requisitionVisibility('rec1'));
    expect(json).toContain('coverRecruiterId');
  });
});
