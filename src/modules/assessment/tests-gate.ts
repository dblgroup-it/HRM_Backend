/**
 * Which assigned screening tests still have no mark.
 *
 * The first-interview verdict waits on these: a test HR assigned is either
 * marked or explicitly skipped (switched off for this candidate) before
 * anybody decides — otherwise a finalist reaches Corporate HR with a blank
 * where the written test should be, and nobody can say whether it was sat.
 *
 * No SalaryFixation row means no tests were ever assigned, which matches what
 * the Assigned Candidates worklist shows.
 */
export function unmarkedTests(
  f: {
    writtenTestEnabled: boolean;
    writtenTestObtained: number | null;
    computerTestEnabled: boolean;
    computerTestObtained: number | null;
    aiTestEnabled: boolean;
    aiTestObtained: number | null;
  } | null,
): string[] {
  if (!f) return [];
  return [
    f.writtenTestEnabled && f.writtenTestObtained == null ? 'Written' : null,
    f.computerTestEnabled && f.computerTestObtained == null
      ? 'Computer literacy'
      : null,
    f.aiTestEnabled && f.aiTestObtained == null ? 'AI proficiency' : null,
  ].filter((t): t is string => t !== null);
}

/** "Written", "Written and AI proficiency", "A, B and C". */
export function listTests(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
