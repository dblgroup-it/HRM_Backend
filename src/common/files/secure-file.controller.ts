import { Controller, Get, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { Public } from '../decorators/public.decorator';
import { FileGrantService } from './file-grant.service';
import { SecureFileService } from './secure-file.service';

/**
 * Streams one Drive file, identified entirely by a signed grant.
 *
 * `@Public()` is correct here and is not a gap: the grant *is* the credential.
 * It was minted by a code path that had already checked the caller's right to
 * the owning record, it names exactly one file, and it expires. The route
 * accepts no file id of its own, so there is nothing for a holder to change.
 *
 * This exists because the session JWT lives in localStorage and is therefore
 * absent from top-level navigations — an `<a href>` or `window.open` carries no
 * Authorization header. See FileGrantService for the full reasoning.
 */
@Controller('files')
export class SecureFileController {
  constructor(
    private readonly grants: FileGrantService,
    private readonly files: SecureFileService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':grant')
  async open(@Param('grant') grant: string, @Res() res: Response) {
    const { fileId, filename } = this.grants.verify(grant);
    await this.files.stream(res, fileId, { filename });
  }
}
