import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** A leaver whose account IT is asked to delete. Addresses are checked in the service, which can name the bad one. */
export class ItLeaverDto {
  @IsString()
  @MaxLength(150)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string | null;

  @IsString()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reason?: string | null;
}

/** "Notify IT" — what HR settled in the dialog. Also the body of a preview. */
export class SendItRequestDto {
  /** Blank: IT chooses the address. */
  @IsOptional()
  @IsString()
  @MaxLength(254)
  preferredEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  purpose?: string;

  /** `@Type` matters: without it the global pipe turns each row into `{}`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ItLeaverDto)
  deletions?: ItLeaverDto[];
}

/** IT's answer, from the link in the email. */
export class CompleteItRequestDto {
  @IsString()
  @MaxLength(254)
  createdEmail!: string;

  /** Signs the "completed" reply. */
  @IsString()
  @MaxLength(150)
  completedByName!: string;

  /** The addresses IT did delete, out of those it was asked to. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  deleted?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
