import { buildOfferEmail, offerEmailHtml, offerEmailText } from './offer-email';
import type { LetterInput } from './letters';

const base: LetterInput = {
  candidateName: 'Kamrul Ahmed',
  salutation: 'Mr.',
  designation: 'Deputy General Manager',
  department: 'Washing',
  unitFactory: 'Hamza Textiles Ltd.',
  joiningDate: new Date('2026-09-01T00:00:00Z'),
  jobLocation: 'Hamza Textiles Ltd., Nayapara, Kashimpur, Gazipur',
  signatoryName: 'Chief Human Resources Officer',
  signatoryTitle: 'Chief Human Resources Officer',
};

const body = (input: LetterInput) =>
  buildOfferEmail(input).paragraphs.join('\n');

describe('buildOfferEmail', () => {
  it('addresses the candidate by title and surname', () => {
    expect(buildOfferEmail(base).paragraphs[0]).toBe('Dear Mr. Ahmed,');
  });

  it('uses the full name when no title is known, rather than guessing one', () => {
    expect(buildOfferEmail({ ...base, salutation: null }).paragraphs[0]).toBe(
      'Dear Kamrul Ahmed,',
    );
  });

  it('names the post with its department', () => {
    expect(body(base)).toContain(
      'the position of Deputy General Manager – Washing.',
    );
  });

  it('names the post alone when it sits in no department', () => {
    expect(body({ ...base, department: null })).toContain(
      'the position of Deputy General Manager.',
    );
  });

  it('states the job location and the joining date', () => {
    const out = body(base);
    expect(out).toContain(
      'Your Job location will be at Hamza Textiles Ltd., Nayapara, Kashimpur, Gazipur.',
    );
    expect(out).toContain(
      'You have agreed to join the duties on or before September 1, 2026.',
    );
  });

  it('drops the job-location sentence rather than leaving a gap in it', () => {
    const out = body({ ...base, jobLocation: null });
    expect(out).not.toContain('Your Job location');
    // The sentences either side must still be there.
    expect(out).toContain('A detailed appointment letter will be issued');
  });

  it('drops the joining-date sentence when no date is agreed', () => {
    const out = body({ ...base, joiningDate: null });
    expect(out).not.toContain('on or before');
  });

  it('escapes the candidate name in the HTML body', () => {
    const html = offerEmailHtml(
      buildOfferEmail({ ...base, candidateName: 'A <script>x</script>' }),
      'https://hrm.example/onboarding/t',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('carries both the accept and the decline link', () => {
    const html = offerEmailHtml(buildOfferEmail(base), 'https://hrm.example/x');
    expect(html).toContain('https://hrm.example/x"');
    expect(html).toContain('https://hrm.example/x?action=decline');
  });

  it('keeps the sign-off as one block in the plain-text body', () => {
    expect(
      offerEmailText(buildOfferEmail(base), 'https://hrm.example/x'),
    ).toContain('On Behalf of DBL Group\nCorporate HR Department\nDBL Group');
  });
});
