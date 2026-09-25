import { RbacService } from './rbac.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from './permissions.service';

/**
 * Access Control and Approval Paths are one decision seen from two sides.
 *
 * A raiser's chain is their role made concrete, and a level naming somebody is
 * why they hold `unit_approver` at all. Removing the role and leaving the path
 * behind left a requisition routing to a person who could no longer sign in —
 * and Access Control claiming access the config no longer backed.
 */
describe('RbacService — removing a role clears what it held up', () => {
  function build(assignment: unknown, levels: { id: string; pathId: string }[] = []) {
    const deletedLevels: unknown[] = [];
    const levelUpdates: { id: string; orderIndex: number }[] = [];
    const prisma = {
      roleAssignment: {
        findUnique: jest.fn().mockResolvedValue(assignment),
        delete: jest.fn().mockResolvedValue({}),
      },
      approvalPath: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      approvalPathLevel: {
        findMany: jest
          .fn()
          // First call: the levels naming this person. Second: what is left,
          // for renumbering.
          .mockResolvedValueOnce(levels)
          .mockResolvedValue([{ id: 'keep-a' }, { id: 'keep-b' }]),
        deleteMany: jest.fn().mockImplementation((args: unknown) => {
          deletedLevels.push(args);
          return Promise.resolve({ count: levels.length });
        }),
        update: jest.fn().mockImplementation((args: { where: { id: string }; data: { orderIndex: number } }) => {
          levelUpdates.push({ id: args.where.id, orderIndex: args.data.orderIndex });
          return Promise.resolve({});
        }),
      },
      $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    const permissions = { invalidate: jest.fn() } as unknown as PermissionsService;
    return {
      service: new RbacService(prisma, permissions),
      prisma,
      deletedLevels,
      levelUpdates,
    };
  }

  const assignment = (roleKey: string) => ({
    id: 'ra1',
    userId: 'u1',
    unitId: 'unit1',
    role: { key: roleKey },
    unit: { name: 'Jinnat Textile Mills Ltd.' },
  });

  it("deletes a raiser's chain for that unit with the role", async () => {
    const { service, prisma } = build(assignment('requisition_raiser'));
    const res = await service.deleteAssignment('ra1');
    expect(prisma.approvalPath.deleteMany).toHaveBeenCalledWith({
      where: { unitId: 'unit1', raiserId: 'u1' },
    });
    expect(res.removed.paths).toBe(1);
  });

  it('takes an approver off every level in that unit', async () => {
    const { service, levelUpdates } = build(assignment('unit_approver'), [
      { id: 'lvl1', pathId: 'path1' },
    ]);
    const res = await service.deleteAssignment('ra1');
    expect(res.removed.levels).toBe(1);
    // Renumbered afterwards: orderIndex is unique per path and is copied onto
    // a requisition's steps, where a hole would collide with the Corporate HR
    // step appended at the end.
    expect(levelUpdates.filter((u) => u.orderIndex >= 0)).toEqual([
      { id: 'keep-a', orderIndex: 0 },
      { id: 'keep-b', orderIndex: 1 },
    ]);
    // Shifted through negatives first, so no two rows claim one index.
    expect(levelUpdates.some((u) => u.orderIndex < 0)).toBe(true);
  });

  it('leaves approval paths alone for any other role', async () => {
    const { service, prisma } = build(assignment('sbu_head'));
    const res = await service.deleteAssignment('ra1');
    expect(prisma.approvalPath.deleteMany).not.toHaveBeenCalled();
    expect(res.removed).toEqual({ paths: 0, levels: 0, jobAnalyses: 0 });
  });

  it('ignores a global assignment — there is no unit to clear', async () => {
    const { service, prisma } = build({
      id: 'ra1',
      userId: 'u1',
      unitId: null,
      role: { key: 'requisition_raiser' },
      unit: null,
    });
    await service.deleteAssignment('ra1');
    expect(prisma.approvalPath.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * Taking someone off Factory HR — say, to make them Factory HR Head — must
 * not leave job analyses addressed to them (they kept showing on their
 * dashboard), and must close the gap in the unit's layering.
 */
describe('RbacService — removing a Factory HR', () => {
  function build() {
    const prioritySet: { id: string; priority: number }[] = [];
    const prisma = {
      roleAssignment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ra1',
          userId: 'u1',
          unitId: 'unit1',
          roleId: 'role-fhr',
          role: { key: 'factory_hr' },
          unit: { name: 'Jinnat Textile Mills Ltd.' },
        }),
        delete: jest.fn().mockResolvedValue({}),
        // What is left in the unit after the delete: 2nd and 3rd priority.
        findMany: jest.fn().mockResolvedValue([
          { id: 'ra3', userId: 'u3', priority: 3, createdAt: new Date(3) },
          { id: 'ra2', userId: 'u2', priority: 2, createdAt: new Date(2) },
        ]),
        update: jest
          .fn()
          .mockImplementation(
            (a: { where: { id: string }; data: { priority: number } }) => {
              prioritySet.push({ id: a.where.id, priority: a.data.priority });
              return Promise.resolve({});
            },
          ),
      },
      requisition: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'q-same', unitFactory: 'Jinnat Textile Mills Ltd' },
          { id: 'q-other', unitFactory: 'Matin Spinning Mills Ltd' },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest
        .fn()
        .mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    const permissions = {
      invalidate: jest.fn(),
    } as unknown as PermissionsService;
    return {
      service: new RbacService(prisma, permissions),
      prisma,
      prioritySet,
    };
  }

  it('releases job analyses addressed to them in that unit only', async () => {
    const { service, prisma } = build();
    const res = await service.deleteAssignment('ra1');
    expect(prisma.requisition.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['q-same'] } },
      data: { jobAnalysisAssigneeId: null },
    });
    expect(res.removed.jobAnalyses).toBe(1);
  });

  it('moves 2nd and 3rd priority up to 1st and 2nd', async () => {
    const { service, prioritySet } = build();
    await service.deleteAssignment('ra1');
    expect(prioritySet).toEqual([
      { id: 'ra2', priority: 1 },
      { id: 'ra3', priority: 2 },
    ]);
  });
});
