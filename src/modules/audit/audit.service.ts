import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

import { currentContext } from '../../common/context/request-context';
import { PermissionsService } from '../rbac/permissions.service';

/** One field that changed. */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  entityLabel?: string | null;
  summary?: string;
  changes?: FieldChange[] | null;
  source?: 'http' | 'db' | 'system';
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  /**
   * Who did it, when the caller already knows.
   *
   * The HTTP interceptor needs this: its `tap` callbacks fire when the response
   * emits, by which time the AsyncLocalStorage scope that wrapped the handler
   * has closed, so `currentContext()` would come back empty.
   */
  actor?: { id: string | null; name: string; type: string } | null;
}

/**
 * Fields whose values must never be copied into the log.
 *
 * The audit table is read by super admins through a different door from the
 * records themselves, so mirroring medical findings or pay into it would
 * quietly create a second, less protected copy. These are recorded as having
 * changed, without the values.
 */
const REDACTED_FIELDS = new Set([
  // Medical Fitness Report — clinical findings
  'bloodPressure',
  'pulse',
  'height',
  'weight',
  'bloodGroup',
  'visionRightEye',
  'visionLeftEye',
  'hearingRightEar',
  'hearingLeftEar',
  'colorVisionYellow',
  'colorVisionRed',
  'colorVisionGreen',
  'colorVisionBlue',
  'speech',
  'extremities',
  'noAnemiaJaundiceEtc',
  'urineTestClear',
  'hepatitisBNegative',
  'liverFunctionNormal',
  'pastIllnessHistory',
  'familyHistoryDmHtn',
  'familyHistoryDetail',
  'stableNormotensiveNondiabetic',
  // Medical Fitness Report — the doctor's determination and free-text notes
  'fitToJoin',
  'remarks',
  'registrationNo',
  'consultantName',
  // Pay. The doc comment above says pay is kept out of this table; without
  // these entries it was not — SalaryFixation is a tracked model, so every
  // proposed figure, override and screening mark was being copied here in
  // cleartext for anyone who can read the activity log.
  'salaryExpectation',
  'proposedSalary',
  'proposedSalaryOverride',
  'averageScore',
  'computedBand',
  'bandOverride',
  'writtenTestObtained',
  'writtenTestTotal',
  'computerTestObtained',
  'computerTestTotal',
  'aiTestObtained',
  'aiTestTotal',
  'totalScore',
  'scores',
  'salaryScores',
  'salaryTotal',
  // Credentials. `User` is tracked, so enabling an authenticator app wrote the
  // TOTP seed itself into this table — a second copy of the second factor,
  // behind weaker protection than the users table.
  'passwordHash',
  'twoFactorSecret',
  'otpHash',
  'token',
  'refreshToken',
]);

/** Never logged at all — noise, or huge. */
const IGNORED_FIELDS = new Set([
  'updatedAt',
  'createdAt',
  'offerLetterHtml',
  'appointmentLetterHtml',
  'matchDetails',
  'aiExtract',
  'questionIds',
  'answers',
  'crossCheck',
]);

