import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

const EXAM_TYPES = ['written', 'excel'] as const;

export class AddExamQuestionDto {
  @IsIn(EXAM_TYPES)
  examType!: string;

  @IsIn(['mcq', 'text'])
  kind!: string;

  @IsString()
  @MinLength(1)
  prompt!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];

  @IsOptional()
  @IsString()
  answer?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  marks!: number;
}

export class UpdateExamQuestionDto {
  @IsOptional()
  @IsIn(['mcq', 'text'])
  kind?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  prompt?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];

  @IsOptional()
  @IsString()
  answer?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  marks?: number;
}

export class CreateAttemptDto {
  @IsIn(EXAM_TYPES)
  examType!: string;

  @IsOptional()
  @IsBoolean()
  notifyCandidate?: boolean;
}

export class SubmitExamDto {
  /** { questionId: answerText } */
  @IsObject()
  answers!: Record<string, string>;
}
