import type { CvEducation, CvEmployment, CvProfile } from './cv-profile.types';

/**
 * A `CvProfile` flattened to plain text, for the AI screener.
 *
 * Bdjobs applicants arrive as fields, not documents, so there is no PDF to
 * hand the vision model — but the same facts are all present. This renders
 * them as the CV the screener would otherwise have read.
 *
 * Deliberately plain and label-led ("Company: …"), not prose: the screener
 * scores against explicit criteria, and a label it can anchor on beats a
 * nicely-written paragraph. Empty fields are omitted rather than printed as
 * blanks, so the model is never invited to reason about "Designation: ".
 */

/** Bdjobs pads free text with backticks; "govt girl``````s school" is real. */
const tidy = (v: string): string =>
  v.replace(/[`´]+/g, "'").replace(/\s+/g, ' ').replace(/'{2,}/g, "'").trim();

const text = (v: string | number | undefined | null): string | null => {
  const t = String(v ?? '').trim();
  return t ? tidy(t) : null;
};

/** "Mar 2011" — ISO in, human out. Null rather than "Invalid Date". */
function monthYear(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function period(job: CvEmployment): string {
  const from = monthYear(job.from);
  const to = job.current ? 'Present' : monthYear(job.to);
  if (!from && !to) return 'dates not stated';
  return `${from ?? '?'} – ${to ?? '?'}`;
}

function jobLines(job: CvEmployment, index: number): string[] {
  const head = [text(job.designation), text(job.company)]
    .filter(Boolean)
    .join(' at ');
  const out = [`${index + 1}. ${head || 'Role not stated'} (${period(job)})`];
  const role = text(job.role);
  if (role) out.push(`   Responsibilities: ${role}`);
  return out;
}

function eduLine(e: CvEducation, index: number): string {
  const parts = [
    text(e.degree),
    text(e.institute),
    // Bdjobs often repeats the institute as the university; the mapper drops
    // it when it does, so anything left here is genuinely different.
    text(e.university),
    e.passYear ? `passed ${e.passYear}` : null,
    text(e.result) ? `result ${text(e.result)}` : null,
    text(e.country),
  ].filter(Boolean);
  return `${index + 1}. ${parts.join(' · ') || 'Qualification not stated'}`;
}

export function cvProfileToText(profile: CvProfile): string {
  const p = profile.personal ?? { fullName: '' };
  const c = profile.contact ?? {};
  const s = profile.summary ?? { currentlyEmployed: false };
  const employment = profile.employment ?? [];
  const education = profile.education ?? [];
  const comp = profile.compensation ?? {};

  const blocks: string[] = [];

  const identity = [
    `Name: ${text([p.salutation, p.fullName].filter(Boolean).join(' ')) ?? 'Not stated'}`,
    text(p.gender) && `Gender: ${text(p.gender)}`,
    text(p.dateOfBirth) && `Date of birth: ${text(p.dateOfBirth)}`,
    text(p.maritalStatus) && `Marital status: ${text(p.maritalStatus)}`,
    text(c.email) && `Email: ${text(c.email)}`,
    text(c.phone) && `Phone: ${text(c.phone)}`,
    text(c.currentLocation) && `Current location: ${text(c.currentLocation)}`,
    text(c.currentAddress) && `Current address: ${text(c.currentAddress)}`,
    text(c.permanentAddress) && `Permanent address: ${text(c.permanentAddress)}`,
  ].filter(Boolean) as string[];
  blocks.push(identity.join('\n'));

  const facts = [
    s.totalExperienceLabel && `Total experience: ${s.totalExperienceLabel}`,
    s.lastOrganization &&
      `${s.currentlyEmployed ? 'Currently at' : 'Last organization'}: ${[
        text(s.lastOrganization),
        text(s.lastDesignation),
      ]
        .filter(Boolean)
        .join(' — ')}`,
    s.latestEducation && `Latest education: ${text(s.latestEducation)}`,
    comp.current && `Current salary: ${comp.current} per month`,
    comp.expected && `Expected salary: ${comp.expected} per month`,
  ].filter(Boolean) as string[];
  if (facts.length) blocks.push(`SUMMARY\n${facts.join('\n')}`);

  if (employment.length) {
    blocks.push(
      `EMPLOYMENT HISTORY (most recent first)\n${employment
        .flatMap((job, i) => jobLines(job, i))
        .join('\n')}`,
    );
  } else {
    blocks.push('EMPLOYMENT HISTORY\nNone stated in the application.');
  }

  if (education.length) {
    blocks.push(
      `EDUCATION\n${education.map((e, i) => eduLine(e, i)).join('\n')}`,
    );
  } else {
    blocks.push('EDUCATION\nNone stated in the application.');
  }

  return blocks.join('\n\n');
}
