export interface BdJobsLocation {
  id: number;
  name: string;
  parentLocationId: number;
}

export interface BdJobsCategory {
  id: number;
  name: string;
}

export interface BdJobsEduLevel {
  id: number;
  name: string;
}

export interface BdJobsDegree {
  id: number;
  name: string;
}

export interface BdJobsIndustry {
  id: string;
  name: string;
}

export interface BdJobsSkill {
  id: number;
  name: string;
}

export const EDU_LEVELS: { id: number; name: string }[] = [
  { id: 1, name: 'SSC/Equivalent' },
  { id: 2, name: 'HSC/Equivalent' },
  { id: 3, name: 'Diploma' },
  { id: 4, name: 'Bachelor/Honors' },
  { id: 5, name: 'Masters' },
  { id: 6, name: 'PhD/Postdoc' },
];

export type BdJobsEmploymentStatus =
  | 'full_time'
  | 'part_time'
  | 'contractual'
  | 'internship'
  | 'freelance';

export type BdJobsWorkplace = 'wfo' | 'wfh';
export type BdJobsGender = 'all' | 'male' | 'female' | 'others';

export interface PostBdJobsFormData {
  // Step 1 — Job details
  jobTitle: string;
  vacancyNo: number;
  locationIds: number[];
  locationNames: string[];
  categoryId: number | null;
  categoryName: string;
  employmentStatus: BdJobsEmploymentStatus[];
  workplace: BdJobsWorkplace[];
  salaryMin: number;
  salaryMax: number;
  showSalary: boolean;
  jobDescription: string;
  // Step 2 — Candidate requirements
  preferredGender: BdJobsGender;
  ageMin: number | null;
  ageMax: number | null;
  experienceYears: number;
  educationLevelId: number | null;
  educationLevelName: string;
  educationDegreeId: number | null;
  educationDegreeName: string;
  educationConcentration: string;
  industryExperience: { id: string; name: string }[];
  skills: { id: number; name: string }[];
  additionalRequirements: string;
  // Step 3 — Restrictions & posting
  restrictAge: boolean;
  restrictGender: boolean;
  restrictExperience: boolean;
  applyOnline: boolean;
  publishLinkedIn: boolean;
}
