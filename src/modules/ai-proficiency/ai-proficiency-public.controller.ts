import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { AiProficiencyService } from './ai-proficiency.service';
import { RecordViolationDto, SubmitAiProficiencyDto } from './dto/ai-proficiency.dto';

/** Public, no-login candidate-facing AI Proficiency Test endpoints. */
@Controller('ai-proficiency')
export class AiProficiencyPublicController {
  constructor(private readonly aiProficiency: AiProficiencyService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  getByToken(@Param('token') token: string) {
    return this.aiProficiency.getByToken(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':token/start')
  start(@Param('token') token: string) {
    return this.aiProficiency.startAttempt(token);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':token/violation')
  recordViolation(@Param('token') token: string, @Body() dto: RecordViolationDto) {
    return this.aiProficiency.recordViolation(token, dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':token')
  submit(@Param('token') token: string, @Body() dto: SubmitAiProficiencyDto) {
    return this.aiProficiency.submitByToken(token, dto);
  }
}
