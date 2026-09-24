import {
  Body,
  HttpCode,
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
import { FirstInterviewApprovalService } from './first-interview-approval.service';
import {
  BulkFirstInterviewOutcomeDto,
  BulkScheduleInterviewDto,
  DelegateInterviewsDto,
  DelegateWorkloadDto,
  FirstInterviewApprovalDecisionDto,
  FirstInterviewOutcomeDto,
  ScheduleInterviewDto,
  SubmitEvaluationDto,
  UpdateInterviewDto,
  AddPanelistsDto,
  CandidatePackageDto,
  RejectAtInterviewDto,
} from './dto/interview.dto';

@Controller()
export class InterviewController {
  constructor(
    private readonly interviews: InterviewService,
    private readonly headApprovals: FirstInterviewApprovalService,
  ) {}

  /** The current user's own interview assignments (committee marking). */
  /** Hand shortlisted candidates to people who will run the first interview. */
  @Post('interview-delegations')
  delegate(@Body() dto: DelegateInterviewsDto, @CurrentUser() user: AuthUser) {
    return this.interviews.delegate(
      dto.candidateIds,
      dto.delegateUserIds,
      { id: user.id, name: user.name },
      dto.note,
      dto.tests,
    );
  }

  /** Candidates handed to me, with whether a round exists yet. */
  /**
   * What each named interviewer is currently carrying.
   *
   * POST because the list of people can be long enough to strain a query
   * string, and because it reads as "tell me about these people".
   */
  @Post('interview-delegations/workload')
  @HttpCode(200)
  delegateWorkload(
    @Body() dto: DelegateWorkloadDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.delegateWorkload(dto.userIds, user.id);
  }

  /** The scoreboard: every delegation on a requisition and where it stands. */
  @Get('requisitions/:reqId/interview-delegations')
  delegationBoard(
    @Param('reqId') reqId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.requisitionDelegationBoard(reqId, user.id);
  }

  @Get('my-delegated-candidates')
  myDelegated(@CurrentUser() user: AuthUser) {
    return this.interviews.myDelegatedCandidates(user.id);
  }

  @Get('candidates/:candidateId/interview-delegations')
  listDelegations(
    @Param('candidateId') candidateId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.listDelegations(candidateId, user.id);
  }

  @Delete('candidates/:candidateId/interview-delegations/:delegateUserId')
  revokeDelegation(
    @Param('candidateId') candidateId: string,
    @Param('delegateUserId') delegateUserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.revokeDelegation(
      candidateId,
      delegateUserId,
      user.id,
    );
  }

  /**
   * The same verdict for several candidates — Factory HR putting a batch of
   * finalists through to the Factory HR Head. Per-candidate results.
   */
  @Post('first-interview-outcomes')
  firstInterviewOutcomeMany(
    @Body() dto: BulkFirstInterviewOutcomeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.recordFirstInterviewOutcomeMany(
      dto.candidateIds,
      dto.outcome,
      { id: user.id, name: user.name },
      dto.note,
    );
  }

  /** Finalists waiting on this Factory HR Head, oldest first. */
  @Get('first-interview-approvals')
  firstInterviewApprovalQueue(@CurrentUser() user: AuthUser) {
    return this.headApprovals.queue(user.id);
  }

  /** Approve, return or reject a selection — per-candidate results. */
  @Post('first-interview-approvals/decide')
  @HttpCode(200)
  decideFirstInterviewApprovals(
    @Body() dto: FirstInterviewApprovalDecisionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.headApprovals.decideMany(user.id, dto);
  }

  /** First-interview verdict — advance to final, or reject. */
  @Post('candidates/:candidateId/first-interview-outcome')
  firstInterviewOutcome(
    @Param('candidateId') candidateId: string,
    @Body() dto: FirstInterviewOutcomeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.recordFirstInterviewOutcome(
      candidateId,
      dto.outcome,
      { id: user.id, name: user.name },
      dto.note,
    );
  }

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

  /**
   * Add someone to a panel that already exists — including mid-session.
   *
   * Not PATCH /interviews/:roundId: that replaces the panel wholesale and
   * re-notifies everyone on it. This appends and tells only the newcomers.
   */
  @Post('interviews/:roundId/panelists')
  addPanelists(
    @Param('roundId') roundId: string,
    @Body() dto: AddPanelistsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.addPanelists(roundId, dto.panelistUserIds, user.id);
  }

  /** What the candidate earns now and what they are asking for. */
  @Patch('candidates/:candidateId/package')
  setPackage(
    @Param('candidateId') candidateId: string,
    @Body() dto: CandidatePackageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.setCandidatePackage(candidateId, user.id, dto);
  }

  /** Turn the candidate down from the interview screen, at any round. */
  @Post('candidates/:candidateId/interview-reject')
  rejectAtInterview(
    @Param('candidateId') candidateId: string,
    @Body() dto: RejectAtInterviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.interviews.rejectAtInterview(
      candidateId,
      { id: user.id, name: user.name },
      dto.reason,
    );
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