const MAX_VALUE_LENGTH = 300;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /**
   * Deliberately its own PrismaClient, not the shared PrismaService.
   *
   * The shared one carries the extension that records changes; writing the log
   * through it would make every log row trigger another log row.
   */
  private readonly db = new PrismaClient();

  constructor(private readonly permissions: PermissionsService) {}

  /**
   * Write one entry.
   *
   * Never throws: an audit failure must not break the action being audited.
   * A dropped entry is a gap in the log; a thrown error is a broken feature.
   */
  async record(entry: AuditEntry): Promise<void> {
    const ctx = currentContext();
    try {
      await this.db.auditLog.create({
        data: {
          actorId: entry.actor?.id ?? ctx?.userId ?? null,
          actorName: entry.actor?.name ?? ctx?.userName ?? 'System',
          actorType: entry.actor?.type ?? ctx?.actorType ?? 'system',
          action: entry.action.slice(0, 60),
          entity: entry.entity.slice(0, 60),
          entityId: entry.entityId?.slice(0, 64) ?? null,
          entityLabel: entry.entityLabel?.slice(0, 200) ?? null,
          summary: entry.summary ?? '',
          changes: entry.changes
            ? (entry.changes as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          source: entry.source ?? 'http',
          method: entry.method ?? ctx?.method ?? null,
          path: (entry.path ?? ctx?.path)?.slice(0, 300) ?? null,
          statusCode: entry.statusCode ?? null,
          ip: ctx?.ip?.slice(0, 64) ?? null,
          requestId: ctx?.requestId ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`Could not write audit entry: ${(e as Error).message}`);
    }
  }

  /**
   * Compare two rows and return only what genuinely changed.
   *
   * Prisma hands back full records, so a naive diff reports every column. This
   * keeps the fields a person would care about, redacts the sensitive ones and
   * truncates anything long enough to bloat the row.
   */
  diff(
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): FieldChange[] {
    if (!after) return [];
    const changes: FieldChange[] = [];
    for (const [field, next] of Object.entries(after)) {
      if (IGNORED_FIELDS.has(field)) continue;
      const prev = before ? before[field] : undefined;
      if (before && this.same(prev, next)) continue;
      if (!before && (next === null || next === undefined)) continue;
      changes.push(
        REDACTED_FIELDS.has(field)
          ? { field, from: '[redacted]', to: '[redacted]' }
          : { field, from: this.trim(prev), to: this.trim(next) },
      );
    }
    return changes;
  }

  private same(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a instanceof Date && b instanceof Date)
      return a.getTime() === b.getTime();
    if (a === null || b === null || a === undefined || b === undefined)
      return false;
    if (typeof a === 'object' && typeof b === 'object') {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return false;
      }
    }
    return false;
  }

  private trim(v: unknown): unknown {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') {
      return v.length > MAX_VALUE_LENGTH
        ? `${v.slice(0, MAX_VALUE_LENGTH)}…`
        : v;
    }
    if (typeof v === 'object') {
      const json = JSON.stringify(v);
      return json.length > MAX_VALUE_LENGTH
        ? `${json.slice(0, MAX_VALUE_LENGTH)}…`
        : v;
    }
    return v;
  }

  // --- reading -------------------------------------------------------------

  /** The log is super-admin only, enforced here rather than by hiding the nav. */
  private async requireSuperUser(userId: string): Promise<void> {
    if (!(await this.permissions.isSuperUser(userId))) {
      throw new ForbiddenException(
        'Only a super user can read the system activity log.',
      );
    }
  }

  async list(
    userId: string,
    query: {
      actorId?: string;
      entity?: string;
      action?: string;
      search?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    await this.requireSuperUser(userId);
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to
                ? { lte: new Date(`${query.to}T23:59:59.999Z`) }
                : {}),
            },
          }
        : {}),
      ...(query.search?.trim()
        ? {
            OR: [
              {
                summary: { contains: query.search.trim(), mode: 'insensitive' },
              },
              {
                actorName: {
                  contains: query.search.trim(),
                  mode: 'insensitive',
                },
              },
              {
                entityLabel: {
                  contains: query.search.trim(),
                  mode: 'insensitive',
                },
              },
              {
                entityId: {
                  contains: query.search.trim(),
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.auditLog.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        actorId: r.actorId,
        actorName: r.actorName,
        actorType: r.actorType,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        entityLabel: r.entityLabel,
        summary: r.summary,
        changes: (r.changes as FieldChange[] | null) ?? [],
        source: r.source,
        method: r.method,
        path: r.path,
        statusCode: r.statusCode,
        ip: r.ip,
        requestId: r.requestId,
      })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /** The values behind the filter dropdowns, drawn from what is actually there. */
  async filters(userId: string) {
    await this.requireSuperUser(userId);
    const [entities, actions, actors] = await Promise.all([
      this.db.auditLog.groupBy({ by: ['entity'], _count: { _all: true } }),
      this.db.auditLog.groupBy({ by: ['action'], _count: { _all: true } }),
      this.db.auditLog.groupBy({
        by: ['actorId', 'actorName'],
        _count: { _all: true },
      }),
    ]);
    const byCount = <T extends { _count: { _all: number } }>(a: T, b: T) =>
      b._count._all - a._count._all;
    return {
      entities: entities.sort(byCount).map((e) => ({
        value: e.entity,
        count: e._count._all,
      })),
      actions: actions.sort(byCount).map((a) => ({
        value: a.action,
        count: a._count._all,
      })),
      actors: actors
        .sort(byCount)
        .filter((a) => a.actorId)
        .map((a) => ({
          value: a.actorId as string,
          label: a.actorName,
          count: a._count._all,
        })),
    };
  }
}
