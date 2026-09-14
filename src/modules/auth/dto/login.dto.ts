import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /** Email address or employee code. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  identifier!: string;

  @IsString()
  @MinLength(4)
  // bcrypt only reads the first 72 bytes; anything longer is wasted work.
  @MaxLength(72)
  password!: string;
}
