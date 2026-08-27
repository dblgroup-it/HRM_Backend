/** One of the 10 fixed, policy-defined scoring criteria (never HR-configurable). */
export interface SalaryFixationCriterion {
  key: string;
  label: string;
  hint?: string;
  max: number;
  /** Discrete selectable point values for this criterion, [value, label][]. */
  options: [number, string][];
}

export const CRITERIA: SalaryFixationCriterion[] = [
  {
    key: 'education',
    label: 'Education',
    hint: 'Related to the role',
    max: 8,
    options: [
      [2, 'Required, Partial Related'],
      [4, 'Required, Related'],
      [6, 'Above Required, Partial Related'],
      [8, 'Above Required, Related'],
    ],
  },
  {
    key: 'experience',
    label: 'Experience',
    max: 8,
    options: [
      [2, 'Required, Partial Related'],
      [4, 'Required, Related'],
      [6, 'Above Required, Partial Related'],
      [8, 'Above Required, Related'],
    ],
  },
  {
    key: 'training',
    label: 'Training',
    max: 4,
    options: [
      [1, 'Basic'],
      [2, 'Relevant'],
      [3, 'Adequate Relevant'],
      [4, 'Abroad Relevant'],
    ],
  },
  {
    key: 'it_knowledge',
    label: 'IT Knowledge',
    max: 4,
    options: [
      [1, 'Basic'],
      [2, 'Work Perform'],
      [3, 'Intermediate'],
      [4, 'Expert'],
    ],
  },
  {
    key: 'leadership',
    label: 'Leadership',
    max: 4,
    options: [
      [1, 'Low'],
      [2, 'Moderate'],
      [3, 'High'],
      [4, 'Very High'],
    ],
  },
  {
    key: 'attitude_approach',
    label: 'Attitude & Approach',
    max: 4,
    options: [
      [1, 'Average'],
      [2, 'Fair'],
      [3, 'Good'],
      [4, 'Excellent'],
    ],
  },
  {
    key: 'presentation_skill',
    label: 'Presentation Skill',
    hint: 'Includes written test weightage (4 marks merged)',
    max: 8,
    options: [
      [2, 'Average'],
      [4, 'Fair'],
      [6, 'Good'],
      [8, 'Excellent'],
    ],
  },
  {
    key: 'discretion',
    label: 'Discretion on Decision Making',
    max: 4,
    options: [
      [1, 'Rarely Effective'],
      [2, 'Somehow Effective'],
      [3, 'Effective'],
      [4, 'Highly Effective'],
    ],
  },
  {
    key: 'position_scarcity',
    label: 'Position Scarcity',
    hint: 'Availability of candidates in market',
    max: 4,
    options: [
      [1, 'Available'],
      [2, 'Partially Available'],
      [3, 'Occasionally Available'],
      [4, 'Rarely Available'],
    ],
  },
  {
    key: 'complexity_of_work',
    label: 'Complexity of Work',
    max: 2,
    options: [
      [0.5, 'Undemanding'],
      [1, 'Quiet'],
      [1.5, 'Complicated'],
      [2, 'Challenging'],
    ],
  },
];

export const TOTAL_MAX = CRITERIA.reduce((sum, c) => sum + c.max, 0); // 50

export const JOB_GRADES = [
  'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15',
  'T1', 'T2', 'TM1', 'TM2', 'SM1', 'SM2', 'SM3', 'SM4', 'SM5', 'SM6', 'BM2',
] as const;
export type JobGrade = (typeof JOB_GRADES)[number];

/**
 * Salary Matrix — General Stream (M1-M7) is the official HR policy doc
 * ("Salary Matrix General Stream - Recruitment", effective May 2022);
 * `verified: true` for those 7. Everything else (M8-M15 continuing the same
 * stream's growth curve; T/TM/SM/BM2 — the Sales/Territory stream, mapped to
 * the General Stream tier they sit alongside) is `verified: false`: an
 * extrapolation pending an official HR document, not a confirmed policy
 * figure. Each grade spans 11 equal-step gross salary bands (bandSalary()).
 */
