import {
  chooseDatabase,
  copyDate,
  databaseOf,
  isCopyName,
  withDatabase,
} from './sandbox-db';

const P = 'dbl_hrm_dev_';

describe('sandbox database copies', () => {
  it('recognises only prefix + 8-digit date', () => {
    expect(isCopyName('dbl_hrm_dev_20261002', P)).toBe(true);
    expect(isCopyName('dbl_hrm', P)).toBe(false);
    expect(isCopyName('dbl_hrm_dev_2026', P)).toBe(false);
    expect(isCopyName('dbl_hrm_dev_20261002; drop', P)).toBe(false);
  });

  it('reads the date off the name', () => {
    expect(copyDate('dbl_hrm_dev_20261002', P)).toBe('2026-10-02');
    expect(copyDate('dbl_hrm', P)).toBeNull();
  });

  it('swaps the database in a URL and keeps everything else', () => {
    const url = 'postgresql://u:p%40ss@127.0.0.1:5432/dbl_hrm?schema=public';
    const next = withDatabase(url, 'dbl_hrm_dev_20261002');
    expect(databaseOf(next)).toBe('dbl_hrm_dev_20261002');
    expect(next).toContain('u:p%40ss@127.0.0.1:5432');
    expect(next).toContain('schema=public');
  });

  it('opens the picked copy, or the newest for "latest"', () => {
    const available = [
      'dbl_hrm_dev_20260930',
      'dbl_hrm',
      'dbl_hrm_dev_20261002',
    ];
    expect(
      chooseDatabase({ picked: 'dbl_hrm_dev_20260930', prefix: P, available }),
    ).toBe('dbl_hrm_dev_20260930');
    expect(chooseDatabase({ picked: 'latest', prefix: P, available })).toBe(
      'dbl_hrm_dev_20261002',
    );
    expect(chooseDatabase({ picked: null, prefix: P, available })).toBe(
      'dbl_hrm_dev_20261002',
    );
  });

  it('never opens something that is not a copy', () => {
    // The live database must be unreachable from the switcher.
    expect(
      chooseDatabase({ picked: 'dbl_hrm', prefix: P, available: ['dbl_hrm'] }),
    ).toBeNull();
    expect(
      chooseDatabase({ picked: 'latest', prefix: P, available: ['dbl_hrm'] }),
    ).toBeNull();
  });
});
