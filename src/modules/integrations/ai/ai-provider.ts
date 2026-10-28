/**
 * Which AI answers, and in what order. Decorator-free so a test can import it.
 *
 * Two providers, Claude and Gemini. The administrator picks one on
 * Integrations › AI provider and gives each its own API key; with fallback on,
 * a request the chosen provider fails (error, refusal, empty answer) is put to
 * the other one, so a provider outage does not stop CV screening.
 */

export type AiProviderName = 'claude' | 'gemini';

export const AI_PROVIDERS: readonly AiProviderName[] = ['claude', 'gemini'];

/** Offered on the page; the first is the default. */
export const CLAUDE_MODELS: readonly { id: string; label: string }[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, lowest cost' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — most capable' },
];

export const GEMINI_MODELS: readonly { id: string; label: string }[] = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
];

export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0].id;
export const DEFAULT_GEMINI_MODEL = GEMINI_MODELS[0].id;

export const CLAUDE_MODEL_PATTERN = /^claude-[a-z0-9.-]{2,60}$/;
export const GEMINI_MODEL_PATTERN = /^gemini-[a-z0-9.-]{2,60}$/;

export const otherProvider = (p: AiProviderName): AiProviderName =>
  p === 'claude' ? 'gemini' : 'claude';

export const isProviderName = (v: unknown): v is AiProviderName =>
  v === 'claude' || v === 'gemini';

/**
 * The providers to try, in order: the chosen one if it has a key, then — with
 * fallback on — the other if it has one. Fallback off and no key for the
 * chosen provider means no AI at all, not a quiet switch to the other one.
 */
export function providerOrder(
  primary: AiProviderName,
  fallback: boolean,
  hasKey: Record<AiProviderName, boolean>,
): AiProviderName[] {
  const order: AiProviderName[] = [];
  if (hasKey[primary]) order.push(primary);
  const other = otherProvider(primary);
  if (fallback && hasKey[other]) order.push(other);
  return order;
}

/** What the page shows for a saved key: never the key, only its last four. */
export const keyHint = (key: string): string =>
  key.length > 8 ? `…${key.slice(-4)}` : '••••';

/**
 * The answer in a Claude response: its text blocks, in order. Current models
 * think by default, so the first block is often a `thinking` block — reading
 * `content[0].text` returned an empty answer.
 */
export const claudeAnswer = (
  content: readonly { type: string; text?: string }[],
): string =>
  content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

/**
 * Whether a Claude model takes `output_config.effort`. The 4.6-and-later and
 * 5.x families do; Haiku 4.5 and older reject it.
 */
export const claudeTakesEffort = (model: string): boolean =>
  /^claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[6-9])/.test(model);
