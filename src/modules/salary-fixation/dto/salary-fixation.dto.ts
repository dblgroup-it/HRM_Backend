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
  @IsOptional() @IsBoolean() computerTestEnabled?: boolean;
  @IsOptional() @IsNumber() computerTestTotal?: number | null;
  @IsOptional() @IsNumber() computerTestObtained?: number | null;
  @IsOptional() @IsBoolean() aiTestEnabled?: boolean;
  @IsOptional() @IsNumber() aiTestTotal?: number | null;
  @IsOptional() @IsNumber() aiTestObtained?: number | null;

  @IsOptional() @IsInt() @Min(1) @Max(11) bandOverride?: number | null;

  /** HR's manual figure — takes precedence over the auto-computed proposed salary. */
  @IsOptional() @IsNumber() @Min(0) proposedSalaryOverride?: number | null;
}

/**
 * The hand-marked screening tests only.
 *
 * Kept apart from UpsertSalaryFixationDto so the endpoint a delegated
 * interviewer can reach cannot carry a band or salary override — the global
 * ValidationPipe is `forbidNonWhitelisted`, so anything else is rejected
 * outright rather than silently ignored.
 */
export class UpsertScreeningTestsDto {
  @IsOptional() @IsBoolean() writtenTestEnabled?: boolean;
  @IsOptional() @IsNumber() writtenTestTotal?: number | null;
  @IsOptional() @IsNumber() writtenTestObtained?: number | null;
  @IsOptional() @IsBoolean() computerTestEnabled?: boolean;
  @IsOptional() @IsNumber() computerTestTotal?: number | null;
  @IsOptional() @IsNumber() computerTestObtained?: number | null;
  /** Skipping the online test is a judgement call the interviewer can make. */
  @IsOptional() @IsBoolean() aiTestEnabled?: boolean;
}
