import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { FirstInterviewApprovalDecisionDto } from './dto/interview.dto';
import { FirstInterviewApprovalService } from './first-interview-approval.service';

/**
 * A Factory HR Head's emailed Candidate Approval link: no sign-in, the token
 * is the key, and it reaches only the candidates that email was about.
 */
@Controller('candidate-approval')
export class CandidateApprovalPublicController {
  constructor(private readonly approvals: FirstInterviewApprovalService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':token')
  info(@Param('token') token: string) {
    return this.approvals.linkInfo(token);
  }

  /** Approve, return or reject one or more — per-candidate results. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':token')
  @HttpCode(200)
  decide(
    @Param('token') token: string,
    @Body() dto: FirstInterviewApprovalDecisionDto,
  ) {
    return this.approvals.decideByLink(token, dto);
  }
}
