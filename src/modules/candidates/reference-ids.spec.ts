import {
  applicationId,
  applicationNoFromSearch,
  referralId,
} from './reference-ids';

describe('applicationId / referralId', () => {
  it('reads APP-<year>-<number> and REF-<year>-<number>', () => {
    const at = new Date('2026-10-04T08:00:00Z');
    expect(applicationId(31, at)).toBe('APP-2026-00031');
    expect(referralId(7, at)).toBe('REF-2026-0007');
  });

  it('lets the number grow past its padding rather than wrap', () => {
    const at = new Date('2026-10-04T08:00:00Z');
    expect(applicationId(1234567, at)).toBe('APP-2026-1234567');
    expect(referralId(98765, at)).toBe('REF-2026-98765');
  });

  it('takes the year in Dhaka — New Year’s Day starts at 18:00 UTC', () => {
    // 31 Dec 2026, 19:00 UTC is 1 Jan 2027, 01:00 in Dhaka.
    expect(applicationId(5, new Date('2026-12-31T19:00:00Z'))).toBe(
      'APP-2027-00005',
    );
    expect(applicationId(5, new Date('2026-12-31T17:59:00Z'))).toBe(
      'APP-2026-00005',
    );
  });
});

describe('applicationNoFromSearch', () => {
  it('finds the number in the ways people type an ID', () => {
    expect(applicationNoFromSearch('APP-2026-00031')).toBe(31);
    expect(applicationNoFromSearch(' app-2026-31 ')).toBe(31);
    expect(applicationNoFromSearch('APP 2026 00031')).toBe(31);
    expect(applicationNoFromSearch('APP-31')).toBe(31);
  });

  it('leaves names, emails and phone numbers to the ordinary search', () => {
    expect(applicationNoFromSearch('Rahim')).toBeNull();
    expect(applicationNoFromSearch('apple@example.com')).toBeNull();
    expect(applicationNoFromSearch('01712345678')).toBeNull();
    expect(applicationNoFromSearch('APP-')).toBeNull();
    expect(applicationNoFromSearch('APP-0')).toBeNull();
  });
});
