import {
  AUTOMATED_EMAIL_NOTICE,
  hasAutomatedNotice,
  withAutomatedNotice,
} from '../integrations/mail/automated-notice';
import { renderPlainMessage } from '../integrations/mail/branded-email';
import {
  applyEmailCodeEmail,
  applicationReceivedEmail,
  referredCandidateEmail,
  referrerEmail,
} from './recruitment-emails';

const vacancy = {
  position: 'Senior Merchandiser',
  businessUnit: 'Jinnat Textile Mills Ltd.',
  location: 'Gazipur',
};
const careersUrl = 'https://talenthub.dbl-group.com/careers';

/** Every line, found in the order given. */
function inOrder(text: string, lines: string[]) {
  const at = lines.map((line) => text.indexOf(line));
  const missing = lines.filter((_, i) => at[i] < 0);
  expect(missing).toEqual([]);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
}

function branded(email: { html: string; text: string }) {
  expect(email.html).toContain('src="cid:dbl-group-logo"');
  // In the layout's own footer — so MailService adds nothing on the way out.
  expect(hasAutomatedNotice(email.html)).toBe(true);
  expect(withAutomatedNotice(email)).toEqual(email);
  expect(email.text.endsWith(`—\n${AUTOMATED_EMAIL_NOTICE}`)).toBe(true);
}

describe('application received', () => {
  const email = applicationReceivedEmail({
    ...vacancy,
    candidateName: 'Md. Rahim Uddin',
    applicationId: 'APP-2026-00031',
    statusUrl:
      'https://talenthub.dbl-group.com/apply/status?email=rahim%40example.com',
    careersUrl,
  });

  it('names the post in the subject', () => {
    expect(email.subject).toBe(
      'Application Received — Senior Merchandiser | DBL Group',
    );
  });

  it('is DBL’s wording, in order', () => {
    inOrder(email.text, [
      'Dear Rahim,',
      'Thank you for your interest in DBL Group.',
      'We are pleased to confirm that your application has been successfully received.',
      'Position: Senior Merchandiser',
      'Business Unit: Jinnat Textile Mills Ltd.',
      'Location: Gazipur',
      'Application ID: APP-2026-00031',
      'What Happens Next?',
      'Our Talent Acquisition Team will review your application against the requirements of the role.',
      'View Application Status: https://talenthub.dbl-group.com/apply/status?email=rahim%40example.com',
      'About DBL Group',
      'Established in 1991, DBL Group is a diversified business conglomerate',
      'with a workforce of more than 51,000 people.',
      'Driven by People, Purpose, and Progress',
      'We are committed to a fair, transparent, inclusive, and merit-based recruitment process.',
      'Explore More Opportunities',
      'Interested in other opportunities at DBL Group?',
      `Explore Careers at DBL Group: ${careersUrl}`,
      'We look forward to learning more about you.',
      'Warm regards,\nTalent Acquisition Team\nDBL Group',
    ]);
  });

  it('links the status page and the careers page as buttons', () => {
    expect(email.html).toContain(
      'href="https://talenthub.dbl-group.com/apply/status?email=rahim%40example.com"',
    );
    expect(email.html).toContain('>View Application Status</a>');
    expect(email.html).toContain('>Explore Careers at DBL Group</a>');
  });

  it('carries the logo and the notice', () => branded(email));

  it('leaves out a detail it does not have rather than print a blank', () => {
    const noPlace = applicationReceivedEmail({
      ...vacancy,
      location: null,
      candidateName: 'Rahim',
      applicationId: 'APP-2026-00031',
      statusUrl: 'https://x/apply/status',
      careersUrl,
    });
    expect(noPlace.text).not.toContain('Location:');
    expect(noPlace.html).not.toContain('>Location<');
  });
});

