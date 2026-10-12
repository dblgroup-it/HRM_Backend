import { isEmailAddress, parseEmailList } from './email-list';

describe('parseEmailList', () => {
  it('reads one address', () => {
    expect(parseEmailList('hr-lt-req@dbl-group.com')).toEqual({
      valid: ['hr-lt-req@dbl-group.com'],
      invalid: [],
    });
  });

  it('splits on commas, semicolons, spaces and new lines', () => {
    expect(
      parseEmailList(
        'a@dbl-group.com, b@dbl-group.com;c@dbl-group.com\nd@dbl-group.com',
      ).valid,
    ).toEqual([
      'a@dbl-group.com',
      'b@dbl-group.com',
      'c@dbl-group.com',
      'd@dbl-group.com',
    ]);
  });

  it('drops duplicates case-insensitively, keeping the first spelling', () => {
    expect(parseEmailList('IT@dbl-group.com, it@dbl-group.com').valid).toEqual([
      'IT@dbl-group.com',
    ]);
  });

  it('names what is not an address instead of refusing everything', () => {
    expect(parseEmailList('it@dbl-group.com, helpdesk, x@y')).toEqual({
      valid: ['it@dbl-group.com'],
      invalid: ['helpdesk', 'x@y'],
    });
  });

  it('treats empty input as an empty list', () => {
    expect(parseEmailList('')).toEqual({ valid: [], invalid: [] });
    expect(parseEmailList(null)).toEqual({ valid: [], invalid: [] });
    expect(parseEmailList(' , ; ')).toEqual({ valid: [], invalid: [] });
  });
});

describe('isEmailAddress', () => {
  it.each([
    ['quality.accesories@glory-dbl.com', true],
    ['rasel.rana@dbl-group.com', true],
    ['  padded@dbl-group.com  ', true],
    ['no-at-sign.com', false],
    ['two@@dbl-group.com', false],
    ['nodot@localhost', false],
    ['', false],
  ])('%s → %s', (value, expected) => {
    expect(isEmailAddress(value)).toBe(expected);
  });
});
