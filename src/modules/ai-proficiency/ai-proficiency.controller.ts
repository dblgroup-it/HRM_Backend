import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { AiProficiencyService } from './ai-proficiency.service';
import {
  AddQuestionDto,
  AssignTestDto,
  BulkAddQuestionsDto,
  BulkDeleteQuestionsDto,
  GenerateQuestionsDto,
  UpdateQuestionDto,
} from './dto/ai-proficiency.dto';

/** Global AI Proficiency question bank + per-candidate assignment (authenticated). */
@Controller()
export class AiProficiencyController {
  constructor(private readonly aiProficiency: AiProficiencyService) {}

  @Get('ai-proficiency/questions')
  getBank(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('grade') grade?: string,
    @Query('page') page?: string,
  ) {
    return this.aiProficiency.getBank(user.id, {
      search,
      grade,
      page: page ? Number(page) : undefined,
    });
  }

  @Post('ai-proficiency/questions')
  addQuestion(@Body() dto: AddQuestionDto, @CurrentUser() user: AuthUser) {
    return this.aiProficiency.addQuestion(user.id, dto);
  }

  /** AI-generate a batch of questions for review — nothing is saved yet. */
  @Post('ai-proficiency/questions/generate')
  generateQuestions(@Body() dto: GenerateQuestionsDto, @CurrentUser() user: AuthUser) {
    return this.aiProficiency.generateQuestions(user.id, dto);
  }

  /** Save a reviewed batch (typically from "generate") to the bank in one go. */
  @Post('ai-proficiency/questions/bulk')
  bulkAddQuestions(@Body() dto: BulkAddQuestionsDto, @CurrentUser() user: AuthUser) {
    return this.aiProficiency.bulkAddQuestions(user.id, dto);
  }

  @Patch('ai-proficiency/questions/:id')
  updateQuestion(
    @Param('id') id: string,
    @Body() dto: UpdateQuestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.aiProficiency.updateQuestion(user.id, id, dto);
  }

  @Delete('ai-proficiency/questions/:id')
  removeQuestion(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.aiProficiency.removeQuestion(user.id, id);
  }

  @Post('ai-proficiency/questions/bulk-delete')
  bulkRemoveQuestions(@Body() dto: BulkDeleteQuestionsDto, @CurrentUser() user: AuthUser) {
    return this.aiProficiency.bulkRemoveQuestions(user.id, dto);
  }

  @Get('candidates/:id/ai-proficiency')
  getStatus(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.aiProficiency.getStatus(id, user.id);
  }

  @Get('candidates/:id/ai-proficiency/review')
  getReview(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.aiProficiency.getReview(id, user.id);
  }

  @Post('candidates/:id/ai-proficiency')
  assignTest(
    @Param('id') id: string,
    @Body() dto: AssignTestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.aiProficiency.assignTest(id, user.id, dto);
  }
}
