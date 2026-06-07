import {
  ApprovalRole,
  Prisma,
  RequirementType,
  RequisitionSource,
} from '@prisma/client';

/** Metadata for every possible approval role. */
export const APPROVAL_ROLE_META: Record<
  ApprovalRole,
  { title: string; subtitle: string }
> = {
  DEPARTMENT_HEAD: {
    title: 'Department / Division Head',
    subtitle: 'Raises and signs the requisition',
  },
  FACTORY_HR: {
    title: 'Factory HR',
    subtitle: 'Verifies vacancy & local details',
  },
  SBU_HEAD: {
    title: 'SBU Head',
    subtitle: 'Approves new headcount beyond organogram',
  },
  CORPORATE_HR: {
    title: 'Corporate HR',
    subtitle: 'Final approval to commence hiring',
  },
  CHRO: {
    title: 'CHRO',
    subtitle: 'Escalated final approval',
  },
};

/**
 * Routing rules (from the requisition flowchart):
 *  - Department Head always first.
 *  - Factory HR when the source is a factory.
 *  - SBU Head only for NEW headcount raised from a factory.
 *  - Corporate HR is the single final approver.
 */
export function buildApprovalRoles(
  requirement: RequirementType,
  source: RequisitionSource,
): ApprovalRole[] {
  const roles: ApprovalRole[] = ['DEPARTMENT_HEAD'];
  if (source === 'FACTORY') roles.push('FACTORY_HR');
  if (requirement === 'NEW' && source === 'FACTORY') roles.push('SBU_HEAD');
  roles.push('CORPORATE_HR');
  return roles;
}

export interface Signatories {
  departmentHeadName: string;
  factoryHRName?: string;
}

/** Build the ApprovalStep create-payloads for a new requisition. */
export function buildChainSteps(
  requirement: RequirementType,
  source: RequisitionSource,
  signatories: Signatories,
): Prisma.ApprovalStepCreateWithoutRequisitionInput[] {
  const assignees: Partial<Record<ApprovalRole, string>> = {
    DEPARTMENT_HEAD: signatories.departmentHeadName,
    FACTORY_HR: signatories.factoryHRName,
  };
  return buildApprovalRoles(requirement, source).map((role, orderIndex) => ({
    orderIndex,
    role,
    title: APPROVAL_ROLE_META[role].title,
    subtitle: APPROVAL_ROLE_META[role].subtitle,
    assignee: assignees[role] ?? '',
    status: 'PENDING',
  }));
}

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
