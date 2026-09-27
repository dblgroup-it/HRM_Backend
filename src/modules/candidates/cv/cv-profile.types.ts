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
    motherName?: string;
    gender?: string;
    /** ISO date (yyyy-mm-dd) — sources send several formats. */
    dateOfBirth?: string;
    maritalStatus?: string;
    bloodGroup?: string;
    nationalId?: string;
    religion?: string;
    nationality?: string;
    /** Metres, e.g. 1.72. */
    heightMeters?: number;
    weightKg?: number;
  };

  /** The candidate's own statement of what they are looking for. */
  careerObjective?: string;

  contact: {
    email?: string;
    /** Country code and number already joined, e.g. "+880 1712345678". */
    phone?: string;
    currentLocation?: string;
    currentAddress?: string;
    permanentAddress?: string;
    facebookUrl?: string;
    linkedinUrl?: string;
  };

  employment: CvEmployment[];
  education: CvEducation[];
  /** Courses and workshops — "Training Summary" on a Bdjobs CV. */
  training?: CvTraining[];
  /** Professional certifications — "Professional Qualification". */
  certifications?: CvCertification[];
  skills?: CvSkill[];
  languages?: CvLanguage[];
  references?: CvReference[];

  /** "Career and Application Information" — what they are applying for. */
  career?: {
    preferredJobCategories?: string[];
    /** "Entry", "Mid", "Top" — Bdjobs' "Looking For". */
    jobLevel?: string;
    preferredDistricts?: string[];
    preferredOrganizationTypes?: string[];
  };

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
    /**
     * What the candidate said their experience is. Kept apart from the figure
     * computed from the job dates: the two disagree often enough that the
     * sheet must never print one as if it were the other.
     */
    statedExperienceYears?: number;
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
  /** Branch or city — "Company Location" on a Bdjobs CV. */
  location?: string;
  /** "Area of Expertise" for this post. */
  expertise?: string;
}

export interface CvEducation {
  institute: string;
  /** Omitted when it merely repeats `institute`, as Bdjobs often does. */
  university?: string;
  degree?: string;
  country?: string;
  passYear?: number;
  /** "45%", "CGPA 3.5 out of 4" — sources disagree, so it stays a string. */
  result?: string;
  /** Concentration / major, e.g. "Accounting". */
  major?: string;
  /** e.g. "4 years" — often blank on a Bdjobs CV. */
  duration?: string;
  achievement?: string;
}

export interface CvTraining {
  title: string;
  topic?: string;
  institute?: string;
  country?: string;
  location?: string;
  year?: number;
  /** As written, e.g. "2 weeks". */
  duration?: string;
}

export interface CvCertification {
  name: string;
  institute?: string;
  location?: string;
  /** ISO date (yyyy-mm-dd). */
  from?: string;
  to?: string;
}

export interface CvSkill {
  name: string;
  description?: string;
}

export interface CvLanguage {
  language: string;
  /** "High" / "Medium" / "Low", as Bdjobs rates them. */
  reading?: string;
  writing?: string;
  speaking?: string;
}

export interface CvReference {
  name: string;
  organization?: string;
  designation?: string;
  relation?: string;
  email?: string;
  phone?: string;
  address?: string;
}
