import { safePath, shouldLog, SLOW_MS } from './api-log-rules';

describe('API log rules', () => {
  it('keeps every error and every slow call, nothing else', () => {
    expect(shouldLog('/api/v1/requisitions', 500, 20)).toBe('error');
    expect(shouldLog('/api/v1/requisitions', 404, 20)).toBe('error');
    expect(shouldLog('/api/v1/requisitions', 200, SLOW_MS + 1)).toBe('slow');
    expect(shouldLog('/api/v1/requisitions', 200, 50)).toBeNull();
  });

  it('skips health probes and its own traffic', () => {
    expect(shouldLog('/api/health', 500, 10)).toBeNull();
    expect(shouldLog('/api/v1/health', 500, 10)).toBeNull();
    expect(shouldLog('/api/v1/api-logs', 500, 10)).toBeNull();
    expect(shouldLog('/api/v1/client-errors', 400, 10)).toBeNull();
  });

  it('never stores a working token or a query string', () => {
    const grant = 'eyJmIjoiMWUwbmszSldIQ1ZDYW9pa2xhY2tzb21ldGhpbmc';
    expect(safePath(`/api/files/${grant}`)).toBe('/api/files/:token');
    expect(safePath('/api/v1/eval/3f2a9c7e8b1d4f6a9c2e7b3d1f8a6c4e/cv')).toBe(
      '/api/v1/eval/:token/cv',
    );
    expect(safePath('/api/v1/employees?search=karim&page=2')).toBe(
      '/api/v1/employees',
    );
  });

  it('keeps record ids readable', () => {
    expect(safePath('/api/v1/requisitions/cmuctx38r0009ftw2x5z6p822')).toBe(
      '/api/v1/requisitions/cmuctx38r0009ftw2x5z6p822',
    );
  });
});
