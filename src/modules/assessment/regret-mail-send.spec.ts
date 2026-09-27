import { ForbiddenException } from '@nestjs/common';

import { InterviewService } from './interview.service';

/**
 * The regret letter's send path, with the mailer and the database faked.
 *
 * What it pins: each candidate is judged on its own; a candidate is stamped
 * only once the mail has actually left; the master switch swallowing the mail
 * is reported as a failure, not recorded as sent; and whoever may not run the
 * candidate's interviews is refused.
 */
type Cand = {
  id: string;
  name: string;
  stage: string;
  email: string | null;
  notes: string | null;
  regretSentAt: Date | null;
  requisitionId: string;
  requisition: {
    designation: string;
    unitFactory: string;
    recruiterId: string | null;
    coverRecruiterId: null;
    coverUntil: null;
  };
};

const cand = (over: Partial<Cand>): Cand => ({
  id: 'c1',
  name: 'Rahim',
  stage: 'REJECTED',
  email: 'rahim@example.com',
  notes: null,
  regretSentAt: null,
  requisitionId: 'r1',
  requisition: {
    designation: 'Sewing Operator',
    unitFactory: 'JTML',
    recruiterId: null,
    coverRecruiterId: null,
    coverUntil: null,
  },
  ...over,
});

function build(opts: {
  rows: Cand[];
  messageId?: string;
  delegated?: boolean;
  recruiter?: boolean;
}) {
  const byId = new Map(opts.rows.map((r) => [r.id, r]));
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const prisma = {
    candidate: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(byId.get(where.id) ?? null),
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: where.id, data });
          return Promise.resolve({});
        },
      ),
    },
  };
  const permissions = {
    hasInterviewDelegation: jest.fn(() => Promise.resolve(Boolean(opts.delegated))),
    requireRecruitmentAccess: jest.fn(() =>
      opts.recruiter
        ? Promise.resolve()
        : Promise.reject(new ForbiddenException('Only the recruiter')),
    ),
  };
  const sent: { to: string; subject: string; text?: string }[] = [];
  const mail = {
    isConfigured: () => true,
    send: jest.fn((m: { to: string; subject: string; text?: string }) => {
      sent.push(m);
      return Promise.resolve({ messageId: opts.messageId ?? 'm-1' });
    }),
  };
  const notifications = { broadcastChange: jest.fn() };
  const svc = new InterviewService(
    prisma as never,
    permissions as never,
    notifications as never,
    mail as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, sent, updates, notifications };
}

const actor = { id: 'u1', name: 'Omar Faruque' };

describe('sendRegretMail', () => {
  it('sends the letter to a rejected candidate and stamps who sent it', async () => {
    const t = build({ rows: [cand({})], delegated: true });
    const res = await t.svc.sendRegretMail(['c1'], actor);
    expect(res).toMatchObject({ sent: 1, skipped: 0 });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].to).toBe('rahim@example.com');
    expect(t.sent[0].subject).toBe(
      'Application Update — Sewing Operator | DBL Group',
    );
    expect(t.sent[0].text).toMatch(/^Dear Applicant,/);
    expect(t.updates[0].data).toMatchObject({ regretSentById: 'u1' });
    expect(t.updates[0].data.regretSentAt).toBeInstanceOf(Date);
    expect(t.notifications.broadcastChange).toHaveBeenCalledTimes(1);
  });

  it('judges each candidate on its own and says which did not go', async () => {
    const t = build({
      rows: [
        cand({ id: 'ok' }),
        cand({ id: 'live', name: 'Karim', stage: 'INTERVIEW' }),
        cand({ id: 'nomail', name: 'Jamal', email: null }),
        cand({ id: 'done', name: 'Selim', regretSentAt: new Date() }),
      ],
      recruiter: true,
    });
    const res = await t.svc.sendRegretMail(
      ['ok', 'live', 'nomail', 'done', 'ok'],
      actor,
    );
    expect(res.sent).toBe(1);
    expect(res.skipped).toBe(3);
    expect(t.sent).toHaveLength(1);
    const errors = res.results.filter((r) => !r.ok).map((r) => r.error);
    expect(errors).toEqual([
      'Karim has not been rejected.',
      'Jamal has no email address on file.',
      'Selim has already been sent the regret mail.',
    ]);
  });

  it('does not record a letter the master switch swallowed', async () => {
    const t = build({ rows: [cand({})], recruiter: true, messageId: 'suppressed' });
    const res = await t.svc.sendRegretMail(['c1'], actor);
    expect(res).toMatchObject({ sent: 0, skipped: 1 });
    expect(res.results[0].error).toMatch(/switched off/);
    expect(t.updates).toHaveLength(0);
  });

  it('refuses someone who neither recruits nor was handed the candidate', async () => {
    const t = build({ rows: [cand({})] });
    const res = await t.svc.sendRegretMail(['c1'], actor);
    expect(res).toMatchObject({ sent: 0, skipped: 1 });
    expect(t.sent).toHaveLength(0);
  });
});
