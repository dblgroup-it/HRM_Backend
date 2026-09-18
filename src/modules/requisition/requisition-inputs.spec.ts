import {
  designationLabel,
  designationList,
  normaliseAlternateDesignations,
  normaliseReplacements,
  replacementCountNotice,
} from './requisition-inputs';

describe('normaliseAlternateDesignations', () => {
  it('keeps the extra levels a post may be filled at', () => {
    expect(
      normaliseAlternateDesignations('Assistant Manager', [
        'Senior Executive',
        'Executive',
      ]),
    ).toEqual(['Senior Executive', 'Executive']);
  });

  it('drops the primary when it is repeated in the list', () => {
    // "Assistant Manager or Assistant Manager" on a signed sheet is nonsense.
    expect(
      normaliseAlternateDesignations('Assistant Manager', [
        'assistant manager',
        'Senior Executive',
      ]),
    ).toEqual(['Senior Executive']);
  });

  it('drops repeats within the list, ignoring case and padding', () => {
    expect(
      normaliseAlternateDesignations('Manager', [
        'Senior Executive',
        '  senior executive  ',
        '',
        '   ',
      ]),
    ).toEqual(['Senior Executive']);
  });

  it('is empty for a plain single-designation requisition', () => {
    expect(normaliseAlternateDesignations('Manager', undefined)).toEqual([]);
    expect(normaliseAlternateDesignations('Manager', null)).toEqual([]);
    expect(normaliseAlternateDesignations('Manager', [])).toEqual([]);
  });
});

describe('designationLabel', () => {
  it('reads primary first, joined for a sheet or a list', () => {
    expect(designationLabel('Senior Executive', ['Assistant Manager'])).toBe(
      'Senior Executive / Assistant Manager',
    );
    expect(designationList('Senior Executive', ['Assistant Manager'])).toEqual([
      'Senior Executive',
      'Assistant Manager',
    ]);
  });

  it('is just the designation when there are no alternates', () => {
    expect(designationLabel('Manager', [])).toBe('Manager');
  });
});

describe('normaliseReplacements', () => {
  it('keeps each leaver with their own reason and date', () => {
    const out = normaliseReplacements({
      replacements: [
        {
          employeeName: 'Employee One',
          employeeCode: '15106254',
          separationReason: 'Resigned',
          vacantDate: '2026-08-01',
        },
        {
          employeeName: 'Employee Two',
          employeeCode: '15107001',
          separationReason: 'Retired',
          vacantDate: '2026-09-15',
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].separationReason).toBe('Resigned');
    expect(out[1].separationReason).toBe('Retired');
    expect(out[0].vacantDate?.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(out.map((r) => r.orderIndex)).toEqual([0, 1]);
  });

  it('reads the old single fields when no list is sent', () => {
    // Older clients still post these; one code path must serve both.
    const out = normaliseReplacements({
      replaceOfName: 'Employee One',
      replaceOfEmployeeCode: '15106254',
      separationReason: 'Resigned',
      vacantDate: '2026-08-01',
      replacementRemarks: 'Seat held open',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      employeeName: 'Employee One',
      employeeCode: '15106254',
      separationReason: 'Resigned',
      remarks: 'Seat held open',
    });
  });

  it('drops nameless rows rather than storing blanks', () => {
    // A form that lets people add rows will be given empty ones.
    const out = normaliseReplacements({
      replacements: [
        { employeeName: '   ', separationReason: 'Resigned' },
        { employeeName: 'Employee One', separationReason: 'Resigned' },
        { employeeName: null },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].employeeName).toBe('Employee One');
  });

  it('counts the same person once — one seat, not two', () => {
    const out = normaliseReplacements({
      replacements: [
        { employeeName: 'Employee One', employeeCode: '15106254' },
        { employeeName: 'Employee One Renamed', employeeCode: '15106254' },
      ],
    });
    expect(out).toHaveLength(1);
  });

  it('identifies by name when there is no employee code', () => {
    const out = normaliseReplacements({
      replacements: [
        { employeeName: 'Employee One' },
        { employeeName: 'employee one' },
        { employeeName: 'Employee Two' },
      ],
    });
    expect(out.map((r) => r.employeeName)).toEqual([
      'Employee One',
      'Employee Two',
    ]);
  });

  it('never produces an Invalid Date from a bad vacancy date', () => {
    const out = normaliseReplacements({
      replacements: [
        { employeeName: 'Employee One', vacantDate: 'not a date' },
      ],
    });
    expect(out[0].vacantDate).toBeNull();
  });

  it('is empty when nothing was supplied at all', () => {
    expect(normaliseReplacements({})).toEqual([]);
  });
});

describe('replacementCountNotice', () => {
  it('says nothing when the counts agree', () => {
    expect(replacementCountNotice(3, 3)).toBeNull();
  });

  it('says nothing on a new headcount', () => {
    expect(replacementCountNotice(0, 2)).toBeNull();
  });

  it('names the direction when they differ', () => {
    expect(replacementCountNotice(3, 2)).toContain('headcount goes down by 1');
    expect(replacementCountNotice(1, 3)).toContain('headcount goes up by 2');
  });

  it('reads correctly for one person and one post', () => {
    expect(replacementCountNotice(1, 2)).toContain('1 person');
    expect(replacementCountNotice(2, 1)).toContain('1 post');
  });
});
