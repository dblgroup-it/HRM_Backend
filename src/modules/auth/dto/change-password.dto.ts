import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  // Length is checked only in assertPasswordPolicy() (auth.service.ts), which
  // reads PASSWORD_MIN_LENGTH. A second copy here is how the two drifted apart
  // and each rejected with a message contradicting the other.
  @MinLength(1)
  @MaxLength(72)
  newPassword!: string;
}
