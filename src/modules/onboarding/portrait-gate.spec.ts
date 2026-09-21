import {
  PORTRAIT_REJECT_CONFIDENCE,
  portraitRejection,
} from './portrait-gate';

/**
 * The asymmetry this gate is built around: letting a wrong image through
 * costs HR ten seconds, refusing a real photograph stops somebody's
 * onboarding with nobody to appeal to. Every uncertain case allows.
 */
describe('portraitRejection', () => {
  it('allows when the model was never asked (not configured, or it failed)', () => {
    expect(portraitRejection(null)).toBeNull();
  });

  it('allows a confident yes', () => {
    expect(
      portraitRejection({ isPortrait: true, confidence: 0.99, reason: 'A face.' }),
    ).toBeNull();
  });

  it('allows a hesitant yes', () => {
    expect(
      portraitRejection({ isPortrait: true, confidence: 0.2, reason: 'Probably.' }),
    ).toBeNull();
  });

  it('allows a no the model is unsure about', () => {
    expect(
      portraitRejection({
        isPortrait: false,
        confidence: 0.6,
        reason: 'Hard to tell — very dark.',
      }),
    ).toBeNull();
  });

  it('refuses a confident no, and says why', () => {
    const msg = portraitRejection({
      isPortrait: false,
      confidence: 0.95,
      reason: 'This is a scanned certificate.',
    });
    expect(msg).toContain('does not look like a passport photograph');
    expect(msg).toContain('This is a scanned certificate.');
    expect(msg).toContain('clear photo of your face');
  });

  it('treats the threshold itself as confident enough', () => {
    expect(
      portraitRejection({
        isPortrait: false,
        confidence: PORTRAIT_REJECT_CONFIDENCE,
        reason: 'A blank page.',
      }),
    ).not.toBeNull();
    expect(
      portraitRejection({
        isPortrait: false,
        confidence: PORTRAIT_REJECT_CONFIDENCE - 0.01,
        reason: 'A blank page.',
      }),
    ).toBeNull();
  });

  it('keeps the bar high — a coin-flip never refuses', () => {
    expect(
      portraitRejection({ isPortrait: false, confidence: 0.5, reason: 'Unsure.' }),
    ).toBeNull();
  });
});
