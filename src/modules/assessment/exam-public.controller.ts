import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { ExamService } from './exam.service';
import { SubmitExamDto } from './dto/exam.dto';

/** Public, token-linked exam endpoints used by the candidate's exam page. */
@Controller('exam')
export class ExamPublicController {
  constructor(private readonly exams: ExamService) {}

  @Public()
  @Get(':token')
  get(@Param('token') token: string) {
    return this.exams.getByToken(token);
  }

  @Public()
  @Post(':token')
  submit(@Param('token') token: string, @Body() dto: SubmitExamDto) {
    return this.exams.submitByToken(token, dto);
  }
}
