import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  Logger,
  ValidationPipe,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import helmet from 'helmet';
import { json, type NextFunction, type Request, type Response } from 'express';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

/** Fail fast on missing / insecure configuration before the app boots. */
function validateEnv(): void {
  const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
  const errors: string[] = [];

  if (!process.env.DATABASE_URL) errors.push('DATABASE_URL is required');
  const secret = process.env.JWT_SECRET;
  if (!secret) errors.push('JWT_SECRET is required');

  if (isProd) {
    if (secret && (secret === 'dev-secret-change-me' || secret.length < 24)) {
      errors.push(
        'JWT_SECRET must be a strong, unique value (≥24 chars) in production',
      );
    }
    if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*') {
      errors.push(
        'CORS_ORIGIN must be your frontend origin(s) in production (not "*")',
      );
    }
    // Without this, a missing env var silently falls back to a localhost
    // callback (see configuration.ts) — Google would redirect the OAuth
    // consent flow to a URL nobody in production can reach.
    // TOTP seeds are reversible secrets — they are encrypted at rest, and the
    // key lives outside the database on purpose. Without it the server would
    // fall back to a key derived from JWT_SECRET, which is not acceptable for
    // a second authentication factor in production.
    const totpKey = process.env.TOTP_ENCRYPTION_KEY;
    if (!totpKey || totpKey.trim().length < 32) {
      errors.push(
        'TOTP_ENCRYPTION_KEY is required in production and must be at least 32 characters (generate with: openssl rand -hex 32)',
      );
    }
    if (
      !process.env.GOOGLE_OAUTH_REDIRECT_URI ||
      process.env.GOOGLE_OAUTH_REDIRECT_URI.includes('localhost')
    ) {
      errors.push(
        'GOOGLE_OAUTH_REDIRECT_URI must be set to your production callback URL (not localhost) in production',
      );
    }
  }

  if (errors.length) {
    Logger.error(
      `Invalid configuration:\n - ${errors.join('\n - ')}`,
      'Bootstrap',
    );
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  validateEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Trust exactly one proxy hop, so `req.ip` is the real client rather than
  // nginx.
  //
  // Without this, Express reports the proxy's own address for every request and
  // @nestjs/throttler — whose default tracker is literally `req.ip` — buckets
  // the entire company together. Every per-route limit then applies to everyone
  // at once: `@Throttle({ limit: 10 })` on login becomes ten sign-ins per minute
  // for the whole organisation, not per person, and the eleventh user at 9am
  // gets a 429 they cannot do anything about.
  //
  // `1`, not `true`: trusting every hop lets a client that can reach the API
  // directly spoof X-Forwarded-For and mint itself a fresh rate-limit bucket per
  // request. One hop trusts nginx and nothing beyond it.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // The SPA on a different origin loads images/files from this API (avatars,
  // Drive proxies), so resources must be cross-origin readable. We also serve
  // no HTML, so helmet's CSP (which governs documents) only gets in the way.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );
  const config = app.get(ConfigService);

  const apiPrefix = config.get<string>('apiPrefix', 'api');
  const port = config.get<number>('port', 8000);
  const corsOrigin = config.get<string>('corsOrigin', '*');

  app.setGlobalPrefix(apiPrefix);
  // API v1. Every route answers at /api/v1/… — what this frontend calls —
  // and, unchanged, at /api/… for what already points there and cannot be
  // re-sent: links in emails already delivered (files, evaluations, board
  // votes, offers), the BDJobs webhook BDJobs posts to, and the Google OAuth
  // callback registered in Google's console. A v2 controller declares
  // `@Version('2')` and lives at /api/v2/… beside it.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: ['1', VERSION_NEUTRAL],
  });
  // The BDJobs webhook may carry the applicant's photo inline as a data: URI
  // (up to 2 MB of image, ~2.7 MB as base64), well past the default 100 KB
  // JSON limit. Raised for that one route only: registered before Nest's own
  // parser, which then sees the body already parsed and leaves it alone.
  //
  // Wrapped, not passed directly: Nest skips registering its own JSON parser
  // when it finds a middleware named `jsonParser` already in the stack, and
  // body-parser's function carries exactly that name — so passing it straight
  // in left every other route without a parsed body (sign-in included).
  const bdjobsJson = json({ limit: '4mb' });
  app.use(
    [
      `/${apiPrefix}/integrations/bdjobs/candidates`,
      `/${apiPrefix}/v1/integrations/bdjobs/candidates`,
    ],
    (req: Request, res: Response, next: NextFunction) =>
      bdjobsJson(req, res, (err?: unknown) => {
        if (!err) return next();
        // Answered here, in the webhook's own error shape: an error thrown
        // by a parser registered this early never reaches the route's
        // exception filter, and BDJobs got a bare "Internal server error".
        const e = err as { type?: string; status?: number; message?: string };
        const tooLarge = e.type === 'entity.too.large';
        res.status(tooLarge ? 413 : (e.status ?? 400)).json({
          success: false,
          data: null,
          code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
          message: tooLarge
            ? 'The request body is larger than 4 MB.'
            : `The request body is not valid JSON: ${e.message ?? 'parse error'}.`,
          hint: tooLarge
            ? 'Send the photo as a link (photo.url) rather than inline, or keep an inline photo under 2 MB.'
            : 'Send Content-Type: application/json with a single JSON object.',
        });
      }),
  );
  app.enableCors({
    origin: corsOrigin.split(','),
    credentials: true,
    // Downloads are served cross-origin (SPA on :3000, API on :4000), and a
    // browser hides every header from JS unless it is named here — without
    // this the filename in Content-Disposition is invisible and exports save
    // under an opaque id.
    exposedHeaders: ['Content-Disposition'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  await app.listen(port);
  Logger.log(
    `🚀 HRM API ready at http://localhost:${port}/${apiPrefix}`,
    'Bootstrap',
  );
}

void bootstrap();
