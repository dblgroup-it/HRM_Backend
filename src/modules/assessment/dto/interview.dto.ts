import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

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
