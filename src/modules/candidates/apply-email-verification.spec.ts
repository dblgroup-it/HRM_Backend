import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_WINDOW,
  VERIFIED_TTL_MS,
  codeUnusable,
  normaliseEmail,
  readVerification,
  sendDecision,
  signVerification,
  verificationKey,
  type CodeState,
} from './apply-email-verification';

const NOW = new Date('2026-10-07T10:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);

const sent = (overrides: Partial<CodeState> = {}): CodeState => ({
  codeHash: 'hash',
  expiresAt: later(CODE_TTL_MS),
  attempts: 0,
  sentAt: NOW,
  windowStart: NOW,
  windowCount: 1,
  ...overrides,
});

describe('normaliseEmail', () => {
  it('treats case and stray spaces as the same mailbox', () => {
    expect(normaliseEmail('  Rahim.Uddin@Gmail.COM ')).toBe(
      'rahim.uddin@gmail.com',
    );
  });
});

describe('sendDecision', () => {
  it('sends the first code and starts the hour', () => {
    expect(sendDecision(null, NOW)).toEqual({
      action: 'send',
      windowStart: NOW,
      windowCount: 1,
    });
  });

  it('keeps a code sent under a minute ago — a second click is not a second mail', () => {
    expect(sendDecision(sent({ sentAt: ago(20_000) }), NOW)).toEqual({
      action: 'wait',
      resendInSeconds: 40,
    });
  });

  it('sends again after a minute, counting it in the same hour', () => {
    expect(
      sendDecision(
        sent({ sentAt: ago(61_000), windowStart: ago(61_000), windowCount: 2 }),
        NOW,
      ),
    ).toEqual({ action: 'send', windowStart: ago(61_000), windowCount: 3 });
  });

  it('does not make anyone wait for a replacement of a dead code', () => {
    // Cancelled after five wrong guesses: hash cleared, so no cooldown.
    expect(
      sendDecision(sent({ codeHash: null, sentAt: ago(10_000) }), NOW).action,
    ).toBe('send');
  });

  it(`stops at ${MAX_SENDS_PER_WINDOW} codes an hour, saying when to come back`, () => {
    expect(
      sendDecision(
        sent({
          sentAt: ago(5 * 60_000),
          windowStart: ago(20 * 60_000),
          windowCount: MAX_SENDS_PER_WINDOW,
        }),
        NOW,
      ),
    ).toEqual({ action: 'limit', retryInMinutes: 40 });
  });

  it('starts a new hour once the old one is over', () => {
    expect(
      sendDecision(
        sent({
          sentAt: ago(61 * 60_000),
          windowStart: ago(61 * 60_000),
          windowCount: MAX_SENDS_PER_WINDOW,
        }),
        NOW,
      ),
    ).toEqual({ action: 'send', windowStart: NOW, windowCount: 1 });
  });
});

describe('codeUnusable', () => {
  it('lets a live code be checked', () => {
    expect(codeUnusable(sent(), NOW)).toBeNull();
  });

  it('names why a code cannot be checked', () => {
    expect(codeUnusable(null, NOW)).toBe('none');
    expect(codeUnusable(sent({ expiresAt: ago(1) }), NOW)).toBe('expired');
    expect(codeUnusable(sent({ attempts: MAX_ATTEMPTS }), NOW)).toBe(
      'exhausted',
    );
  });
});

describe('the verification', () => {
  const key = verificationKey('test-secret');

  it('proves the address it was issued for, whatever its spelling', () => {
    const { token, expiresAt } = signVerification(' Rahim@Gmail.com', key, NOW);
    expect(expiresAt).toEqual(later(VERIFIED_TTL_MS));
    expect(readVerification(token, key, later(59 * 60_000))).toBe(
      'rahim@gmail.com',
    );
  });

  it('lapses after an hour', () => {
    const { token } = signVerification('rahim@gmail.com', key, NOW);
    expect(readVerification(token, key, later(VERIFIED_TTL_MS))).toBeNull();
  });

  it('cannot be edited to name another address or a later expiry', () => {
    const { token } = signVerification('rahim@gmail.com', key, NOW);
    const [v, , exp, mac] = token.split('.');
    const other = Buffer.from('someone@else.com').toString('base64url');
    expect(
      readVerification(`${v}.${other}.${exp}.${mac}`, key, NOW),
    ).toBeNull();
    const longer = String(Number(exp) + 86_400_000);
    expect(
      readVerification(
        `${v}.${token.split('.')[1]}.${longer}.${mac}`,
        key,
        NOW,
      ),
    ).toBeNull();
  });

  it('is worthless under any other secret', () => {
    const { token } = signVerification('rahim@gmail.com', key, NOW);
    expect(
      readVerification(token, verificationKey('another-secret'), NOW),
    ).toBeNull();
  });

  it('refuses rubbish without throwing', () => {
    for (const junk of [
      undefined,
      null,
      '',
      'abc',
      'v1.a.b',
      'v2.a.1.c',
      'v1.a.x.c',
    ]) {
      expect(readVerification(junk, key, NOW)).toBeNull();
    }
  });
});
