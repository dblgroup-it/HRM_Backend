import { IsString, MinLength } from 'class-validator';

export class TwoFactorCodeDto {
  @IsString()
  @MinLength(4)
  code!: string;
}

export class TwoFactorLoginDto {
  @IsString()
  challengeToken!: string;

  @IsString()
  @MinLength(4)
  code!: string;
}

export class DisableTwoFactorDto {
  @IsString()
  @MinLength(1)
  password!: string;
}
