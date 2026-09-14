import { AuditService } from './audit.service';
import type { PermissionsService } from '../rbac/permissions.service';

/**
 * The audit table is read through a different door from the records it
 * describes, so anything copied into it becomes a second, less-protected copy.
 * The service's own doc comment says pay and clinical findings are kept out of
 * it; before this cover, only the clinical findings actually were.
 */
describe('AuditService.diff — redaction', () => {
  const audit = new AuditService({} as PermissionsService);

  // AuditService opens its own PrismaClient (deliberately — see the service),
  // so close it or the worker never exits.
  afterAll(async () => {
    await (
      audit as unknown as { db: { $disconnect(): Promise<void> } }
    ).db.$disconnect();
  });

  const redacted = (field: string, before: unknown, after: unknown) => {
    const [change] = audit.diff({ [field]: before }, { [field]: after });
    expect(change).toBeDefined();
    return change;
  };

  it.each([
    ['proposedSalary', 40000, 65000],
    ['proposedSalaryOverride', null, 72000],
    ['salaryExpectation', null, 55000],
    ['averageScore', 3.1, 4.4],
    ['writtenTestObtained', 40, 71],
  ])('keeps %s out of the log', (field, before, after) => {
    const change = redacted(field, before, after);
    expect(change.from).toBe('[redacted]');
    expect(change.to).toBe('[redacted]');
    expect(JSON.stringify(change)).not.toContain(String(after));
  });

  it.each([
    ['twoFactorSecret', null, 'JBSWY3DPEHPK3PXP'],
    ['otpHash', null, '$2a$08$abcdefghijklmnopqrstuv'],
    ['passwordHash', 'old', '$2a$10$zzzzzzzzzzzzzzzzzzzzzz'],
  ])('keeps the credential %s out of the log', (field, before, after) => {
    const change = redacted(field, before, after);
    expect(change.to).toBe('[redacted]');
    expect(JSON.stringify(change)).not.toContain(after);
  });

  it.each([
    'hepatitisBNegative',
    'bloodGroup',
    'fitToJoin',
    'pastIllnessHistory',
  ])('keeps the medical finding %s out of the log', (field) => {
    const change = redacted(field, null, 'POSITIVE');
    expect(change.to).toBe('[redacted]');
  });

  it('still records ordinary business fields in full, so the log stays useful', () => {
    const change = redacted('status', 'draft', 'fixed');
    expect(change.from).toBe('draft');
    expect(change.to).toBe('fixed');
  });

  it('records that a redacted field changed, rather than dropping it', () => {
    const changes = audit.diff({ proposedSalary: 1 }, { proposedSalary: 2 });
    expect(changes.map((c) => c.field)).toEqual(['proposedSalary']);
  });
});
