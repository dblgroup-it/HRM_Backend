import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const STAGE_VALUES = [
  '',
  'applied',
  'ai_shortlisted',
  'shortlisted',
  'interview',
  'final',
  'selected',
  'rejected',
] as const;

export class CandidateQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;

  @IsOptional()
  @IsIn(STAGE_VALUES)
  stage?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  minScore?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['recent', 'match', 'name'])
  sortBy?: string;
}

export class BulkRejectDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  maxScore!: number;
}

const STAGES = [
  'applied',
  'shortlisted',
  'interview',
  'final',
  'selected',
  'rejected',
] as const;

const SOURCES = ['manual', 'upload', 'email', 'drive'] as const;

export class CreateCandidateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsIn(SOURCES)
  source?: string;
}

export class UpdateCandidateDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsIn(STAGES)
  stage?: string;

  @IsOptional()
  @IsBoolean()
  talentPool?: boolean;
}

export class EmailCandidateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  subject!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(8000)
  message!: string;
}

/** Public job-application payload (no auth — submitted from the apply page). */
export class PublicApplyDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  @MaxLength(160)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  salaryExpectation?: string;
}
