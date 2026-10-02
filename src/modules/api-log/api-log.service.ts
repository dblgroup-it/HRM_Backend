import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { cutoffDay, retentionCutoff } from '../../common/util/retention-cutoff';
import { clip } from './api-log-rules';

export interface ApiLogEntry {
  source: 'api' | 'browser';
  kind: 'error' | 'slow';
  method?: string | null;
  path?: string | null;
  status?: number | null;
  durationMs?: number | null;
  userId?: string | null;
  userName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  message?: string | null;
  stack?: string | null;
}

/** Days of API log kept. */
const KEEP_DAYS = 30;

/**
 * Errors and slow calls, from the API and from users' browsers.
 *
 * Writing is fire-and-forget: a failing log write must never turn into a
 * failing request, and a request must never wait on its own log row.
 */
@Injectable()
export class ApiLogService {
  private readonly logger = new Logger(ApiLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  record(entry: ApiLogEntry): void {
    this.prisma.apiLog
      .create({
        data: {
          source: entry.source,
          kind: entry.kind,
          method: entry.method?.slice(0, 10) ?? null,
          path: entry.path?.slice(0, 500) ?? null,
          status: entry.status ?? null,
          durationMs: entry.durationMs ?? null,
          userId: entry.userId ?? null,
          userName: entry.userName?.slice(0, 150) ?? null,
          ip: entry.ip?.slice(0, 64) ?? null,
          userAgent: entry.userAgent?.slice(0, 300) ?? null,
          requestId: entry.requestId?.slice(0, 40) ?? null,
          message: clip(entry.message, 4000),
          stack: clip(entry.stack, 12000),
        },
      })
      .catch((e: Error) =>
        this.logger.warn(`API log write failed: ${e.message}`),
      );
  }

  async list(q: {
    source?: string;
    kind?: string;
    status?: string;
    search?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }) {
    const pageSize = Math.min(Math.max(q.pageSize ?? 50, 10), 200);
    const page = Math.max(q.page ?? 1, 1);
    const where: Prisma.ApiLogWhereInput = {};
    if (q.source) where.source = q.source;
    if (q.kind) where.kind = q.kind;
    if (q.status === '5xx') where.status = { gte: 500 };
    else if (q.status === '4xx') where.status = { gte: 400, lt: 500 };
    else if (q.status && /^\d{3}$/.test(q.status))
      where.status = Number(q.status);
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    if (q.search?.trim()) {
      const s = q.search.trim();
      where.OR = [
        { path: { contains: s, mode: 'insensitive' } },
        { message: { contains: s, mode: 'insensitive' } },
        { userName: { contains: s, mode: 'insensitive' } },
        { requestId: s },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.apiLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.apiLog.count({ where }),
    ]);
    return {
      items: items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })),
      total,
      page,
      pageSize,
    };
  }

  /** The last 24 hours at a glance, and the paths failing most. */
  async summary() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [server, client, browser, slow, top] = await Promise.all([
      this.prisma.apiLog.count({
        where: { createdAt: { gte: since }, status: { gte: 500 } },
      }),
      this.prisma.apiLog.count({
        where: { createdAt: { gte: since }, status: { gte: 400, lt: 500 } },
      }),
      this.prisma.apiLog.count({
        where: { createdAt: { gte: since }, source: 'browser' },
      }),
      this.prisma.apiLog.count({
        where: { createdAt: { gte: since }, kind: 'slow' },
      }),
      this.prisma.apiLog.groupBy({
        by: ['method', 'path', 'status'],
        where: { createdAt: { gte: since }, kind: 'error', source: 'api' },
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
        take: 8,
      }),
    ]);
    return {
      last24h: {
        serverErrors: server,
        clientErrors: client,
        browserErrors: browser,
        slow,
      },
      topFailing: top.map((t) => ({
        method: t.method,
        path: t.path,
        status: t.status,
        count: t._count._all,
      })),
    };
  }

  /** Every night: keep the last 30 days, today included. Never throws. */
  @Cron('30 3 * * *', { name: 'api-log-retention', timeZone: 'Asia/Dhaka' })
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = retentionCutoff(now, KEEP_DAYS);
    let removed = 0;
    try {
      for (;;) {
        const n = await this.prisma.$executeRaw`
          DELETE FROM "api_logs"
           WHERE "id" IN (
             SELECT "id" FROM "api_logs" WHERE "created_at" < ${cutoff} LIMIT 5000
           )`;
        removed += n;
        if (n < 5000) break;
      }
      if (removed)
        this.logger.log(
          `API log: removed ${removed} rows before ${cutoffDay(cutoff)}`,
        );
    } catch (e) {
      this.logger.error(
        `API log cleanup failed after ${removed}: ${(e as Error).message}`,
      );
    }
    return removed;
  }
}
