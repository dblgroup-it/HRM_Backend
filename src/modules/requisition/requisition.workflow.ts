/**
 * Approval routing is no longer defined here.
 *
 * Chains are configured per unit (Configuration → Approval Paths) as an
 * ordered list of named approvers, and snapshotted onto each requisition at
 * creation time by `ApprovalPathsService.buildStepsForUnitName()`. The old
 * hardcoded rules (Dept Head → Factory HR if factory → SBU Head if new+factory
 * → Corporate HR) are gone; the `ApprovalRole` enum now only survives on
 * legacy chains raised before that change and on the CHRO step appended when
 * a final approver escalates.
 */

export interface RoleProfile {
  summary: string;
  jobDescription: string;
  responsibilities: string[];
  requirements: string[];
  generatedAt: string;
}

/** Step 3 — synthesize a structured role profile from the requisition. */
export function synthesizeRoleProfile(req: {
  designation: string;
  department: string;
  unitFactory: string;
  placeOfPosting: string;
  jobDescription: string;
  education: string;
  experience: string;
  others: string | null;
  requiredPosts: number;
}): RoleProfile {
  return {
    summary: `${req.designation} supporting ${req.department} at ${req.unitFactory}, based in ${req.placeOfPosting}.`,
    jobDescription:
      req.jobDescription ||
      `${req.unitFactory} is seeking a ${req.designation} for the ${req.department} department.`,
    responsibilities: [
      `Deliver ${req.department} outcomes for ${req.unitFactory}`,
      'Maintain quality, safety and compliance standards',
      'Collaborate with cross-functional teams',
      'Report progress and escalate risks',
    ],
    requirements: [
      `Education: ${req.education}`,
      `Experience: ${req.experience}`,
      ...(req.others ? [req.others] : []),
      `Suitable for ${req.requiredPosts} position(s)`,
    ],
    generatedAt: new Date().toISOString(),
  };
}
