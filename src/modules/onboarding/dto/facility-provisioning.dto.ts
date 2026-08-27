import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
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
