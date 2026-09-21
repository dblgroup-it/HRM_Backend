import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import axios from 'axios';
import * as bcrypt from 'bcryptjs';
import { Prisma, SyncLog } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import {
  runWithContext,
  systemContext,
} from '../../../common/context/request-context';
import { normalizeUnitName } from '../../../common/util/normalize-unit';
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
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Heal orphaned runs: a sync that was "running" when the process stopped
    // (crash / redeploy / dev reload) can never finish, yet it would otherwise
    // freeze the live-status console forever. On a fresh boot nothing is
    // actually running, so close any such rows out as interrupted.
    const healed = await this.prisma.syncLog.updateMany({
      where: { status: 'running' },
      data: {
        status: 'failed',
        message: 'Interrupted — the server restarted before the sync finished.',
        finishedAt: new Date(),
      },
    });
    if (healed.count > 0) {
      this.logger.warn(
        `Cleared ${healed.count} interrupted ZingHR sync run(s) from a previous restart`,
      );
    }

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

  /**
   * The sync writes thousands of User and Employee rows per run, so it runs
   * inside a system context with database-level auditing switched off and
   * accounts for itself with a single summary entry at the end.
   */
  private async runSync(logId: string): Promise<void> {
    return runWithContext(
      { ...systemContext('ZingHR sync'), suppressDbAudit: true },
      () => this.runSyncInner(logId),
    );
  }

  private async runSyncInner(logId: string): Promise<void> {
    const prefix = this.config.get<string>('zinghr.employeeCodePrefix', '151');
    const startedMs = Date.now();

    // Rolling buffer — keep the most recent lines so the UI tails the run
    // like a terminal without storing one line per employee.
    const MAX_LINES = 300;
    const lines: string[] = [];
    const log = (line: string): void => {
      const ts = new Date().toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Dhaka',
        hour12: false,
      });
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
      // Keyed by the normalized name so "X Ltd." reuses an existing "X Ltd"
      // unit instead of creating a duplicate.
      const unitMap = new Map(
        units.map(
          (u) =>
            [normalizeUnitName(u.name), { id: u.id, name: u.name }] as const,
        ),
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
      // One audit row for the whole run. Logging each employee write would add
      // ~4,400 rows a night and bury the ~50 things a person actually did.
      await this.audit.record({
        action: 'synced',
        entity: 'Employee',
        summary: `ZingHR sync — ${processed} read, ${inserted} created, ${updated} updated, ${skipped} skipped${failed ? `, ${failed} failed` : ''}`,
        changes: [
          { field: 'read', from: null, to: processed },
          { field: 'created', from: null, to: inserted },
          { field: 'updated', from: null, to: updated },
          { field: 'skipped', from: null, to: skipped },
          { field: 'failed', from: null, to: failed },
        ],
        source: 'system',
      });
      this.logger.log(
        `ZingHR sync done — inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}, failed: ${failed}`,
      );
    } catch (e) {
      log(`❌ Sync failed: ${(e as Error).message}`);
      await this.audit.record({
        action: 'sync failed',
        entity: 'Employee',
        summary: `ZingHR sync failed — ${(e as Error).message}`,
        source: 'system',
      });
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
    unitMap: Map<string, { id: string; name: string }>,
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

    // Resolve the unit by NORMALIZED name — reuse a configured unit if one
    // matches (so "X Ltd." aligns to "X Ltd"), and store its canonical name
    // so employees and role-assignment units share the same representation.
    let unitId: string | null = null;
    let canonicalUnitName: string | null = unitName?.trim() || null;
    if (canonicalUnitName) {
      const key = normalizeUnitName(canonicalUnitName);
      const existing = unitMap.get(key);
      if (existing) {
        unitId = existing.id;
        canonicalUnitName = existing.name;
      } else {
        const unit = await this.prisma.unit.create({
          data: { name: canonicalUnitName },
        });
        unitId = unit.id;
        canonicalUnitName = unit.name;
        unitMap.set(key, { id: unit.id, name: unit.name });
      }
    }

    const profile = {
      employeeCode,
      designation,
      department,
      section: attr(ZING_ATTR.SECTION),
      grade: attr(ZING_ATTR.GRADE),
      category: attr(ZING_ATTR.CATEGORY),
      unitName: canonicalUnitName,
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

    return { isNew, designation, department, unitName: canonicalUnitName };
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

/**
 * A ZingHR date, as the calendar day it names — never shifted by a timezone.
 *
 * `dateOfBirth` and `joiningDate` are `@db.Date`: a calendar day, no time, no
 * zone. Every branch below therefore ends at `utcMidnight`, because a `Date`
 * built at LOCAL midnight is 18:00Z the previous day in Dhaka (+6), and
 * Postgres then stores the DATE one day early.
 *
 * ZingHR sends `"15 Feb 2024"` — a bare day, no time and no zone. That is the
 * only form the live payload contains (checked across all 10,098 employees),
 * so it is parsed here by hand rather than left to `new Date`, whose handling
 * of non-ISO strings is implementation-defined and, in V8, LOCAL. Reading the
 * UTC parts of that local-midnight instant is what turned 15 Feb into 14 Feb
 * on every synced record.
 *
 * The other branches are defensive: ZingHR does not currently send them, so
 * they are kept as they were rather than re-interpreted on a guess.
 */
export function parseZingDate(value: string | null): Date | null {
  if (!value) return null;
  const text = value.trim();
  if (!text) return null;

  // .NET /Date(ms)/ — an absolute instant, flattened to the day it falls on.
  const dotNet = /\/Date\((-?\d+)\)\//.exec(text);
  if (dotNet) return utcDay(new Date(Number(dotNet[1])));

  // 15-02-2024 or 15/02/2024
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
  if (dmy) return utcMidnight(+dmy[3], +dmy[2] - 1, +dmy[1]);

  // 2024-02-15
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (ymd) return utcMidnight(+ymd[1], +ymd[2] - 1, +ymd[3]);

  // 15 Feb 2024 / 15-Feb-2024 / 15 February 2024 — what ZingHR actually sends.
  const named = /^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})$/.exec(text);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) return utcMidnight(+named[3], month, +named[1]);
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  // A string carrying no zone was read as LOCAL time, so its LOCAL parts are
  // the day that was written; anything zoned is a real instant.
  return ZONED.test(text)
    ? utcDay(parsed)
    : utcMidnight(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Does the string name a timezone, making it an instant rather than a day? */
const ZONED = /(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})\s*$/i;

/** Midnight UTC on the day this instant falls on, in UTC. */
function utcDay(d: Date): Date {
  return utcMidnight(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Midnight UTC on a given calendar day.
 *
 * `setUTCFullYear` rather than passing the year straight to `Date.UTC`, which
 * maps 0-99 onto 1900-1999 — a 1951 birthdate typed as "51" would silently
 * become 1951 either way, but a genuine year 51 would not round-trip.
 */
function utcMidnight(year: number, month: number, day: number): Date {
  const d = new Date(Date.UTC(2000, month, day));
  d.setUTCFullYear(year);
  return d;
}
