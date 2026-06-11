import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';

import { Public } from '../../../common/decorators/public.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { GoogleAuthService } from './google-auth.service';
import { DriveService } from './drive.service';

/** HTML helper for the one-time setup pages (these are opened in a browser). */
function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#0f172a;color:#e2e8f0;padding:48px;line-height:1.6}
  .card{max-width:760px;margin:0 auto;background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px}
  h1{color:#8cc63f;margin-top:0} code,pre{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:2px 6px}
  pre{padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-all} a{color:#1877c0}</style></head>
  <body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
}

@Controller('integrations/google')
export class GoogleController {
  private readonly logger = new Logger(GoogleController.name);

  constructor(
    private readonly auth: GoogleAuthService,
    private readonly drive: DriveService,
  ) {}

  /** Whether Drive is connected — used by the frontend to gate recruitment UI. */
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @Get('drive/status')
  status() {
    return {
      hasClient: this.auth.hasClient(),
      connected: this.auth.isConfigured(),
      // Calendar rides on the same OAuth token. A pre-calendar consent keeps
      // working for Drive and simply skips invites until consent is redone.
      calendar: this.auth.isConfigured(),
    };
  }

  /**
   * One-time setup: open this in a browser (signed in as itassets@dbl-group.com)
   * to grant Drive access. Public because Google redirects back without our JWT.
   */
  @Public()
  @Get('oauth/start')
  start(@Res() res: Response) {
    if (!this.auth.hasClient()) {
      res.type('html').send(
        page(
          'Google Drive — not configured',
          `<p>Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in
             <code>HRM_Backend/.env</code> first, then restart the backend and reopen this page.</p>`,
        ),
      );
      return;
    }
    res.redirect(this.auth.getConsentUrl());
  }

  @Public()
  @Get('oauth/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    if (error || !code) {
      res.type('html').send(
        page(
          'Authorization failed',
          `<p>${error ?? 'No authorization code was returned.'} Please
             <a href="/api/integrations/google/oauth/start">try again</a>.</p>`,
        ),
      );
      return;
    }

    try {
      const tokens = await this.auth.exchangeCode(code);
      const refresh = tokens.refresh_token;
      if (!refresh) {
        res.type('html').send(
          page(
            'Almost there — no refresh token',
            `<p>Google did not return a refresh token (this happens if you've authorized before).
             Remove this app's access at
             <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a>
             and <a href="/api/integrations/google/oauth/start">start again</a>.</p>`,
          ),
        );
        return;
      }
      this.logger.log('Google Drive consent complete — refresh token issued.');
      res.type('html').send(
        page(
          'Google Drive connected ✓',
          `<p>Copy this into <code>HRM_Backend/.env</code>, then restart the backend:</p>
           <pre>GOOGLE_REFRESH_TOKEN=${refresh}</pre>
           <p>After restarting, recruitment folders will be created automatically when a requisition is posted.</p>`,
        ),
      );
    } catch (err) {
      this.logger.error('Token exchange failed', err as Error);
      res.type('html').send(
        page(
          'Token exchange failed',
          `<p>${(err as Error).message}. Please
             <a href="/api/integrations/google/oauth/start">try again</a>.</p>`,
        ),
      );
    }
  }
}
