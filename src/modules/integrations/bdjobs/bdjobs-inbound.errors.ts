import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  ValidationPipe,
} from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import type { Response } from 'express';

/**
 * One failed field, in words the integrator on the other side can act on.
 */
export interface BdJobsFieldError {
  /** Dotted path into the payload, e.g. "CandidateData.personalData.emailId". */
  field: string;
  problem: string;
  /** What arrived, trimmed — so they can see their own value echoed back. */
  received?: string;
}

export interface BdJobsErrorBody {
  success: false;
  data: null;
  /** Self-sufficient: a client reading only this still learns what to fix. */
  message: string;
  /** Stable machine-readable reason, safe to branch on. */
  code: string;
  errors?: BdJobsFieldError[];
  /** What to do about it. */
  hint?: string;
}

/** Throw with structure; the filter below turns it into the response body. */
export class BdJobsInboundError extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly errors?: BdJobsFieldError[],
  ) {
    super({ code, message, hint, errors }, status);
  }
}

/** Show a value back without dumping a whole nested payload into the reply. */
function preview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'object')
    return Array.isArray(value) ? `array(${value.length})` : 'object';
  const s = String(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** Walk nested validation errors, keeping the path to each bad field. */
function flatten(errors: ValidationError[], parent = ''): BdJobsFieldError[] {
  const out: BdJobsFieldError[] = [];
  for (const e of errors) {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const problems = Object.values(e.constraints ?? {});
    if (problems.length) {
      // A field that was simply not sent trips every rule at once — type,
      // length, the lot. Reporting four contradictory complaints about one
      // absent value reads like four separate bugs, so it is said once.
      if (e.value === undefined) {
        out.push({ field, problem: `${field} is required but was not sent` });
      } else {
        for (const problem of problems) {
          out.push({ field, problem, received: preview(e.value) });
        }
      }
    }
    if (e.children?.length) out.push(...flatten(e.children, field));
  }
  return out;
}

/**
 * The validation pipe for the inbound webhook.
 *
 * The global pipe's rejection escapes this endpoint's contract: it answers
 * with `{ success, statusCode, message: [...], path, timestamp }` and a
 * `message` that is an array, which a client expecting `{ success, data,
 * message }` with a string cannot read. This one fails in the same shape as
 * every other error here, and names the field that was wrong.
 */
export const bdjobsInboundValidation = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  exceptionFactory: (errors: ValidationError[]) => {
    const fields = flatten(errors);
    const summary = fields
      .slice(0, 4)
      .map((f) => `${f.field}: ${f.problem}`)
      .join('; ');
    return new BdJobsInboundError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_FAILED',
      `Payload rejected — ${fields.length} field problem${fields.length === 1 ? '' : 's'}. ${summary}${fields.length > 4 ? '; …' : ''}`,
      'Send the candidate as either a `candidate` block or a `CandidateData` profile. `resume`, `profile` and `jobReferenceId` are all optional.',
      fields,
    );
  },
});

/**
 * Every failure on this route answers in Bdjobs' documented shape.
 *
 * Applied to the route rather than globally so the rest of the API keeps its
 * own error format, and placed as a filter rather than a try/catch because a
 * validation failure is thrown while arguments are being resolved — before
 * the handler body runs, where a try/catch can never see it.
 */
@Catch()
export class BdJobsInboundFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof BdJobsInboundError) {
      const body: BdJobsErrorBody = {
        success: false,
        data: null,
        message: exception.message,
        code: exception.code,
        ...(exception.hint ? { hint: exception.hint } : {}),
        ...(exception.errors?.length ? { errors: exception.errors } : {}),
      };
      res.status(exception.getStatus()).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const raw = exception.getResponse();
      const message =
        typeof raw === 'string'
          ? raw
          : Array.isArray((raw as { message?: unknown }).message)
            ? (raw as { message: string[] }).message.join('; ')
            : ((raw as { message?: string }).message ?? exception.message);
      res.status(exception.getStatus()).json({
        success: false,
        data: null,
        message,
        code: 'REQUEST_REJECTED',
      } satisfies BdJobsErrorBody);
      return;
    }

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      data: null,
      message:
        exception instanceof Error
          ? `Unexpected server error: ${exception.message}`
          : 'Unexpected server error',
      code: 'SERVER_ERROR',
      hint: 'Nothing was saved. The push can be retried unchanged.',
    } satisfies BdJobsErrorBody);
  }
}
