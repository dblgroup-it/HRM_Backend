import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class AddCommitteeMemberDto {
  @IsString()
  @MinLength(1)
  memberUserId!: string;

  @IsOptional()
  @IsIn(['interviewer', 'evaluator'])
  role?: string;
}

class RubricCriterionInput {
  @IsString()
  @MinLength(1)
  label!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxScore!: number;
}

export class SetRubricDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RubricCriterionInput)
  criteria!: RubricCriterionInput[];
}

class AssessmentComponentInput {
  @IsIn(['written', 'excel', 'skill', 'viva'])
  type!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxScore?: number;
}

export class SetPlanDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssessmentComponentInput)
  components!: AssessmentComponentInput[];
}

export class SaveNotesDto {
  @IsString()
  notes!: string;
}
