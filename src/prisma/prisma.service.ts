import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { buildAuditExtension } from './audit-extension';
import type { AuditService } from '../modules/audit/audit.service';

/**
 * The database client, with audit recording attached.
 *
 * Prisma 6 removed `$use`, and `$extends` returns a *new* client rather than
 * mutating this one — which does not fit a service that extends PrismaClient.
 * The extended model delegates are therefore grafted back onto `this` on
 * startup, so every existing `this.prisma.candidate.update(...)` call site
 * keeps working untouched while writes flow through the audit extension.
 *
 * The AuditService is handed over after construction rather than injected:
 * it depends on Prisma itself, and constructor injection would be circular.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private audit: AuditService | null = null;

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.attachAudit();
  }

  /** Called by AuditModule once the service exists. */
  setAuditService(service: AuditService): void {
    this.audit = service;
  }

  private attachAudit(): void {
    const extended = buildAuditExtension(() => this.audit)(this);
    for (const key of Object.keys(extended)) {
      if (key.startsWith('$') || key.startsWith('_')) continue;
      const delegate = (extended as unknown as Record<string, unknown>)[key];
      if (!delegate || typeof delegate !== 'object') continue;
      Object.defineProperty(this, key, {
        value: delegate,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
