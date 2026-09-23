import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { JOB_GRADES } from '../../salary-fixation/salary-fixation.constants';
import { CV_SOURCES } from '../cv-sources';

const FACILITY_KEYS = ['laptopDesktop', 'transport', 'dormitory', 'seating'];

/** One facility confirm/skip decision, made by whichever role is the current pending approver. */
export class FacilityDecisionDto {
  @IsIn(FACILITY_KEYS)
  key!: 'laptopDesktop' | 'transport' | 'dormitory' | 'seating';

  @IsIn(['confirmed', 'skipped'])
  status!: 'confirmed' | 'skipped';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  hrNote?: string;
}

export class UpdateFacilitiesDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FacilityDecisionDto)
  decisions?: FacilityDecisionDto[];

  /**
   * The fixed appointment terms HR attaches — bonus share, salary review,
   * tax. Sent as the complete list, so removing one is just leaving it out;
   * omit the field entirely to leave the notes untouched.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  specialNotes?: string[];
}

/** Editable fields when a requisition is bounced back for clarification. */
export class UpdateRequisitionDto {
  /**
   * Section A's identity fields. Correctable by the unit's Factory HR during
   * the job analysis (and by HR at any stage) — the vacancy is often stated
   * loosely by the raiser and pinned down by the person writing the JD.
   * The approval chain was snapshotted when it was raised and is not rerouted.
   */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  designation?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  section?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  subSection?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  lineOfBusiness?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredPosts?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  totalVacantPosts?: number;

  @IsOptional()
  @IsString()
  placeOfPosting?: string;

  @IsOptional()
  @IsString()
  vacantDate?: string;

  @IsOptional()
  @IsString()
  neededDate?: string;

  @IsOptional()
  @IsIn(['top', 'moderate', 'ordinary'])
  priority?: 'top' | 'moderate' | 'ordinary';

  @IsOptional()
  @IsIn(['permanent', 'temporary', 'contractual'])
  employmentNature?: 'permanent' | 'temporary' | 'contractual';

  @IsOptional()
  @IsString()
  contractualPurpose?: string;

  @IsOptional()
  @IsString()
  jobDescription?: string;

  @IsOptional()
  @IsString()
  education?: string;

  @IsOptional()
  @IsString()
  experience?: string;

  @IsOptional()
  @IsString()
  others?: string;

  /** Confirmed job grade for this post — one of JOB_GRADES, or '' to clear. */
  @IsOptional()
  @IsIn([...JOB_GRADES, ''])
  grade?: string;
}

/**
 * Section B, written by the unit's Factory HR (or, where a unit has none, by
 * Head of Talent Acquisition / a Corporate Recruiter) after the requisition is
 * raised and before it enters its approval chain.
 *
 * Every field is optional so a half-written JD can be saved and finished later;
 * completeness is enforced on submit, in the service, not here.
 */
export class JobAnalysisDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  jobDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  education?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  experience?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  others?: string;

  /**
   * Default. `false` saves progress and leaves the requisition where it is;
   * `true` releases it to the approval chain.
   */
  @IsOptional()
  @IsBoolean()
  submit?: boolean;
}

/**
 * Ask the AI to draft section B from section A.
 *
 * Carries what is already typed so a redraft improves the writer's own words
 * rather than replacing them, plus an optional steer in plain language.
 */
export class DraftJobAnalysisDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  jobDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  education?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  experience?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  others?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  hint?: string;
}

/** Factory HR hands the requisition back to the raiser, with a reason. */
export class ReturnToRaiserDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

export class ApprovalActionDto {
  @IsIn(['approved', 'rejected', 'need_more_info', 'escalate'])
  decision!: 'approved' | 'rejected' | 'need_more_info' | 'escalate';

  @IsOptional()
  @IsString()
  note?: string;
}

/** Nominate (or clear, with null) the Corporate Recruiter for a requisition. */
/** Head of Talent Acquisition's CV collection sources — see cv-sources.ts. */
export class SetCvSourcesDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Tick at least one CV collection source' })
  @IsIn(CV_SOURCES, { each: true })
  sources!: string[];
}

export class AssignRecruiterDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  recruiterId!: string | null;
}

/** Head of Talent Acquisition's manual edits to the (AI-)generated role profile. */
export class UpdateRoleProfileDto {
  @IsString()
  @MaxLength(2000)
  summary!: string;

  @IsString()
  @MaxLength(5000)
  jobDescription!: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  @ArrayMaxSize(20)
  responsibilities!: string[];

  @IsArray()
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  @ArrayMaxSize(20)
  requirements!: string[];
}

export class PostRequisitionDto {
  @IsString()
  closingDate!: string;
}

export class QueryRequisitionsDto extends PaginationDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  unitFactory?: string;
}

/** AI quick-fill — the hiring manager's plain-language description. */
export class DraftRequisitionDto {
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  prompt!: string;
}
