import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Either pick a real employee (by their user id) or type a name + email manually. */
export class RecipientDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  /**
   * Blank is the same as absent.
   *
   * `@IsOptional()` only skips `undefined` and `null`, so an empty string still
   * reaches `@IsEmail()` and fails with "email must be an email". The picker
   * sends `''` for anyone chosen from the directory — the employee list no
   * longer carries personal email addresses, and the service resolves the real
   * one from `userId` anyway, ignoring whatever was sent. Rejecting the request
   * over a field nobody reads was pure friction.
   */
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsOptional()
  @IsEmail()
  email?: string;
}

/** One or several recipients — HR can notify a single person or a few at once. */
export class NotifyFacilityDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecipientDto)
  recipients!: RecipientDto[];
}

export class ConfirmFacilityDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Refusing a facility request. The reason is not optional — see declineByToken. */
export class DeclineFacilityDto {
  // Trim first, so whitespace can't pass the length check here and then be
  // rejected by the service — one rule, one error message.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
