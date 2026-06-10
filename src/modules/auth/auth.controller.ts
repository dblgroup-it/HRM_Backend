import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import {
  DisableTwoFactorDto,
  TwoFactorCodeDto,
  TwoFactorLoginDto,
} from './dto/two-factor.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user.id);
  }

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

  @Post('2fa/totp/enable')
  @HttpCode(200)
  totpEnable(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.authService.enableTotp(user.id, dto.code);
  }

  @Post('2fa/email/start')
  @HttpCode(200)
  emailStart(@CurrentUser() user: AuthUser) {
    return this.authService.startEmailSetup(user.id);
  }

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
