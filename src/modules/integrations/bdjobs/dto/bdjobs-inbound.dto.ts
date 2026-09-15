import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Optional as a whole when `CandidateData` is sent: the name, email and phone
 * are in the profile's personalData, and asking for them twice invites the
 * two copies to disagree.
 */
class InboundCandidateDto {
  @IsOptional() @IsString() @MaxLength(150) name?: string;
  @IsOptional() @IsString() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
}

/**
 * Bdjobs' structured candidate profile.
 *
 * Passed through as-is and normalised by `bdjobsToCvProfile` rather than
 * validated field by field: their blanks arrive as "", null and 0
 * interchangeably, and a field they add next quarter should widen the CV we
 * store, not reject the application at the door. `whitelist` on the global
 * pipe would strip an un-declared nested object, so the three blocks are
 * declared and left loose inside.
 */
class BdJobsCandidateDataDto {
  @IsOptional() @IsObject() personalData?: Record<string, unknown>;
  @IsOptional() @IsArray() EmploymentHistory?: Record<string, unknown>[];
  @IsOptional() @IsArray() qualifications?: Record<string, unknown>[];
}

class InboundResumeDto {
  @IsString() url!: string;
  @IsOptional() @IsString() @MaxLength(255) fileName?: string;
  @IsOptional() @IsString() @MaxLength(100) mimeType?: string;
}

export class BdJobsInboundCandidateDto {
  @IsOptional() @IsString() @MaxLength(100) jobReferenceId?: string;
  @IsString() @MaxLength(100) bdJobsJobId!: string;
  @IsString() @MaxLength(100) applicationId!: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => InboundCandidateDto)
  candidate?: InboundCandidateDto;

  /**
   * Bdjobs' flat candidate profile.
   *
   * Deliberately NOT a validated nested class. It used to be one declaring
   * `bdjobsApplicantId` and `skills`, and the global pipe runs with
   * `forbidNonWhitelisted` — so when the live job board posted the twelve
   * fields it actually sends (currentEmployer, expectedSalary, dateOfBirth,
   * employmentHistory, educationHistory and the rest) every application was
   * rejected at the door with a 400. Nobody can fix that from Bdjobs' side,
   * and the next field they add would break it again.
   *
   * `@IsObject()` without `@ValidateNested()` means class-validator does not
   * descend, so `whitelist` leaves the contents alone and unknown keys are
   * kept rather than rejected. The shape is interpreted by
   * `bdjobsProfileToCandidateData`, which is defensive about every field —
   * the same treatment `CandidateData` already gets, and for the same reason.
   */
  @IsOptional()
  @IsObject()
  profile?: Record<string, unknown>;

  /**
   * Optional since a structured CandidateData block is itself a CV — a Bdjobs
   * applicant who never uploaded a file still has a full profile.
   */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => InboundResumeDto)
  resume?: InboundResumeDto;

  /** The applicant's CV as structured data. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BdJobsCandidateDataDto)
  CandidateData?: BdJobsCandidateDataDto;

  @IsInt() ts!: number;
}
