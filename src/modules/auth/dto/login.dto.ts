import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class LoginDto {
  /** Email address or employee code. */
  @IsString()
  @IsNotEmpty()
  identifier!: string;

  @IsString()
  @MinLength(4)
  password!: string;
}
