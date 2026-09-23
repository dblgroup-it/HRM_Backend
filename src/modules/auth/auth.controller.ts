import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  DisableTwoFactorDto,
  TwoFactorCodeDto,
  TwoFactorLoginDto,
} from './dto/two-factor.dto';

/**
 * Request ceilings for the authentication routes.
 *
 * These are per client IP, and IP is a blunt key here: staff reach the system
 * through a handful of site NAT addresses, so an office shares one bucket no
 * matter how many people are in it. A limit sized for one person therefore
 * throttles a whole floor — at 10/min, the eleventh person signing in at 9am
 * got a 429 with nothing wrong on their side.
 *
 * They are sized generously on purpose, because they are NOT the brute-force
 * defence. That is the per-account lockout in AuthService: five failed attempts
 * locks that account for fifteen minutes, and it is keyed on the account, so it
 * is unaffected by how many people share an address. These ceilings exist for
 * the one thing lockout cannot see — a single source spraying many different
 * accounts — and for that, the order of magnitude matters far more than the
 * exact number.
 *
 * Tracking authenticated traffic by user id rather than IP would remove the
 * shared-bucket problem entirely and is the right long-term fix; it is recorded
 * as an open decision rather than made here.
 */
const AUTH_RATE = {
  /** Sign-in. Must comfortably absorb a start-of-shift rush from one site. */
  login: 60,
  /**
   * Second step of sign-in. Deliberately the same as `login`: every 2FA user
   * hits it immediately after, so anything lower just moves the bottleneck.
   */
  loginTwoFactor: 60,
  /**
   * Password change. Sized for the forced first-login rollout, which makes this
   * a mass event rather than an occasional one.
   */
  changePassword: 30,
  /** Enrolling or confirming a second factor — bursty during a rollout. */
  twoFactorEnrol: 30,
  /** Sending an email OTP. Lower, because each one sends a real message. */
  twoFactorEmailStart: 20,
} as const;

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: AUTH_RATE.login, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user.id);
  }

  @Patch('me')
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(user.id, dto);
  }

  /** Invalidate the current session's tokens server-side. */
  @Post('logout')
  @HttpCode(200)
  logout(@CurrentUser() user: AuthUser) {
    return this.authService.logout(user.id, {
      id: user.sessionId,
      expiresAt: user.sessionExpiresAt,
    });
  }

  @Throttle({ default: { limit: AUTH_RATE.changePassword, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(200)
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  /** Super-user-only: reset another user's password to its default. */
  @Post('users/:userId/reset-password')
  @HttpCode(200)
  resetPassword(
    @Param('userId') userId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.authService.resetPasswordToDefault(userId, actor.id);
  }

  // --- two-factor authentication -----------------------------------------

  /** Second step of login: verify the 2FA code with the challenge token. */
  @Public()
  @Throttle({ default: { limit: AUTH_RATE.loginTwoFactor, ttl: 60_000 } })
  @Post('login/2fa')
  @HttpCode(200)
  loginTwoFactor(@Body() dto: TwoFactorLoginDto) {
    return this.authService.verifyLoginTwoFactor(dto.challengeToken, dto.code);
  }

  @Get('2fa')
  twoFactorStatus(@CurrentUser() user: AuthUser) {
    return this.authService.twoFactorStatus(user.id);
  }

  @Post('2fa/totp/setup')
  @HttpCode(200)
  totpSetup(@CurrentUser() user: AuthUser) {
    return this.authService.setupTotp(user.id);
  }

  @Throttle({ default: { limit: AUTH_RATE.twoFactorEnrol, ttl: 60_000 } })
  @Post('2fa/totp/enable')
  @HttpCode(200)
  totpEnable(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.authService.enableTotp(user.id, dto.code);
  }

  @Throttle({ default: { limit: AUTH_RATE.twoFactorEmailStart, ttl: 60_000 } })
  @Post('2fa/email/start')
  @HttpCode(200)
  emailStart(@CurrentUser() user: AuthUser) {
    return this.authService.startEmailSetup(user.id);
  }

  @Throttle({ default: { limit: AUTH_RATE.twoFactorEnrol, ttl: 60_000 } })
  @Post('2fa/email/enable')
  @HttpCode(200)
  emailEnable(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.authService.enableEmail(user.id, dto.code);
  }

  @Post('2fa/disable')
  @HttpCode(200)
  twoFactorDisable(
    @CurrentUser() user: AuthUser,
    @Body() dto: DisableTwoFactorDto,
  ) {
    return this.authService.disableTwoFactor(user.id, dto.password);
  }
}
