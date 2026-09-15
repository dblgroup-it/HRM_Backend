/** Intended aspect ratio of an e-signature image: three times as wide as tall. */
export const SIGNATURE_ASPECT_RATIO = 3;

/**
 * How far from 3:1 an upload may be.
 *
 * Exact 3.000 would reject almost every real crop — a person trimming a scan
 * by hand lands near the ratio, not on it. 10% either side accepts 2.7:1 to
 * 3.3:1, which renders correctly in a fixed-ratio box, while still refusing a
 * square or a full-page scan that would letterbox into a smear.
 */
export const SIGNATURE_RATIO_TOLERANCE = 0.1;

export function signatureRatioError(
  width: number,
  height: number,
): string | null {
  if (height <= 0 || width <= 0) return 'That image has no usable dimensions.';
  const ratio = width / height;
  const min = SIGNATURE_ASPECT_RATIO * (1 - SIGNATURE_RATIO_TOLERANCE);
  const max = SIGNATURE_ASPECT_RATIO * (1 + SIGNATURE_RATIO_TOLERANCE);
  if (ratio >= min && ratio <= max) return null;
  return (
    `A signature must be about 3 times as wide as it is tall. ` +
    `This image is ${width}×${height} (${ratio.toFixed(2)}:1) — ` +
    `crop it to roughly 3:1, for example ${height * 3}×${height}.`
  );
}
