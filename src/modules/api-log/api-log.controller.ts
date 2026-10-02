import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request } from 'express';

import { AllowSuperUser } from '../../common/decorators/allow-super-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { safePath } from './api-log-rules';
import { ApiLogService } from './api-log.service';

class ApiLogQueryDto {
  @IsOptional() @IsIn(['api', 'browser']) source?: string;
  @IsOptional() @IsIn(['error', 'slow']) kind?: string;
  @IsOptional() @IsString() @MaxLength(5) status?: string;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(200)
  pageSize?: number;
}

/** A crash in a user's browser, reported by the page itself. */
class ClientErrorDto {
  @IsString() @MaxLength(2000) message!: string;
  @IsOptional() @IsString() @MaxLength(12000) stack?: string;
  /** The page the user was on (path only is kept). */
  @IsOptional() @IsString() @MaxLength(1000) page?: string;
  @IsOptional() @IsString() @MaxLength(40) userId?: string;
  @IsOptional() @IsString() @MaxLength(150) userName?: string;
}

@Controller()
export class ApiLogController {
  constructor(private readonly logs: ApiLogService) {}

  @Roles(UserRole.ADMIN)
  @AllowSuperUser()
  @Get('api-logs')
  list(@Query() q: ApiLogQueryDto) {
    return this.logs.list(q);
  }

  @Roles(UserRole.ADMIN)
  @AllowSuperUser()
  @Get('api-logs/summary')
  summary() {
    return this.logs.summary();
  }

  /**
   * Open to every page, signed in or not — the token pages (an interviewer's
   * marking sheet, a candidate's offer) crash too. Throttled per address, and
   * the user it names is what the page said, marked as such.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('client-errors')
  clientError(@Body() dto: ClientErrorDto, @Req() req: Request) {
    this.logs.record({
      source: 'browser',
      kind: 'error',
      path: dto.page ? safePath(dto.page) : null,
      userId: dto.userId ?? null,
      userName: dto.userName ?? null,
      ip:
        String(req.headers['x-forwarded-for'] ?? '')
          .split(',')[0]
          .trim() ||
        req.ip ||
        null,
      userAgent: req.headers['user-agent'] ?? null,
      message: dto.message,
      stack: dto.stack ?? null,
    });
    return { ok: true };
  }
}
