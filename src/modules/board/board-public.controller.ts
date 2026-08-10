import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { BoardService } from './board.service';
import { SubmitVoteDto } from './dto/board.dto';

/** Public endpoints — no auth required (tokenised one-time links). */
@Controller()
export class BoardPublicController {
  constructor(private readonly board: BoardService) {}

  @Public()
  @Get('board-vote/:token')
  getVoteInfo(@Param('token') token: string) {
    return this.board.getVoteInfo(token);
  }

  @Public()
  @Post('board-vote/:token')
  submitVote(@Param('token') token: string, @Body() dto: SubmitVoteDto) {
    return this.board.submitVote(token, dto.notes);
  }
}
