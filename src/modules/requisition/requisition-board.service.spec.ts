import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { RequisitionBoardService } from './requisition-board.service';
import { hashActionToken } from '../../common/crypto/action-token';

/**
 * The CHRO's hand-off to the board: only from the CHRO step, only to board
 * members with an email, and the first emailed answer decides.
 */
describe('RequisitionBoardService', () => {
  const step = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    role: null as string | null,
    status: 'APPROVED',
    approverUserId: null,
    title: 'Approver',
    assignee: '',
    ...over,
  });

  function build(opts: {
    steps?: ReturnType<typeof step>[];
    canAct?: boolean;
    boardIds?: string[];
    users?: { id: string; name: string; email: string | null }[];
  }) {
    const steps = opts.steps ?? [
      step({ id: 's1' }),
      step({ id: 's2', role: 'CHRO', status: 'PENDING', title: 'CHRO' }),
    ];
    const req = {
      id: 'r1',
      code: 'REQ-2026-001',
      designation: 'Officer',
      unitFactory: 'JTML',
      department: 'HR',
      requiredPosts: 1,
      requirementType: 'NEW',
      raisedBy: 'Raiser',
      approvalSteps: steps,
    };
    const tx = {
      approvalStep: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'board-step' }),
      },
      requisitionActivity: { create: jest.fn() },
      requisition: { update: jest.fn() },
    };
    const prisma = {
      boardGroupMember: {
        findMany: jest.fn().mockResolvedValue(
          (opts.boardIds ?? ['b1', 'b2']).map((userId) => ({ userId })),
        ),
      },
      user: {
        findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          (
            opts.users ?? [
              { id: 'b1', name: 'Board One', email: 'one@dbl-group.com' },
              { id: 'b2', name: 'Board Two', email: 'two@dbl-group.com' },
            ]
          ).filter((u) => where.id.in.includes(u.id)),
        ),
      },
      requisitionBoardVote: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const requisitions = {
      loadForBoard: jest.fn().mockResolvedValue(req),
      mayActOnStep: jest.fn().mockResolvedValue(opts.canAct ?? true),
      finishDecision: jest.fn().mockResolvedValue({ ok: true }),
    };
    const mail = { send: jest.fn().mockResolvedValue({ messageId: 'x' }) };
    const config = { get: () => 'https://talenthub.example' };
    const svc = new RequisitionBoardService(
      prisma as never,
      requisitions as never,
      mail as never,
      config as never,
    );
    return { svc, prisma, tx, requisitions, mail };
  }

  const actor = { id: 'chro', name: 'The CHRO' };

  describe('sendToBoard', () => {
    it('appends a BOARD step and mails each chosen member a personal link', async () => {
      const { svc, tx, prisma, mail, requisitions } = build({});
      await svc.sendToBoard('r1', ['b1', 'b2'], 'Please review', actor);
      expect(tx.approvalStep.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'BOARD', status: 'PENDING' }),
        }),
      );
      expect(prisma.requisitionBoardVote.create).toHaveBeenCalledTimes(2);
      expect(mail.send).toHaveBeenCalledTimes(2);
      // Only the hash is stored; the link carries a different (raw) value.
      const stored = prisma.requisitionBoardVote.create.mock.calls[0][0].data.tokenHash;
      const html: string = mail.send.mock.calls[0][0].html;
      const raw = /requisition-board\/([a-f0-9]+)/.exec(html)![1];
      expect(stored).toBe(hashActionToken(raw));
      expect(html).not.toContain(stored);
      expect(requisitions.finishDecision).toHaveBeenCalled();
    });

    it('is refused unless the pending step is the CHRO step', async () => {
      const { svc } = build({
        steps: [step({ id: 's1', status: 'PENDING', title: 'Approver' })],
      });
      await expect(svc.sendToBoard('r1', ['b1'], '', actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('is refused to anyone who may not act on the CHRO step', async () => {
      const { svc } = build({ canAct: false });
      await expect(svc.sendToBoard('r1', ['b1'], '', actor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('takes only board members, and only those with an email', async () => {
      const notBoard = build({ boardIds: ['b1'] });
      await expect(
        notBoard.svc.sendToBoard('r1', ['b1', 'b2'], '', actor),
      ).rejects.toThrow('board groups');
      const noMail = build({
        users: [{ id: 'b1', name: 'No Mail', email: null }],
      });
      await expect(noMail.svc.sendToBoard('r1', ['b1'], '', actor)).rejects.toThrow(
        'no email',
      );
    });
  });

  describe('vote', () => {
    const vote = (over: Record<string, unknown> = {}) => ({
      id: 'v1',
      requisitionId: 'r1',
      stepId: 'board-step',
      status: 'pending',
      tokenExpiresAt: new Date(Date.now() + 60_000),
      user: { id: 'b1', name: 'Board One' },
      step: { status: 'PENDING', assignee: '' },
      requisition: { approvalSteps: [] },
      ...over,
    });

    it('the first answer decides the step and finishes the requisition', async () => {
      const { svc, prisma, tx, requisitions } = build({});
      prisma.requisitionBoardVote.findUnique.mockResolvedValue(vote());
      await expect(svc.vote('tok', 'approved')).resolves.toMatchObject({
        decision: 'approved',
      });
      expect(tx.requisition.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'APPROVED' } }),
      );
      expect(requisitions.finishDecision).toHaveBeenCalledWith(
        'r1',
        'approved',
        'Board One',
      );
    });

    it('a later answer finds it decided and changes nothing', async () => {
      const { svc, prisma, requisitions } = build({});
      prisma.requisitionBoardVote.findUnique.mockResolvedValue(
        vote({ step: { status: 'APPROVED', assignee: 'Board Two' } }),
      );
      await expect(svc.vote('tok', 'rejected', 'No')).resolves.toMatchObject({
        alreadyDecided: true,
      });
      expect(requisitions.finishDecision).not.toHaveBeenCalled();
    });

    it('a rejection needs a reason', async () => {
      const { svc, prisma } = build({});
      prisma.requisitionBoardVote.findUnique.mockResolvedValue(vote());
      await expect(svc.vote('tok', 'rejected', ' ')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('an expired link is refused', async () => {
      const { svc, prisma } = build({});
      prisma.requisitionBoardVote.findUnique.mockResolvedValue(
        vote({ tokenExpiresAt: new Date(Date.now() - 1) }),
      );
      await expect(svc.vote('tok', 'approved')).rejects.toThrow('expired');
    });
  });
});
