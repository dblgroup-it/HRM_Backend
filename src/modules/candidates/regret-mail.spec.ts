import {
  AUTOMATED_EMAIL_NOTICE,
  hasAutomatedNotice,
  withAutomatedNotice,
} from '../integrations/mail/automated-notice';
import {
  regretMail,
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
    for (const stage of [
      'APPLIED',
      'SHORTLISTED',
      'INTERVIEW',
      'FINAL',
      'SELECTED',
    ]) {
      expect(regretMailBlocker({ ...base, stage })).toMatch(
        /not been rejected/,
      );
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
  const letter = regretMail({
    candidateName: 'Md. Rahim Uddin',
    position: 'Sewing Operator',
    careersUrl: 'https://talenthub.dbl-group.com/careers',
  });

  it('is addressed by first name and names the post', () => {
    expect(letter.text.startsWith('Dear Rahim,\n\n')).toBe(true);
    expect(letter.text).toContain(
      'Thank you for your interest in DBL Group and for the time and effort you invested in our recruitment process for the position of Sewing Operator.',
    );
    expect(letter.html).toContain('<strong');
    expect(letter.html).toContain('Sewing Operator');
  });

  it('is DBL’s wording, in order, signed by Talent Acquisition', () => {
    const order = [
      'we have decided not to proceed with your candidature for this position.',
      'Explore Current Opportunities:\nhttps://talenthub.dbl-group.com/careers',
      'Where appropriate, your profile may also be considered',
      'fair, transparent, inclusive, and merit-based recruitment process',
      'We wish you continued success and growth in your professional endeavors.',
      'Warm regards,\nTalent Acquisition Team\nDBL Group',
    ];
    const at = order.map((line) => letter.text.indexOf(line));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('ends with the automated-email notice, once', () => {
    expect(letter.text.endsWith(AUTOMATED_EMAIL_NOTICE)).toBe(true);
    expect(hasAutomatedNotice(letter.html)).toBe(true);
    expect(withAutomatedNotice(letter)).toEqual(letter);
  });

  it('shows the logo and links the careers page', () => {
    expect(letter.html).toContain('src="cid:dbl-group-logo"');
    expect(letter.html).toContain(
      'href="https://talenthub.dbl-group.com/careers"',
    );
  });

  it('names the post in the subject when there is one', () => {
    expect(letter.subject).toBe(
      'Application Update — Sewing Operator | DBL Group',
    );
    expect(regretMailSubject('')).toBe('Application Update | DBL Group');
  });

  it('escapes what it is given', () => {
    const odd = regretMail({
      candidateName: 'Rahim <b>',
      position: 'R&D <Lead>',
      careersUrl: 'https://talenthub.dbl-group.com/careers',
    });
    expect(odd.html).toContain('R&amp;D &lt;Lead&gt;');
    expect(odd.html).not.toContain('<Lead>');
  });
});
