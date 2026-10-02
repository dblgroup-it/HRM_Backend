import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { IsString, Matches } from 'class-validator';
import * as fs from 'node:fs';

import { AllowSuperUser } from '../../common/decorators/allow-super-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { copyDate, isCopyName } from './sandbox-db';
import { PromoteService } from './promote.service';
import { SandboxService } from './sandbox.service';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';

class PromoteDto {
  /** Typed by hand: deploying the live site is not one click. */
  @IsString()
  @Matches(/^DEPLOY$/, { message: 'Type DEPLOY to confirm.' })
  confirm!: string;
}

class SwitchDatabaseDto {
  /** A copy's database name, or "latest" for the newest copy. */
  @IsString()
  @Matches(/^(latest|[a-z0-9_]{1,63})$/)
  database!: string;
}

/**
 * The dev server's controls. Everything but `status` is admin-only and
 * answers 404 on the live server, where none of it applies.
 */
@Controller('sandbox')
export class SandboxController {
  private readonly logger = new Logger('Sandbox');

  constructor(
    private readonly sandbox: SandboxService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly promote: PromoteService,
  ) {}

  /** What "Deploy to Prod" would put live, and how the last one went. */
  @Roles(UserRole.ADMIN)
  @Get('promote')
  promoteStatus() {
    return this.promote.status();
  }

  /**
   * Put the dev build live. The ADMIN login only — not super users: this
   * changes the live site for everyone.
   */
  @Roles(UserRole.ADMIN)
  @Post('promote')
  startPromote(@Body() _dto: PromoteDto, @CurrentUser() user: AuthUser) {
    return this.promote.start({ id: user.id, name: user.name });
  }

  /** Signed-in users: is this the dev server, and on which day's copy. */
  @Get('status')
  status() {
    if (!this.sandbox.enabled) return { enabled: false };
    const db = this.sandbox.database();
    return { enabled: true, database: db.name, date: db.date };
  }

  private requireSandbox() {
    if (!this.sandbox.enabled) throw new NotFoundException();
  }

  @Roles(UserRole.ADMIN)
  @AllowSuperUser()
  @Get('databases')
  async databases() {
    this.requireSandbox();
    const prefix = this.sandbox.dbPrefix;
    const rows = await this.prisma.$queryRaw<
      { datname: string; bytes: bigint }[]
    >`
      select datname, pg_database_size(datname) as bytes
      from pg_database where datname like ${prefix + '%'} order by datname desc`;
    const current = this.sandbox.database().name;
    const picked = this.readPicked();
    return {
      current,
      following: picked === null || picked === 'latest' ? 'latest' : picked,
      copies: rows
        .filter((r) => isCopyName(r.datname, prefix))
        .map((r) => ({
          name: r.datname,
          date: copyDate(r.datname, prefix),
          sizeMb: Math.round(Number(r.bytes) / 1024 / 1024),
        })),
    };
  }

  /**
   * Move the dev server onto another day's copy. Written to the pick file,
   * then the process exits and PM2 starts it again on the new database — a
   * few seconds, the same as a deploy.
   */
  @Roles(UserRole.ADMIN)
  @AllowSuperUser()
  @Post('databases/switch')
  async switchDatabase(@Body() dto: SwitchDatabaseDto) {
    this.requireSandbox();
    const { copies } = await this.databases();
    if (
      dto.database !== 'latest' &&
      !copies.some((c) => c.name === dto.database)
    ) {
      throw new NotFoundException(`No copy named ${dto.database}.`);
    }
    if (dto.database === 'latest' && copies.length === 0) {
      throw new NotFoundException('There are no copies yet.');
    }
    fs.writeFileSync(this.dbFile(), `${dto.database}\n`);
    this.logger.warn(`Switching to ${dto.database} — restarting`);
    setTimeout(() => process.exit(0), 800);
    return { switching: dto.database, restartInSeconds: 5 };
  }

  @Roles(UserRole.ADMIN)
  @AllowSuperUser()
  @Get('outbox')
  async outbox(@Query('kind') kind?: string, @Query('page') page = '1') {
    this.requireSandbox();
    const take = 50;
    const skip = (Math.max(1, Number(page) || 1) - 1) * take;
    const where = kind ? { kind } : {};
    const [items, total] = await Promise.all([
      this.prisma.sandboxOutbox.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.sandboxOutbox.count({ where }),
    ]);
    return {
      items: items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })),
      total,
      page: Number(page) || 1,
      pageSize: take,
    };
  }

  private dbFile() {
    return this.config.get<string>('sandbox.dbFile') ?? '.dev-db';
  }

  private readPicked(): string | null {
    try {
      return fs.readFileSync(this.dbFile(), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
}
