import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { ExamService } from './exam.service';
import {
  AddExamQuestionDto,
  CreateAttemptDto,
  UpdateExamQuestionDto,
} from './dto/exam.dto';

@Controller()
export class ExamController {
  constructor(private readonly exams: ExamService) {}

  @Get('requisitions/:reqId/exam-bank')
  getBank(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.exams.getBank(reqId, user.id);
  }

  @Post('requisitions/:reqId/exam-questions')
  addQuestion(
    @Param('reqId') reqId: string,
    @Body() dto: AddExamQuestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.addQuestion(reqId, user.id, dto);
  }

  @Patch('exam-questions/:qid')
  updateQuestion(
    @Param('qid') qid: string,
    @Body() dto: UpdateExamQuestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.updateQuestion(qid, user.id, dto);
  }

  @Delete('exam-questions/:qid')
  removeQuestion(@Param('qid') qid: string, @CurrentUser() user: AuthUser) {
    return this.exams.removeQuestion(qid, user.id);
  }

  @Post('candidates/:candidateId/exams')
  createAttempt(
    @Param('candidateId') candidateId: string,
    @Body() dto: CreateAttemptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.createAttempt(
      candidateId,
      { id: user.id, name: user.name },
      dto,
    );
  }

  @Get('candidates/:candidateId/exams')
  listAttempts(
    @Param('candidateId') candidateId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.listAttempts(candidateId, user.id);
  }

  @Post('exam-attempts/:id/grade')
  grade(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.exams.gradeWithAi(id, user.id);
  }
}