describe('referral — to the candidate', () => {
  const email = referredCandidateEmail({
    ...vacancy,
    candidateName: 'NUSRAT JAHAN',
    referrerName: 'Md. Kamrul Hasan',
    careersUrl,
  });

  it('says who referred them, for what', () => {
    expect(email.subject).toBe(
      'You Have Been Referred — Senior Merchandiser | DBL Group',
    );
    inOrder(email.text, [
      'Dear Nusrat,',
      'Greetings from DBL Group.',
      // The unit's own full stop ends the sentence; no second one.
      'We are pleased to let you know that Md. Kamrul Hasan has referred your profile for the position of Senior Merchandiser at Jinnat Textile Mills Ltd.\n',
      'Position: Senior Merchandiser',
      'Business Unit: Jinnat Textile Mills Ltd.',
      'Location: Gazipur',
      'Referred By: Md. Kamrul Hasan',
      'Our Talent Acquisition Team will review your profile against the requirements of the role.',
      'We encourage you to explore DBL Group',
      `Explore Careers at DBL Group:\n${careersUrl}`,
      'At DBL Group, we are committed to a fair, transparent, inclusive, and merit-based recruitment process.',
      'We look forward to learning more about you.',
      'Warm regards,\nTalent Acquisition Team\nDBL Group',
    ]);
  });

  it('carries the logo and the notice', () => branded(email));
});

describe('referral — to the referrer', () => {
  const email = referrerEmail({
    ...vacancy,
    referrerName: 'Md. Kamrul Hasan',
    referralId: 'REF-2026-0007',
    candidates: [
      { name: 'Nusrat Jahan', email: 'nusrat@example.com' },
      { name: 'Tanvir Ahmed', email: null },
      { name: 'Sadia Islam', email: ' sadia@example.com ' },
    ],
    careersUrl,
  });

  it('lists everyone sent in, numbered, with the count and the referral ID', () => {
    expect(email.subject).toBe(
      'Referral Confirmation — Senior Merchandiser (REF-2026-0007) | DBL Group',
    );
    inOrder(email.text, [
      'Dear Kamrul,',
      'Thank you for recommending talented professionals to DBL Group.',
      'Your referral has been successfully submitted. Please find the details below:',
      'Position: Senior Merchandiser',
      'Candidates Referred',
      '1. Nusrat Jahan — nusrat@example.com',
      // No address on the CV: listed by name, not with a dangling dash.
      '2. Tanvir Ahmed\n',
      '3. Sadia Islam — sadia@example.com',
      'Total Candidates Referred: 3',
      'Referral ID: REF-2026-0007',
      'Our Talent Acquisition Team will review each candidate individually',
      'We appreciate your contribution',
      `Explore Current Opportunities:\n${careersUrl}`,
      'Warm regards,\nTalent Acquisition Team\nDBL Group',
    ]);
  });

  it('carries the logo and the notice', () => branded(email));
});

describe('a recruiter’s own message in the layout', () => {
  const email = renderPlainMessage(
    'Documents needed',
    'Dear Rahim,\r\n\r\nPlease bring:\n- NID\n- Certificates\n\n\nThanks,\nHR',
  );

  it('keeps their paragraphs and line breaks', () => {
    expect(email.html).toContain('Please bring:<br>- NID<br>- Certificates');
    expect(email.text.startsWith('Dear Rahim,\n\nPlease bring:\n- NID')).toBe(
      true,
    );
  });

  it('previews the first real sentence, not the greeting', () => {
    expect(email.html).toMatch(
      /mso-hide:all[^>]*>Please bring: - NID - Certificates/,
    );
  });

  it('carries the logo and the notice', () => branded(email));
});

describe('application email code', () => {
  const email = applyEmailCodeEmail({
    candidateName: 'Md. Rahim Uddin',
    position: 'Senior Merchandiser',
    code: '048193',
    validMinutes: 10,
  });

  it('keeps the code out of the subject, and puts it in the inbox preview', () => {
    expect(email.subject).toBe('Your DBL Group application verification code');
    expect(email.subject).not.toContain('048193');
    expect(email.html).toContain('Your verification code is 048193.');
  });

  it('greets by first name, names the post, gives the code and its lifetime', () => {
    inOrder(email.text, [
      'Dear Rahim,',
      'submit your application for Senior Merchandiser at DBL Group.',
      '048193',
      'This code expires in 10 minutes.',
      'Nothing will be submitted without this code.',
      'Talent Acquisition Team',
    ]);
  });

  it('shows the code on its own, leading zero kept', () => {
    expect(email.html).toMatch(/monospace[^>]*>048193<\/td>/);
    expect(email.text).toContain('\n\n048193\n\n');
  });

  it('greets an applicant who has not typed a name yet', () => {
    expect(
      applyEmailCodeEmail({ position: 'X', code: '123456', validMinutes: 10 })
        .text,
    ).toContain('Dear Applicant,');
  });

  it('carries the logo and the notice', () => branded(email));
});
