/** Unit tests for the security boundaries — no database, no network. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Some services under test construct their own PrismaClient (AuditService
  // does so deliberately, to avoid recursive audit writes). Jest sees the idle
  // connection pool as a leaked handle; the suites themselves are clean, so
  // exit once they have all reported rather than hanging the run.
  forceExit: true,
  detectOpenHandles: false,
};
