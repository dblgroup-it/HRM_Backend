import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';

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
  app.enableCors({ origin: corsOrigin.split(','), credentials: true });

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
