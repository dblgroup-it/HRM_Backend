/**
 * Whether a hand-marked screening mark may still be changed.
 *
 * A first interview run at a factory is delegated: someone outside recruitment
 * enters the marks from the session. Once they have entered a mark it is
 * fixed for them — a mark that can be revised quietly afterwards is not a
 * record of what the candidate scored, and the delegate is not the authority
 * on corrections. Corporate HR and the recruiter can still fix a genuine
 * mistake, which is where that authority sits.
 *
 * "Entered" means the obtained mark, not the total: setting the paper out of
 * 100 and then typing the score is one act of marking, not two.
 */

export interface ScreeningMarkState {
  writtenTestObtained: number | null;
  computerTestObtained: number | null;
}

export interface ScreeningMarkPatch {
  writtenTestTotal?: number | null;
  writtenTestObtained?: number | null;
  computerTestTotal?: number | null;
  computerTestObtained?: number | null;
}

/** Tests whose mark this patch would change. */
export function lockedMarkConflicts(
  existing: ScreeningMarkState | null,
  patch: ScreeningMarkPatch,
): string[] {
  if (!existing) return [];
  const out: string[] = [];

  const touched = (
    current: number | null,
    nextObtained: number | null | undefined,
    nextTotal: number | null | undefined,
  ) => {
    if (current === null) return false;
    // Re-sending the same number is not a change — the marks dialog saves both
    // fields together, so an edit to one must not trip on the other.
    const obtainedChanged =
      nextObtained !== undefined && nextObtained !== current;
    const totalChanged = nextTotal !== undefined;
    return obtainedChanged || totalChanged;
  };

  if (
    touched(
      existing.writtenTestObtained,
      patch.writtenTestObtained,
      patch.writtenTestTotal,
    )
  ) {
    out.push('Written Test');
  }
  if (
    touched(
      existing.computerTestObtained,
      patch.computerTestObtained,
      patch.computerTestTotal,
    )
  ) {
    out.push('Computer Literacy');
  }
  return out;
}

export function lockedMarkMessage(tests: string[]): string {
  const list = tests.join(' and ');
  return `${list} ${tests.length > 1 ? 'marks have' : 'mark has'} already been entered and cannot be changed from here. Ask Corporate HR if a correction is needed.`;
}
