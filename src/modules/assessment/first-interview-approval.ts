/**
 * Factory HR Head sign-off on first-interview finalists.
 *
 * Factory HR runs a handed-over first interview and puts candidates through;
 * where the unit has a Factory HR Head, those finalists wait on them before
 * reaching the Corporate Recruiter for the second interview. The Head
 * approves, returns (back to Factory HR with a note) or rejects — singly or
 * for a selection.
 *
 * Decorator-free so a test can import it.
 */

export const FACTORY_HR_HEAD_ROLE_KEY = 'factory_hr_head';

export const HEAD_DECISIONS = ['approve', 'return', 'reject'] as const;
export type HeadDecision = (typeof HEAD_DECISIONS)[number];

/**
 * Returning or rejecting overrules the interviewer who was in the room, so it
 * carries a reason; approving does not need one. Null when the note is fine.
 */
export function headDecisionNoteError(
  decision: HeadDecision,
  note: string | null | undefined,
): string | null {
  if (decision === 'approve') return null;
  if ((note ?? '').trim().length >= 3) return null;
  return decision === 'return'
    ? 'Say what Factory HR should look at again'
    : 'Give a reason for rejecting';
}

/**
 * Which units' queues this person may work: every unit for a super user or a
 * global holder, otherwise the units their Factory HR Head role is scoped to.
 */
export function headScope(perms: {
  isSuperUser: boolean;
  roles: { key: string; unitId: string | null; unitName: string | null }[];
}): { all: boolean; unitNames: string[] } {
  if (perms.isSuperUser) return { all: true, unitNames: [] };
  const held = perms.roles.filter((r) => r.key === FACTORY_HR_HEAD_ROLE_KEY);
  if (held.some((r) => r.unitId === null)) return { all: true, unitNames: [] };
  return {
    all: false,
    unitNames: held
      .map((r) => r.unitName)
      .filter((n): n is string => Boolean(n)),
  };
}
