/**
 * DBL's joining-document checklist.
 *
 * One flat, ordered catalogue rather than the old pair of string arrays. Each
 * entry carries everything the portal and HR's screen need to render and
 * enforce it, so the two cannot drift: which section it belongs under,
 * whether it holds anything up, whether the candidate may send more than one,
 * and whether a paper copy is expected on top of the scan.
 *
 * `key` is what the filed document is matched on, and it never changes.
 * `label` is what people read and may be reworded freely — the previous
 * version matched on the label, so rewording an item orphaned every document
 * already collected under the old words and a candidate's file silently went
 * back to incomplete.
 */
export type DocSection =
  | 'photographs'
  | 'academic'
  | 'professional'
  | 'experience'
  | 'identity'
  | 'financial'
  | 'signature';

export interface JoiningDocSpec {
  key: string;
  label: string;
  /** The line of guidance under the label. */
  hint: string;
  section: DocSection;
  /** Absent blocks final verification. */
  required: boolean;
  /**
   * The candidate may add as many as they have, naming each one.
   *
   * Used for professional certifications: nobody can say in advance whether
   * somebody holds none or six, and six fixed empty slots read as six things
   * missing.
   */
  repeatable?: boolean;
  /** A physical copy is expected as well as the upload. */
  hardCopy?: boolean;
  /** Structured particulars are typed alongside the scan. */
  particulars?: 'nid';
  /**
   * Only a photograph will do — no PDF.
   *
   * The passport photographs become the candidate's picture across the
   * system, and a PDF in an `<img>` is a broken icon. It is also what the
   * slot literally asks for: a lab print, photographed or scanned.
   */
  imageOnly?: boolean;
  /**
   * An upload here is checked by the vision model before it is accepted.
   *
   * Only worth doing where the image is used as a picture of the person —
   * it becomes their avatar and prints on their summary, so a certificate
   * scanned into this slot by mistake ends up as somebody's face across the
   * system. The check fails open; see portrait-gate.ts.
   */
  verifyPortrait?: boolean;
}

export const DOC_SECTIONS: { key: DocSection; label: string; blurb: string }[] =
  [
    {
      key: 'photographs',
      label: 'Photographs',
      blurb: 'Lab prints, handed over as well as uploaded.',
    },
    {
      key: 'academic',
      label: 'Academic',
      blurb: 'Each certificate and its marksheet, separately.',
    },
    {
      key: 'professional',
      label: 'Professional & Training',
      blurb: 'Add one row per certification you hold.',
    },
    {
      key: 'experience',
      label: 'Experience & Employment',
      blurb: 'From your previous employers.',
    },
    {
      key: 'identity',
      label: 'Identity & Address',
      blurb: 'Proof of who you are and where you live.',
    },
    {
      key: 'financial',
      label: 'Tax & Salary',
      blurb: 'If you have them.',
    },
    {
      key: 'signature',
      label: 'Signature',
      blurb: 'Used to sign your joining forms.',
    },
  ];

/** The one item that is a picture, and the one every later form signs with. */
export const SIGNATURE_DOC_KEY = 'signature';

/** The signed Code of Conduct, filed like any other joining document. */
export const COC_DOC_KEY = 'code_of_conduct';
export const COC_DOC_LABEL = 'Code of Conduct (signed)';

