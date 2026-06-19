import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { AssessmentService } from './assessment.service';
import {
  AddCommitteeMemberDto,
  SaveNotesDto,
  SetPlanDto,
  SetRubricDto,
} from './dto/assessment.dto';

@Controller()
export class AssessmentController {
  constructor(private readonly assessment: AssessmentService) {}

  @Get('requisitions/:reqId/assessment')
  getSetup(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.assessment.getSetup(reqId, user.id);
  }

  @Post('requisitions/:reqId/committee')
  addMember(
    @Param('reqId') reqId: string,
    @Body() dto: AddCommitteeMemberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assessment.addCommitteeMember(reqId, user.id, dto);
  }

  @Delete('committee/:id')
  removeMember(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.assessment.removeCommitteeMember(id, user.id);
  }

  @Put('requisitions/:reqId/rubric')
  setRubric(
    @Param('reqId') reqId: string,
    @Body() dto: SetRubricDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assessment.setRubric(reqId, user.id, dto);
  }

  @Put('requisitions/:reqId/assessment-plan')
  setPlan(
    @Param('reqId') reqId: string,
    @Body() dto: SetPlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assessment.setPlan(reqId, user.id, dto);
  }

  /** AI-generate role-specific interview questions for this requisition. */
  @Post('requisitions/:reqId/interview-questions')
  generateQuestions(
    @Param('reqId') reqId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assessment.generateInterviewQuestions(reqId, user.id);
  }

  @Get('requisitions/:reqId/assessment/scorecard')
  getScorecard(@Param('reqId') reqId: string, @CurrentUser() user: AuthUser) {
    return this.assessment.getScorecard(reqId, user.id);
  }

  @Patch('requisitions/:reqId/assessment/notes')
  saveNotes(
    @Param('reqId') reqId: string,
    @Body() dto: SaveNotesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assessment.saveNotes(reqId, dto.notes, user.id);
  }

  @Post('candidates/:candidateId/evaluation-summary')
  generateEvaluationSummary(
    @Param('candidateId') candidateId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assessment.generateEvaluationSummary(candidateId, user.id);
  }
}
