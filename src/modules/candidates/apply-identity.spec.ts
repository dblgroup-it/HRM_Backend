import { applyCounts, emailKey, phoneKey, sameApplicant } from './apply-identity';

describe('applicant identity', () => {
  it('treats the three ways a Bangladeshi mobile is written as one number', () => {
    expect(phoneKey('+880 1712-345678')).toBe('1712345678');
    expect(phoneKey('01712345678')).toBe('1712345678');
    expect(phoneKey('8801712345678')).toBe('1712345678');
  });

  it('ignores a number too short to be a mobile', () => {
    expect(phoneKey('12345')).toBeNull();
    expect(phoneKey('')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });

  it('compares email without case or spaces, and refuses non-addresses', () => {
    expect(emailKey('  Rafi@Example.COM ')).toBe('rafi@example.com');
    expect(emailKey('n/a')).toBeNull();
  });

  const pool = [
    { id: 'a', email: 'rafi@example.com', phone: '01712345678' },
    // Same person, new email, same phone written differently.
    { id: 'b', email: 'rafi.new@example.com', phone: '+8801712345678' },
    // Same person, same email, no phone.
    { id: 'c', email: 'RAFI@example.com', phone: null },
    // Somebody else.
    { id: 'd', email: 'someone@example.com', phone: '01811111111' },
  ];

  it('finds an earlier application under a different email by the mobile', () => {
    expect(sameApplicant(pool[1], pool).map((r) => r.id).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('counts each row including itself', () => {
    const counts = applyCounts(pool, pool);
    expect(counts.get('a')).toBe(3); // a, b by phone, c by email
    expect(counts.get('d')).toBe(1);
  });

  it('counts 1 for a candidate with neither email nor phone', () => {
    const lone = { id: 'x', email: null, phone: null };
    expect(applyCounts([lone], pool).get('x')).toBe(1);
  });
});
