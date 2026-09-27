/**
 * The facilities fields an HR interviewer records in the room: what the
 * candidate earns now, what they want, what comes with it, and where they
 * would be picked up from.
 *
 * One record per candidate, not one per interviewer. They are facts about the
 * candidate — a person has one present salary — and Salary Fixation reads one
 * figure. Several HR interviewers can sit on a panel, so the record is shared:
 * each save is stamped with who made it, and a save made from a form that was
 * showing older values than a colleague has since saved is refused rather than
 * silently replacing theirs.
 *
 * Decorator-free so the spec can import it.
 */

export interface FacilitiesRow {
  presentSalary: number | null;
  salaryExpectation: number | null;
  salaryBenefitsNote: string | null;
  salaryBenefits: string[];
  transportPickup: string | null;
  packageUpdatedAt: Date | null;
  packageUpdatedByName: string | null;
}

export interface FacilitiesView {
  presentSalary: number | null;
  salaryExpectation: number | null;
  salaryBenefitsNote: string | null;
  salaryBenefits: string[];
  transportPickup: string | null;
  /** ISO. Sent back as `baseUpdatedAt` on the next save. */
  updatedAt: string | null;
  updatedByName: string | null;
}

export function facilitiesView(c: FacilitiesRow): FacilitiesView {
  return {
    presentSalary: c.presentSalary,
    salaryExpectation: c.salaryExpectation,
    salaryBenefitsNote: c.salaryBenefitsNote,
    salaryBenefits: c.salaryBenefits ?? [],
    transportPickup: c.transportPickup,
    updatedAt: c.packageUpdatedAt?.toISOString() ?? null,
    updatedByName: c.packageUpdatedByName,
  };
}

/**
 * Why this save must not go through, or null when it may.
 *
 * `base` is the stamp of the values the form was showing (undefined when the
 * screen predates the check, which is let through as before). A save is
 * refused only when somebody else saved in between — saving over your own
 * earlier save is simply an edit.
 */
export function facilitiesConflict(
  base: string | null | undefined,
  current: { at: Date | null; byName: string | null; byId: string | null },
  actorId: string,
): string | null {
  if (base === undefined) return null;
  const currentIso = current.at?.toISOString() ?? null;
  if (currentIso === (base || null)) return null;
  if (current.byId && current.byId === actorId) return null;
  const who = current.byName ?? 'Another interviewer';
  const when = current.at
    ? current.at.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Dhaka',
      })
    : '';
  return `${who} saved these facilities${when ? ` at ${when}` : ''} while you had the form open. Their figures are now shown — check them, change what you need and save again.`;
}
