import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ApprovalPathLevelDto {
  /** The named approver for this level. */
  @IsString()
  @MinLength(1)
  userId!: string;

  /** Display label, e.g. "Factory HR" / "Unit Head". */
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subtitle?: string;
}

/** Nominate a Requisition Raiser for a unit. */
export class AddRaiserDto {
  @IsString()
  @MinLength(1)
  raiserId!: string;
}

/**
 * A raiser's intermediate approvers. May be empty — a Corporate HR step is
 * always appended, so an empty list means "straight to Corporate HR".
 */
export class ReplaceApprovalPathDto {
  @IsArray()
  @ArrayMaxSize(10, { message: 'An approval path can have at most 10 levels' })
  @ValidateNested({ each: true })
  @Type(() => ApprovalPathLevelDto)
  levels!: ApprovalPathLevelDto[];
}
