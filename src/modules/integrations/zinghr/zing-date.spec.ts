import { parseZingDate } from './zinghr.service';

/**
 * These dates land in `@db.Date` columns — a calendar day, no time, no zone.
 *
 * The bug this pins: `new Date(y, m, d)` builds LOCAL midnight, so on a server
 * east of UTC (Dhaka is +6) every birthday and joining date was stored, and
 * read back, one day early. The assertions are on the UTC parts for that
 * reason — asserting on `getDate()` would pass on a UTC machine and fail in
 * Dhaka, which is exactly how this shipped.
 */
describe('parseZingDate', () => {
  const originalTz = process.env.TZ;
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  const iso = (d: Date | null) => d?.toISOString() ?? null;

  it('reads DD-MM-YYYY as that calendar day at UTC midnight', () => {
    expect(iso(parseZingDate('15-05-1990'))).toBe('1990-05-15T00:00:00.000Z');
  });

  it('accepts the slash form too', () => {
    expect(iso(parseZingDate('01/10/2026'))).toBe('2026-10-01T00:00:00.000Z');
  });

  it('does not shift the day for a date east of UTC', () => {
    // The whole point: no hour of the stored instant may fall on the 14th,
    // or Postgres records the DATE as the 14th.
    const d = parseZingDate('15-05-1990')!;
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCMonth()).toBe(4);
    expect(d.getUTCFullYear()).toBe(1990);
    expect(d.getUTCHours()).toBe(0);
  });

  it('flattens a .NET /Date(ms)/ instant to its UTC day', () => {
    // 2026-10-01T18:30:00Z — an instant, not a day. It must not round to the 2nd.
    const ms = Date.UTC(2026, 9, 1, 18, 30);
    expect(iso(parseZingDate(`/Date(${ms})/`))).toBe('2026-10-01T00:00:00.000Z');
  });

  it('flattens an ISO datetime to its UTC day', () => {
    expect(iso(parseZingDate('2026-10-01T18:30:00Z'))).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('returns null for empty and unparseable input', () => {
    expect(parseZingDate(null)).toBeNull();
    expect(parseZingDate('')).toBeNull();
    expect(parseZingDate('not a date')).toBeNull();
  });
});
