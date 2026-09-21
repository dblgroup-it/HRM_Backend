import { rejectBlocker } from './reject-guard';

const c = (stage: string, onboarding: RejOb = null) => ({
  name: 'OMOR KYUM Aunto',
  stage,
  onboarding,
});
type RejOb = { status: string; offerSentAt: Date | null } | null;
const fresh: RejOb = { status: 'docs_pending', offerSentAt: null };
const running: RejOb = { status: 'offer_sent', offerSentAt: new Date() };
const finished: RejOb = { status: 'onboarded', offerSentAt: new Date() };

describe('rejectBlocker', () => {
  it('lets the panel reject a candidate at the interview stage', () => {
    expect(rejectBlocker(c('INTERVIEW'))).toBeNull();
  });

  it('lets the panel reject somebody being re-interviewed after an unwound hire', () => {
    // The regression: marked absent, rescheduled, and still carrying the
    // onboarding record from the hire that was reversed. Refusing here meant
    // no decision could ever be recorded for them.
    expect(rejectBlocker(c('INTERVIEW', finished))).toBeNull();
    expect(rejectBlocker(c('SHORTLISTED', finished))).toBeNull();
  });

  it('refuses when they are already rejected', () => {
    expect(rejectBlocker(c('REJECTED'))).toMatch(/already been rejected/);
  });

  it('refuses when they have been selected', () => {
    expect(rejectBlocker(c('SELECTED'))).toMatch(/already been selected/);
  });

  it('refuses at FINAL once an offer is out', () => {
    expect(rejectBlocker(c('FINAL', running))).toMatch(/offer is out/);
    expect(rejectBlocker(c('FINAL', finished))).toMatch(/offer is out/);
  });

  it('allows at FINAL while onboarding has not actually moved', () => {
    expect(rejectBlocker(c('FINAL', fresh))).toBeNull();
    expect(rejectBlocker(c('FINAL', null))).toBeNull();
  });
});
