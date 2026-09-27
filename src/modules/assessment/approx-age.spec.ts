import { estimateAge, levelOf } from './approx-age';

const NOW = new Date('2026-09-27T06:00:00Z');

describe('approximate age from SSC / HSC', () => {
  it('reads the level however it is written', () => {
    for (const d of ['SSC', 'S.S.C', 'S.S.C.', 'S S C', 'Secondary School Certificate', 'Dakhil', 'O Level'])
      expect(levelOf(d)).toBe('SSC');
    for (const d of ['HSC', 'H.S.C.', 'Higher Secondary Certificate', 'Higher Secondary School Certificate', 'Alim', 'A-Levels'])
      expect(levelOf(d)).toBe('HSC');
    for (const d of ['BSc', 'MBA', 'Diploma in Engineering', 'BBA (Hons)', ''])
      expect(levelOf(d)).toBeNull();
  });

  it('takes SSC at 16', () => {
    expect(estimateAge([{ degree: 'SSC', passYear: 2012 }], NOW)).toEqual({
      age: 30,
      basis: 'SSC',
      year: 2012,
    });
  });

  it('takes HSC at 18 when there is no SSC', () => {
    expect(estimateAge([{ degree: 'HSC', passYear: 2014 }, { degree: 'BSc', passYear: 2018 }], NOW)).toEqual({
      age: 30,
      basis: 'HSC',
      year: 2014,
    });
  });

  it('prefers SSC when both are there', () => {
    expect(
      estimateAge([{ degree: 'HSC', passYear: 2014 }, { degree: 'S.S.C', passYear: 2011 }], NOW)?.basis,
    ).toBe('SSC');
  });

  it('gives nothing without a school-leaving year it can trust', () => {
    expect(estimateAge([{ degree: 'MBA', passYear: 2018 }], NOW)).toBeNull();
    expect(estimateAge([{ degree: 'SSC', passYear: undefined }], NOW)).toBeNull();
    expect(estimateAge([{ degree: 'SSC', passYear: 2031 }], NOW)).toBeNull();
    expect(estimateAge([], NOW)).toBeNull();
  });
});
