import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Step 1: ask for a reset code. */
export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

/** Step 2: prove you received it. */
export class VerifyResetCodeDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(/^\s*\d{6}\s*$/, { message: 'Enter the 6-digit code from the email.' })
  code!: string;
}

/** Step 3: set the new password with the token step 2 returned. */
export class ResetPasswordDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  resetToken!: string;

  @IsString()
  // Length is policed by assertPasswordPolicy (PASSWORD_MIN/MAX_LENGTH), as
  // for a password change; a second copy here is how the two drift apart.
  @MinLength(1)
  @MaxLength(72)
  newPassword!: string;
}
