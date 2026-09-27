import type {
  CvCertification,
  CvEducation,
  CvEmployment,
  CvLanguage,
  CvProfile,
  CvReference,
  CvSkill,
  CvTraining,
} from './cv-profile.types';

/**
 * Bdjobs' candidate payload, exactly as they send it.
 *
 * Declared loosely on purpose: their blanks arrive as "", null and 0
 * interchangeably, and a field they add tomorrow should not break the import.
 * Everything is tightened up by the mapper below.
 */
export interface BdJobsCandidateData {
  personalData?: Record<string, unknown>;
  EmploymentHistory?: Record<string, unknown>[];
  qualifications?: Record<string, unknown>[];
  // Added with the 51-field parameter list (v2). All optional; a payload
  // without them is read exactly as before.
  trainings?: unknown;
  professionalQualifications?: unknown;
  careerInfo?: unknown;
  skills?: unknown;
  languages?: unknown;
  references?: unknown;
}

/** Rows that are objects; anything else in the array is dropped. */
function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter(
        (r): r is Record<string, unknown> =>
          typeof r === 'object' && r !== null && !Array.isArray(r),
      )
    : [];
}

/** The first of several spellings that holds something. */
function pick(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = text(row[k]);
    if (v) return tidy(v);
  }
  return undefined;
}

/**
 * A list sent as an array, or as one string separated by commas or pipes —
 * Bdjobs uses both for multi-select answers.
 */
function list(v: unknown): string[] | undefined {
  const parts = Array.isArray(v)
    ? v.map((x) => text(x))
    : (text(v) ?? '').split(/[|,]/).map((x) => text(x));
  const out = [...new Set(parts.filter((x): x is string => Boolean(x)).map(tidy))];
  return out.length ? out : undefined;
}

/** Height or weight: a positive number, from "1.72" or 1.72. */
function measure(v: unknown): number | undefined {
  const n = positiveNumber(typeof v === 'string' ? v.replace(/[^\d.]/g, '') : v);
  return n ? Math.round(n * 100) / 100 : undefined;
}

/** Only an http(s) link is kept — anything else is not a profile URL. */
function link(v: unknown): string | undefined {
  const t = text(v);
  if (!t) return undefined;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** "" , "   ", null, undefined → undefined. Everything else, trimmed. */
function text(v: unknown): string | undefined {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** Bdjobs sends 0 for "not stated", which is not the same as earning nothing. */
function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Bdjobs dates are dd/MM/yyyy. Parsed by hand rather than with `new Date`,
 * which would read "02/01/2012" as 2 January in Bangladesh and 1 February in
 * the United States depending on nothing but the server's locale.
 */
function isoDate(v: unknown): string | undefined {
  const raw = text(v);
  if (!raw) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (m) {
    const [, d, mo, y] = m;
    const day = Number(d);
    const month = Number(mo);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // Already ISO, or something close enough for Date to read unambiguously.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : undefined;
}

const monthsBetween = (from: string, to: string): number => {
  const a = new Date(from);
  const b = new Date(to);
  return (
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
  );
};

/**
 * Total experience with overlapping jobs counted once.
 *
 * Real Bdjobs profiles carry a dozen entries whose ranges sit on top of each
 * other — the sample has sixteen, most of them still "current". Adding the
 * spans would credit a 2011 graduate with eighty years, so the ranges are
 * merged into a timeline first and the timeline is what gets measured.
 */
function mergedExperienceMonths(jobs: CvEmployment[], today: string): number {
  const spans = jobs
    .map((j) => ({ from: j.from, to: j.to && j.to <= today ? j.to : today }))
    .filter((s): s is { from: string; to: string } => Boolean(s.from))
    .filter((s) => s.from <= s.to)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!spans.length) return 0;

  const merged: { from: string; to: string }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) {
      if (span.to > last.to) last.to = span.to;
    } else {
      merged.push({ ...span });
    }
  }
  return merged.reduce(
    (n, s) => n + Math.max(0, monthsBetween(s.from, s.to)),
    0,
  );
}

