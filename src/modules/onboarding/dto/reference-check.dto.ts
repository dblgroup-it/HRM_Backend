import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Blank from a form field means "not answered", not an invalid value. */
const blankToUndefined = () =>
  Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  );

export class ReferenceCheckDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  refereeName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  refereeDesignation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  refereeOrganization?: string;

  @blankToUndefined()
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  refereeEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  refereePhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  knownDuration?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  relationship?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  strengths?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  weaknesses?: string;

  /**
   * The nine scales, as { trustworthiness: 'excellent', … }.
   *
   * Validated in the service against the question list rather than here: the
   * allowed values differ per question (question e has its own scale), which a
   * DTO decorator cannot express.
   */
  @IsOptional()
  @IsObject()
  ratings?: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  handover?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  rehireEligible?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  concerns?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  overallComments?: string;
}

/**
 * What the form holds so far, sent to have the overall comment drafted.
 * Nothing is saved; every field is optional because the draft is asked for
 * mid-call, before the referee's details are necessarily all in.
 */
export class DraftReferenceCommentDto {
  @IsOptional()
  @IsObject()
  ratings?: Record<string, string>;

  @IsOptional() @IsString() @MaxLength(150) refereeName?: string;
  @IsOptional() @IsString() @MaxLength(150) refereeDesignation?: string;
  @IsOptional() @IsString() @MaxLength(200) refereeOrganization?: string;
  @IsOptional() @IsString() @MaxLength(500) relationship?: string;
  @IsOptional() @IsString() @MaxLength(500) knownDuration?: string;
  @IsOptional() @IsString() @MaxLength(4000) strengths?: string;
  @IsOptional() @IsString() @MaxLength(4000) weaknesses?: string;
  @IsOptional() @IsString() @MaxLength(4000) handover?: string;
  @IsOptional() @IsString() @MaxLength(4000) rehireEligible?: string;
  @IsOptional() @IsString() @MaxLength(4000) concerns?: string;
  /** Whatever is already in the box — refined, not thrown away. */
  @IsOptional() @IsString() @MaxLength(4000) overallComments?: string;
}
