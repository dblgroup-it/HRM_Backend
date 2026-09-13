/**
 * One CV shape for the whole system, whatever produced it.
 *
 * Bdjobs sends a structured profile, an applicant may upload a PDF, and a
 * recruiter may type a candidate in by hand. Everything downstream — the
 * approval sheet's Education / Total Exp. / Last Organization columns, the
 * screening panel, the interviewer's card — should read one shape rather than
 * learn each source's quirks. This is that shape.
 *
 * Every field is optional except the name, because no source fills them all.
 * Absent means "the source did not say", never an empty string: blanks are
 * normalised away on the way in so a consumer can trust `??` and `||`.
 */
export interface CvProfile {
  /** Where this came from, so a stale import can be traced or refreshed. */
  source: 'bdjobs' | 'upload' | 'manual';
  /** ISO timestamp of when we received it. */
  capturedAt: string;

  personal: {
    fullName: string;
    salutation?: string;
    firstName?: string;
    middleName?: string;
    lastName?: string;
    fatherName?: string;
    gender?: string;
    /** ISO date (yyyy-mm-dd) — sources send several formats. */
    dateOfBirth?: string;
    maritalStatus?: string;
    bloodGroup?: string;
    nationalId?: string;
  };

  contact: {
    email?: string;
    /** Country code and number already joined, e.g. "+880 1712345678". */
    phone?: string;
    currentLocation?: string;
    currentAddress?: string;
    permanentAddress?: string;
  };

  employment: CvEmployment[];
  education: CvEducation[];

  compensation: {
    /** Monthly, in the source's currency. Absent when the source sent 0. */
    current?: number;
    expected?: number;
  };

  /**
   * What the rest of the system actually reads.
   *
   * Derived once, on the way in, so nobody re-computes it — and so a sheet
   * column and an interviewer's card can never disagree about how long
   * somebody has worked.
   */
  summary: {
    /**
     * The most recently completed qualification, as one line.
     *
     * "Latest", not "highest": Bdjobs sends no degree level, so pass year is
     * the only ordering available and claiming seniority from it would be a
     * guess printed on an approval sheet.
     */
    latestEducation?: string;
    /** Years of real experience, overlapping jobs counted once. */
    totalExperienceYears?: number;
    /** The same figure written the way the approval sheet prints it. */
    totalExperienceLabel?: string;
    lastOrganization?: string;
    lastDesignation?: string;
    /** True when a job has no end date, or one in the future. */
    currentlyEmployed: boolean;
  };

  /** Anything the source sent that this format has no home for. */
  extra?: Record<string, unknown>;
}

export interface CvEmployment {
  company: string;
  designation?: string;
  role?: string;
  /** ISO date (yyyy-mm-dd). */
  from?: string;
  to?: string;
  /** Still there — no end date, or one that has not arrived yet. */
  current: boolean;
}

export interface CvEducation {
  institute: string;
  /** Omitted when it merely repeats `institute`, as Bdjobs often does. */
  university?: string;
  degree?: string;
  country?: string;
  passYear?: number;
  /** "45%", "CGPA 3.5", "A" — sources disagree, so it stays a string. */
  result?: string;
}
