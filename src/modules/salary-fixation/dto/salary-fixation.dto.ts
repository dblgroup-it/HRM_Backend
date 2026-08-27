import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

import { JOB_GRADES } from '../salary-fixation.constants';

export class UpsertSalaryFixationDto {
  @IsOptional() @IsIn(JOB_GRADES) jobGrade?: string;

  @IsOptional() @IsBoolean() writtenTestEnabled?: boolean;
  @IsOptional() @IsNumber() writtenTestTotal?: number | null;
  @IsOptional() @IsNumber() writtenTestObtained?: number | null;
  @IsOptional() @IsBoolean() aiTestEnabled?: boolean;
  @IsOptional() @IsNumber() aiTestTotal?: number | null;
  @IsOptional() @IsNumber() aiTestObtained?: number | null;

  @IsOptional() @IsInt() @Min(1) @Max(11) bandOverride?: number | null;

  /** HR's manual figure — takes precedence over the auto-computed proposed salary. */
  @IsOptional() @IsNumber() @Min(0) proposedSalaryOverride?: number | null;
}
