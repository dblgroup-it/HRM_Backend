import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../integrations/mail/mail.service';
import { EventsGateway } from './events.gateway';

export interface NotifyInput {
  type: string;
  title: string;
  message: string;
  link?: string;
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

  /** Persist a notification for a user, push it live, and optionally email it. */
  async notify(userId: string, input: NotifyInput): Promise<void> {
    const notification = await this.prisma.notification.create({
      data: { userId, ...input },
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
          this.config.get<string>('corsOrigin') ?? 'http://localhost:3000';
        const link = input.link
          ? `${origin.replace(/\/$/, '')}${input.link}`
          : origin;
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
