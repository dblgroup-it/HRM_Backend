import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { SendItRequestDto } from './dto/it-account-request.dto';
import { ItAccountRequestService } from './it-account-request.service';

/** "Notify IT" on onboarding's last step — the recruiting side. */
@Controller()
export class ItAccountRequestController {
  constructor(private readonly it: ItAccountRequestService) {}

  @Get('candidates/:id/onboarding/it-request/draft')
  draft(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.it.draft(id, user.id);
  }

  /** The email as it would go — nothing is sent or saved. */
  @Post('candidates/:id/onboarding/it-request/preview')
  @HttpCode(200)
  preview(
    @Param('id') id: string,
    @Body() dto: SendItRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.it.preview(id, dto, user.id);
  }

  @Post('candidates/:id/onboarding/it-request')
  send(
    @Param('id') id: string,
    @Body() dto: SendItRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.it.send(id, dto, user);
  }
}
