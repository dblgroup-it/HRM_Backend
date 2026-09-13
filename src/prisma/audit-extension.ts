import { PrismaClient } from '@prisma/client';

import { currentContext } from '../common/context/request-context';
import type { AuditService } from '../modules/audit/audit.service';

/**
 * Models worth recording field-by-field.
 *
 * Deliberately a list rather than "everything". `Employee` is the reason:
 * the nightly ZingHR sync updates ~4,400 of them, which would bury the ~50
 * things a person did that day. It records one summary row per run instead.
 *
 * The value is the field to read a human label from, so the log can say
 * "Arafat Haque Alvi" rather than a cuid.
 */
const TRACKED: Record<string, string | null> = {
  User: 'name',
  Role: 'name',
  RoleAssignment: null,
  Unit: 'name',
  Department: 'name',
  Position: 'designation',
  Requisition: 'code',
  ApprovalStep: 'title',
  ApprovalPath: null,
  ApprovalPathLevel: 'title',
  Candidate: 'name',
  InterviewRound: null,
  InterviewDelegation: null,
  Evaluation: null,
  SalaryFixation: null,
  Onboarding: null,
  MedicalExam: null,
  BoardApproval: null,
  BoardApprovalBatch: 'reference',
  BoardGroup: 'name',
  Setting: 'key',
  MasterOption: 'value',
};

const WRITE_OPS = new Set([
  'create',
  'update',
  'upsert',
  'delete',
  'updateMany',
  'deleteMany',
  'createMany',
]);

/** "update" → "updated", for a log that reads as sentences. */
const PAST_TENSE: Record<string, string> = {
  create: 'created',
  createMany: 'created',
  update: 'updated',
  updateMany: 'updated',
  upsert: 'saved',
  delete: 'deleted',
  deleteMany: 'deleted',
};

/**
 * Record what actually changed in the database.
 *
 * Prisma 6 removed `$use`, so this is a client extension. It returns a new
 * client rather than mutating, which is why PrismaService grafts the extended
 * delegates back onto itself — see prisma.service.ts.
 */
export function buildAuditExtension(audit: () => AuditService | null) {
  return (client: PrismaClient) =>
    client.$extends({
      name: 'audit',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const svc = audit();
            const ctx = currentContext();
            const tracked = model && model in TRACKED;

            if (
              !svc ||
              !tracked ||
              !WRITE_OPS.has(operation) ||
              ctx?.suppressDbAudit
            ) {
              return query(args);
            }

            const labelField = TRACKED[model as string];
            const delegate = (client as unknown as Record<string, any>)[
              lowerFirst(model as string)
            ];

            // "Before" is a separate read — Prisma hands the hook the `where`
            // and the new `data`, never the prior row.
            let before: Record<string, unknown> | null = null;
            const a = args as Record<string, any>;
            if (
              ['update', 'delete', 'upsert'].includes(operation) &&
              a?.where &&
              delegate?.findUnique
            ) {
              before = await delegate
                .findUnique({ where: a.where })
                .catch(() => null);
            }

            const result = await query(args);

            try {
              const after =
                operation === 'delete'
                  ? null
                  : (result as Record<string, unknown> | null);
              const changes =
                operation === 'delete' ? [] : svc.diff(before, after ?? null);

              // An update that changed nothing is noise.
              if (operation === 'update' && changes.length === 0) return result;

              const row = (after ?? before) as Record<string, unknown> | null;
              const label =
                labelField && row && typeof row[labelField] === 'string'
                  ? (row[labelField] as string)
                  : null;
              const id =
                (row?.id as string | undefined) ??
                (typeof a?.where?.id === 'string' ? a.where.id : undefined);

              const verb = PAST_TENSE[operation] ?? operation;
              const many = operation.endsWith('Many');
              const count =
                many &&
                typeof (result as { count?: number })?.count === 'number'
                  ? (result as { count: number }).count
                  : null;

              await svc.record({
                action: verb,
                entity: model as string,
                entityId: id ?? null,
                entityLabel: label,
                summary: many
                  ? `${verb} ${count ?? 'several'} ${model} records`
                  : `${verb} ${model}${label ? ` — ${label}` : ''}`,
                changes: changes.length ? changes : null,
                source: 'db',
              });
              if (ctx) ctx.dbWrites = (ctx.dbWrites ?? 0) + 1;
            } catch {
              // Auditing must never break the write it is recording.
            }

            return result;
          },
        },
      },
    });
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
