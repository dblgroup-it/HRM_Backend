import { accessGrantedEmail, passwordResetEmail } from './account-emails';

// A stand-in: the real default lives only in the server's .env.
const PW = 'Stand-In@26';
const base = {
  name: 'Md. Rahim Uddin',
  employeeCode: '15100001',
  signInUrl: 'https://talenthub.dbl-group.com/login',
};

describe('access granted email', () => {
  it('gives a first-timer their roles, user ID and the default password', () => {
    const mail = accessGrantedEmail({
      ...base,
      defaultPassword: PW,
      firstAccess: true,
      granted: [
        { role: 'Factory HR', unit: 'Jinnat Textile Mills Ltd.' },
        { role: 'Head of Talent Acquisition', unit: null },
      ],
    });
    expect(mail.subject).toBe('Your TalentHub access and sign-in details');
    expect(mail.text).toContain('Dear Rahim,');
    expect(mail.text).toContain('given access to TalentHub');
    expect(mail.text).toContain('Jinnat Textile Mills Ltd.');
    expect(mail.text).toContain('All units');
    expect(mail.text).toContain('15100001');
    expect(mail.text).toContain(PW);
    expect(mail.text).toContain('choose your own password');
    expect(mail.html).toContain(base.signInUrl);
  });

  it('never writes a password it does not hold', () => {
    const mail = accessGrantedEmail({
      ...base,
      defaultPassword: null,
      firstAccess: true,
      granted: [{ role: 'Unit Approver', unit: 'DBL Ceramics' }],
    });
    expect(mail.text).not.toContain('Default password');
    expect(mail.text).toContain('usual TalentHub password');
  });

  it('tells someone who already had access what was added, and nothing more', () => {
    const mail = accessGrantedEmail({
      ...base,
      // Even if handed one, a later grant must not repeat sign-in details.
      defaultPassword: PW,
      firstAccess: false,
      granted: [{ role: 'Factory HR', unit: 'DBL Ceramics' }],
    });
    expect(mail.subject).toBe('New access in TalentHub');
    expect(mail.text).toContain('You now also have');
    expect(mail.text).toContain('DBL Ceramics');
    expect(mail.text).toContain('Sign in as usual');
    expect(mail.text).not.toContain(PW);
    expect(mail.text).not.toContain('User ID');
    expect(mail.text).not.toContain('15100001');
  });

  it('keeps the password out of the subject, which is logged', () => {
    const mail = accessGrantedEmail({
      ...base,
      defaultPassword: PW,
      firstAccess: true,
      granted: [{ role: 'Factory HR', unit: 'DBL Ceramics' }],
    });
    expect(mail.subject).not.toContain(PW);
  });
});

describe('password reset email', () => {
  const reset = (twoFactorWasOn: boolean) =>
    passwordResetEmail({ ...base, defaultPassword: PW, twoFactorWasOn });

  it('says who reset it and why, with the default password', () => {
    const mail = reset(false);
    expect(mail.subject).toBe('Your TalentHub password has been reset');
    expect(mail.subject).not.toContain(PW);
    expect(mail.text).toContain(
      'For security purposes, your TalentHub password has been reset by the Administrator.',
    );
    expect(mail.text).toContain(PW);
    expect(mail.text).toContain('choose your own password');
  });

  it('mentions two-step verification only when the reset turned it off', () => {
    expect(reset(true).text).toContain('Two-step verification');
    expect(reset(false).text).not.toContain('Two-step verification');
  });
});
