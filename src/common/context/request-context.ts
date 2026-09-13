import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Who is behind the work currently running.
 *
 * Services here learn the actor because the controller passes `userId` down —
 * which works fine until something further from the request needs to know, and
 * the Prisma extension that records field-level changes is exactly that: it
 * sees the write but has no argument telling it who asked for it.
 *
 * This carries the actor alongside the request instead, so the audit log can
 * say "Md. Al Amin changed the salary" rather than "the salary changed".
 */
export interface RequestContext {
  /** Null for public token endpoints and for scheduled work. */
  userId: string | null;
  userName: string;
  /** user — signed in · public — token link · system — cron/startup. */
  actorType: 'user' | 'public' | 'system';
  requestId: string;
  ip?: string;
  method?: string;
  path?: string;
  /**
   * Set while a bulk job runs so the Prisma extension stays quiet — the nightly
   * ZingHR sync would otherwise write ~4,400 rows a night and bury the ~50 a
   * human actually did. The job records one summary row itself instead.
   */
  suppressDbAudit?: boolean;
  /**
   * How many field-level entries the Prisma extension wrote for this request.
   *
   * When it wrote any, the interceptor stays quiet: those rows say the same
   * thing with more detail, and logging both doubles the log for no gain.
   */
  dbWrites?: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with this context attached to everything it awaits. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** A context for scheduled work, which has no request behind it. */
export function systemContext(name = 'System'): RequestContext {
  return {
    userId: null,
    userName: name,
    actorType: 'system',
    requestId: randomUUID(),
  };
}

/**
 * Run a block with database-level auditing turned off.
 *
 * For jobs that write in bulk and account for themselves with a single summary
 * entry. Restores the previous setting afterwards so nesting is safe.
 */
export async function withoutDbAudit<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = storage.getStore();
  if (!ctx) return fn();
  const previous = ctx.suppressDbAudit;
  ctx.suppressDbAudit = true;
  try {
    return await fn();
  } finally {
    ctx.suppressDbAudit = previous;
  }
}
