import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(6, { message: 'New password must be at least 6 characters' })
  @MaxLength(72)
  newPassword!: string;
}
