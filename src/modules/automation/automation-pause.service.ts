import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export const AUTOMATION_JOBS = ['ingest', 'nudges', 'backup'] as const;
export type AutomationJob = (typeof AUTOMATION_JOBS)[number];

const KEY = 'automation_pause';
/** Sentinel for "off until someone turns it back on". */
const INDEFINITE = 'indefinite';

export interface JobPauseState {
  paused: boolean;
  /** ISO timestamp the pause ends, or null when indefinite / not paused. */
  pausedUntil: string | null;
  indefinite: boolean;
}

/**
 * Per-job pause switch for the scheduled automations, stored in Settings so it
 * survives restarts. A dated pause expires by itself; "Run now" always works.
 */
@Injectable()
export class AutomationPauseService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll(): Promise<Record<AutomationJob, JobPauseState>> {
    const stored = await this.read();
    const out = {} as Record<AutomationJob, JobPauseState>;
    for (const job of AUTOMATION_JOBS) out[job] = this.stateOf(stored[job]);
    return out;
  }

  async isPaused(job: AutomationJob): Promise<boolean> {
    const stored = await this.read();
    return this.stateOf(stored[job]).paused;
  }

  /** Pause for N days, or indefinitely when no duration is given. */
  async pause(job: AutomationJob, days?: number): Promise<JobPauseState> {
    this.assertJob(job);
    if (
      days !== undefined &&
      (!Number.isInteger(days) || days < 1 || days > 365)
    ) {
      throw new BadRequestException('days must be between 1 and 365');
    }
    const value =
      days === undefined
        ? INDEFINITE
        : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await this.write(job, value);
    return this.stateOf(value);
  }

  async resume(job: AutomationJob): Promise<JobPauseState> {
    this.assertJob(job);
    await this.write(job, null);
    return this.stateOf(null);
  }

  assertJob(job: string): asserts job is AutomationJob {
    if (!AUTOMATION_JOBS.includes(job as AutomationJob)) {
      throw new BadRequestException(`Unknown automation "${job}"`);
    }
  }

  private stateOf(value: string | null | undefined): JobPauseState {
    if (!value) return { paused: false, pausedUntil: null, indefinite: false };
    if (value === INDEFINITE) {
      return { paused: true, pausedUntil: null, indefinite: true };
    }
    const until = new Date(value);
    const active = until.getTime() > Date.now();
    return {
      paused: active,
      pausedUntil: active ? until.toISOString() : null,
      indefinite: false,
    };
  }

  private async read(): Promise<Partial<Record<AutomationJob, string | null>>> {
    const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
    return (row?.value as Partial<Record<AutomationJob, string | null>>) ?? {};
  }

  private async write(job: AutomationJob, value: string | null): Promise<void> {
    const current = await this.read();
    const next = { ...current, [job]: value } as Prisma.InputJsonValue;
    await this.prisma.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: next },
      update: { value: next },
    });
  }
}
