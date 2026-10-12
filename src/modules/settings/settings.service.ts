import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { parseEmailList } from '../../common/util/email-list';
import { PrismaService } from '../../prisma/prisma.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';

export interface AiConfig {
  /** Minimum CV match % (0-100) to auto-advance to AI Shortlisted. */
  shortlistThreshold: number;
  /** Auto-screen CVs in the background as they arrive. */
  autoScreen: boolean;
  /** Auto-generate the AI role profile when a requisition is fully approved. */
  autoRoleProfile: boolean;
}

export interface NotificationConfig {
  /** Master switch — when false, no outgoing emails are sent regardless of user preferences. */
  emailEnabled: boolean;
}

export interface ScreeningConfig {
  /** Minimum % of Written Test marks to pass (0-100). */
  writtenTestPassPct: number;
  /** Minimum % of Computer Literacy Test marks to pass (0-100). */
  computerTestPassPct: number;
  /** Minimum % of AI Proficiency Test marks to pass (0-100). */
  aiTestPassPct: number;
}

/**
 * "Notify IT" on onboarding's last step: where the request for a new hire's
 * work email goes, and how it is addressed. Kept here rather than in .env
 * because IT's mailbox changes and the administrator changes it on
 * Integrations, not the server.
 */
export interface ItRequestConfig {
  /** One or more IT addresses; the request goes to all of them. */
  recipients: string[];
  /** How the email opens: "Dear <salutation>,". */
  salutation: string;
  /** The platform new accounts are made on, unless HR picks another. */
  platform: string;
}

/** At most this many IT addresses — a request is for a desk, not a list. */
export const IT_REQUEST_MAX_RECIPIENTS = 5;

const AI_KEY = 'ai';
const NOTIFICATION_KEY = 'notifications';
const SCREENING_KEY = 'screening';
const IT_REQUEST_KEY = 'it_requests';

const DEFAULT_AI: AiConfig = {
  shortlistThreshold: 60,
  autoScreen: true,
  autoRoleProfile: false,
};

const DEFAULT_NOTIFICATION: NotificationConfig = { emailEnabled: true };

const DEFAULT_SCREENING: ScreeningConfig = {
  writtenTestPassPct: 50,
  computerTestPassPct: 50,
  aiTestPassPct: 50,
};

