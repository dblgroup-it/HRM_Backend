import { assertPasswordPolicy } from './auth.service';
import { defaultPasswordFor, sharedDefaultPassword } from './default-password';

// A stand-in: the real default lives only in the server's .env.
const SHARED = 'Stand-In@26';

describe('default password', () => {
  const saved = process.env.DEFAULT_USER_PASSWORD;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEFAULT_USER_PASSWORD;
    else process.env.DEFAULT_USER_PASSWORD = saved;
  });

  it('is the employee code when no shared default is set', () => {
    delete process.env.DEFAULT_USER_PASSWORD;
    expect(sharedDefaultPassword()).toBeNull();
    expect(defaultPasswordFor('15100001')).toBe('15100001');
  });

  it('treats a blank setting as unset', () => {
    process.env.DEFAULT_USER_PASSWORD = '   ';
    expect(defaultPasswordFor('15100001')).toBe('15100001');
  });

  it('is the shared default, trimmed, when one is set', () => {
    process.env.DEFAULT_USER_PASSWORD = ` ${SHARED} `;
    expect(defaultPasswordFor('15100001')).toBe(SHARED);
    expect(defaultPasswordFor('15100002')).toBe(SHARED);
  });

  it('is read at call time, so a restart is all a changed .env needs', () => {
    delete process.env.DEFAULT_USER_PASSWORD;
    expect(defaultPasswordFor('15100001')).toBe('15100001');
    process.env.DEFAULT_USER_PASSWORD = SHARED;
    expect(defaultPasswordFor('15100001')).toBe(SHARED);
  });

  describe('as a password of your own', () => {
    const target = {
      employeeCode: '15100001',
      email: 'someone@dbl-group.com',
      name: 'Test User',
    };

    it.each([
      ['exactly', SHARED],
      ['in another case', SHARED.toUpperCase()],
    ])('is refused %s', (_label, pw) => {
      process.env.DEFAULT_USER_PASSWORD = SHARED;
      expect(() => assertPasswordPolicy(pw, target)).toThrow(
        /default password/,
      );
    });

    it('is allowed once no shared default is set', () => {
      delete process.env.DEFAULT_USER_PASSWORD;
      expect(() => assertPasswordPolicy(SHARED, target)).not.toThrow();
    });
  });
});
