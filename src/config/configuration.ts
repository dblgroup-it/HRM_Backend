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
});
