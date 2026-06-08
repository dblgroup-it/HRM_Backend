import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import axios from 'axios';
import * as bcrypt from 'bcryptjs';
import { Prisma, SyncLog } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { ZING_ATTR, ZingHrEmployee, ZingHrResponse } from './zinghr.types';

const SYNC_PATH = '/2015/route/EmployeeDetails/GetEmployeeMasterDetails';
const ALLOWED_STATUS = new Set(['Existing', 'NewJoinee']);
// Lower cost factor — these are low-risk default passwords; speeds up big runs.
const SALT_ROUNDS = 8;
const PROGRESS_EVERY = 50;

@Injectable()
export class ZingHrService implements OnModuleInit {
  private readonly logger = new Logger(ZingHrService.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>('zinghr.syncEnabled', true);
    const expression = this.config.get<string>(
      'zinghr.syncCron',
      '36 20 * * *',
    );
    if (!enabled) {
      this.logger.warn('ZingHR scheduled sync is disabled');
      return;
    }
    const job = new CronJob(expression, () => {
      void this.startSync();
    });
    this.scheduler.addCronJob('zinghr-sync', job);
    job.start();
    this.logger.log(`ZingHR daily sync scheduled (cron: ${expression})`);
  }

  /**
   * Kick off a sync in the background and return the run record immediately,
   * so the UI can poll its live progress. If one is already running, the
   * current run is returned instead of starting a second.
   */
  async startSync(): Promise<SyncLog> {
    if (this.running) {
      const current = await this.prisma.syncLog.findFirst({
        where: { status: 'running' },
        orderBy: { startedAt: 'desc' },
      });
      if (current) return current;
    }
    this.running = true;
    const log = await this.prisma.syncLog.create({
      data: { source: 'zinghr', status: 'running', logs: [] },
    });

    // Fire-and-forget — progress is written to the SyncLog row as it goes.
    void this.runSync(log.id)
      .catch((e) => this.logger.error('ZingHR sync crashed', e as Error))
      .finally(() => {
        this.running = false;
      });

    return log;
  }

  /** Latest run (running or finished) — the UI polls this for live progress. */
  getStatus(): Promise<SyncLog | null> {
    return this.prisma.syncLog.findFirst({ orderBy: { startedAt: 'desc' } });
  }

  getLogs(take = 20): Promise<SyncLog[]> {
    return this.prisma.syncLog.findMany({
      orderBy: { startedAt: 'desc' },
      take,
    });
  }

  // --- worker -------------------------------------------------------------

  private async runSync(logId: string): Promise<void> {
    const prefix = this.config.get<string>('zinghr.employeeCodePrefix', '151');
    const startedMs = Date.now();

    // Rolling buffer — keep the most recent lines so the UI tails the run
    // like a terminal without storing one line per employee.
    const MAX_LINES = 300;
    const lines: string[] = [];
    const log = (line: string): void => {
      const ts = new Date().toISOString().slice(11, 19);
      lines.push(`[${ts}] ${line}`);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    };

    let total = 0;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let errorLines = 0;

    const persist = (extra: Record<string, unknown> = {}) =>
      this.prisma.syncLog.update({
        where: { id: logId },
        data: {
          total,
          processed,
          inserted,
          updated,
          skipped,
          failed,
          logs: lines,
          ...extra,
        },
      });

    log('▶ ZingHR sync started');
    log(`⬇ Fetching employee master from ZingHR (prefix "${prefix}")…`);
    await persist();

    try {
      const employees = await this.fetchEmployees();
      total = employees.length;
      log(`✓ Fetched ${total.toLocaleString()} records`);
      log('⚙ Processing…');
      await persist();

      // Preload existing users + units to avoid per-row lookups.
      const [users, units] = await Promise.all([
        this.prisma.user.findMany({ select: { id: true, employeeCode: true } }),
        this.prisma.unit.findMany({ select: { id: true, name: true } }),
      ]);
      const userMap = new Map(users.map((u) => [u.employeeCode, u.id]));
      const unitMap = new Map(
        units.map((u) => [u.name.toLowerCase(), u.id] as const),
      );

      for (const raw of employees) {
        processed++;
        try {
          if (
            !raw.EmployeeCode?.startsWith(prefix) ||
            !ALLOWED_STATUS.has(raw.EmployeeStatus)
          ) {
            skipped++;
          } else {
            const r = await this.upsertEmployee(raw, userMap, unitMap);
            if (r.isNew) inserted++;
            else updated++;
            // Stream the raw employee detail line.
            const tag = r.isNew ? '＋ NEW ' : '~ upd ';
            log(
              `${tag} ${raw.EmployeeCode}  ${displayName(raw)}  ·  ` +
                `${r.designation ?? '—'}  ·  ${r.department ?? '—'}  ·  ` +
                `${r.unitName ?? '—'}  ·  ${raw.EmployeeStatus}`,
            );
          }
        } catch (e) {
          failed++;
          if (errorLines < 50) {
            errorLines++;
            log(`✗ ${raw.EmployeeCode} failed: ${(e as Error).message}`);
          }
        }

        if (processed % PROGRESS_EVERY === 0) await persist();
      }

      const secs = ((Date.now() - startedMs) / 1000).toFixed(1);
      log(
        `✅ Done in ${secs}s — inserted ${inserted}, updated ${updated}, skipped ${skipped}, failed ${failed}`,
      );
      await persist({ status: 'success', finishedAt: new Date() });
      this.logger.log(
        `ZingHR sync done — inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}, failed: ${failed}`,
      );
    } catch (e) {
      log(`❌ Sync failed: ${(e as Error).message}`);
      await persist({
        status: 'failed',
        message: (e as Error).message,
        finishedAt: new Date(),
      });
      throw e;
    }
  }

