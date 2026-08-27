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
import { InterviewService } from './interview.service';
import {
  BulkScheduleInterviewDto,
  ScheduleInterviewDto,
  SubmitEvaluationDto,
  UpdateInterviewDto,
} from './dto/interview.dto';

@Controller()
export class InterviewController {
  constructor(private readonly interviews: InterviewService) {}

  /** The current user's own interview assignments (committee marking). */
  @Get('my-interviews')
  myInterviews(@CurrentUser() user: AuthUser) {
    return this.interviews.myInterviews(user.id);
  }

  @Post('interviews/:roundId/evaluation')
  submitEvaluation(
    @Param('roundId') roundId: string,
    @Body() dto: SubmitEvaluationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.submitEvaluation(roundId, user.id, dto);
  }

  @Get('requisitions/:reqId/interviews')
  listForReq(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.interviews.listForRequisition(reqId, user.id);
  }

  @Get('candidates/:candidateId/interviews')
  listForCandidate(
    @Param('candidateId') candidateId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.listForCandidate(candidateId, user.id);
  }

  /** Schedule the same interview config for multiple candidates at once. */
  @Post('interviews/bulk')
  bulkSchedule(
    @Body() dto: BulkScheduleInterviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.bulkSchedule({ id: user.id, name: user.name }, dto);
  }

  @Post('candidates/:candidateId/interviews')
  schedule(
    @Param('candidateId') candidateId: string,
    @Body() dto: ScheduleInterviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.schedule(
      candidateId,
      { id: user.id, name: user.name },
      dto,
    );
  }

  @Patch('interviews/:roundId')
  update(
    @Param('roundId') roundId: string,
    @Body() dto: UpdateInterviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.update(roundId, user.id, dto);
  }

  @Delete('interviews/:roundId')
  remove(@Param('roundId') roundId: string, @CurrentUser() user: AuthUser) {
    return this.interviews.remove(roundId, user.id);
  }

  /** Regenerate the one-click evaluation link for a specific panelist. */
  @Post('interviews/:roundId/eval-token/:panelistUserId/resend')
  resendEvalToken(
    @Param('roundId') roundId: string,
    @Param('panelistUserId') panelistUserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.resendEvalToken(roundId, panelistUserId, user.id);
  }
}
