import { Transform, Type } from 'class-transformer';
import { CandidateSource } from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
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

const SOURCES = ['manual', 'upload', 'email', 'drive', 'application'] as const;

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
  source?: CandidateSource;
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

  /** What the candidate actually asked for — updated as it comes up in
   * interviews, distinct from the application-time figure and from the
   * company's own proposed salary. Optional. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  salaryExpectation?: number | null;
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

export class FlagCandidateDto {
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}

export class CopyToRequisitionDto {
  @IsString()
  @MinLength(1)
  requisitionId!: string;

  // Explicit transform: the global ValidationPipe's implicit conversion coerces
  // ANY non-empty string (including the literal "false") to `true` via `Boolean(value)`,
  // which would silently invert this flag — so convert it ourselves before @IsBoolean sees it.
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? value : value === true || value === 'true'))
  @IsBoolean()
  force?: boolean;
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
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salaryExpectation?: number;
}
