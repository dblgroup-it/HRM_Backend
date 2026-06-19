import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';

export interface AiConfig {
  /** Minimum CV match % (0-100) to auto-advance to AI Shortlisted. */
  shortlistThreshold: number;
  /** Auto-screen CVs in the background as they arrive. */
  autoScreen: boolean;
  /** Auto-generate the AI role profile when a requisition is fully approved. */
  autoRoleProfile: boolean;
  /** Auto-generate evaluation summary when interview modal is opened. */
  autoEvalSummary: boolean;
}

export interface NotificationConfig {
  /** Master switch — when false, no outgoing emails are sent regardless of user preferences. */
  emailEnabled: boolean;
}

const AI_KEY = 'ai';
const NOTIFICATION_KEY = 'notifications';

const DEFAULT_AI: AiConfig = {
  shortlistThreshold: 60,
  autoScreen: true,
  autoRoleProfile: false,
  autoEvalSummary: false,
};

const DEFAULT_NOTIFICATION: NotificationConfig = { emailEnabled: true };

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
      autoEvalSummary: v.autoEvalSummary ?? DEFAULT_AI.autoEvalSummary,
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
      autoEvalSummary: input.autoEvalSummary ?? current.autoEvalSummary,
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
    return { emailEnabled: v.emailEnabled ?? DEFAULT_NOTIFICATION.emailEnabled };
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
}
