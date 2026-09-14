import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { InterviewService } from './interview.service';
import { SubmitEvaluationDto } from './dto/interview.dto';

/** Public, token-linked evaluation endpoints (no login required). */
@Controller('eval')
export class EvalPublicController {
  constructor(private readonly interviews: InterviewService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  get(@Param('token') token: string) {
    return this.interviews.getEvalByToken(token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':token')
  submit(@Param('token') token: string, @Body() dto: SubmitEvaluationDto) {
    return this.interviews.submitEvalByToken(token, dto);
  }

  /**
   * The candidate's CV, for the panelist holding this evaluation link.
   *
   * The file is private on Drive; the token is the credential and names the
   * candidate, so this cannot be pointed at anyone else.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token/cv')
  cv(@Param('token') token: string, @Res() res: Response) {
    return this.interviews.streamEvalCv(token, res);
  }
}