const DEFAULT_IT_REQUEST: ItRequestConfig = {
  recipients: ['hr-lt-req@dbl-group.com'],
  salutation: 'IT Team',
  platform: 'Google',
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(n)));

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiGraderService,
  ) {}

  /** Effective AI config (defaults merged with stored overrides). */
  async getAiConfig(): Promise<AiConfig> {
    const row = await this.prisma.setting.findUnique({
      where: { key: AI_KEY },
    });
    const v = (row?.value as Partial<AiConfig> | null) ?? {};
    return {
      shortlistThreshold: clamp(
        v.shortlistThreshold ?? DEFAULT_AI.shortlistThreshold,
        0,
        100,
      ),
      autoScreen: v.autoScreen ?? DEFAULT_AI.autoScreen,
      autoRoleProfile: v.autoRoleProfile ?? DEFAULT_AI.autoRoleProfile,
    };
  }

  /** AI config + read-only provider info for the settings screen. */
  async getAiConfigView() {
    const config = await this.getAiConfig();
    return {
      ...config,
      provider: this.ai.provider,
      configured: this.ai.isConfigured(),
    };
  }

  async setAiConfig(input: Partial<AiConfig>): Promise<AiConfig> {
    const current = await this.getAiConfig();
    const merged: AiConfig = {
      shortlistThreshold:
        input.shortlistThreshold !== undefined
          ? clamp(input.shortlistThreshold, 0, 100)
          : current.shortlistThreshold,
      autoScreen: input.autoScreen ?? current.autoScreen,
      autoRoleProfile: input.autoRoleProfile ?? current.autoRoleProfile,
    };
    await this.prisma.setting.upsert({
      where: { key: AI_KEY },
      create: {
        key: AI_KEY,
        value: merged as unknown as Prisma.InputJsonValue,
      },
      update: { value: merged as unknown as Prisma.InputJsonValue },
    });
    return merged;
  }

  async getNotificationConfig(): Promise<NotificationConfig> {
    const row = await this.prisma.setting.findUnique({
      where: { key: NOTIFICATION_KEY },
    });
    const v = (row?.value as Partial<NotificationConfig> | null) ?? {};
    return {
      emailEnabled: v.emailEnabled ?? DEFAULT_NOTIFICATION.emailEnabled,
    };
  }

  async setNotificationConfig(
    input: Partial<NotificationConfig>,
  ): Promise<NotificationConfig> {
    const current = await this.getNotificationConfig();
    const merged: NotificationConfig = {
      emailEnabled: input.emailEnabled ?? current.emailEnabled,
    };
    await this.prisma.setting.upsert({
      where: { key: NOTIFICATION_KEY },
      create: {
        key: NOTIFICATION_KEY,
        value: merged as unknown as Prisma.InputJsonValue,
      },
      update: { value: merged as unknown as Prisma.InputJsonValue },
    });
    return merged;
  }

  /** Effective screening config (defaults merged with stored overrides). */
  async getScreeningConfig(): Promise<ScreeningConfig> {
    const row = await this.prisma.setting.findUnique({
      where: { key: SCREENING_KEY },
    });
    const v = (row?.value as Partial<ScreeningConfig> | null) ?? {};
    return {
      writtenTestPassPct: clamp(
        v.writtenTestPassPct ?? DEFAULT_SCREENING.writtenTestPassPct,
        0,
        100,
      ),
      computerTestPassPct: clamp(
        v.computerTestPassPct ?? DEFAULT_SCREENING.computerTestPassPct,
        0,
        100,
      ),
      aiTestPassPct: clamp(
        v.aiTestPassPct ?? DEFAULT_SCREENING.aiTestPassPct,
        0,
        100,
      ),
    };
  }

  async setScreeningConfig(
    input: Partial<ScreeningConfig>,
  ): Promise<ScreeningConfig> {
    const current = await this.getScreeningConfig();
    const merged: ScreeningConfig = {
      writtenTestPassPct:
        input.writtenTestPassPct !== undefined
          ? clamp(input.writtenTestPassPct, 0, 100)
          : current.writtenTestPassPct,
      computerTestPassPct:
        input.computerTestPassPct !== undefined
          ? clamp(input.computerTestPassPct, 0, 100)
          : current.computerTestPassPct,
      aiTestPassPct:
        input.aiTestPassPct !== undefined
          ? clamp(input.aiTestPassPct, 0, 100)
          : current.aiTestPassPct,
    };
    await this.prisma.setting.upsert({
      where: { key: SCREENING_KEY },
      create: {
        key: SCREENING_KEY,
        value: merged as unknown as Prisma.InputJsonValue,
      },
      update: { value: merged as unknown as Prisma.InputJsonValue },
    });
    return merged;
  }

  /** Effective "Notify IT" config (defaults merged with stored overrides). */
  async getItRequestConfig(): Promise<ItRequestConfig> {
    const row = await this.prisma.setting.findUnique({
      where: { key: IT_REQUEST_KEY },
    });
    const v = (row?.value as Partial<ItRequestConfig> | null) ?? {};
    const recipients = Array.isArray(v.recipients)
      ? parseEmailList(v.recipients.join(',')).valid
      : [];
    return {
      recipients: recipients.length
        ? recipients
        : DEFAULT_IT_REQUEST.recipients,
      salutation: v.salutation?.trim() || DEFAULT_IT_REQUEST.salutation,
      platform: v.platform?.trim() || DEFAULT_IT_REQUEST.platform,
    };
  }

  /**
   * Change it. `recipients` arrives as the box was typed — "a@x, b@x" — and
   * is refused, naming the culprit, if anything in it is not an address.
   */
  async setItRequestConfig(input: {
    recipients?: string;
    salutation?: string;
    platform?: string;
  }): Promise<ItRequestConfig> {
    const current = await this.getItRequestConfig();
    let recipients = current.recipients;
    if (input.recipients !== undefined) {
      const { valid, invalid } = parseEmailList(input.recipients);
      if (invalid.length) {
        throw new BadRequestException(
          `Not an email address: ${invalid.join(', ')}`,
        );
      }
      if (!valid.length) {
        throw new BadRequestException('Enter at least one IT email address.');
      }
      if (valid.length > IT_REQUEST_MAX_RECIPIENTS) {
        throw new BadRequestException(
          `At most ${IT_REQUEST_MAX_RECIPIENTS} addresses.`,
        );
      }
      recipients = valid;
    }
    const merged: ItRequestConfig = {
      recipients,
      salutation: input.salutation?.trim() || current.salutation,
      platform: input.platform?.trim() || current.platform,
    };
    await this.prisma.setting.upsert({
      where: { key: IT_REQUEST_KEY },
      create: {
        key: IT_REQUEST_KEY,
        value: merged as unknown as Prisma.InputJsonValue,
      },
      update: { value: merged as unknown as Prisma.InputJsonValue },
    });
    return merged;
  }
}
