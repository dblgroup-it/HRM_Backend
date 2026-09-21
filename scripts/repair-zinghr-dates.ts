/**
 * Put every employee's date of birth and joining date back on the right day.
 *
 * ZingHR sends a bare calendar day — `"15 Feb 2024"`, no time and no zone.
 * `new Date` reads a string in that shape as LOCAL midnight, which on this
 * server (Asia/Dhaka, UTC+6) is 18:00Z the day before, and the old parser
 * then took the UTC parts of that instant. Every synced birthday, joining
 * date and exit date was therefore stored one day early.
 *
 * The parser is fixed, and a normal sync now writes the right day — but only
 * for the employees a sync actually writes. It skips anyone whose
 * `EmployeeStatus` is not `Existing` or `NewJoinee`, which at the time of
 * writing is about 5,700 people: `FnF Locked` leavers, `Pending`,
 * `Not Joined`, `FnF Initiated`. Their rows were last written by the broken
 * parser and no future sync will ever touch them again. This repairs them.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/repair-zinghr-dates.ts            # dry run (default)
 *   npx ts-node -r tsconfig-paths/register scripts/repair-zinghr-dates.ts --execute  # write
 *
 * What it does NOT do matters as much. It reads the authoritative value from
 * ZingHR and writes three date columns. It does not create users, does not
 * revive a leaver's profile, does not touch designation, department, unit,
 * roles or status, and does not shift dates by a fixed offset — a blanket
 * "+1 day" would have corrupted every row the fixed sync had already put
 * right. Rows already holding the correct day are left alone, so this is
 * idempotent and safe to re-run.
 *
 * Only employee codes and dates are printed — no names.
 */
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

import { parseZingDate } from '../src/modules/integrations/zinghr/zinghr.service';

const EXECUTE = process.argv.includes('--execute');
const prisma = new PrismaClient();

const SYNC_PATH = '/2015/route/EmployeeDetails/GetEmployeeMasterDetails';

interface RawEmployee {
  EmployeeCode?: string;
  EmployeeStatus?: string;
  DateofBirth?: string | null;
  DateofJoining?: string | null;
  ExitDate?: string | null;
}

/** Same day? Both sides are UTC-midnight instants, so compare the timestamps. */
function sameDay(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? '—';

async function main(): Promise<void> {
  const base = process.env.ZINGHR_BASE_URL;
  const prefix = process.env.ZINGHR_EMPLOYEE_CODE_PREFIX ?? '151';
  if (!base || !process.env.ZINGHR_TOKEN) {
    throw new Error('ZINGHR_BASE_URL and ZINGHR_TOKEN must be set');
  }

  console.log(EXECUTE ? '● EXECUTE — writing changes' : '○ DRY RUN — no writes');

  const now = new Date();
  const today = `${String(now.getDate()).padStart(2, '0')}-${String(
    now.getMonth() + 1,
  ).padStart(2, '0')}-${now.getFullYear()}`;

  const { data } = await axios.post<{ Employees?: RawEmployee[] }>(
    `${base}${SYNC_PATH}`,
    {
      SubscriptionName: process.env.ZINGHR_SUBSCRIPTION_NAME,
      Token: process.env.ZINGHR_TOKEN,
      PageSize: '20000',
      PageNumber: '1',
      Fromdate: '01-01-1990',
      Todate: today,
      EmpFlag: '',
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 180_000 },
  );

  const employees = (data?.Employees ?? []).filter((e) =>
    e.EmployeeCode?.startsWith(prefix),
  );
  console.log(`Fetched ${employees.length.toLocaleString()} records from ZingHR`);

  // One read of the columns we may change, rather than a query per employee.
  const existing = await prisma.employee.findMany({
    select: {
      id: true,
      employeeCode: true,
      dateOfBirth: true,
      joiningDate: true,
      exitDate: true,
    },
  });
  const byCode = new Map(existing.map((e) => [e.employeeCode, e]));

  let checked = 0;
  let repaired = 0;
  let absent = 0;
  let shown = 0;

  for (const raw of employees) {
    const row = byCode.get(raw.EmployeeCode!);
    if (!row) {
      absent++;
      continue;
    }
    checked++;

    const want = {
      dateOfBirth: parseZingDate(raw.DateofBirth ?? null),
      joiningDate: parseZingDate(raw.DateofJoining ?? null),
      exitDate: parseZingDate(raw.ExitDate ?? null),
    };
    const drifted =
      !sameDay(want.dateOfBirth, row.dateOfBirth) ||
      !sameDay(want.joiningDate, row.joiningDate) ||
      !sameDay(want.exitDate, row.exitDate);
    if (!drifted) continue;

    repaired++;
    if (shown < 15) {
      shown++;
      console.log(
        `  ${row.employeeCode}  [${raw.EmployeeStatus}]  ` +
          `dob ${day(row.dateOfBirth)} → ${day(want.dateOfBirth)}  ·  ` +
          `joining ${day(row.joiningDate)} → ${day(want.joiningDate)}`,
      );
    } else if (shown === 15) {
      shown++;
      console.log('  …');
    }

    if (EXECUTE) {
      await prisma.employee.update({ where: { id: row.id }, data: want });
    }
  }

  console.log(
    `\n${checked.toLocaleString()} employees checked · ` +
      `${repaired.toLocaleString()} ${EXECUTE ? 'repaired' : 'would be repaired'} · ` +
      `${absent.toLocaleString()} in ZingHR but not in this database (ignored)`,
  );
  if (!EXECUTE && repaired > 0) {
    console.log('\nRe-run with --execute to apply.');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
