/**
 * Requisition numbers: REQ-<year>-<sequence>, the sequence running on across
 * years (REQ-2026-015 is followed by REQ-2027-016).
 *
 * The next sequence is the highest one in use plus one. It used to be the row
 * count plus one, which is the same thing only until a requisition is deleted:
 * after that the count lags the numbers, the next code is one that already
 * exists, the unique constraint refuses it, and every raise fails with a 500
 * until the count catches up.
 */

/** The trailing sequence of a code, or 0 when it has none. */
export function codeSequence(code: string): number {
  const m = /(\d+)\s*$/.exec(code);
  return m ? Number(m[1]) : 0;
}

export function formatRequisitionCode(year: number, sequence: number): string {
  return `REQ-${year}-${String(sequence).padStart(3, '0')}`;
}

/** The code after the highest of `existing`. */
export function nextRequisitionCode(existing: string[], year: number): string {
  const highest = existing.reduce(
    (max, c) => Math.max(max, codeSequence(c)),
    0,
  );
  return formatRequisitionCode(year, highest + 1);
}

/** A unique-constraint failure on the requisition code (a concurrent raise). */
export function isCodeCollision(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (e?.code !== 'P2002') return false;
  const target = e.meta?.target;
  return Array.isArray(target)
    ? target.includes('code')
    : String(target ?? '').includes('code');
}
