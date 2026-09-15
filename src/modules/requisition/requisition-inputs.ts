/**
 * Turning what the requisition form sends into what the database stores.
 *
 * Pure and free of Nest and Prisma so the rules can be exercised directly —
 * these decide what an approver sees on a signed form, and "the form probably
 * sends it tidy" is not a basis for that.
 */

export interface ReplacedEmployeeInput {
  employeeName?: string | null;
  employeeCode?: string | null;
  separationReason?: string | null;
  vacantDate?: string | null;
  remarks?: string | null;
}

export interface NormalisedReplacement {
  employeeName: string;
  employeeCode: string | null;
  separationReason: string | null;
  vacantDate: Date | null;
  remarks: string | null;
  orderIndex: number;
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/** An ISO date string, or null — never an Invalid Date. */
const toDate = (v?: string | null): Date | null => {
  const t = clean(v, 40);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The other levels this post may be filled at.
 *
 * The primary designation is removed if it also appears in the list, because
 * "Assistant Manager or Assistant Manager" on an approval sheet is nonsense,
 * and repeats are dropped case-insensitively — a form that lets someone add
 * rows will eventually be given the same one twice.
 */
export function normaliseAlternateDesignations(
  primary: string,
  alternates?: string[] | null,
): string[] {
  if (!Array.isArray(alternates)) return [];
  const seen = new Set<string>([primary.trim().toLowerCase()]);
  const out: string[] = [];
  for (const raw of alternates) {
    const value = clean(raw, 150);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Every designation this requisition covers, primary first — how the post is
 * named on a list, a sheet or a notification.
 */
export function designationList(
  primary: string,
  alternates?: string[] | null,
): string[] {
  return [
    primary.trim(),
    ...normaliseAlternateDesignations(primary, alternates),
  ];
}

/** "Senior Executive / Assistant Manager" */
export function designationLabel(
  primary: string,
  alternates?: string[] | null,
): string {
  return designationList(primary, alternates).join(' / ');
}

/**
 * The people this requisition replaces.
 *
 * Accepts the list the form now sends, and falls back to the four single
 * fields older clients still send, so one code path produces the stored rows
 * either way. Entries with no name are dropped rather than stored blank: a
 * nameless row on a replacement sheet is worse than no row.
 */
export function normaliseReplacements(input: {
  replacements?: ReplacedEmployeeInput[] | null;
  replaceOfName?: string | null;
  replaceOfEmployeeCode?: string | null;
  separationReason?: string | null;
  replacementRemarks?: string | null;
  vacantDate?: string | null;
}): NormalisedReplacement[] {
  const rows: ReplacedEmployeeInput[] = Array.isArray(input.replacements)
    ? input.replacements
    : [
        {
          employeeName: input.replaceOfName,
          employeeCode: input.replaceOfEmployeeCode,
          separationReason: input.separationReason,
          vacantDate: input.vacantDate,
          remarks: input.replacementRemarks,
        },
      ];

  const seen = new Set<string>();
  const out: NormalisedReplacement[] = [];
  for (const row of rows) {
    const employeeName = clean(row?.employeeName, 150);
    if (!employeeName) continue;
    const employeeCode = clean(row?.employeeCode, 50);

    // The same person twice means one seat counted twice. Identity is the
    // employee code where there is one, because two people can share a name.
    const key = (employeeCode ?? employeeName).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      employeeName,
      employeeCode,
      separationReason: clean(row?.separationReason, 120),
      vacantDate: toDate(row?.vacantDate),
      remarks: clean(row?.remarks, 500),
      orderIndex: out.length,
    });
  }
  return out;
}

/**
 * What to tell someone when the number of leavers and the number of posts
 * disagree — a notice, never a refusal.
 *
 * Replacing three leavers with two hires is a real decision a raiser may
 * intend, and refusing it would push them to raise a requisition they do not
 * want just to get past a validator. Returns null when there is nothing to say.
 */
export function replacementCountNotice(
  replacedCount: number,
  requiredPosts: number,
): string | null {
  if (replacedCount === 0 || replacedCount === requiredPosts) return null;
  const people = `${replacedCount} ${replacedCount === 1 ? 'person' : 'people'}`;
  const posts = `${requiredPosts} ${requiredPosts === 1 ? 'post' : 'posts'}`;
  return replacedCount > requiredPosts
    ? `Replacing ${people} but requesting ${posts} — headcount goes down by ${replacedCount - requiredPosts}.`
    : `Replacing ${people} but requesting ${posts} — headcount goes up by ${requiredPosts - replacedCount}.`;
}
