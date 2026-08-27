import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { JOB_GRADES } from '../../salary-fixation/salary-fixation.constants';

const GRADE_VALUES = JOB_GRADES;

export class AddQuestionDto {
  @IsString()
  @MinLength(1)
  prompt!: string;

  @IsArray()
  @ArrayMinSize(2)
  @IsString({ each: true })
  options!: string[];

  @IsString()
  @MinLength(1)
  answer!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  marks?: number;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(GRADE_VALUES, { each: true })
  grades!: string[];
}

export class UpdateQuestionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  prompt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @IsString({ each: true })
  options?: string[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  answer?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  marks?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(GRADE_VALUES, { each: true })
  grades?: string[];
}

export class AssignTestDto {
  @IsIn(GRADE_VALUES)
  jobGrade!: string;

  @IsInt()
  @Min(1)
  @Max(200)
  questionCount!: number;

  @IsOptional()
  @IsBoolean()
  notifyCandidate?: boolean;

  /** Minutes the candidate gets once they open the test; omit for no limit. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  timeLimitMinutes?: number;
}

export class SubmitAiProficiencyDto {
  @IsObject()
  answers!: Record<string, string>;

  /** Why this submit is happening — omit for a normal candidate-initiated submit. */
  @IsOptional()
  @IsIn(['time_up', 'violation'])
  reason?: 'time_up' | 'violation';
}

export class RecordViolationDto {
  @IsString()
  leftAt!: string;

  @IsOptional()
  @IsString()
  returnedAt?: string;

  @IsBoolean()
  endedTest!: boolean;
}

export class GenerateQuestionsDto {
  @IsIn(GRADE_VALUES)
  grade!: string;

  @IsInt()
  @Min(1)
  @Max(30)
  count!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  topic?: string;
}

class GeneratedQuestionItemDto {
  @IsString()
  @MinLength(1)
  prompt!: string;

  @IsArray()
  @ArrayMinSize(2)
  @IsString({ each: true })
  options!: string[];

  @IsString()
  @MinLength(1)
  answer!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  marks?: number;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(GRADE_VALUES, { each: true })
  grades!: string[];
}

export class BulkAddQuestionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GeneratedQuestionItemDto)
  items!: GeneratedQuestionItemDto[];
}

export class BulkDeleteQuestionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  ids!: string[];
}
