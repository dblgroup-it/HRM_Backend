import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { ExamService } from './exam.service';
import { SubmitExamDto } from './dto/exam.dto';

/** Public, token-linked exam endpoints used by the candidate's exam page. */
@Controller('exam')
export class ExamPublicController {
  constructor(private readonly exams: ExamService) {}

  // Exam tokens are 16-byte random hex (unguessable), but rate-limit anyway.
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  get(@Param('token') token: string) {
    return this.exams.getByToken(token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':token')
  submit(@Param('token') token: string, @Body() dto: SubmitExamDto) {
    return this.exams.submitByToken(token, dto);
  }
}
