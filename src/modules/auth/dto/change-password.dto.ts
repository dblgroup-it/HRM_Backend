import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  // Kept in step with assertPasswordPolicy() in auth.service.ts, which applies
  // the rest of the rules. Without this the DTO rejected first with a stale
  // "at least 6 characters" message that contradicted the real policy.
  @MinLength(12, {
    message:
      'Password must be at least 12 characters. A short sentence you will remember works well.',
  })
  @MaxLength(72)
  newPassword!: string;
}
