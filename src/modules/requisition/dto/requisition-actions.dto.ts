import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FacilityDecisionDto)
  decisions!: FacilityDecisionDto[];
}

/** Editable fields when a requisition is bounced back for clarification. */
export class UpdateRequisitionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredPosts?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
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

  @IsOptional()
  @IsArray()
  @IsIn(['job_advertisement', 'headhunting', 'cv_bank'], {
    each: true,
  })
  preferredSources?: string[];

  /** Confirmed job grade for this post — one of JOB_GRADES, or '' to clear. */
  @IsOptional()
  @IsIn([...JOB_GRADES, ''])
  grade?: string;
}

export class ApprovalActionDto {
  @IsIn(['approved', 'rejected', 'need_more_info', 'escalate'])
  decision!: 'approved' | 'rejected' | 'need_more_info' | 'escalate';

  @IsOptional()
  @IsString()
  note?: string;
}

/** Nominate (or clear, with null) the Corporate Recruiter for a requisition. */
export class AssignRecruiterDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  recruiterId!: string | null;
}

/** Corporate HR's manual edits to the (AI-)generated role profile. */
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
  @IsIn(['job_advertisement', 'headhunting', 'cv_bank'], {
    each: true,
  })
  sources!: string[];

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
