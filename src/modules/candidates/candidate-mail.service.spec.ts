import { CandidateMailService } from './candidate-mail.service';

/**
 * Who is written to, and when, with the mailer and the database faked.
 *
 * What it pins: a referral is written about once however often it is
 * reached (the queue and the overdue sweep can both get there); each
 * referred candidate with an address gets their own letter; the referrer
 * gets one listing everybody, including those whose CV carried no address;
 * a referrer who turned email off, or has left, is not written to; and an
 * applicant's confirmation links their own status page.
 */

const requisition = {
  designation: 'Senior Merchandiser',
  alternateDesignations: ['Merchandiser'],
  unitFactory: 'Jinnat Textile Mills Ltd.',
  placeOfPosting: 'Gazipur',
};

function build(opts: {
  candidates?: { id: string; name: string; email: string | null }[];
  referrer?: {
    name: string;
    email: string | null;
    status: 'ACTIVE' | 'INACTIVE';
    emailNotifications: boolean;
  } | null;
  configured?: boolean;
  failFor?: string;
}) {
  const claimed = new Set<string>();
  const prisma = {
    candidateReferral: {
      updateMany: jest.fn(({ where }: { where: { id: string } }) => {
        if (claimed.has(where.id)) return Promise.resolve({ count: 0 });
        claimed.add(where.id);
        return Promise.resolve({ count: 1 });
      }),
      findUnique: jest.fn(() =>
        Promise.resolve({
          referenceNo: 7,
          createdAt: new Date('2026-10-04T06:00:00Z'),
          referrerCode: '15106254',
          referrerName: 'Md. Kamrul Hasan',
          requisition,
          candidates: opts.candidates ?? [],
        }),
      ),
    },
    user: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          opts.referrer === undefined
            ? {
                name: 'Md. Kamrul Hasan',
                email: 'kamrul@dbl-group.com',
                status: 'ACTIVE',
                emailNotifications: true,
              }
            : opts.referrer,
        ),
      ),
    },
    candidate: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          name: 'Nusrat Jahan',
          email: 'nusrat@example.com',
          applicationNo: 31,
          createdAt: new Date('2026-10-04T06:00:00Z'),
          requisition,
        }),
      ),
    },
  };
  const sent: { to: string; subject: string; text?: string; html?: string }[] =
    [];
  const mail = {
    isConfigured: () => opts.configured ?? true,
    send: jest.fn((m: { to: string; subject: string; text?: string }) => {
      if (m.to === opts.failFor) return Promise.reject(new Error('SMTP down'));
      sent.push(m);
      return Promise.resolve({ messageId: 'm' });
    }),
  };
  const config = { get: () => 'https://talenthub.dbl-group.com' };
  const svc = new CandidateMailService(
    prisma as never,
    mail as never,
    config as never,
  );
  return { svc, sent, prisma };
}

const three = [
  { id: 'a', name: 'Nusrat Jahan', email: 'nusrat@example.com' },
  { id: 'b', name: 'Tanvir Ahmed', email: null },
  { id: 'c', name: 'Sadia Islam', email: 'sadia@example.com' },
];

describe('notifyReferral', () => {
  it('writes to each referred candidate with an address, then the referrer once', async () => {
    const t = build({ candidates: three });
    await t.svc.notifyReferral('r1');
    expect(t.sent.map((m) => m.to)).toEqual([
      'nusrat@example.com',
      'sadia@example.com',
      'kamrul@dbl-group.com',
    ]);
    expect(t.sent[0].subject).toBe(
      'You Have Been Referred — Senior Merchandiser / Merchandiser | DBL Group',
    );
    expect(t.sent[0].text).toMatch(/^Dear Nusrat,/);
    const toReferrer = t.sent[2];
    expect(toReferrer.subject).toContain('(REF-2026-0007)');
    expect(toReferrer.text).toMatch(/^Dear Kamrul,/);
    // Everyone is listed — including the one whose CV carried no address.
    expect(toReferrer.text).toContain('2. Tanvir Ahmed\n');
    expect(toReferrer.text).toContain('Total Candidates Referred: 3');
  });

  it('writes about a referral once, however often it is reached', async () => {
    const t = build({ candidates: three });
    await t.svc.notifyReferral('r1');
    await t.svc.notifyReferral('r1');
    expect(t.sent).toHaveLength(3);
  });

  it('does not let one failed letter stop the rest', async () => {
    const t = build({ candidates: three, failFor: 'nusrat@example.com' });
    await t.svc.notifyReferral('r1');
    expect(t.sent.map((m) => m.to)).toEqual([
      'sadia@example.com',
      'kamrul@dbl-group.com',
    ]);
  });

  it('leaves out a referrer who turned email off, has left, or has no address', async () => {
    for (const referrer of [
      {
        name: 'K',
        email: 'k@dbl-group.com',
        status: 'ACTIVE' as const,
        emailNotifications: false,
      },
      {
        name: 'K',
        email: 'k@dbl-group.com',
        status: 'INACTIVE' as const,
        emailNotifications: true,
      },
      {
        name: 'K',
        email: null,
        status: 'ACTIVE' as const,
        emailNotifications: true,
      },
      null,
    ]) {
      const t = build({ candidates: three, referrer });
      await t.svc.notifyReferral('r1');
      expect(t.sent.map((m) => m.to)).toEqual([
        'nusrat@example.com',
        'sadia@example.com',
      ]);
    }
  });

  it('sends nothing for a referral whose candidates were all removed', async () => {
    const t = build({ candidates: [] });
    await t.svc.notifyReferral('r1');
    expect(t.sent).toHaveLength(0);
  });

  it('sends nothing when email is not set up', async () => {
    const t = build({ candidates: three, configured: false });
    await t.svc.notifyReferral('r1');
    expect(t.sent).toHaveLength(0);
  });
});

describe('sendApplicationReceived', () => {
  it('confirms with the Application ID and a link to their own status', async () => {
    const t = build({});
    await t.svc.sendApplicationReceived('cand-1');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].to).toBe('nusrat@example.com');
    expect(t.sent[0].text).toContain('Application ID: APP-2026-00031');
    expect(t.sent[0].html).toContain(
      'href="https://talenthub.dbl-group.com/apply/status?email=nusrat%40example.com"',
    );
    expect(t.sent[0].html).toContain(
      'href="https://talenthub.dbl-group.com/careers"',
    );
  });

  it('never throws — the application has already been taken', async () => {
    const t = build({ failFor: 'nusrat@example.com' });
    await expect(
      t.svc.sendApplicationReceived('cand-1'),
    ).resolves.toBeUndefined();
  });
});
