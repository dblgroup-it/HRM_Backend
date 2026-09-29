import { normalizeGender } from './gender';

describe('normalizeGender', () => {
  it('reads the spellings a CV or BDJobs uses', () => {
    expect(normalizeGender('Male')).toBe('male');
    expect(normalizeGender(' F ')).toBe('female');
    expect(normalizeGender('FEMALE')).toBe('female');
  });

  it('stores nothing rather than a guess', () => {
    expect(normalizeGender('Other')).toBeNull();
    expect(normalizeGender('')).toBeNull();
    expect(normalizeGender(undefined)).toBeNull();
    expect(normalizeGender(1)).toBeNull();
  });
});
