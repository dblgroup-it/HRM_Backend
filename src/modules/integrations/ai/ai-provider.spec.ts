import {
  claudeAnswer,
  claudeTakesEffort,
  keyHint,
  providerOrder,
} from './ai-provider';

describe('providerOrder', () => {
  const both = { claude: true, gemini: true };

  it('tries the chosen provider, then the other when fallback is on', () => {
    expect(providerOrder('claude', true, both)).toEqual(['claude', 'gemini']);
    expect(providerOrder('gemini', true, both)).toEqual(['gemini', 'claude']);
  });

  it('tries only the chosen provider when fallback is off', () => {
    expect(providerOrder('claude', false, both)).toEqual(['claude']);
  });

  it('skips a provider with no key', () => {
    expect(
      providerOrder('claude', true, { claude: false, gemini: true }),
    ).toEqual(['gemini']);
    expect(
      providerOrder('claude', true, { claude: true, gemini: false }),
    ).toEqual(['claude']);
  });

  it('does not quietly switch providers when fallback is off and the chosen one has no key', () => {
    expect(
      providerOrder('claude', false, { claude: false, gemini: true }),
    ).toEqual([]);
  });

  it('is empty — AI off — with no keys at all', () => {
    expect(
      providerOrder('gemini', true, { claude: false, gemini: false }),
    ).toEqual([]);
  });
});

describe('claudeAnswer', () => {
  it('reads the text blocks, not the first block — current models think first', () => {
    expect(
      claudeAnswer([
        { type: 'thinking', text: undefined },
        { type: 'text', text: '{"score":' },
        { type: 'text', text: '7}' },
      ]),
    ).toBe('{"score":7}');
  });

  it('is empty when there is no text block (thinking used the whole budget)', () => {
    expect(claudeAnswer([{ type: 'thinking' }])).toBe('');
  });
});

describe('claudeTakesEffort', () => {
  it('sends effort to the 4.6+ and 5.x models only', () => {
    expect(claudeTakesEffort('claude-haiku-5-5')).toBe(true);
    expect(claudeTakesEffort('claude-opus-5-5')).toBe(true);
    expect(claudeTakesEffort('claude-sonnet-4-6')).toBe(true);
    expect(claudeTakesEffort('claude-haiku-4-5-20251001')).toBe(false);
  });
});

describe('keyHint', () => {
  it('shows only the last four characters', () => {
    expect(keyHint('sk-ant-api03-abcdefghijklWXYZ')).toBe('…WXYZ');
    expect(keyHint('short')).toBe('••••');
  });
});
