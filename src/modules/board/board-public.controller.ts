import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { BoardService } from './board.service';
import { SubmitVoteDto } from './dto/board.dto';

/**
 * Public endpoints — no auth required (tokenised one-time links).
 *
 * Throttled like the other token surfaces: these return a candidate's name,
 * role and agreed salary to whoever holds the link, so an unthrottled GET is
 * both a token-guessing oracle and an unmetered PII endpoint.
 */
@Controller()
export class BoardPublicController {
  constructor(private readonly board: BoardService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('board-vote/:token')
  getVoteInfo(@Param('token') token: string) {
    return this.board.getVoteInfo(token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('board-vote/:token')
  submitVote(@Param('token') token: string, @Body() dto: SubmitVoteDto) {
    return this.board.submitVote(token, dto.notes, dto.decision ?? 'approved');
  }

  /**
   * The candidate's CV, streamed for a single-candidate approval link.
   *
   * The file is private on Drive; the vote token is the credential and the
   * candidate is resolved from it, so the URL cannot be edited to reach
   * anyone else's CV.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('board-vote/:token/cv')
  voteCv(@Param('token') token: string, @Res() res: Response) {
    return this.board.streamVoteCv(token, res);
  }

  /** A whole Hiring Approval Sheet — several candidates, one decision. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('board-sheet/:token')
  getSheet(@Param('token') token: string) {
    return this.board.getSheetVoteInfo(token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('board-sheet/:token')
  submitSheet(@Param('token') token: string, @Body() dto: SubmitVoteDto) {
    return this.board.submitSheetVote(
      token,
      dto.notes,
      dto.decision ?? 'approved',
    );
  }

  /**
   * One candidate's CV from a Hiring Approval Sheet.
   *
   * `candidateId` is checked against the sheet this token belongs to, so a
   * token for one sheet cannot fetch a CV from another.
   */
  @Public()
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Get('board-sheet/:token/cv/:candidateId')
  sheetCv(
    @Param('token') token: string,
    @Param('candidateId') candidateId: string,
    @Res() res: Response,
  ) {
    return this.board.streamSheetCv(token, candidateId, res);
  }
}
