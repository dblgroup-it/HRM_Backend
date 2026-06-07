import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: EventsGateway,
  ) {}

  /** Persist a notification for a user and push it live. */
  async notify(userId: string, input: NotifyInput): Promise<void> {
    const notification = await this.prisma.notification.create({
      data: { userId, ...input },
    });
    this.gateway.emitToUser(userId, 'notification', notification);
  }

  async notifyMany(userIds: string[], input: NotifyInput): Promise<void> {
    for (const id of new Set(userIds)) await this.notify(id, input);
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
