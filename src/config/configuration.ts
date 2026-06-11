export interface AppConfig {
  nodeEnv: string;
  port: number;
  apiPrefix: string;
  corsOrigin: string;
  jwt: {
    secret: string;
    expiresIn: string;
  };
  zinghr: {
    baseUrl: string;
    subscriptionName: string;
    token: string;
    employeeCodePrefix: string;
    syncCron: string;
    syncEnabled: boolean;
  };
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    refreshToken: string;
    rootFolderId: string;
    rootFolderName: string;
  };
  mail: {
    user: string;
    appPassword: string;
    from: string;
  };
  ai: {
    provider: string;
    gemini: { apiKey: string; model: string };
    anthropic: { apiKey: string; model: string };
  };
  it: {
    webhookUrl: string;
  };
  nudge: {
    /** Days a requisition may sit with an approver before a daily reminder. */
    approvalDays: number;
  };
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '8000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
  },
  zinghr: {
    baseUrl: process.env.ZINGHR_BASE_URL ?? 'https://portal.zinghr.com',
    subscriptionName: process.env.ZINGHR_SUBSCRIPTION_NAME ?? '',
    token: process.env.ZINGHR_TOKEN ?? '',
    employeeCodePrefix: process.env.ZINGHR_EMPLOYEE_CODE_PREFIX ?? '151',
    syncCron: process.env.ZINGHR_SYNC_CRON ?? '36 20 * * *',
    syncEnabled: (process.env.ZINGHR_SYNC_ENABLED ?? 'true') === 'true',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri:
      process.env.GOOGLE_OAUTH_REDIRECT_URI ??
      'http://localhost:4000/api/integrations/google/oauth/callback',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? '',
    rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? '',
    rootFolderName:
      process.env.GOOGLE_DRIVE_ROOT_FOLDER_NAME ?? 'DBL HRM Recruitment',
  },
  mail: {
    user: process.env.MAIL_USER ?? '',
    appPassword: (process.env.MAIL_APP_PASSWORD ?? '').replace(/\s+/g, ''),
    from: process.env.MAIL_FROM ?? process.env.MAIL_USER ?? '',
  },
  ai: {
    provider: process.env.AI_PROVIDER ?? 'gemini',
    gemini: {
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
    },
  },
  it: {
    // Optional: IT provisioning webhook. When unset, HR enters email/asset id manually.
    webhookUrl: process.env.IT_WEBHOOK_URL ?? '',
  },
  nudge: {
    approvalDays: parseInt(process.env.NUDGE_APPROVAL_DAYS ?? '3', 10),
  },
});
