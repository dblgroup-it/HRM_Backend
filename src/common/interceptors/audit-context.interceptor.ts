import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { RequestContext, runWithContext } from '../context/request-context';
import { AuditService } from '../../modules/audit/audit.service';

/** Only these change anything, so only these are logged. */
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Paths that change something every time they are called and would otherwise
 * bury the log — logins in particular, and the sync trigger which accounts for
 * itself with its own summary row.
 */
const SKIP_PATHS = [/\/auth\/login$/, /\/integrations\/zinghr\/sync$/];

/** What a verb means in business terms when no record was written. */
const VERB: Record<string, string> = {
  POST: 'submitted',
  PATCH: 'changed',
  PUT: 'changed',
  DELETE: 'removed',
};

/** The same verbs as infinitives, for "Attempted to …". */
const VERB_INFINITIVE: Record<string, string> = {
  POST: 'submit',
  PATCH: 'change',
  PUT: 'change',
  DELETE: 'remove',
};

/**
 * Name the thing a request was about, in words an HR manager would use.
 *
 * These rows only exist when nothing reached the database — a rejection, a
 * validation failure — so the label has to come from the route. Ids are
 * dropped so "candidates/:id/interviews" reads as "Candidate interviews"
 * rather than carrying a cuid into the log.
 */
function describe(
  method: string,
  path: string,
): { entity: string; action: string } {
  const parts = path
    .replace(/^\/api\//, '')
    .split('?')[0]
    .split('/')
    .filter(Boolean);

  // Anything that looks like an identifier rather than a word.
  const words = parts.filter(
    (p) => /^[a-z][a-z-]*$/i.test(p) && !/^\d+$/.test(p) && p.length < 30,
  );
  const readable = (w: string) =>
    w.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

  const entity = words.length ? readable(words[words.length - 1]) : 'Request';
  return { entity, action: VERB[method] ?? method.toLowerCase() };
}

/**
 * Attach the actor to everything a request touches, and log the request itself.
 *
 * Runs on every call so the AsyncLocalStorage context exists for the Prisma
 * extension underneath. Only mutating requests produce an entry of their own;
 * reads pass through with a context and nothing written.
 */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const user = req.user as { id?: string; name?: string } | undefined;

    const ctx: RequestContext = {
      userId: user?.id ?? null,
      // A token link has no signed-in user; the action still has an owner and
      // the service layer records who when it can resolve the token.
      userName: user?.name ?? (user ? 'Unknown user' : 'Public link'),
      actorType: user?.id ? 'user' : 'public',
      requestId: randomUUID(),
      ip:
        (req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.ip ||
        undefined,
      method: req.method,
      path: req.originalUrl ?? req.url,
    };

    return runWithContext(ctx, () =>
      next.handle().pipe(
        tap({
          next: () => this.log(ctx, res?.statusCode ?? 200),
          error: (err: { status?: number }) =>
            this.log(ctx, err?.status ?? 500, true),
        }),
      ),
    );
  }

  private log(ctx: RequestContext, statusCode: number, failed = false): void {
    const method = ctx.method ?? '';
    const path = ctx.path ?? '';
    if (!MUTATING.has(method)) return;
    if (SKIP_PATHS.some((re) => re.test(path.split('?')[0]))) return;
    // The Prisma layer already recorded this request in more detail. Only
    // speak up when it had nothing to say — a rejected request, a validation
    // failure, or an action against a model that is not tracked field by field.
    if (!failed && statusCode < 400 && (ctx.dbWrites ?? 0) > 0) return;

    const { entity, action } = describe(method, path);
    void this.audit.record({
      // Passed explicitly: by the time this runs the ALS scope has closed.
      actor: { id: ctx.userId, name: ctx.userName, type: ctx.actorType },
      action: failed ? 'attempted' : action,
      entity,
      summary: failed
        ? `Attempted to ${VERB_INFINITIVE[method] ?? 'change'} ${entity.toLowerCase()} — not completed`
        : `${action} ${entity.toLowerCase()}`,
      source: 'http',
      method,
      path,
      statusCode,
    });
  }
}
