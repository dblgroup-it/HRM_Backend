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
    expect(res.removed).toEqual({ paths: 0, levels: 0 });
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
