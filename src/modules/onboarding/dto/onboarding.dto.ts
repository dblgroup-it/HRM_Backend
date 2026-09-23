import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { OnboardingDocStatus, MedicalStatus } from '@prisma/client';

/** A cleared date `<input>` sends `''`, not omit the field — treat that as
 * "clear this date" (null) rather than an invalid date string. Distinct from
 * `undefined` (field simply wasn't sent), which the service leaves alone. */
const emptyToNull = () =>
  Transform(({ value }) => (value === '' ? null : value));

export class UploadDocDto {
  /** Which checklist slot this fills — see JOINING_DOCS. */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  docKey!: string;

  /**
   * What to call it, for the repeatable slots only.
   *
   * A professional certification is named by the candidate ("PMP"); a fixed
   * slot always prints the catalogue's own wording whatever arrives here.
   */
  @IsOptional()
  @IsString()
  @MaxLength(150)
  label?: string;
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
   * The CHRO this letter is issued over.
   *
   * Required. It used to be whichever `chro` assignment the database returned
   * first, so nothing on screen told HR whose name would appear at the bottom
   * of a contract. Whether that person has an e-signature on file is a
   * separate matter — the letter prints an empty rule for a wet signature.
   */
  @IsString()
  @MaxLength(60)
  signatoryUserId!: string;

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

/** Send the pre-employment medical test letter. */
export class SendMedicalLetterDto {
  /**
   * Which test list. Not derived server-side from the date of birth: the two
   * lists differ by an actual test, Bdjobs applicants frequently have no date
   * on file, and HR may know better than the record does.
   */
  @IsIn(['below_40', 'above_40'])
  band!: 'below_40' | 'above_40';

  /** Appointment date AND time — "10.30 AM" is printed on the letter. */
  @IsString()
  @IsNotEmpty()
  examAt!: string;

  /**
   * The letter's reference. Left out, the next number in DBL's register is
   * issued; supplied, that is what the letter and both emails carry.
   */
  @IsOptional() @IsString() @MaxLength(40) refNo?: string;

  /** Defaults to MEDICAL_TEST_VENUE, and to whatever was used last time. */
  @IsOptional() @IsString() @MaxLength(500) venue?: string;

  /** "Mr." / "Ms." — omitted rather than guessed. */
  @IsOptional() @IsString() @MaxLength(10) salutation?: string;

  /**
   * No recipient list.
   *
   * The letter goes to whoever holds the Medical Officer and Central Medical
   * Officer roles, resolved server-side. Those people are already in the
   * system, their addresses are already on their accounts, and typing them on
   * every send is a transcription error waiting to reach an external clinic.
   */

  /**
   * Who to send to. Both default to true; the service refuses a send with
   * neither, since an email to nobody is not a send.
   *
   * Separate flags because the two are genuinely independent: a clinic already
   * told by phone still needs the candidate emailed, and a candidate told in
   * person still needs the clinic to receive the letter.
   */
  @IsOptional() @IsBoolean() notifyMedicalTeam?: boolean;
  @IsOptional() @IsBoolean() notifyCandidate?: boolean;
}

/**
 * The recruiter's side of the medical test: which list, how to address the
 * candidate, and the register's reference if one was already given. No date,
 * no venue, no recipients — Head of Talent Acquisition sets those and sends.
 */
export class RequestMedicalTestDto {
  @IsIn(['below_40', 'above_40'])
  band!: 'below_40' | 'above_40';

  @IsOptional() @IsString() @MaxLength(10) salutation?: string;

  /** Left blank, the next number in the register is issued when it is sent. */
  @IsOptional() @IsString() @MaxLength(40) refNo?: string;
}

/** One candidate on Head of Talent Acquisition's send — their own date and venue. */
export class MedicalRequestItemDto {
  @IsString() @IsNotEmpty() onboardingId!: string;

  @IsString() @IsNotEmpty() examAt!: string;

  @IsOptional() @IsString() @MaxLength(500) venue?: string;

  /** Head of Talent Acquisition may correct what the recruiter asked for. */
  @IsOptional() @IsIn(['below_40', 'above_40']) band?: 'below_40' | 'above_40';
  @IsOptional() @IsString() @MaxLength(10) salutation?: string;
  @IsOptional() @IsString() @MaxLength(40) refNo?: string;
}

/** Send several requests at once — still one email per candidate. */
export class SendMedicalRequestsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => MedicalRequestItemDto)
  items!: MedicalRequestItemDto[];

  @IsOptional() @IsBoolean() notifyMedicalTeam?: boolean;
  @IsOptional() @IsBoolean() notifyCandidate?: boolean;
}

/** The Central Medical Officer's verdict on a submitted medical finding. */
export class MedicalDecisionDto {
  @IsIn(['approve', 'reject', 'return'])
  decision!: 'approve' | 'reject' | 'return';

  /** Required for reject and return — enforced in the service, with wording. */
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** The same verdict applied to a selection from the queue. */
export class MedicalDecisionBulkDto extends MedicalDecisionDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  onboardingIds!: string[];
}

/** Settle which of the requisition's designations a candidate is hired at. */
export class SetFixedDesignationDto {
  @IsString() @MaxLength(150) designation!: string;
}

/** The appointment letter, issued after joining. */
export class AppointmentLetterDto {
  /** The CHRO this letter is issued over — see OfferLetterDto. */
  @IsString()
  @MaxLength(60)
  signatoryUserId!: string;

  /** See OfferLetterDto.fixedDesignation — the appointment letter prints the same. */
  @IsOptional() @IsString() @MaxLength(150) fixedDesignation?: string;
  @IsOptional() @IsString() @MaxLength(60) reference?: string;
  @IsOptional() @IsString() joiningDate?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
}

/**
 * Declining an offer. The reason is required — see publicDeclineOffer for why.
 */
export class DeclineOfferDto {
  // Trimmed first so whitespace cannot satisfy the length rule here and then
  // be rejected by the service — one rule, one message.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

/** What the candidate tells us when accepting. */
export class AcceptOfferDto {
  /** The date they expect to join — theirs to give, so it is not required. */
  @IsOptional()
  @IsDateString()
  joiningTentative?: string;
}

/**
 * The placement: the number this hire is filed under and who they report to.
 *
 * One payload because they are settled in one conversation — "they're
 * 15107556, reporting to Kamal" — and two endpoints would let a file exist
 * with an ID and no manager for as long as somebody forgot the second save.
 * The line manager is a snapshot off the synced directory, so all three
 * fields travel together or not at all.
 */
export class EmployeeIdDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  employeeId!: string;

  /**
   * Who the hire reports to, taken from the synced employee directory.
   *
   * Optional: the ID is often settled before the reporting line is, and
   * refusing the ID until somebody knows the manager would just mean nobody
   * records either. Sending an empty string clears it.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(150)
  lineManagerName?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(20)
  lineManagerCode?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(150)
  lineManagerTitle?: string;
}

/**
 * The candidate's particulars exactly as printed on their NID.
 *
 * Every field optional on the wire because the form saves as they type — a
 * half-filled form must not be rejected and lost. Completeness is enforced
 * at final verification instead, which is the point where it matters.
 */
export class NidParticularsDto {
  @IsOptional() @IsString() @MaxLength(150) name?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(30) dateOfBirth?: string;
  @IsOptional() @IsString() @MaxLength(40) number?: string;
}

/** HR ticking off that the physical photographs arrived. */
export class PhotosHardCopyDto {
  @IsBoolean()
  received!: boolean;
}
