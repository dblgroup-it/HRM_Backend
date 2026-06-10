import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { AssessmentService } from './assessment.service';
import {
  AddCommitteeMemberDto,
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
}
