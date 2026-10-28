import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { SecretEncryptionService } from '../../../common/crypto/secret-encryption.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AiProviderName,
  CLAUDE_MODEL_PATTERN,
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_PATTERN,
  GEMINI_MODELS,
  isProviderName,
  keyHint,
  providerOrder,
} from './ai-provider';

const SETTING_KEY = 'ai_provider';

/** As stored in `settings`: keys only ever encrypted. */
interface StoredAiProvider {
  provider?: AiProviderName;
  fallback?: boolean;
  claude?: { model?: string; key?: string | null };
  gemini?: { model?: string; key?: string | null };
}

export interface ProviderRuntime {
  model: string;
  apiKey: string;
  /** Where the key came from: saved on Integrations, `.env`, or nowhere. */
  keySource: 'settings' | 'env' | null;
}

export interface AiRuntimeConfig {
  provider: AiProviderName;
  fallback: boolean;
  claude: ProviderRuntime;
  gemini: ProviderRuntime;
}

export interface AiProviderView {
  provider: AiProviderName;
  fallback: boolean;
  /** The order requests are tried in right now; empty = AI is off. */
  order: AiProviderName[];
  claude: ProviderView;
  gemini: ProviderView;
}

interface ProviderView {
  model: string;
  models: { id: string; label: string }[];
  hasKey: boolean;
  keySource: 'settings' | 'env' | null;
  /** The last four characters of the key in use, never the key. */
  keyHint: string | null;
}

export interface AiProviderUpdate {
  provider?: AiProviderName;
  fallback?: boolean;
  claudeModel?: string;
  geminiModel?: string;
  /** A new key; an empty string removes the saved one. Omitted = unchanged. */
  claudeKey?: string;
  geminiKey?: string;
}

/**
 * The AI provider settings: which provider answers first, each provider's
 * model and API key, and whether the other one takes over on a failure.
 *
 * Saved on Integrations (settings key `ai_provider`); anything not saved there
 * comes from `.env` (`AI_PROVIDER`, `ANTHROPIC_*`, `GEMINI_*`), so a server
 * configured the old way keeps working untouched. Keys are encrypted with
 * `SecretEncryptionService` and are never sent back to the page.
 *
 * The grader asks on every request, synchronously, so the resolved settings
 * are held in memory: loaded at boot and replaced on every save. Production
 * runs a single API process, so a save is seen at once.
 */
@Injectable()
export class AiProviderConfigService implements OnModuleInit {
  private readonly logger = new Logger(AiProviderConfigService.name);
  private snapshot: AiRuntimeConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly secrets: SecretEncryptionService,
  ) {
    this.snapshot = this.resolve(null);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.reload();
    } catch (e) {
      this.logger.warn(
        `AI provider settings could not be read; using .env: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  get current(): AiRuntimeConfig {
    return this.snapshot;
  }

  /** The providers to try, in order. Empty when AI is not configured. */
  order(): AiProviderName[] {
    const s = this.snapshot;
    return providerOrder(s.provider, s.fallback, {
      claude: Boolean(s.claude.apiKey),
      gemini: Boolean(s.gemini.apiKey),
    });
  }

  view(): AiProviderView {
    const s = this.snapshot;
    const one = (
      r: ProviderRuntime,
      models: readonly { id: string; label: string }[],
    ): ProviderView => ({
      model: r.model,
      // the model in use stays in the list even if it is not one we offer
      models: models.some((m) => m.id === r.model)
        ? [...models]
        : [...models, { id: r.model, label: r.model }],
      hasKey: Boolean(r.apiKey),
      keySource: r.keySource,
      keyHint: r.apiKey ? keyHint(r.apiKey) : null,
    });
    return {
      provider: s.provider,
      fallback: s.fallback,
      order: this.order(),
      claude: one(s.claude, CLAUDE_MODELS),
      gemini: one(s.gemini, GEMINI_MODELS),
    };
  }

  async update(input: AiProviderUpdate): Promise<AiProviderView> {
    if (input.claudeModel && !CLAUDE_MODEL_PATTERN.test(input.claudeModel)) {
      throw new BadRequestException('That is not a Claude model name.');
    }
    if (input.geminiModel && !GEMINI_MODEL_PATTERN.test(input.geminiModel)) {
      throw new BadRequestException('That is not a Gemini model name.');
    }
    const stored = await this.readStored();
    const next: StoredAiProvider = {
      provider: input.provider ?? stored.provider,
      fallback: input.fallback ?? stored.fallback,
      claude: {
        model: input.claudeModel ?? stored.claude?.model,
        key: this.nextKey(input.claudeKey, stored.claude?.key),
      },
      gemini: {
        model: input.geminiModel ?? stored.gemini?.model,
        key: this.nextKey(input.geminiKey, stored.gemini?.key),
      },
    };
    await this.prisma.setting.upsert({
      where: { key: SETTING_KEY },
      create: {
        key: SETTING_KEY,
        value: next as unknown as Prisma.InputJsonValue,
      },
      update: { value: next as unknown as Prisma.InputJsonValue },
    });
    this.snapshot = this.resolve(next);
    return this.view();
  }

  async reload(): Promise<void> {
    this.snapshot = this.resolve(await this.readStored());
  }

  private async readStored(): Promise<StoredAiProvider> {
    const row = await this.prisma.setting.findUnique({
      where: { key: SETTING_KEY },
    });
    return (row?.value as StoredAiProvider | null) ?? {};
  }

  private nextKey(
    typed: string | undefined,
    current: string | null | undefined,
  ): string | null {
    if (typed === undefined) return current ?? null;
    const key = typed.trim();
    if (!key) return null;
    if (/\s/.test(key)) {
      throw new BadRequestException(
        'An API key has no spaces — paste only the key.',
      );
    }
    return this.secrets.encrypt(key);
  }

  private resolve(stored: StoredAiProvider | null): AiRuntimeConfig {
    const env = (k: string) => this.config.get<string>(k) ?? '';
    const envProvider = env('ai.provider').toLowerCase();
    const provider = isProviderName(stored?.provider)
      ? stored.provider
      : isProviderName(envProvider)
        ? envProvider
        : 'gemini';
    return {
      provider,
      fallback: stored?.fallback ?? true,
      claude: this.runtime(
        stored?.claude,
        env('ai.anthropic.apiKey'),
        env('ai.anthropic.model') || DEFAULT_CLAUDE_MODEL,
      ),
      gemini: this.runtime(
        stored?.gemini,
        env('ai.gemini.apiKey'),
        env('ai.gemini.model') || DEFAULT_GEMINI_MODEL,
      ),
    };
  }

  private runtime(
    stored: { model?: string; key?: string | null } | undefined,
    envKey: string,
    envModel: string,
  ): ProviderRuntime {
    let saved = '';
    if (stored?.key) {
      try {
        saved = this.secrets.decrypt(stored.key);
      } catch {
        // the encryption key changed: the saved key is unreadable — say so,
        // and fall back to .env rather than sending a garbled key
        this.logger.warn(
          'A saved AI API key could not be decrypted; re-enter it on Integrations.',
        );
      }
    }
    return {
      model: stored?.model || envModel,
      apiKey: saved || envKey,
      keySource: saved ? 'settings' : envKey ? 'env' : null,
    };
  }
}
