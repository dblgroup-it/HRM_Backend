export interface AppConfig {
  nodeEnv: string;
  port: number;
  apiPrefix: string;
  corsOrigin: string;
  /** Single public-facing frontend URL used to build links in emails/notifications. */
  frontendUrl: string;
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
  bdjobs: {
    baseUrl: string;
    authToken: string;
    companyId: string;
    decodeId: string;
    /** Template hashed (SHA-256) into X-Api-AuthToken — BDJobs defines the order. */
    signatureFormat: string;
  };
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '8000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  frontendUrl: (process.env.FRONTEND_URL ?? process.env.CORS_ORIGIN?.split(',')[0] ?? 'http://localhost:3000').replace(/\/$/, ''),
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
  bdjobs: {
    baseUrl: process.env.BDJOBS_BASE_URL ?? 'https://application.bdjobs.com/v1',
    authToken: process.env.BDJOBS_AUTH_TOKEN ?? '',
    companyId: process.env.BDJOBS_COMPANY_ID ?? '',
    decodeId: process.env.BDJOBS_DECODE_ID ?? '',
    signatureFormat:
      process.env.BDJOBS_SIGNATURE_FORMAT ?? '{token}{decodeId}{ts}',
  },
});
