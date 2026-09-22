import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Who takes one requisition while its recruiter is away. */
export class RecruitmentCoverDto {
  @IsString()
  requisitionId!: string;

  /** A Corporate Recruiter other than the person going on leave. */
  @IsString()
  coverRecruiterId!: string;
}

/**
 * Going on leave.
 *
 * `days` is what the buttons send (3 / 7 / 15); `until` is the custom date.
 * Neither means "until further notice", ended by hand on return.
 */
export class StartLeaveDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;

  /** ISO date — the last day away, inclusive. */
  @IsOptional()
  @IsString()
  until?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /**
   * Stand-ins for the requisitions this person is recruiting. Sent from the
   * handover list; requisitions left out simply keep waiting for them.
   *
   * Job analyses are NOT listed here — those move to the next Factory HR in the
   * unit's HR layering on their own, with nothing to choose.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RecruitmentCoverDto)
  covers?: RecruitmentCoverDto[];
}