export const JOINING_DOCS: readonly JoiningDocSpec[] = [
  // ── Photographs ────────────────────────────────────────────────────────
  {
    key: 'passport_photos',
    label: 'Passport Photographs',
    hint: 'Four copies · white background · lab print · JPG or PNG, plus the printed set',
    section: 'photographs',
    required: true,
    hardCopy: true,
    imageOnly: true,
    verifyPortrait: true,
  },

  // ── Academic ───────────────────────────────────────────────────────────
  // Certificate and marksheet are separate rows on purpose: candidates
  // routinely have one and not the other, and a single combined row cannot
  // say which half is missing.
  {
    key: 'ssc_certificate',
    label: 'SSC Certificate',
    hint: 'Secondary School Certificate, or equivalent',
    section: 'academic',
    required: true,
  },
  {
    key: 'ssc_marksheet',
    label: 'SSC Marksheet',
    hint: 'Transcript or statement of marks',
    section: 'academic',
    required: true,
  },
  {
    key: 'hsc_certificate',
    label: 'HSC Certificate',
    hint: 'Higher Secondary Certificate, or equivalent',
    section: 'academic',
    required: true,
  },
  {
    key: 'hsc_marksheet',
    label: 'HSC Marksheet',
    hint: 'Transcript or statement of marks',
    section: 'academic',
    required: true,
  },
  {
    key: 'graduation_certificate',
    label: 'Graduation Certificate',
    hint: 'Your bachelor’s degree certificate',
    section: 'academic',
    required: true,
  },
  {
    key: 'graduation_marksheet',
    label: 'Graduation Marksheet',
    hint: 'Transcript or consolidated statement of marks',
    section: 'academic',
    required: true,
  },
  {
    key: 'post_graduation_certificate',
    label: 'Post Graduation Certificate',
    hint: 'If you have completed a master’s degree',
    section: 'academic',
    required: false,
  },
  {
    key: 'post_graduation_marksheet',
    label: 'Post Graduation Marksheet',
    hint: 'If you have completed a master’s degree',
    section: 'academic',
    required: false,
  },

  // ── Professional ───────────────────────────────────────────────────────
  {
    key: 'professional_cert',
    label: 'Professional Certification',
    hint: 'Name the certification, then attach it. Add a row for each one.',
    section: 'professional',
    required: false,
    repeatable: true,
  },
  {
    key: 'training_certificates',
    label: 'Training Certificates',
    hint: 'All training certificates you hold',
    section: 'professional',
    required: false,
    repeatable: true,
  },

  // ── Experience & employment ────────────────────────────────────────────
  {
    key: 'experience_certificates',
    label: 'Experience Certificates',
    hint: 'One from each previous employer, if any',
    section: 'experience',
    required: false,
    repeatable: true,
  },
  {
    key: 'relieving_letter',
    label: 'Relieving Letter',
    hint: 'From your previous employer — experienced candidates',
    section: 'experience',
    required: false,
  },
  {
    key: 'last_pay_slip',
    label: 'Last Pay Slip',
    hint: 'From your previous employer, if you have it',
    section: 'experience',
    required: false,
  },

  // ── Identity & address ─────────────────────────────────────────────────
  {
    key: 'nid_or_passport',
    label: 'NID / Birth Registration / Passport',
    hint: 'At least one. Fill in the four details exactly as printed.',
    section: 'identity',
    required: true,
    particulars: 'nid',
  },
  {
    key: 'residence_proof',
    label: 'Proof of Residence',
    hint: 'Any recent government utility bill',
    section: 'identity',
    required: true,
  },

  // ── Tax & salary ───────────────────────────────────────────────────────
  {
    key: 'tin_copy',
    label: 'TIN Certificate',
    hint: 'If you have one',
    section: 'financial',
    required: false,
  },
  {
    key: 'tax_return',
    label: 'Last Tax Return Submission',
    hint: 'If any — experienced candidates',
    section: 'financial',
    required: false,
  },
  {
    key: 'salary_certificate',
    label: 'Salary Certificate / Statement',
    hint: 'Experienced candidates',
    section: 'financial',
    required: false,
  },

  // ── Signature ──────────────────────────────────────────────────────────
  {
    key: SIGNATURE_DOC_KEY,
    label: 'Signature',
    hint: 'A photo or scan of your signature — you crop it here',
    section: 'signature',
    required: true,
  },
];

const BY_KEY = new Map(JOINING_DOCS.map((d) => [d.key, d]));

export function docSpec(key: string | null | undefined): JoiningDocSpec | null {
  return key ? (BY_KEY.get(key) ?? null) : null;
}

/** Keys that must be on file before final verification will pass. */
export const REQUIRED_DOC_KEYS = JOINING_DOCS.filter((d) => d.required).map(
  (d) => d.key,
);

/** The label a required key is reported as when it is missing. */
export function docLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/**
 * Old label -> new key, for documents filed before the checklist was split.
 *
 * Kept in code as well as in the migration: a row that slipped in between
 * the deploy and the migration, or one restored from an older backup, still
 * lands on the right slot rather than becoming an orphan nobody can see.
 */
export const LEGACY_LABEL_TO_KEY: Record<string, string> = {
  'Passport Photographs': 'passport_photos',
  'Academic Certificates': 'graduation_certificate',
  'Experience Certificates': 'experience_certificates',
  'National ID or Passport': 'nid_or_passport',
  'Proof of Residence': 'residence_proof',
  Signature: SIGNATURE_DOC_KEY,
  'Relieving Letter & Last Pay Slip': 'relieving_letter',
  'TIN or Last Tax Return': 'tin_copy',
  'Salary Certificate': 'salary_certificate',
  [COC_DOC_LABEL]: COC_DOC_KEY,
};
