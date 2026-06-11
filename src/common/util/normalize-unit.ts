/**
 * Canonical comparison key for a unit name.
 *
 * ZingHR returns names with trailing punctuation / inconsistent spacing
 * (e.g. "Jinnat Textile Mills Ltd.") while hand-configured units may differ
 * ("Jinnat Textile Mills Ltd"). Matching on the raw string silently breaks
 * access, routing and scoping — so every unit-name comparison goes through this.
 */
export function normalizeUnitName(name: string | null | undefined): string {
  return (name ?? '')
    .trim()
    .replace(/\s+/g, ' ') // collapse internal whitespace
    .replace(/[.,;:’'`-]+$/g, '') // strip trailing punctuation
    .trim()
    .toLowerCase();
}

/** True if two unit names refer to the same unit (ignoring punctuation/case/spacing). */
export function sameUnit(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeUnitName(a) === normalizeUnitName(b);
}
