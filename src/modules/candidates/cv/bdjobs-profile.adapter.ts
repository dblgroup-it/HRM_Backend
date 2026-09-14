import type { BdJobsCandidateData } from './bdjobs-cv.mapper';

/**
 * Bdjobs' *flat* candidate profile — the second shape they send.
 *
 * The same applicant reaches us two ways. Some integrations post a nested
 * `CandidateData` block (personalData / EmploymentHistory / qualifications);
 * the live BDJobs job board posts a flat `profile` object instead, with the
 * work history under `employmentHistory`, the education under
 * `educationHistory`, and the personal fields hoisted to the top level.
 *
 * Rather than teach the mapper two vocabularies, or — worse — write a second
 * mapper, this translates the flat shape into the nested one and hands it to
 * the single mapper that already knows how to parse dd/MM/yyyy, merge
 * overlapping jobs, drop duplicate rows and tidy Bdjobs' backtick padding.
 * One CV shape, one set of rules, so the approval sheet and the interviewer's
 * card cannot disagree about the same candidate.
 *
 * Everything here is defensive about types. The inbound DTO deliberately
 * accepts `profile` as a loose object (a field Bdjobs adds next quarter must
 * widen the CV, not reject the application at the door), so nothing upstream
 * guarantees that `employmentHistory` is an array or that `passingYear` is a
 * number.
 */
export interface BdJobsFlatProfile {
  [key: string]: unknown;
}

/** Rows that are objects; anything else Bdjobs put in the array is dropped. */
function objectRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter(
        (row): row is Record<string, unknown> =>
          typeof row === 'object' && row !== null && !Array.isArray(row),
      )
    : [];
}

/** "", "   ", null, undefined → undefined. Numbers become their digits. */
function text(v: unknown): string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/**
 * Does this profile carry a CV, or only identifiers?
 *
 * Integrations that send `CandidateData` also send a `profile` holding nothing
 * but `bdjobsApplicantId`. Adapting that would store an empty CV profile on
 * every such candidate and overwrite nothing useful with nothing at all, so
 * those return null and the caller falls back to `CandidateData` as before.
 */
function carriesCv(p: BdJobsFlatProfile): boolean {
  return (
    objectRows(p.employmentHistory).length > 0 ||
    objectRows(p.educationHistory).length > 0 ||
    Boolean(
      text(p.currentEmployer) ??
      text(p.currentDesignation) ??
      text(p.highestEducation) ??
      text(p.institution) ??
      text(p.dateOfBirth) ??
      text(p.presentLocation) ??
      text(p.gender),
    )
  );
}

/**
 * Translate Bdjobs' flat `profile` into the nested shape `bdjobsToCvProfile`
 * consumes. Returns null when the profile holds no CV content at all.
 *
 * `candidate` is the payload's top-level name/email/phone block. In the flat
 * variant that block is the only place the applicant's name appears, and the
 * stored CV should not be missing the name of the person it describes.
 */
export function bdjobsProfileToCandidateData(
  profile: BdJobsFlatProfile | null | undefined,
  candidate?: { name?: string; email?: string; phone?: string } | null,
): BdJobsCandidateData | null {
  if (!profile || typeof profile !== 'object') return null;
  if (!carriesCv(profile)) return null;

  const employment = objectRows(profile.employmentHistory);
  const education = objectRows(profile.educationHistory);

  return {
    personalData: {
      fullName: text(candidate?.name),
      emailId: text(candidate?.email),
      // The mapper joins countryCode + mobileNo; the flat variant sends one
      // already-joined string, so it goes in whole and countryCode stays unset.
      mobileNo: text(candidate?.phone),
      gender: text(profile.gender),
      // Flat profiles send ISO (1988-01-01); the mapper reads ISO and
      // dd/MM/yyyy both, so no conversion is needed or wanted here.
      Dob: text(profile.dateOfBirth),
      currentLocation: text(profile.presentLocation),
      currentSalary: profile.currentSalary,
      expectedSalary: profile.expectedSalary,
      currentCompanyName: text(profile.currentEmployer),
    },

    // `companyName` / `designation` / `role` / `fromDate` / `toDate` are spelled
    // identically in both variants, so the rows pass through untouched.
    //
    // When Bdjobs sends no history but does name a current employer, that one
    // job is still the answer to "last organization" on the approval sheet.
    // With no dates it contributes nothing to the experience total, which is
    // right — we were not told how long.
    EmploymentHistory: employment.length
      ? employment
      : text(profile.currentEmployer)
        ? [
            {
              companyName: text(profile.currentEmployer),
              designation: text(profile.currentDesignation),
            },
          ]
        : [],

    // `passingYear` here, `passYear` in the nested variant — the mapper accepts
    // both. Everything else is spelled the same.
    //
    // Same fallback as above: `highestEducation` + `institution` + `passingYear`
    // is a qualification, and losing it would blank the sheet's Education column.
    qualifications: education.length ? education : flatQualification(profile),
  };
}

/**
 * The one qualification a flat profile states outside `educationHistory`.
 *
 * `institution` is the school and `highestEducation` the award — except Bdjobs
 * very often puts the school in both, and the mapper drops a row with no
 * institute. So the institute falls back to whichever field is filled, and the
 * degree is only set when it actually says something different.
 */
function flatQualification(p: BdJobsFlatProfile): Record<string, unknown>[] {
  const institution = text(p.institution);
  const award = text(p.highestEducation);
  const institute = institution ?? award;
  if (!institute) return [];
  const degree =
    award && award.toLowerCase() !== institute.toLowerCase()
      ? award
      : undefined;
  return [{ institute, degree, passingYear: p.passingYear }];
}
