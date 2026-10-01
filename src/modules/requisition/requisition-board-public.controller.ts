import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { RequisitionBoardService } from './requisition-board.service';
import { RequisitionBoardVoteDto } from './dto/requisition-actions.dto';

/** A board member's emailed requisition link: no sign-in, the token is the key. */
@Controller('requisition-board')
export class RequisitionBoardPublicController {
  constructor(private readonly board: RequisitionBoardService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':token')
  info(@Param('token') token: string) {
    return this.board.voteInfo(token);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':token')
  @HttpCode(200)
  vote(@Param('token') token: string, @Body() dto: RequisitionBoardVoteDto) {
    return this.board.vote(token, dto.decision, dto.note);
  }
}
