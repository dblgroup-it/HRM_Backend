import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

/** Full Drive scope — needed to create folders, upload, move and share files. */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Subset of Google's OAuth token response we care about. */
export interface OAuthTokens {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  token_type?: string | null;
  id_token?: string | null;
}

/**
 * Owns the OAuth2 plumbing for acting as the recruitment Google account
 * (itassets@dbl-group.com). Files created live in that account's own Drive,
 * counting against its storage — no separate/service-account storage needed.
 */
@Injectable()
export class GoogleAuthService {
  constructor(private readonly config: ConfigService) {}

  private get creds() {
    return {
      clientId: this.config.get<string>('google.clientId') ?? '',
      clientSecret: this.config.get<string>('google.clientSecret') ?? '',
      redirectUri: this.config.get<string>('google.redirectUri') ?? '',
      refreshToken: this.config.get<string>('google.refreshToken') ?? '',
    };
  }

  /** True once the one-time consent has produced a refresh token in .env. */
  isConfigured(): boolean {
    const c = this.creds;
    return Boolean(c.clientId && c.clientSecret && c.refreshToken);
  }

  /** True once a client id/secret exist (enough to run the consent flow). */
  hasClient(): boolean {
    const c = this.creds;
    return Boolean(c.clientId && c.clientSecret);
  }

  /** Bare client for the setup flow (consent URL + code→token exchange). */
  private oauthClient() {
    const c = this.creds;
    return new google.auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri);
  }

  getConsentUrl(): string {
    return this.oauthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [DRIVE_SCOPE],
    });
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const { tokens } = await this.oauthClient().getToken(code);
    return tokens;
  }

  /** Authorized client for live API calls (uses the stored refresh token). */
  getAuthorizedClient() {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Google Drive is not connected. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET and complete the one-time consent to obtain GOOGLE_REFRESH_TOKEN.',
      );
    }
    const client = this.oauthClient();
    client.setCredentials({ refresh_token: this.creds.refreshToken });
    return client;
  }
}
