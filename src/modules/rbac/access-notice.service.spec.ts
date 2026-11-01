import * as bcrypt from 'bcryptjs';

import { AccessNoticeService, GRANT_QUIET_MS } from './access-notice.service';

// A stand-in: the real default lives only in the server's .env.
const PW = 'Stand-In@26';
const DEFAULT_HASH = bcrypt.hashSync(PW, 4);
const OWN_HASH = bcrypt.hashSync('their-own-1', 4);

const role = (id: string, name: string, unit: string | null) => ({
  id,
  role: { name },
  unit: unit ? { name: unit } : null,
});

function build(opts: {
  email?: string | null;
  passwordHash?: string;
  mustChangePassword?: boolean;
  held?: ReturnType<typeof role>[];
  mailOn?: boolean;
}) {
  const user = {
    id: 'u1',
    name: 'Rahim Uddin',
    email: opts.email === undefined ? 'rahim@dbl-group.com' : opts.email,
    status: 'ACTIVE',
    role: 'MANAGEMENT',
    employeeCode: '15100001',
    passwordHash: opts.passwordHash ?? DEFAULT_HASH,
    mustChangePassword: opts.mustChangePassword ?? true,
  };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    roleAssignment: {
      findMany: jest.fn().mockResolvedValue(opts.held ?? []),
    },
  };
  const mail = {
    canDeliver: jest.fn().mockResolvedValue(opts.mailOn ?? true),
    send: jest.fn().mockResolvedValue({ messageId: 'm1' }),
  };
  const config = { get: () => 'https://talenthub.dbl-group.com' };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new AccessNoticeService(
    prisma as never,
    mail as never,
    config as never,
    audit as never,
  );
  return { svc, mail, prisma };
}

/** bcrypt works in setImmediate slices; let them run until `done`. */
async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('AccessNoticeService — a role was given', () => {
  const saved = process.env.DEFAULT_USER_PASSWORD;
  beforeEach(() => {
    process.env.DEFAULT_USER_PASSWORD = PW;
    // The window is a setTimeout; bcrypt's own slicing must stay real.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (saved === undefined) delete process.env.DEFAULT_USER_PASSWORD;
    else process.env.DEFAULT_USER_PASSWORD = saved;
  });

  it('sends one letter for grants made in one sitting, once they stop', async () => {
    const { svc, mail } = build({
      held: [
        role('a1', 'Factory HR', 'DBL Ceramics'),
        role('a2', 'Requisition Raiser', 'DBL Ceramics'),
      ],
    });
    await expect(svc.roleGranted('u1', 'a1')).resolves.toEqual({
      status: 'queued',
      email: 'rahim@dbl-group.com',
    });
    await jest.advanceTimersByTimeAsync(GRANT_QUIET_MS - 1_000);
    await svc.roleGranted('u1', 'a2');
    // The second grant restarted the wait.
    await jest.advanceTimersByTimeAsync(GRANT_QUIET_MS - 1_000);
    expect(mail.send).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    await settle(() => mail.send.mock.calls.length > 0);

    expect(mail.send).toHaveBeenCalledTimes(1);
    const sent = mail.send.mock.calls[0][0];
    expect(sent.to).toBe('rahim@dbl-group.com');
    expect(sent.subject).toBe('Your TalentHub access and sign-in details');
    expect(sent.text).toContain('Factory HR');
    expect(sent.text).toContain('Requisition Raiser');
    expect(sent.text).toContain(PW);
  });

  it('leaves the password out once they have their own', async () => {
    const { svc, mail } = build({
      passwordHash: OWN_HASH,
      mustChangePassword: false,
      held: [role('a1', 'Factory HR', 'DBL Ceramics')],
    });
    await svc.roleGranted('u1', 'a1');
    await jest.advanceTimersByTimeAsync(GRANT_QUIET_MS);
    await settle(() => mail.send.mock.calls.length > 0);
    const sent = mail.send.mock.calls[0][0];
    expect(sent.subject).toBe('Your TalentHub access and sign-in details');
    expect(sent.text).not.toContain(PW);
  });

  it('sends a second unit with no password, even before they first sign in', async () => {
    // Still on the default — but they were already given access once.
    const { svc, mail } = build({
      held: [
        role('old', 'Unit Approver', 'DBL Ceramics'),
        role('a1', 'Factory HR', 'Jinnat Textile Mills Ltd.'),
      ],
    });
    await svc.roleGranted('u1', 'a1');
    await jest.advanceTimersByTimeAsync(GRANT_QUIET_MS);
    await settle(() => mail.send.mock.calls.length > 0);
    const sent = mail.send.mock.calls[0][0];
    expect(sent.subject).toBe('New access in TalentHub');
    expect(sent.text).toContain('Jinnat Textile Mills Ltd.');
    expect(sent.text).not.toContain(PW);
    expect(sent.text).not.toContain('15100001');
  });

  it('says nothing about a grant taken back inside the window', async () => {
    const { svc, mail } = build({ held: [] });
    await svc.roleGranted('u1', 'a1');
    await jest.advanceTimersByTimeAsync(GRANT_QUIET_MS);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('tells the page when there is no address, or email is off', async () => {
    await expect(
      build({ email: null }).svc.roleGranted('u1', 'a1'),
    ).resolves.toEqual({ status: 'no_email', email: null });
    await expect(
      build({ mailOn: false }).svc.roleGranted('u1', 'a1'),
    ).resolves.toEqual({ status: 'mail_off', email: 'rahim@dbl-group.com' });
  });
});
