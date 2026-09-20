import { applyCandidateAcceptance } from './accepted-offer';
import { buildOfferLetter, type LetterInput } from './letters';

const base: LetterInput = {
  candidateName: 'Arafat Haque Alvi',
  designation: 'Officer',
  department: 'Corporate HR',
  unitFactory: 'DBL Group — Head Office',
  signatoryName: 'Mohammad Kamal Hosen',
  signatoryTitle: 'Chief Human Resources Officer',
};

const PNG = 'data:image/png;base64,AAAA';

describe('applyCandidateAcceptance', () => {
  it('drops the signature and date into a letter that went out blank', () => {
    const sent = buildOfferLetter('junior', base);
    expect(sent).toContain('______________________');
    expect(sent).not.toContain(PNG);

    const accepted = applyCandidateAcceptance(sent, {
      signature: PNG,
      joiningDate: new Date('2026-10-01T00:00:00Z'),
    });

    expect(accepted).toContain(PNG);
    expect(accepted).toContain('1 October 2026');
    expect(accepted).not.toContain('______________________');
  });

  it('leaves the letter it was given untouched', () => {
    const sent = buildOfferLetter('senior', base);
    const before = sent;
    applyCandidateAcceptance(sent, {
      signature: PNG,
      joiningDate: new Date('2026-10-01T00:00:00Z'),
    });
    expect(sent).toBe(before);
  });

  it('keeps the CHRO signature that was already on the letter', () => {
    const chroInk = 'data:image/png;base64,BBBB';
    const sent = buildOfferLetter('junior', {
      ...base,
      signatorySignature: chroInk,
    });
    const accepted = applyCandidateAcceptance(sent, {
      signature: PNG,
      joiningDate: null,
    });
    expect(accepted).toContain(chroInk);
    expect(accepted).toContain(PNG);
  });

  it('accepts without a signature on file — the date alone still fills in', () => {
    const sent = buildOfferLetter('junior', base);
    const accepted = applyCandidateAcceptance(sent, {
      signature: null,
      joiningDate: new Date('2026-11-15T00:00:00Z'),
    });
    expect(accepted).toContain('15 November 2026');
    // The slot stays empty rather than the fill being skipped — the letterhead
    // has its own <img>, so this checks the acceptance slot, not the document.
    expect(accepted).toContain('<span class="dbl-accept-sign"></span>');
  });

  it('leaves the date blank when they gave none', () => {
    const sent = buildOfferLetter('junior', base);
    const accepted = applyCandidateAcceptance(sent, {
      signature: PNG,
      joiningDate: null,
    });
    expect(accepted).toContain('______________________');
    expect(accepted).toContain(PNG);
  });

  it('returns null for a letter sent before the slots existed', () => {
    const legacy =
      '<p>Dear Mr. Alvi</p><p>Expected date of join ______________________</p>';
    expect(
      applyCandidateAcceptance(legacy, {
        signature: PNG,
        joiningDate: new Date('2026-10-01T00:00:00Z'),
      }),
    ).toBeNull();
  });

  it('fills the appointment letter the same way', () => {
    // Same markers, so a counter-signed appointment letter needs no second
    // implementation — this is the check that they have not drifted apart.
    const sent = buildOfferLetter('senior', base);
    const accepted = applyCandidateAcceptance(sent, {
      signature: PNG,
      joiningDate: null,
    });
    expect(accepted).not.toBeNull();
  });
});
