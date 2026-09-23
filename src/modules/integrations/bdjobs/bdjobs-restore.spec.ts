import { BDJOBS_DEFAULTS, BdJobsSettingsService } from './bdjobs-settings.service';

/**
 * What "Restore defaults" is allowed to touch.
 *
 * The whole point of the button is to rescue a config somebody has edited into
 * a state where posting no longer works. It stops being a rescue the moment it
 * also clears the API token: that is the one value an admin cannot reconstruct
 * from this screen — it is masked here and may only exist in BDJobs' portal —
 * so wiping it would turn a recoverable mistake into a support ticket.
 */
function makeService(stored: Record<string, unknown>) {
  const rows = new Map<string, unknown>([['bdjobs', stored]]);
  const prisma = {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null,
      upsert: async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
        rows.set(where.key, update.value);
        return { key: where.key, value: update.value };
      },
    },
  };
  const config = { get: () => undefined };
  const svc = new BdJobsSettingsService(
    prisma as never,
    config as never,
  );
  return { svc, rows };
}

const MANGLED = {
  enabled: false,
  baseUrl: 'https://wrong.example.com/v9',
  signatureFormat: 'totally-broken',
  companyId: 'DBL-123',
  authToken: 'live-token-abcdef',
  decodeId: 'decode-xyz',
  specialInstruction: 'oops',
  otherBenefits: 'oops',
  deadlineDays: 2,
  applyOnlineDefault: false,
  publicApplyBaseUrl: 'http://localhost:3000',
  entryLevelMaxYears: 19,
  midLevelMaxYears: 29,
};

describe('BdJobsSettingsService.restoreDefaults', () => {
  it('puts the shipped connection and posting values back', async () => {
    const { svc, rows } = makeService(MANGLED);
    await svc.restoreDefaults();
    const saved = rows.get('bdjobs') as Record<string, unknown>;

    expect(saved.baseUrl).toBe(BDJOBS_DEFAULTS.baseUrl);
    expect(saved.signatureFormat).toBe(BDJOBS_DEFAULTS.signatureFormat);
    expect(saved.specialInstruction).toBe(BDJOBS_DEFAULTS.specialInstruction);
    expect(saved.otherBenefits).toBe(BDJOBS_DEFAULTS.otherBenefits);
    expect(saved.deadlineDays).toBe(BDJOBS_DEFAULTS.deadlineDays);
    expect(saved.applyOnlineDefault).toBe(BDJOBS_DEFAULTS.applyOnlineDefault);
    expect(saved.entryLevelMaxYears).toBe(BDJOBS_DEFAULTS.entryLevelMaxYears);
    expect(saved.midLevelMaxYears).toBe(BDJOBS_DEFAULTS.midLevelMaxYears);
    expect(saved.publicApplyBaseUrl).toBe(BDJOBS_DEFAULTS.publicApplyBaseUrl);
  });

  it('KEEPS the credentials — they are why this is a rescue and not a wipe', async () => {
    const { svc, rows } = makeService(MANGLED);
    await svc.restoreDefaults();
    const saved = rows.get('bdjobs') as Record<string, unknown>;

    expect(saved.authToken).toBe('live-token-abcdef');
    expect(saved.decodeId).toBe('decode-xyz');
    expect(saved.companyId).toBe('DBL-123');
  });

  it('leaves posting switched off if somebody switched it off', async () => {
    // `enabled` is an operational decision, not configuration. Restoring
    // defaults must not quietly start publishing ads again.
    const { svc, rows } = makeService(MANGLED);
    await svc.restoreDefaults();
    expect((rows.get('bdjobs') as Record<string, unknown>).enabled).toBe(false);
  });

  it('leaves posting switched on if it was on', async () => {
    const { svc, rows } = makeService({ ...MANGLED, enabled: true });
    await svc.restoreDefaults();
    expect((rows.get('bdjobs') as Record<string, unknown>).enabled).toBe(true);
  });

  it('still reports the integration as configured afterwards', async () => {
    const { svc } = makeService(MANGLED);
    const view = await svc.restoreDefaults();
    expect(view.configured).toBe(true);
    expect(view.authTokenMasked).toContain('live');
  });

  it('is idempotent — restoring twice changes nothing further', async () => {
    const { svc, rows } = makeService(MANGLED);
    await svc.restoreDefaults();
    const once = JSON.stringify(rows.get('bdjobs'));
    await svc.restoreDefaults();
    expect(JSON.stringify(rows.get('bdjobs'))).toBe(once);
  });

  it('works from nothing stored at all', async () => {
    const { svc, rows } = makeService({});
    await svc.restoreDefaults();
    const saved = rows.get('bdjobs') as Record<string, unknown>;
    expect(saved.baseUrl).toBe(BDJOBS_DEFAULTS.baseUrl);
    expect(saved.authToken).toBe('');
  });
});
