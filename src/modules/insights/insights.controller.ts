import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { InsightsService } from './insights.service';
import { AskDto } from './dto/insights.dto';

/** AI HR Insights — ask-your-data chat, weekly digest, bottleneck analysis. */
// AI calls cost money + take seconds — cap them per IP.
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('status')
  status() {
    return { aiConfigured: this.insights.aiConfigured() };
  }

  @Post('ask')
  ask(@Body() dto: AskDto, @CurrentUser() user: AuthUser) {
    return this.insights.ask(dto.question, user.id);
  }

  @Get('digest')
  digest(@CurrentUser() user: AuthUser) {
    return this.insights.digest(user.id);
  }

  @Get('bottlenecks')
  bottlenecks(@CurrentUser() user: AuthUser) {
    return this.insights.bottlenecks(user.id);
  }
}
