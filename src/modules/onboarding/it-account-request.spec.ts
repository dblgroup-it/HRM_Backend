import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { hashActionToken } from '../../common/crypto/action-token';
import { ItAccountRequestService } from './it-account-request.service';

/**
 * "Notify IT": HR asks, IT answers from the link, and the answer is what
 * completes the onboarding. Tested against the real service with a fake
 * Prisma, so the gates and the hand-offs are what is exercised.
 */

const REQUESTER = {
  id: 'hr-1',
  name: 'Moniruzzaman Monir',
  email: 'monir@dbl-group.com',
  phone: '01332827480',
  employee: { designation: 'IT Infrastructure', department: 'Glory Complex' },
};

/** The users `findMany` looks up by employee code — leavers and Cc picks alike. */
const DIRECTORY = [
  {
    employeeCode: '15108727',
    name: 'Md. Rasel Rana',
    email: 'rasel.rana@dbl-group.com',
    employee: { designation: 'Executive' },
  },
  {
    employeeCode: '15100001',
    name: 'Moved Person',
    email: 'moved@dbl-group.com',
    employee: { designation: 'Officer' },
  },
  {
    employeeCode: '15104846',
    name: 'Nusrat Jahan',
    email: 'nusrat.jahan@dbl-group.com',
    employee: { designation: 'Manager, HR' },
  },
  {
    employeeCode: '15109999',
    name: 'No Mail',
    email: null,
    employee: { designation: 'Operator' },
  },
  {
    employeeCode: '15100002',
    name: 'IT Desk',
    email: 'HR-LT-REQ@dbl-group.com',
    employee: null,
  },
];

function onboarding(over: Record<string, unknown> = {}) {
  return {
    id: 'ob-1',
    candidateId: 'c-1',
    hrVerifiedAt: new Date('2026-10-10T08:00:00Z'),
    itNotifiedAt: null,
    itEmail: null,
    fixedDesignation: null,
    offerJoiningTentative: new Date('2026-10-20T00:00:00Z'),
    offerJoiningDate: null,
    itRequest: null,
    candidate: {
      id: 'c-1',
      name: 'Sudansha Kirtonia',
      employeeId: '15112345',
      requisitionId: 'r-1',
      requisition: {
        id: 'r-1',
        unitFactory: 'Glory Textile & Apparels Ltd.',
        lineOfBusiness: 'RMG Division',
        designation: 'Executive',
        department: 'Quality',
        recruiterId: 'rec-1',
        coverRecruiterId: null,
        coverUntil: null,
        requirementType: 'EXISTING',
        replaceOfName: null,
        replaceOfEmployeeCode: null,
        separationReason: null,
        replacements: [
          {
            employeeName: 'Md. Rasel Rana',
            employeeCode: '15108727',
            separationReason: 'Terminated',
          },
          {
            employeeName: 'Moved Person',
            employeeCode: '15100001',
            separationReason: 'Transferred',
          },
        ],
      },
    },
    ...over,
  };
}

