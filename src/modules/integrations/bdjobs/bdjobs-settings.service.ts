import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';

const KEY = 'bdjobs';

/** Everything an admin can tune about the BDJobs integration. */
export interface BdJobsSettings {
  // --- connection ---
  enabled: boolean;
  baseUrl: string;
  companyId: string;
  authToken: string;
  decodeId: string;
  /** SHA-256 template — BDJobs' documented order (rarely changes). */
  signatureFormat: string;
  // --- posting defaults ---
  specialInstruction: string;
  otherBenefits: string;
  /** Days ahead to close applications (BDJobs hard-caps at 30). */
  deadlineDays: number;
  /** Send our own apply-page URL with the ad by default. */
  applyOnlineDefault: boolean;
  /** Public origin used to build the apply link (falls back to FRONTEND_URL). */
  publicApplyBaseUrl: string;
  /** Years of experience below which a job is Entry / Mid (else Top). */
  entryLevelMaxYears: number;
  midLevelMaxYears: number;
}

/** What the UI receives — secrets masked, never sent back in full. */
export type BdJobsSettingsView = Omit<
  BdJobsSettings,
  'authToken' | 'decodeId'
> & {
  authTokenMasked: string;
  decodeIdMasked: string;
  configured: boolean;
};

const mask = (v: string): string =>
  v ? `${v.slice(0, 4)}${'•'.repeat(Math.max(4, v.length - 4))}` : '';

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(n)));

/**
 * Keep only the origin — the per-requisition path (/apply/{id}) is appended
 * when a job is posted, so pasting a full apply link here must not double up.
 */
const normalizeApplyBase = (url: string): string =>
  url
    .trim()
    .replace(/\/apply(\/.*)?$/i, '')
    .replace(/\/+$/, '');

@Injectable()
export class BdJobsSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Effective settings: stored overrides on top of the .env defaults. */
  async get(): Promise<BdJobsSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
    const v = (row?.value as Partial<BdJobsSettings> | null) ?? {};
    return {
      enabled: v.enabled ?? true,
      baseUrl:
        v.baseUrl ||
        this.config.get<string>('bdjobs.baseUrl') ||
        'https://application.bdjobs.com/v1',
      companyId:
        v.companyId || this.config.get<string>('bdjobs.companyId') || '',
      authToken:
        v.authToken || this.config.get<string>('bdjobs.authToken') || '',
      decodeId: v.decodeId || this.config.get<string>('bdjobs.decodeId') || '',
      signatureFormat:
        v.signatureFormat ||
        this.config.get<string>('bdjobs.signatureFormat') ||
        '{token}&^^{decodeId}*&*{ts}',
      specialInstruction:
        v.specialInstruction ??
        'Apply with your updated CV. Only shortlisted candidates will be contacted.',
      otherBenefits: v.otherBenefits ?? 'As per company policy.',
      deadlineDays: clamp(v.deadlineDays ?? 29, 1, 30),
      applyOnlineDefault: v.applyOnlineDefault ?? true,
      publicApplyBaseUrl: v.publicApplyBaseUrl ?? '',
      entryLevelMaxYears: clamp(v.entryLevelMaxYears ?? 3, 0, 20),
      midLevelMaxYears: clamp(v.midLevelMaxYears ?? 8, 1, 30),
    };
  }

  /** Admin-facing view — credentials masked. */
  async getView(): Promise<BdJobsSettingsView> {
    const s = await this.get();
    const { authToken, decodeId, ...rest } = s;
    return {
      ...rest,
      authTokenMasked: mask(authToken),
      decodeIdMasked: mask(decodeId),
      configured: Boolean(authToken && decodeId && s.companyId),
    };
  }

  /**
   * Merge an update. Blank credential fields mean "keep the current secret" —
   * the UI never receives them, so it can't send them back.
   */
  async set(input: Partial<BdJobsSettings>): Promise<BdJobsSettingsView> {
    const current = await this.get();
    const merged: BdJobsSettings = {
      ...current,
      ...input,
      authToken: input.authToken?.trim() || current.authToken,
      decodeId: input.decodeId?.trim() || current.decodeId,
      publicApplyBaseUrl: normalizeApplyBase(
        input.publicApplyBaseUrl ?? current.publicApplyBaseUrl,
      ),
      deadlineDays: clamp(input.deadlineDays ?? current.deadlineDays, 1, 30),
      entryLevelMaxYears: clamp(
        input.entryLevelMaxYears ?? current.entryLevelMaxYears,
        0,
        20,
      ),
      midLevelMaxYears: clamp(
        input.midLevelMaxYears ?? current.midLevelMaxYears,
        1,
        30,
      ),
    };
    await this.prisma.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: merged as unknown as Prisma.InputJsonValue },
      update: { value: merged as unknown as Prisma.InputJsonValue },
    });
    return this.getView();
  }
}