/** "6 years 4 months", "8 months", "1 year" — how the sheet prints it. */
function experienceLabel(totalMonths: number): string | undefined {
  if (totalMonths <= 0) return undefined;
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const parts: string[] = [];
  if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  if (months) parts.push(`${months} month${months === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** Same company, title and dates twice is one job entered twice. */
function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const k = key(row).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Normalise Bdjobs' backtick padding and stray whitespace in free text. */
const tidy = (v: string): string =>
  v.replace(/[`´]+/g, "'").replace(/\s+/g, ' ').replace(/'{2,}/g, "'").trim();

/**
 * Turn a Bdjobs candidate payload into the system's common CV format.
 *
 * Pure and side-effect free so it can be exercised against a real payload
 * without a database, a network call or a Nest container.
 */
export function bdjobsToCvProfile(
  data: BdJobsCandidateData,
  now: Date = new Date(),
  /**
   * Collects anything quietly dropped or repaired on the way through.
   *
   * A silently ignored date is the hardest kind of integration bug to find
   * from the other side, so the webhook hands these back in its reply.
   */
  warnings?: string[],
): CvProfile {
  const p = data.personalData ?? {};
  const today = now.toISOString().slice(0, 10);

  const fullName =
    text(p.fullName) ??
    [text(p.firstName), text(p.middleName), text(p.lastName)]
      .filter(Boolean)
      .join(' ') ??
    '';

  const phone = [text(p.countryCode), text(p.mobileNo)]
    .filter(Boolean)
    .join(' ');

  const rawJobs = data.EmploymentHistory ?? [];
  const employment: CvEmployment[] = dedupe(
    rawJobs.map((e, i) => {
      const from = isoDate(e.fromDate);
      const to = isoDate(e.toDate);
      if (text(e.fromDate) && !from)
        warnings?.push(
          `EmploymentHistory[${i}].fromDate "${String(e.fromDate)}" could not be read — expected dd/MM/yyyy, so this job has no start date.`,
        );
      if (text(e.toDate) && !to)
        warnings?.push(
          `EmploymentHistory[${i}].toDate "${String(e.toDate)}" could not be read — expected dd/MM/yyyy.`,
        );
      if (!text(e.companyName))
        warnings?.push(
          `EmploymentHistory[${i}] has no companyName and was ignored.`,
        );
      return {
        company: tidy(text(e.companyName) ?? ''),
        designation: text(e.designation)
          ? tidy(String(e.designation))
          : undefined,
        // Duties: `role` in the first version, `responsibilities` in v2.
        role: pick(e, 'responsibilities', 'duties', 'role'),
        location: pick(e, 'companyLocation', 'location', 'branch'),
        expertise: pick(e, 'areaOfExpertise', 'expertise'),
        from,
        to,
        // Bdjobs has no "currently working" flag; an end date that has not
        // arrived yet is how a profile says the job is still running.
        current: !to || to >= today,
      };
    }),
    (e) => `${e.company}|${e.designation ?? ''}|${e.from ?? ''}|${e.to ?? ''}`,
  )
    .filter((e) => e.company)
    // Most recently held first — by when a job *ended*, not when it started.
    // Sorting on the start date puts a role that finished years ago above the
    // one the candidate is in now.
    .sort(
      (a, b) =>
        (b.to ?? b.from ?? '').localeCompare(a.to ?? a.from ?? '') ||
        (b.from ?? '').localeCompare(a.from ?? ''),
    );

  const rawQuals = data.qualifications ?? [];
  const education: CvEducation[] = dedupe(
    rawQuals.map((q, i) => {
      if (!text(q.institute) && !text(q.university))
        warnings?.push(
          `qualifications[${i}] has neither institute nor university and was ignored.`,
        );
      const institute = tidy(text(q.institute) ?? text(q.university) ?? '');
      const university = tidy(text(q.university) ?? '');
      return {
        institute,
        // Bdjobs repeats the institute in `university` more often than not.
        university:
          university && university.toLowerCase() !== institute.toLowerCase()
            ? university
            : undefined,
        degree: text(q.degree) ? tidy(String(q.degree)) : undefined,
        country: text(q.country),
        // `passYear` in the nested CandidateData variant, `passingYear` in
        // the flat profile one. Reading only the first spelling silently blanked
        // the pass year — and with it the sheet's Education column — for every
        // candidate arriving from the live job board.
        passYear: positiveNumber(q.passYear ?? q.passingYear),
        result: educationResult(q),
        major: pick(q, 'concentration', 'major', 'subject'),
        duration: pick(q, 'duration'),
        achievement: pick(q, 'achievement', 'achievements'),
      };
    }),
    (q) => `${q.institute}|${q.passYear ?? ''}|${q.result ?? ''}`,
  )
    .filter((q) => q.institute)
    .sort((a, b) => (b.passYear ?? 0) - (a.passYear ?? 0));

  // A job still running beats one that has ended, however recently.
  if (rawJobs.length > employment.length)
    warnings?.push(
      `${rawJobs.length - employment.length} of ${rawJobs.length} employment rows were duplicates or empty and were merged away.`,
    );
  if (rawQuals.length > education.length)
    warnings?.push(
      `${rawQuals.length - education.length} of ${rawQuals.length} qualification rows were duplicates or empty and were merged away.`,
    );
  if (!text(p.emailId))
    warnings?.push(
      'personalData.emailId is empty — this candidate cannot be emailed from here.',
    );
  if (text(p.Dob ?? p.dateOfBirth) && !isoDate(p.Dob ?? p.dateOfBirth))
    warnings?.push(
      `personalData.Dob "${String(p.Dob ?? p.dateOfBirth)}" could not be read — expected dd/MM/yyyy.`,
    );
  for (const key of ['facebookUrl', 'linkedinUrl'] as const)
    if (text(p[key]) && !link(p[key]))
      warnings?.push(`personalData.${key} "${String(p[key])}" is not a web address and was ignored.`);

  const training: CvTraining[] = rows(data.trainings)
    .map((t, i) => {
      const title = pick(t, 'title', 'trainingTitle');
      if (!title) warnings?.push(`trainings[${i}] has no title and was ignored.`);
      return {
        title: title ?? '',
        topic: pick(t, 'topic', 'topicsCovered'),
        institute: pick(t, 'institute', 'institution'),
        country: pick(t, 'country'),
        location: pick(t, 'location'),
        year: positiveNumber(t.year),
        duration: pick(t, 'duration'),
      };
    })
    .filter((t) => t.title)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

  const certifications: CvCertification[] = rows(data.professionalQualifications)
    .map((c, i) => {
      const name = pick(c, 'certification', 'name', 'title');
      if (!name)
        warnings?.push(
          `professionalQualifications[${i}] has no certification name and was ignored.`,
        );
      const from = isoDate(c.fromDate);
      const to = isoDate(c.toDate);
      if (text(c.fromDate) && !from)
        warnings?.push(
          `professionalQualifications[${i}].fromDate "${String(c.fromDate)}" could not be read — expected dd/MM/yyyy.`,
        );
      if (text(c.toDate) && !to)
        warnings?.push(
          `professionalQualifications[${i}].toDate "${String(c.toDate)}" could not be read — expected dd/MM/yyyy.`,
        );
      return {
        name: name ?? '',
        institute: pick(c, 'institute', 'institution'),
        location: pick(c, 'location'),
        from,
        to,
      };
    })
    .filter((c) => c.name);

  const skills: CvSkill[] = dedupe(
    rows(data.skills)
      .map((k) => ({
        name: pick(k, 'name', 'skill', 'fieldOfSkill') ?? '',
        description: pick(k, 'description', 'skillDescription'),
      }))
      .filter((k) => k.name),
    (k) => k.name,
  );

  const languages: CvLanguage[] = rows(data.languages)
    .map((l) => ({
      language: pick(l, 'language', 'name') ?? '',
      reading: pick(l, 'reading'),
      writing: pick(l, 'writing'),
      speaking: pick(l, 'speaking'),
    }))
    .filter((l) => l.language);

  const references: CvReference[] = rows(data.references)
    .map((r, i) => {
      const name = pick(r, 'name');
      if (!name) warnings?.push(`references[${i}] has no name and was ignored.`);
      return {
        name: name ?? '',
        organization: pick(r, 'organization', 'organisation', 'company'),
        designation: pick(r, 'designation'),
        relation: pick(r, 'relation'),
        email: pick(r, 'email', 'emailId'),
        phone: pick(r, 'phone', 'mobileNo', 'mobile'),
        address: pick(r, 'address'),
      };
    })
    .filter((r) => r.name);

  const ci =
    data.careerInfo && typeof data.careerInfo === 'object' && !Array.isArray(data.careerInfo)
      ? (data.careerInfo as Record<string, unknown>)
      : {};
  const career = {
    preferredJobCategories: list(ci.preferredJobCategories ?? ci.preferredJobCategory),
    jobLevel: pick(ci, 'jobLevel', 'lookingFor'),
    preferredDistricts: list(ci.preferredDistricts ?? ci.preferredDistrict),
    preferredOrganizationTypes: list(
      ci.preferredOrganizationTypes ?? ci.preferredOrganizationType,
    ),
  };
  const hasCareer = Object.values(career).some(Boolean);

  // A job still running beats one that has ended, however recently.
  const latestJob = employment.find((e) => e.current) ?? employment[0];
  const topEducation = education[0];
  const months = mergedExperienceMonths(employment, today);

  return {
    source: 'bdjobs',
    capturedAt: now.toISOString(),
    personal: {
      fullName: tidy(fullName),
      salutation: text(p.salutation),
      firstName: text(p.firstName),
      middleName: text(p.middleName),
      lastName: text(p.lastName),
      fatherName: text(p.fatherName),
      motherName: text(p.motherName),
      gender: text(p.gender),
      dateOfBirth: isoDate(p.Dob ?? p.dateOfBirth),
      maritalStatus: text(p.MaritalStatus ?? p.maritalStatus),
      bloodGroup: text(p.BloodGroup ?? p.bloodGroup),
      nationalId: text(p.nationalId ?? p.aadharNo),
      religion: text(p.religion),
      nationality: text(p.nationality),
      heightMeters: measure(p.heightMeters ?? p.height),
      weightKg: measure(p.weightKg ?? p.weight),
    },
    careerObjective: text(p.careerObjective) ? tidy(String(p.careerObjective)) : undefined,
    contact: {
      email: text(p.emailId),
      phone: phone || undefined,
      currentLocation: text(p.currentLocation),
      currentAddress:
        [text(p.currentAddress1), text(p.currentAddress2)]
          .filter(Boolean)
          .join(', ') || undefined,
      permanentAddress: text(p.permanentAddress),
      facebookUrl: link(p.facebookUrl),
      linkedinUrl: link(p.linkedinUrl),
    },
    employment,
    education,
    ...(training.length ? { training } : {}),
    ...(certifications.length ? { certifications } : {}),
    ...(skills.length ? { skills } : {}),
    ...(languages.length ? { languages } : {}),
    ...(references.length ? { references } : {}),
    ...(hasCareer ? { career } : {}),
    compensation: {
      // v1 sends these in personalData; v2 may send them under careerInfo.
      current: positiveNumber(p.currentSalary ?? ci.presentSalary),
      expected: positiveNumber(p.expectedSalary ?? ci.expectedSalary),
    },
    summary: {
      latestEducation: topEducation
        ? [topEducation.degree, topEducation.institute, topEducation.passYear]
            .filter(Boolean)
            .join(', ')
        : undefined,
      totalExperienceYears: months
        ? Math.round((months / 12) * 10) / 10
        : undefined,
      statedExperienceYears: positiveNumber(p.totalExperienceYears),
      // Computed from the job dates where there are any. With none, what the
      // candidate stated is printed — marked as such, so it is never read as
      // a figure somebody checked.
      totalExperienceLabel:
        experienceLabel(months) ??
        (positiveNumber(p.totalExperienceYears)
          ? `${positiveNumber(p.totalExperienceYears)} years (stated)`
          : undefined),
      lastOrganization: latestJob?.company,
      lastDesignation: latestJob?.designation,
      currentlyEmployed: employment.some((e) => e.current),
    },
    extra: {
      // Kept because it is how Bdjobs names the vacancy on their side.
      requisitionId: text(p.requisitionId),
      employmentType: text(p.employmentType),
      currentCompanyName: text(p.currentCompanyName),
    },
  };
}

/**
 * The result as a reader wants it: "3.50 out of 4", "A+ out of 5", or the
 * grade / percentage the first version sent.
 */
function educationResult(q: Record<string, unknown>): string | undefined {
  const result = text(q.result) ?? text(q.grade) ?? text(q.percentage);
  if (!result) return undefined;
  const scale = text(q.resultScale ?? q.scale ?? q.outOf);
  return scale && !/out of/i.test(result) ? `${result} out of ${scale}` : result;
}
