import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { OnboardingDocStatus, MedicalStatus } from '@prisma/client';

/** A cleared date `<input>` sends `''`, not omit the field — treat that as
 * "clear this date" (null) rather than an invalid date string. Distinct from
 * `undefined` (field simply wasn't sent), which the service leaves alone. */
const emptyToNull = () =>
  Transform(({ value }) => (value === '' ? null : value));

export class UploadDocDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;
}

export class VerifyDocDto {
  @IsIn(['verified', 'rejected', 'pending'])
  status!: OnboardingDocStatus;
}

export class ManualCrossCheckDto {
  @IsIn(['consistent', 'minor_issues', 'discrepancies'])
  verdict!: 'consistent' | 'minor_issues' | 'discrepancies';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class MedicalDto {
  @IsIn(['cleared', 'rejected', 'pending'])
  status!: MedicalStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Draft-friendly — every field optional so the medical officer can save
 * partial progress. Completeness is enforced only when clearing (see
 * OnboardingService.setMedical). */
export class MedicalExamDto {
  @IsOptional()
  @emptyToNull()
  @IsDateString()
  dateOfBirth?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  dutyPosition?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNo?: string;

  @IsOptional()
  @emptyToNull()
  @IsDateString()
  examDate?: string | null;

  @IsOptional()
  @emptyToNull()
  @IsDateString()
  issueDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  consultantName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  height?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  weight?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  pulse?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  bloodPressure?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  visionRightEye?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  visionLeftEye?: string;

  @IsOptional()
  @IsBoolean()
  visionWithGlass?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  colorVisionYellow?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  colorVisionRed?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  colorVisionGreen?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  colorVisionBlue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  hearingRightEar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  hearingLeftEar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  speech?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  extremities?: string;

  @IsOptional()
  @IsBoolean()
  noAnemiaJaundiceEtc?: boolean;

  @IsOptional()
  @IsBoolean()
  stableNormotensiveNondiabetic?: boolean;

  @IsOptional()
  @IsBoolean()
  urineTestClear?: boolean;

  @IsOptional()
  @IsBoolean()
  hepatitisBNegative?: boolean;

  @IsOptional()
  @IsBoolean()
  liverFunctionNormal?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  pastIllnessHistory?: string;

  @IsOptional()
  @IsBoolean()
  familyHistoryDmHtn?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  familyHistoryDetail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  bloodGroup?: string;

  @IsOptional()
  @IsBoolean()
  fitToJoin?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
}

export class NotifyItDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  assetId?: string;
}