export const GRADES: Record<JobGrade, { min: number; max: number; verified: boolean }> = {
  M1: { min: 20_000, max: 35_000, verified: true },
  M2: { min: 30_000, max: 45_000, verified: true },
  M3: { min: 37_500, max: 60_000, verified: true },
  M4: { min: 50_000, max: 80_000, verified: true },
  M5: { min: 70_000, max: 100_000, verified: true },
  M6: { min: 85_000, max: 130_000, verified: true },
  M7: { min: 110_000, max: 170_000, verified: true },
  M8: { min: 145_000, max: 220_000, verified: false },
  M9: { min: 190_000, max: 285_000, verified: false },
  M10: { min: 245_000, max: 370_000, verified: false },
  M11: { min: 320_000, max: 480_000, verified: false },
  M12: { min: 415_000, max: 625_000, verified: false },
  M13: { min: 540_000, max: 810_000, verified: false },
  M14: { min: 700_000, max: 1_050_000, verified: false },
  M15: { min: 910_000, max: 1_365_000, verified: false },
  // Sales/Territory stream — mapped alongside the General Stream tier it sits nearest.
  T1: { min: 30_000, max: 45_000, verified: false }, // ~ M2
  T2: { min: 37_500, max: 60_000, verified: false }, // ~ M3
  TM1: { min: 50_000, max: 80_000, verified: false }, // ~ M4
  TM2: { min: 70_000, max: 100_000, verified: false }, // ~ M5
  SM1: { min: 50_000, max: 80_000, verified: false }, // ~ M4
  SM2: { min: 70_000, max: 100_000, verified: false }, // ~ M5
  SM3: { min: 85_000, max: 130_000, verified: false }, // ~ M6
  SM4: { min: 110_000, max: 170_000, verified: false }, // ~ M7
  SM5: { min: 145_000, max: 220_000, verified: false }, // ~ M8
  SM6: { min: 190_000, max: 285_000, verified: false }, // ~ M9
  BM2: { min: 85_000, max: 130_000, verified: false }, // ~ M6
};

export function isJobGrade(v: string): v is JobGrade {
  return (JOB_GRADES as readonly string[]).includes(v);
}

export function isGradeVerified(grade: JobGrade): boolean {
  return GRADES[grade].verified;
}

/** Band (1-11) → salary, linear interpolation within the grade's range. */
export function bandSalary(grade: JobGrade, band: number): number {
  const g = GRADES[grade];
  return g.min + ((band - 1) * (g.max - g.min)) / 10;
}

/** Average score (of 50) → Salary Band, per the policy table. */
export function bandFromScore(avg: number): number {
  if (avg <= 15) return 1;
  if (avg <= 17) return 2;
  if (avg <= 21) return 3;
  if (avg <= 26) return 4;
  if (avg <= 30) return 7;
  if (avg <= 35) return 8;
  if (avg <= 40) return 9;
  if (avg <= 45) return 10;
  return 11;
}

/** Fallback pass mark, used only until an admin sets one via Settings. */
export const DEFAULT_SCREENING_PASS_PCT = 50;

export interface ScreeningResult {
  status: 'not_conducted' | 'pending' | 'pass' | 'fail';
  pct: number | null;
}

/** Evaluate one screening test's total/obtained marks against its pass mark
 * (admin-configurable per test via Settings — see SettingsService.getScreeningConfig). */
export function evaluateScreeningTest(
  total: number | null | undefined,
  obtained: number | null | undefined,
  conducted: boolean,
  passPct: number = DEFAULT_SCREENING_PASS_PCT,
): ScreeningResult {
  if (!conducted) return { status: 'not_conducted', pct: null };
  if (total == null || obtained == null) return { status: 'pending', pct: null };
  if (total <= 0 || obtained < 0 || obtained > total) {
    return { status: 'pending', pct: null };
  }
  const pct = (obtained / total) * 100;
  return { status: pct >= passPct ? 'pass' : 'fail', pct };
}

/**
 * Validate + clamp a panelist's evaluation submission against the fixed 10
 * criteria — this is the single scoring mechanism used for both the hiring
 * scorecard and salary fixation. All 10 must be present; throws a plain
 * Error (callers wrap as BadRequestException) otherwise — never silently
 * treat a missing criterion as 0, since that would quietly skew both the
 * hiring decision and a real salary determination.
 */
export function scoreCriteria(
  input: Record<string, number> | null | undefined,
): { scores: Record<string, number>; total: number } {
  const missing = CRITERIA.filter((c) => typeof input?.[c.key] !== 'number');
  if (missing.length > 0) {
    throw new Error(
      `Complete all ${CRITERIA.length} evaluation criteria before submitting.`,
    );
  }
  const scores: Record<string, number> = {};
  let total = 0;
  for (const c of CRITERIA) {
    const clamped = Math.max(0, Math.min(c.max, input![c.key]));
    scores[c.key] = clamped;
    total += clamped;
  }
  return { scores, total };
}
