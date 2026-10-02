import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { copyDate, databaseOf } from './sandbox-db';

export type OutboxKind = 'email' | 'calendar' | 'drive' | 'webhook' | 'bdjobs';

/**
 * The dev server's seatbelt.
 *
 * With `SANDBOX_MODE=true` the app runs on a copy of the live data, so every
 * integration that reaches outside asks `intercept()` first. In sandbox it
 * records what would have gone out — in `sandbox_outbox`, and in the server
 * log, which is how a sign-in code can still be read when its email never
 * leaves — and tells the caller not to send. On the live server it is a
 * no-op that always says "go ahead".
 */
@Injectable()
export class SandboxService {
  private readonly logger = new Logger('Sandbox');
  readonly enabled: boolean;
  readonly dbPrefix: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.enabled = config.get<boolean>('sandbox.enabled') ?? false;
    this.dbPrefix = config.get<string>('sandbox.dbPrefix') ?? 'dbl_hrm_dev_';
  }

  /** The database this process is connected to, and the date of the copy. */
  database(): { name: string | null; date: string | null } {
    try {
      const name = databaseOf(process.env.DATABASE_URL ?? '');
      return { name, date: copyDate(name, this.dbPrefix) };
    } catch {
      return { name: null, date: null };
    }
  }

  /**
   * True when the caller must NOT perform the action (sandbox): it has been
   * recorded instead. False on the live server — carry on as normal.
   */
  async intercept(
    kind: OutboxKind,
    entry: {
      target?: string | null;
      subject?: string | null;
      body?: string | null;
      meta?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    if (!this.enabled) return false;
    const subject = entry.subject?.slice(0, 500) ?? null;
    this.logger.warn(
      `[outbox:${kind}] ${entry.target ?? ''} — ${subject ?? ''}${
        kind === 'email' && entry.body ? `\n${entry.body.slice(0, 2000)}` : ''
      }`,
    );
    try {
      await this.prisma.sandboxOutbox.create({
        data: {
          kind,
          target: entry.target?.slice(0, 500) ?? null,
          subject,
          body: entry.body ?? null,
          meta: (entry.meta ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (e) {
      // Never let recording break the flow being tested.
      this.logger.error(
        `Could not record outbox entry: ${(e as Error).message}`,
      );
    }
    return true;
  }

  /** For scheduled jobs that reach outside: skip them on the dev server. */
  skipJob(name: string): boolean {
    if (!this.enabled) return false;
    this.logger.log(`Scheduled job "${name}" skipped (sandbox)`);
    return true;
  }
}
