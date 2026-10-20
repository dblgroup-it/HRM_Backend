import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
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

  /** The guides for the caller's roles (all of them for a super user). */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tutorials.list(user);
  }

  /** The cover picture on a guide's card — same signed link as the PDF. */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('thumb/:grant')
  thumb(@Param('grant') grant: string, @Res() res: Response) {
    return this.tutorials.thumb(grant, res);
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

  /** A guide's video — the same signed link as its PDF; byte ranges honoured for seeking; `?q=720` the lighter rendition. */
  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Get('video/:grant')
  video(
    @Param('grant') grant: string,
    @Headers('range') range: string | undefined,
    @Query('q') quality: string | undefined,
    @Res() res: Response,
  ) {
    return this.tutorials.streamVideo(grant, range, res, quality);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('video/:grant/subtitles/:lang')
  videoSubtitles(
    @Param('grant') grant: string,
    @Param('lang') lang: string,
    @Res() res: Response,
  ) {
    return this.tutorials.videoSubtitles(grant, lang, res);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('video/:grant/poster')
  videoPoster(@Param('grant') grant: string, @Res() res: Response) {
    return this.tutorials.videoPoster(grant, res);
  }
}
