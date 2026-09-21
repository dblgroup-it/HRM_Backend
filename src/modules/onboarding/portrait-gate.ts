import type { PortraitVerdict } from '../integrations/ai/ai-grader.service';

/**
 * How sure the model has to be before a candidate's upload is refused.
 *
 * Deliberately high. The two mistakes are not equal: letting a wrong image
 * through costs HR ten seconds to spot and reject by hand, while refusing a
 * real photograph stops somebody's onboarding with no way to argue back from
 * the portal. At 0.8 the model has to be plainly sure.
 */
export const PORTRAIT_REJECT_CONFIDENCE = 0.8;

/**
 * Should this upload be refused?
 *
 * Fails open at every turn — `null` (not configured, request failed, answer
 * unparseable), an affirmative verdict, or a negative one the model is not
 * confident about all mean "accept". Only a confident negative is refused.
 */
export function portraitRejection(
  verdict: PortraitVerdict | null,
): string | null {
  if (!verdict) return null;
  if (verdict.isPortrait) return null;
  if (verdict.confidence < PORTRAIT_REJECT_CONFIDENCE) return null;
  return `That does not look like a passport photograph. ${verdict.reason} Please upload a clear photo of your face.`;
}
