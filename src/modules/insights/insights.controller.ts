import { Body, Controller, Get, Post } from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { InsightsService } from './insights.service';
import { AskDto } from './dto/insights.dto';

/** AI HR Insights — ask-your-data chat, weekly digest, bottleneck analysis. */
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
