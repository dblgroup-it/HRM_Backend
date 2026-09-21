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

  /** `absent` is the candidate not turning up — see InterviewStatus. */
  @IsOptional()
  @IsIn(['scheduled', 'completed', 'cancelled', 'absent'])
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

/** People to add to a panel that is already arranged. */
export class AddPanelistsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  panelistUserIds!: string[];
}

/**
 * What the candidate is on now and what they want, taken in the room.
 *
 * Deliberately has no field for the salary DBL will offer: that is fixed by
 * Corporate HR against the grade and the committee's marks, on the Salary
 * Fixation screen. An interviewer recording a "final" figure would be making
 * a promise nobody authorised.
 */
export class CandidatePackageDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  presentSalary?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salaryExpectation?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  salaryBenefitsNote?: string | null;
}

/** Why the candidate is being turned down at the interview stage. */
export class RejectAtInterviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
