import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { ReferenceCheckService } from './reference-check.service';
import { ReferenceCheckDto } from './dto/reference-check.dto';

/** Pre-employment reference checks — recorded by the recruiter, per referee. */
@Controller('candidates/:id/reference-checks')
export class ReferenceCheckController {
  constructor(private readonly refChecks: ReferenceCheckService) {}

  @Get()
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.refChecks.list(id, user.id);
  }

  @Post()
  create(
    @Param('id') id: string,
    @Body() dto: ReferenceCheckDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.refChecks.save(id, user.id, dto);
  }

  @Patch(':rcId')
  update(
    @Param('id') id: string,
    @Param('rcId') rcId: string,
    @Body() dto: ReferenceCheckDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.refChecks.save(id, user.id, dto, rcId);
  }

  @Delete(':rcId')
  remove(
    @Param('id') id: string,
    @Param('rcId') rcId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.refChecks.remove(id, rcId, user.id);
  }

  /** The completed form — rendered on request, so it is never out of date. */
  @Get(':rcId/pdf')
  pdf(
    @Param('id') id: string,
    @Param('rcId') rcId: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    return this.refChecks.streamPdf(id, rcId, user.id, res);
  }
}
