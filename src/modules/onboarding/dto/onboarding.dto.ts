import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
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

  /**
   * The check was done on paper, not through the structured form.
   *
   * Skips the form-completeness gate — the officer is attesting to an exam
   * that happened outside the system — so a note is required instead, and the
   * clearance is stamped as manual rather than passing itself off as a
   * completed digital report.
   */
  @IsOptional()
  @IsBoolean()
  manual?: boolean;
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

/** Terms that go on the offer letter, whichever format is chosen. */
export class OfferLetterDto {
  @IsIn(['junior', 'senior'])
  format!: 'junior' | 'senior';

  /**
   * Which of the requisition's designations this person is hired at.
   *
   * A requisition may offer several levels because the level depends on who is
   * found; this settles it for this candidate and is what the letter prints.
   * Omitted on a single-designation requisition, where the primary applies.
   * Rejected server-side if it is not one the requisition actually offers —
   * a letter is signed, and a typo in a job title is not correctable after it
   * has gone out.
   */
  @IsOptional() @IsString() @MaxLength(150) fixedDesignation?: string;

  /** "Mr." / "Ms." — omitted rather than guessed when unknown. */
  @IsOptional() @IsString() @MaxLength(10) salutation?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(60) reference?: string;
  @IsOptional() @IsString() joiningDate?: string;

  /** Senior format only. */
  @IsOptional() @IsString() @MaxLength(200) jobLocation?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) benefits?: string[];

  /** Junior format only. */
  @IsOptional() @IsInt() @Min(0) @Max(24) probationMonths?: number;
  @IsOptional() @IsInt() @Min(0) @Max(180) noticeDays?: number;
}

/** The appointment letter, issued after joining. */
export class AppointmentLetterDto {
  /** See OfferLetterDto.fixedDesignation — the appointment letter prints the same. */
  @IsOptional() @IsString() @MaxLength(150) fixedDesignation?: string;
  @IsOptional() @IsString() @MaxLength(60) reference?: string;
  @IsOptional() @IsString() joiningDate?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
}
