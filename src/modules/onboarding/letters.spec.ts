import {
  buildAppointmentLetter,
  buildOfferLetter,
  type LetterInput,
} from './letters';

const base: LetterInput = {
  candidateName: 'Test Candidate',
  salutation: 'Mr.',
  designation: 'Additional General Manager',
  department: 'Admin, Safety & Security',
  unitFactory: 'Jinnat Knitwears Ltd.',
  joiningDate: new Date('2026-10-01'),
  signatoryName: 'Test Signatory',
  signatoryTitle: 'CHRO',
};

/** Strip tags so an assertion reads the sentence, not the markup around it. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

describe('letters — the post is named with its department', () => {
  it('prints designation and department on the senior offer letter', () => {
    expect(text(buildOfferLetter('senior', base))).toContain(
      'position of "Additional General Manager - Admin, Safety & Security" of Jinnat Knitwears Ltd.',
    );
  });

  it('prints designation and department on the junior offer letter', () => {
    expect(text(buildOfferLetter('junior', base))).toContain(
      'position of Additional General Manager - Admin, Safety & Security in Jinnat Knitwears Ltd.',
    );
  });

  it('prints designation and department on the appointment letter', () => {
    expect(text(buildAppointmentLetter(base))).toContain(
      'appointment as Additional General Manager - Admin, Safety & Security in Jinnat Knitwears Ltd.',
    );
  });

  it('escapes the ampersand rather than emitting raw HTML', () => {
    // "Safety & Security" must not break the markup of a document that is
    // printed and signed.
    const html = buildOfferLetter('senior', base);
    expect(html).toContain('Admin, Safety &amp; Security');
    expect(html).not.toMatch(/Safety & Security/);
  });

  it('falls back to the designation alone when no department is recorded', () => {
    for (const department of [null, undefined, '   ']) {
      const html = buildOfferLetter('senior', { ...base, department });
      expect(text(html)).toContain(
        'position of "Additional General Manager" of Jinnat Knitwears Ltd.',
      );
      expect(text(html)).not.toContain(' - ');
    }
  });

  it('does not repeat a department already inside the designation', () => {
    // Some designations are recorded with the department baked in. "Manager -
    // Admin - Admin" would have to be reprinted and re-signed.
    const html = buildOfferLetter('senior', {
      ...base,
      designation: 'Manager - Admin, Safety & Security',
    });
    expect(text(html)).toContain(
      'position of "Manager - Admin, Safety & Security" of',
    );
    expect(text(html)).not.toContain('Security - Admin');
  });

  it('applies to every letter format, so the three cannot disagree', () => {
    const wanted = 'Additional General Manager - Admin, Safety & Security';
    for (const html of [
      buildOfferLetter('junior', base),
      buildOfferLetter('senior', base),
      buildAppointmentLetter(base),
    ]) {
      expect(text(html)).toContain(wanted);
    }
  });
});
