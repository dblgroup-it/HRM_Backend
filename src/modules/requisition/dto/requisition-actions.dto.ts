import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

import { PaginationDto } from '../../../common/dto/pagination.dto';

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
  whenNeededDate?: string;

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
  @IsIn(['job_advertisement', 'headhunting', 'referral', 'cv_bank'], {
    each: true,
  })
  preferredSources?: string[];
}

export class ApprovalActionDto {
  @IsIn(['approved', 'rejected', 'need_more_info', 'escalate'])
  decision!: 'approved' | 'rejected' | 'need_more_info' | 'escalate';

  @IsOptional()
  @IsString()
  note?: string;
}

export class PostRequisitionDto {
  @IsIn(['job_advertisement', 'headhunting', 'referral', 'cv_bank'], {
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
