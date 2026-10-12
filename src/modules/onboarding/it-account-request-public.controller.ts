import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { CompleteItRequestDto } from './dto/it-account-request.dto';
import { ItAccountRequestService } from './it-account-request.service';

/** Public — IT's link from the request email: see it, and say it is done. */
@Controller('it-request')
export class ItAccountRequestPublicController {
  constructor(private readonly it: ItAccountRequestService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  get(@Param('token') token: string) {
    return this.it.getByToken(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':token/complete')
  complete(@Param('token') token: string, @Body() dto: CompleteItRequestDto) {
    return this.it.completeByToken(token, dto);
  }
}
