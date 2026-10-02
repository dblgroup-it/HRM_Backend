import {
  REGRET_MAIL_BODY,
  regretMailBlocker,
  regretMailSubject,
} from './regret-mail';

const base = {
  name: 'Rahim',
  stage: 'REJECTED',
  email: 'rahim@example.com',
  regretSentAt: null,
};

describe('regretMailBlocker', () => {
  it('lets a rejected candidate with an email through', () => {
    expect(regretMailBlocker(base)).toBeNull();
    // The wire is lowercase; the rule must not care which it is given.
    expect(regretMailBlocker({ ...base, stage: 'rejected' })).toBeNull();
  });

  it('refuses anyone still in the running', () => {
    for (const stage of ['APPLIED', 'SHORTLISTED', 'INTERVIEW', 'FINAL', 'SELECTED']) {
      expect(regretMailBlocker({ ...base, stage })).toMatch(/not been rejected/);
    }
  });

  it('refuses without an email address', () => {
    expect(regretMailBlocker({ ...base, email: null })).toMatch(/no email/);
    expect(regretMailBlocker({ ...base, email: '  ' })).toMatch(/no email/);
  });

  it('sends it once only', () => {
    expect(
      regretMailBlocker({ ...base, regretSentAt: new Date('2026-09-20') }),
    ).toMatch(/already been sent/);
  });
});

describe('the letter', () => {
  it('is DBL’s wording, opening and closing as agreed', () => {
    expect(REGRET_MAIL_BODY.startsWith('Dear Applicant,')).toBe(true);
    expect(REGRET_MAIL_BODY).toContain('we regret to inform you');
    expect(REGRET_MAIL_BODY.endsWith('HR Department\nDBL Group')).toBe(true);
  });

  it('names the post in the subject when there is one', () => {
    expect(regretMailSubject('Sewing Operator')).toBe(
      'Application Update — Sewing Operator | DBL Group',
    );
    expect(regretMailSubject('')).toBe('Application Update | DBL Group');
  });
});
