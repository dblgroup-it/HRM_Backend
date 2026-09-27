import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../integrations/mail/mail.service';
import { EventsGateway } from './events.gateway';
import {
  cutoffDay,
  retentionCutoff,
} from '../../common/util/retention-cutoff';

/** Notifications are kept this many calendar days, today included. */
export const NOTIFICATION_RETENTION_DAYS = 60;

export interface NotifyEmail {
  subject: string;
  html: string;
  text: string;
}

export interface NotifyInput {
  type: string;
  title: string;
  message: string;
  link?: string;
  /**
   * A purpose-built email in place of the generic wrapper, for messages whose
   * email needs more than a title and a line — a list of candidates, say.
   * Given the recipient's name and the app origin, so it can greet them and
   * build absolute links. Still subject to their opt-in; never persisted.
   */
  email?: (to: { name: string; origin: string }) => NotifyEmail;
}

export interface BroadcastChangeOptions<T = unknown> {
  action?: string;
  record?: T;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: EventsGateway,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Every night: delete notifications older than 60 days, read or not.
   *
   * A bell holding a year of "Candidate assigned" is a bell nobody reads, and
   * the requisition itself keeps its own history — a notification is a nudge,
   * not the record. Runs in Dhaka time whatever the server clock says; in
   * batches so a first run over a large backlog never holds one long lock on a
   * table every action writes to. Never throws: a failed night is retried the
   * next one.
   */
  @Cron('20 3 * * *', { name: 'notification-retention', timeZone: 'Asia/Dhaka' })
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = retentionCutoff(now, NOTIFICATION_RETENTION_DAYS);
    let removed = 0;
    try {
      for (;;) {
        const n = await this.prisma.$executeRaw`
          DELETE FROM "notifications"
           WHERE "id" IN (
             SELECT "id" FROM "notifications"
              WHERE "created_at" < ${cutoff}
              LIMIT 5000
           )`;
        removed += n;
        if (n < 5000) break;
      }
    } catch (e) {
      this.logger.error(
        `Notification cleanup failed after removing ${removed}: ${(e as Error).message}`,
      );
      return removed;
    }
    if (removed > 0)
      this.logger.log(
        `Notification cleanup: removed ${removed} older than ${cutoffDay(cutoff)} (keeping ${NOTIFICATION_RETENTION_DAYS} days)`,
      );
    return removed;
  }

  /** Persist a notification for a user, push it live, and optionally email it. */
  async notify(userId: string, input: NotifyInput): Promise<void> {
    const { email: _email, ...data } = input;
    const notification = await this.prisma.notification.create({
      data: { userId, ...data },
    });
    this.gateway.emitToUser(userId, 'notification', notification);
    this.emailIfEnabled(userId, input);
  }

  /** Fire-and-forget email of a notification, if the user opted in. */
  private emailIfEnabled(userId: string, input: NotifyInput): void {
    if (!this.mail.isConfigured()) return;
    void (async () => {
      try {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { email: true, name: true, emailNotifications: true },
        });
        if (!user?.email || !user.emailNotifications) return;
        const origin =
          this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';
        if (input.email) {
          await this.mail.send({
            to: user.email,
            ...input.email({ name: user.name, origin }),
          });
          return;
        }
        const link = input.link ? `${origin}${input.link}` : origin;
        await this.mail.send({
          to: user.email,
          subject: `${input.title} | DBL HRM`,
          text: `${input.message}\n\nOpen DBL HRM: ${link}`,
          html: `<div style="font-family:Arial,sans-serif;color:#0f172a">
            <p style="font-size:15px;font-weight:600">${escapeHtml(input.title)}</p>
            <p style="font-size:14px;color:#334155">${escapeHtml(input.message)}</p>
            <p><a href="${link}" style="display:inline-block;background:#1877c0;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:13px">Open in DBL HRM</a></p>
            <p style="font-size:11px;color:#94a3b8">You receive these because email notifications are on. Turn them off in Settings → Notifications.</p>
          </div>`,
        });
      } catch (err) {
        this.logger.warn(
          `Notification email failed: ${(err as Error).message}`,
        );
      }
    })();
  }

  async notifyMany(userIds: string[], input: NotifyInput): Promise<void> {
    for (const id of new Set(userIds)) await this.notify(id, input);
  }

  /** Broadcast any arbitrary event to all connected clients. */
  broadcastRaw(event: string, data: unknown): void {
    this.gateway.broadcast(event, data);
  }

  /** Broadcast a live data-changed signal so open clients update/refetch. */
  broadcastChange<T = unknown>(
    resource: string,
    id: string,
    options: BroadcastChangeOptions<T> = {},
  ): void {
    this.gateway.broadcast(`${resource}:changed`, {
      resource,
      id,
      action: options.action,
      record: options.record,
      changedAt: new Date().toISOString(),
    });
  }

  list(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, read: false } });
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
    this.gateway.emitToUser(userId, 'notification:read', { id });
    return { id };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    this.gateway.emitToUser(userId, 'notification:read', { all: true });
    return { ok: true };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
