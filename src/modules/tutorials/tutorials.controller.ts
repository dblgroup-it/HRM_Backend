import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { TutorialsService } from './tutorials.service';

/** The Tutorials menu: the system's client documentation, role by role. */
@Controller('tutorials')
export class TutorialsController {
  constructor(private readonly tutorials: TutorialsService) {}

  /** Every signed-in user may read the guides. */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tutorials.list(user);
  }

  /**
   * `@Public()` because the signed link is the credential: it was minted for
   * a signed-in user by `list`, names one guide, and expires — and a new tab
   * carries no session token.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('file/:grant')
  file(
    @Param('grant') grant: string,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ) {
    return this.tutorials.stream(grant, download === '1', res);
  }
}