function build(
  opts: {
    ob?: Record<string, unknown>;
    boardApproved?: boolean;
    deliverable?: boolean;
    sendFails?: boolean;
    row?: Record<string, unknown> | null;
  } = {},
) {
  const ob = onboarding(opts.ob);
  const saved: Record<string, unknown>[] = [];
  const prisma = {
    onboarding: {
      findUnique: jest.fn().mockResolvedValue(ob),
      update: jest.fn().mockResolvedValue(ob),
    },
    boardApproval: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.boardApproved === false ? null : { id: 'ba-1' },
        ),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(REQUESTER),
      findMany: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { employeeCode: { in: string[] } } }) =>
            Promise.resolve(
              DIRECTORY.filter((u) =>
                where.employeeCode.in.includes(u.employeeCode),
              ),
            ),
        ),
    },
    itAccountRequest: {
      create: jest.fn().mockImplementation(({ data }) => {
        const row = { id: 'it-1', sendCount: 1, completedAt: null, ...data };
        saved.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'it-1',
          sentAt: new Date(),
          lastSentAt: new Date(),
          tokenExpiresAt: new Date(Date.now() + 86_400_000),
          sendCount: 1,
          sentTo: 'hr-lt-req@dbl-group.com',
          subject: 's',
          sentByName: REQUESTER.name,
          platform: 'Google',
          deletions: [],
          completedAt: null,
          deletionsDone: null,
          confirmationSentAt: null,
          closedAt: null,
          ...data,
        }),
      ),
      delete: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(opts.row ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const mail = {
    canDeliver: jest.fn().mockResolvedValue(opts.deliverable ?? true),
    send: opts.sendFails
      ? jest.fn().mockRejectedValue(new Error('SMTP down'))
      : jest.fn().mockResolvedValue({ messageId: '<abc@mail.gmail.com>' }),
  };
  const notifications = {
    notify: jest.fn().mockResolvedValue(undefined),
    notifyMany: jest.fn().mockResolvedValue(undefined),
    broadcastChange: jest.fn(),
  };
  const permissions = {
    requireRecruitmentAccess: jest.fn().mockResolvedValue(undefined),
    recruitmentRecipients: jest
      .fn()
      .mockResolvedValue(['hr-1', 'rec-1', 'hota-1']),
  };
  const settings = {
    getItRequestConfig: jest.fn().mockResolvedValue({
      recipients: ['hr-lt-req@dbl-group.com'],
      salutation: 'Farhad bhai',
      platform: 'Google',
    }),
  };
  const config = { get: () => 'https://talenthub.dbl-group.com' };
  const svc = Object.create(
    ItAccountRequestService.prototype,
  ) as ItAccountRequestService;
  Object.assign(svc, {
    prisma,
    mail,
    notifications,
    permissions,
    settings,
    config,
    logger: { error: jest.fn(), warn: jest.fn() },
  });
  return { svc, prisma, mail, notifications, saved };
}

const DTO = {
  preferredEmail: 'quality.accesories@glory-dbl.com',
  platform: 'Google',
  purpose: 'Buyers and suppliers.',
  deletions: [
    {
      name: 'Md. Rasel Rana',
      code: '15108727',
      email: 'rasel.rana@dbl-group.com',
      reason: 'Terminated',
    },
  ],
};