  private async fetchEmployees(): Promise<ZingHrEmployee[]> {
    const cfg = this.config.get<{
      baseUrl: string;
      subscriptionName: string;
      token: string;
    }>('zinghr')!;

    const body = {
      SubscriptionName: cfg.subscriptionName,
      Token: cfg.token,
      PageSize: '20000',
      PageNumber: '1',
      Fromdate: '01-01-1990',
      Todate: formatZingDate(new Date()),
      EmpFlag: '',
    };

    const { data } = await axios.post<ZingHrResponse>(
      `${cfg.baseUrl}${SYNC_PATH}`,
      body,
      { headers: { 'Content-Type': 'application/json' }, timeout: 180_000 },
    );
    return data?.Employees ?? [];
  }

  /**
   * Upsert one employee. Existing employees have their profile refreshed with
   * the latest ZingHR data. Returns whether it was a new user plus a few
   * fields for the live log.
   */
  private async upsertEmployee(
    raw: ZingHrEmployee,
    userMap: Map<string, string>,
    unitMap: Map<string, string>,
  ): Promise<{
    isNew: boolean;
    designation: string | null;
    department: string | null;
    unitName: string | null;
  }> {
    const attr = (id: string): string | null =>
      raw.Attributes?.find((a) => a.AttributeTypeID === id)
        ?.AttributeTypeUnitDesc ?? null;

    const employeeCode = raw.EmployeeCode;
    const name = `${raw.FirstName ?? ''} ${raw.LastName ?? ''}`.trim();
    const unitName = attr(ZING_ATTR.PAYROLL_UNIT);
    const designation = attr(ZING_ATTR.DESIGNATION);
    const department = attr(ZING_ATTR.DEPARTMENT);

    const existingId = userMap.get(employeeCode);
    let userId: string;
    let isNew = false;

    if (existingId) {
      await this.prisma.user.update({
        where: { id: existingId },
        data: { name, email: raw.Email, phone: raw.Mobile },
      });
      userId = existingId;
    } else {
      const user = await this.prisma.user.create({
        data: {
          employeeCode,
          name,
          email: raw.Email,
          phone: raw.Mobile,
          passwordHash: await bcrypt.hash(employeeCode, SALT_ROUNDS),
          role: 'MANAGEMENT',
        },
      });
      userId = user.id;
      userMap.set(employeeCode, userId);
      isNew = true;
    }

    // Resolve (and cache) the unit by name.
    let unitId: string | null = null;
    if (unitName) {
      const key = unitName.toLowerCase();
      unitId = unitMap.get(key) ?? null;
      if (!unitId) {
        const unit = await this.prisma.unit.create({ data: { name: unitName } });
        unitId = unit.id;
        unitMap.set(key, unitId);
      }
    }

    const profile = {
      employeeCode,
      designation,
      department,
      section: attr(ZING_ATTR.SECTION),
      grade: attr(ZING_ATTR.GRADE),
      category: attr(ZING_ATTR.CATEGORY),
      unitName,
      unitId,
      location: attr(ZING_ATTR.LOCATION),
      gender: raw.Gender,
      dateOfBirth: parseZingDate(raw.DateofBirth),
      joiningDate: parseZingDate(raw.DateofJoining),
      exitDate: parseZingDate(raw.ExitDate),
      lineManagerName: raw.ReportingManagerName,
      lineManagerCode: raw.ReportingManagerCode,
      source: 'ZINGHR' as const,
    } satisfies Prisma.EmployeeUncheckedUpdateInput;

    await this.prisma.employee.upsert({
      where: { userId },
      update: profile,
      create: { userId, ...profile },
    });

    return { isNew, designation, department, unitName };
  }
}

function displayName(raw: ZingHrEmployee): string {
  return `${raw.FirstName ?? ''} ${raw.LastName ?? ''}`.trim() || '(no name)';
}

/** ZingHR expects/returns dates as DD-MM-YYYY (and sometimes .NET /Date()/). */
function formatZingDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${date.getFullYear()}`;
}

function parseZingDate(value: string | null): Date | null {
  if (!value) return null;

  const dotNet = /\/Date\((\d+)\)\//.exec(value);
  if (dotNet) return new Date(Number(dotNet[1]));

  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(value.trim());
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
