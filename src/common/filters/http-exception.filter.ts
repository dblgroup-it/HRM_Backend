import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/** Converts any thrown error into a consistent JSON error envelope. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    // A machine-readable reason, when the thrower gave one — so a page can
    // act on it (ask for an email code again) without matching on wording.
    let code: string | undefined;
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string | string[] }).message ??
            exception.message);
      if (typeof res === 'object' && res !== null) {
        const c = (res as { code?: unknown }).code;
        if (typeof c === 'string') code = c;
      }
    }

    // For the API log (main.ts reads it when the response finishes): the
    // real message and, for a crash, the stack — the user only ever sees
    // "Internal server error".
    response.locals.apiError = {
      message:
        exception instanceof Error
          ? exception.message
          : Array.isArray(message)
            ? message.join('; ')
            : String(message),
      stack:
        status >= HttpStatus.INTERNAL_SERVER_ERROR && exception instanceof Error
          ? exception.stack
          : undefined,
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      ...(code && { code }),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
