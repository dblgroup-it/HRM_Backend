import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Which screening tests these candidates must sit, set at hand-off time.
 *
 * Head of Talent Acquisition decides what applies and out of how many marks; the interviewer
 * they send to fills in what was scored. Obtained marks are deliberately not
 * settable here — this is the brief, not the result.
 */
export class DelegationTestsDto {
  @IsOptional() @IsBoolean() writtenTestEnabled?: boolean;
  @IsOptional() @IsNumber() @Min(1) writtenTestTotal?: number | null;
  @IsOptional() @IsBoolean() computerTestEnabled?: boolean;
  @IsOptional() @IsNumber() @Min(1) computerTestTotal?: number | null;
  @IsOptional() @IsBoolean() aiTestEnabled?: boolean;
}

/** Hand shortlisted candidates to the people who will interview them. */
export class DelegateInterviewsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  candidateIds!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  delegateUserIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DelegationTestsDto)
  tests?: DelegationTestsDto;
}

/** What the first-interview panel decided. */
export class FirstInterviewOutcomeDto {
  @IsIn(['final', 'rejected'])
  outcome!: 'final' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ScheduleInterviewDto {
  @IsIn(['first', 'second', 'final'])
  kind!: string;

  @IsIn(['online', 'offline', 'physical'])
  mode!: string;

  @IsOptional()
  @IsString()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsArray()
  @IsString({ each: true })
  panelistUserIds!: string[];

  @IsOptional()
  @IsBoolean()
  notifyCandidate?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyPanel?: boolean;
}

export class UpdateInterviewDto {
  @IsOptional()
  @IsIn(['first', 'second', 'final'])
  kind?: string;

  @IsOptional()
  @IsIn(['online', 'offline', 'physical'])
  mode?: string;

  @IsOptional()
  @IsString()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsIn(['scheduled', 'completed', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  panelistUserIds?: string[];
}

export class BulkScheduleInterviewDto {
  /** IDs of candidates to schedule for (order matters for sequential slots). */
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  candidateIds!: string[];

  @IsIn(['first', 'second', 'final'])
  kind!: string;

  @IsIn(['online', 'offline', 'physical'])
  mode!: string;

  /** One ISO datetime per candidate (same order as candidateIds). Omit for no time. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scheduledAts?: string[];

  @IsOptional()
  @IsString()
  location?: string;

  @IsArray()
  @IsString({ each: true })
  panelistUserIds!: string[];

  @IsOptional()
  @IsBoolean()
  notifyCandidate?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyPanel?: boolean;
}

export class SubmitEvaluationDto {
  /** { criterionKey: score } against the fixed 10-criteria set. */
  @IsObject()
  scores!: Record<string, number>;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comments?: string;
}

/**
 * The people whose workload the send dialog wants to show.
 *
 * Bounded: the dialog shows a page of search results, not the whole directory,
 * and an unbounded list would turn one click into a 4,600-row aggregation.
 */
export class DelegateWorkloadDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  userIds!: string[];
}
