import {
  codeSequence,
  isCodeCollision,
  nextRequisitionCode,
} from './requisition-code';

describe('requisition codes', () => {
  it('continues from the highest number, not the row count', () => {
    // REQ-2026-003 was deleted: two rows remain, but 003 must not come back
    // as the next code while 004 is taken.
    expect(nextRequisitionCode(['REQ-2026-001', 'REQ-2026-004'], 2026)).toBe(
      'REQ-2026-005',
    );
  });

  it('matches the old numbering when nothing was deleted', () => {
    const codes = ['REQ-2026-001', 'REQ-2026-002', 'REQ-2026-003'];
    expect(nextRequisitionCode(codes, 2026)).toBe('REQ-2026-004');
  });

  it('keeps the sequence running into a new year', () => {
    expect(nextRequisitionCode(['REQ-2026-015'], 2027)).toBe('REQ-2027-016');
  });

  it('starts at 001 and grows past three digits', () => {
    expect(nextRequisitionCode([], 2026)).toBe('REQ-2026-001');
    expect(nextRequisitionCode(['REQ-2026-999'], 2026)).toBe('REQ-2026-1000');
    expect(codeSequence('REQ-2026-1000')).toBe(1000);
  });

  it('recognises a collision on the code only', () => {
    expect(isCodeCollision({ code: 'P2002', meta: { target: ['code'] } })).toBe(
      true,
    );
    expect(
      isCodeCollision({
        code: 'P2002',
        meta: { target: 'requisitions_code_key' },
      }),
    ).toBe(true);
    expect(
      isCodeCollision({ code: 'P2002', meta: { target: ['email'] } }),
    ).toBe(false);
    expect(isCodeCollision({ code: 'P2025' })).toBe(false);
  });
});