describe('ItAccountRequestService: sending the request', () => {
  it('starts from the requisition: the purpose, and the leavers with their addresses', async () => {
    const { svc } = build();
    const d = await svc.draft('c-1', 'hr-1');
    expect(d.recipients).toEqual(['hr-lt-req@dbl-group.com']);
    expect(d.purpose).toBe(
      'This account will be used for official communication as Executive, Quality.',
    );
    expect(d.deletions).toEqual([
      expect.objectContaining({
        name: 'Md. Rasel Rana',
        email: 'rasel.rana@dbl-group.com',
        include: true,
      }),
      // Still with the group — not ticked for deletion by default.
      expect.objectContaining({
        name: 'Moved Person',
        email: 'moved@dbl-group.com',
        include: false,
      }),
    ]);
  });

  it('offers no deletion for a new post', async () => {
    const ob = onboarding();
    (ob.candidate.requisition as Record<string, unknown>).requirementType =
      'NEW';
    const { svc } = build({ ob: { candidate: ob.candidate } });
    expect((await svc.draft('c-1', 'hr-1')).deletions).toEqual([]);
  });

  it('refuses before final verification, before board approval, and once complete', async () => {
    await expect(
      build({ ob: { hrVerifiedAt: null } }).svc.send('c-1', DTO, {
        id: 'hr-1',
      }),
    ).rejects.toThrow('Complete HR final verification');
    await expect(
      build({ boardApproved: false }).svc.send('c-1', DTO, { id: 'hr-1' }),
    ).rejects.toThrow('Board Approval is required');
    await expect(
      build({ ob: { itNotifiedAt: new Date() } }).svc.send('c-1', DTO, {
        id: 'hr-1',
      }),
    ).rejects.toThrow('already complete');
  });

  it('refuses when email cannot reach IT, rather than pretending it went', async () => {
    const { svc, mail } = build({ deliverable: false });
    await expect(svc.send('c-1', DTO, { id: 'hr-1' })).rejects.toThrow(
      'Outgoing email is switched off',
    );
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('names a bad address instead of sending', async () => {
    const { svc } = build();
    await expect(
      svc.send(
        'c-1',
        { ...DTO, preferredEmail: 'not-an-address' },
        { id: 'hr-1' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.send(
        'c-1',
        {
          ...DTO,
          deletions: [{ name: 'X', code: null, email: '', reason: null }],
        },
        { id: 'hr-1' },
      ),
    ).rejects.toThrow("Enter X's email address");
  });

  it('mails IT, copies nobody unasked, and keeps only a hash of the link', async () => {
    const { svc, mail, saved, prisma } = build();
    await svc.send('c-1', DTO, { id: 'hr-1' });

    expect(mail.send).toHaveBeenCalledTimes(1);
    const sent = mail.send.mock.calls[0][0];
    expect(sent.to).toBe('hr-lt-req@dbl-group.com');
    // The requester is not copied by default (owner's decision, 2026-10-13);
    // an answer by email still reaches them.
    expect(sent.cc).toBeUndefined();
    expect(sent.replyTo).toBe('monir@dbl-group.com');
    expect(saved[0].cc).toEqual([]);
    expect(sent.subject).toBe(
      "Request for New Email Account Creation and Deletion of Terminated Employee's Email — Sudansha Kirtonia",
    );
    expect(sent.text).toContain('Dear Farhad bhai,');
    expect(sent.text).toContain('Employee ID: 15112345');
    expect(sent.text).toContain('Joining Date: 20 October 2026');

    const link =
      /https:\/\/talenthub\.dbl-group\.com\/it-request\/([0-9a-f]{64})/.exec(
        sent.text,
      );
    expect(link).not.toBeNull();
    const raw = link![1];
    expect(saved[0].tokenHash).toBe(hashActionToken(raw));
    expect(JSON.stringify(saved[0])).not.toContain(raw);
    // The Message-ID is kept so IT's answer threads under it.
    expect(prisma.itAccountRequest.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { messageId: '<abc@mail.gmail.com>' } }),
    );
  });

  it('copies the people HR picked from the directory, each once, never IT itself', async () => {
    const { svc, mail, saved } = build();
    await svc.send(
      'c-1',
      { ...DTO, ccCodes: ['15104846', ' 15104846', '15100002'] },
      { id: 'hr-1' },
    );
    expect(mail.send.mock.calls[0][0].cc).toBe('nusrat.jahan@dbl-group.com');
    expect(saved[0].cc).toEqual([
      {
        code: '15104846',
        name: 'Nusrat Jahan',
        designation: 'Manager, HR',
        email: 'nusrat.jahan@dbl-group.com',
      },
    ]);
  });

  it('shows the copied people in the preview, and refuses one with no address', async () => {
    const { svc, mail } = build();
    const preview = await svc.preview(
      'c-1',
      { ...DTO, ccCodes: ['15109999', '15104846'] },
      'hr-1',
    );
    expect(preview.cc.map((c) => [c.name, c.email])).toEqual([
      ['No Mail', null],
      ['Nusrat Jahan', 'nusrat.jahan@dbl-group.com'],
    ]);
    await expect(
      svc.send('c-1', { ...DTO, ccCodes: ['15109999'] }, { id: 'hr-1' }),
    ).rejects.toThrow('No Mail has no email address');
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('answers for every pick — one already the To address is marked, not dropped', async () => {
    // Dropping it silently left the dialog spinning on "Looking up the
    // address…" for a person whose address was the IT one (2026-10-13).
    const { svc, mail } = build();
    const preview = await svc.preview(
      'c-1',
      { ...DTO, ccCodes: ['15100002', '15104846'] },
      'hr-1',
    );
    expect(preview.cc.map((c) => [c.code, c.email, c.skip])).toEqual([
      ['15100002', 'HR-LT-REQ@dbl-group.com', 'to'],
      ['15104846', 'nusrat.jahan@dbl-group.com', null],
    ]);
    // …and it does not stop the request going, nor go on CC.
    await svc.send('c-1', { ...DTO, ccCodes: ['15100002'] }, { id: 'hr-1' });
    expect(mail.send.mock.calls[0][0].cc).toBeUndefined();
  });

  it('starts a re-send from the people copied last time', async () => {
    const copied = [
      {
        code: '15104846',
        name: 'Nusrat Jahan',
        designation: 'Manager, HR',
        email: 'nusrat.jahan@dbl-group.com',
      },
    ];
    const { svc } = build({
      ob: {
        itRequest: {
          id: 'it-1',
          sentTo: 'hr-lt-req@dbl-group.com',
          subject: 's',
          sentAt: new Date(),
          lastSentAt: new Date(),
          sendCount: 1,
          sentByName: REQUESTER.name,
          preferredEmail: null,
          platform: 'Google',
          purpose: null,
          deletions: [],
          cc: copied,
          tokenExpiresAt: new Date(Date.now() + 86_400_000),
          completedAt: null,
          deletionsDone: null,
          confirmationSentAt: null,
          closedAt: null,
        },
      },
    });
    expect((await svc.draft('c-1', 'hr-1')).cc).toEqual(copied);
    expect((await build().svc.draft('c-1', 'hr-1')).cc).toEqual([]);
  });

  it('removes a first request whose email did not leave', async () => {
    const { svc, prisma } = build({ sendFails: true });
    await expect(svc.send('c-1', DTO, { id: 'hr-1' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.itAccountRequest.delete).toHaveBeenCalledWith({
      where: { id: 'it-1' },
    });
  });
});

describe('ItAccountRequestService: IT answering from the link', () => {
  const RAW = 'a'.repeat(64);
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'it-1',
      sentTo: 'hr-lt-req@dbl-group.com',
      subject:
        "Request for New Email Account Creation and Deletion of Terminated Employee's Email — Sudansha Kirtonia",
      employeeName: 'Sudansha Kirtonia',
      messageId: '<abc@mail.gmail.com>',
      sentById: 'hr-1',
      sentByName: REQUESTER.name,
      sentBy: { id: 'hr-1', name: REQUESTER.name, email: REQUESTER.email },
      deletions: [
        {
          name: 'Md. Rasel Rana',
          code: '15108727',
          email: 'rasel.rana@dbl-group.com',
          reason: null,
        },
      ],
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
      lastSentAt: new Date(),
      completedAt: null,
      closedAt: null,
      closedReason: null,
      onboarding: onboarding(),
      ...over,
    };
  }
  const ANSWER = {
    createdEmail: 'quality.accesories@glory-dbl.com',
    completedByName: 'Md. Farhad Hossain',
    deleted: ['rasel.rana@dbl-group.com'],
  };

  it('records the address, completes onboarding and replies in DBL’s format', async () => {
    const { svc, prisma, mail, notifications } = build({ row: row() });
    await expect(svc.completeByToken(RAW, ANSWER)).resolves.toEqual({
      ok: true,
      alreadyCompleted: false,
    });

    expect(prisma.itAccountRequest.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashActionToken(RAW) } }),
    );
    expect(prisma.onboarding.update).toHaveBeenCalledWith({
      where: { id: 'ob-1' },
      data: expect.objectContaining({
        itEmail: 'quality.accesories@glory-dbl.com',
        status: 'onboarded',
        itNotifiedAt: expect.any(Date),
      }),
    });

    const reply = mail.send.mock.calls[0][0];
    expect(reply.to).toBe('monir@dbl-group.com');
    expect(reply.cc).toBe('hr-lt-req@dbl-group.com');
    expect(reply.inReplyTo).toBe('<abc@mail.gmail.com>');
    expect(
      reply.subject.startsWith('Re: Request for New Email Account Creation'),
    ).toBe(true);
    expect(reply.text).toContain(
      'Both requests have been completed successfully as per your request.',
    );
    expect(reply.text).toContain('Email Account Deleted');
    expect(reply.text).toContain('Thanks & Regards,\n\nMd. Farhad Hossain');

    // The requester already has the reply — no second, generic email.
    expect(notifications.notify).toHaveBeenCalledWith(
      'hr-1',
      expect.objectContaining({ title: 'Work email created', skipEmail: true }),
    );
    expect(notifications.notifyMany).toHaveBeenCalledWith(
      ['rec-1', 'hota-1'],
      expect.objectContaining({ title: 'Work email created' }),
    );
  });

  it('replies to everyone HR copied, as a reply-all would', async () => {
    const { svc, mail } = build({
      row: row({
        cc: [
          {
            code: '15104846',
            name: 'Nusrat Jahan',
            designation: null,
            email: 'nusrat.jahan@dbl-group.com',
          },
          // The requester copied themselves: they are already the To.
          { code: 'x', name: 'Me', designation: null, email: REQUESTER.email },
        ],
      }),
    });
    await svc.completeByToken(RAW, ANSWER);
    const reply = mail.send.mock.calls[0][0];
    expect(reply.to).toBe('monir@dbl-group.com');
    expect(reply.cc).toBe(
      'hr-lt-req@dbl-group.com, nusrat.jahan@dbl-group.com',
    );
  });

  it('does not overwrite an onboarding HR already completed by hand', async () => {
    const { svc, prisma } = build({
      row: row({
        onboarding: onboarding({
          itNotifiedAt: new Date(),
          itEmail: 'kept@dbl-group.com',
        }),
      }),
    });
    await svc.completeByToken(RAW, ANSWER);
    expect(prisma.onboarding.update).not.toHaveBeenCalled();
  });

  it('answers only once', async () => {
    const done = build({ row: row({ completedAt: new Date() }) });
    await expect(done.svc.completeByToken(RAW, ANSWER)).resolves.toEqual({
      ok: true,
      alreadyCompleted: true,
    });
    expect(done.mail.send).not.toHaveBeenCalled();

    const raced = build({ row: row() });
    raced.prisma.itAccountRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(raced.svc.completeByToken(RAW, ANSWER)).resolves.toEqual({
      ok: true,
      alreadyCompleted: true,
    });
    expect(raced.prisma.onboarding.update).not.toHaveBeenCalled();
  });

  it('refuses a closed, expired or half-filled answer', async () => {
    await expect(
      build({
        row: row({ closedAt: new Date(), closedReason: 'recorded by hand' }),
      }).svc.completeByToken(RAW, ANSWER),
    ).rejects.toThrow('HR has already closed this request');
    await expect(
      build({
        row: row({ tokenExpiresAt: new Date(Date.now() - 1000) }),
      }).svc.completeByToken(RAW, ANSWER),
    ).rejects.toThrow('expired');
    await expect(
      build({ row: row() }).svc.completeByToken(RAW, {
        ...ANSWER,
        createdEmail: 'nope',
      }),
    ).rejects.toThrow('Enter the email address you created');
    await expect(
      build({ row: row() }).svc.completeByToken(RAW, {
        ...ANSWER,
        completedByName: ' ',
      }),
    ).rejects.toThrow('Enter your name');
  });
});
