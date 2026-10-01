/**
 * Delete requisitions and everything that hangs off them.
 *
 *   npx ts-node scripts/clear-requisitions.ts                              # dry run: all
 *   npx ts-node scripts/clear-requisitions.ts --codes REQ-2026-001,REQ-2026-004
 *   npx ts-node scripts/clear-requisitions.ts --execute --confirm=<N>      # really delete
 *
 * Without `--execute` it changes nothing and prints, table by table, what
 * would go. With it, `--confirm` must equal the number of requisitions the
 * run selects — the dry run prints it — so a run pointed at the wrong
 * database, or a wrong code list, refuses instead of deleting.
 *
 * What goes: the requisitions and every row cascading from them — approval
 * steps and board votes, activity, replacements, committees, interview
 * rounds / panels / evaluations / tokens, delegations and first-interview
 * approvals, BDJobs posts, Talent Bank matches, and the candidates with
 * their salary fixations, board approvals, onboarding (documents, medical,
 * reference checks, facility requests), AI tests and photos. Candidates
 * belong to a requisition, so clearing all requisitions empties the Talent
 * Bank too. Approval sheets left with no candidate and notifications that
 * link to a deleted requisition are removed as well.
 *
 * What stays: users, employees, roles and access, approval paths, the
 * organogram and units, board groups, master data, settings, the CV and
 * red-flag registries, and System Activity (audit_logs, kept for its own
 * 30 days as the record that this happened). Files on Google Drive are not
 * touched — the database does not own them; remove the folders there by
 * hand if wanted. New requisitions number on from REQ-<year>-001 again once
 * none are left (the next code is the highest in use plus one).
 *
 * Take a backup first: scripts/backup-production.sh. Prints counts and
 * codes only — no names.
 */
import { Prisma, PrismaClient } from '@prisma/client';

const EXECUTE = process.argv.includes('--execute');
const confirmArg = process.argv.find((a) => a.startsWith('--confirm='));
const CONFIRM = confirmArg ? Number(confirmArg.split('=')[1]) : NaN;
const codesIdx = process.argv.indexOf('--codes');
const CODES =
  codesIdx >= 0
    ? (process.argv[codesIdx + 1] ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : null;

const prisma = new PrismaClient();

/** Rows in each table that the selected requisitions would take with them. */
const COUNTS: [string, string][] = [
  ['approval_steps', 'select count(*) from approval_steps where requisition_id = any($1)'],
  ['requisition_board_votes', 'select count(*) from requisition_board_votes where requisition_id = any($1)'],
  ['requisition_activities', 'select count(*) from requisition_activities where requisition_id = any($1)'],
  ['requisition_replacements', 'select count(*) from requisition_replacements where requisition_id = any($1)'],
  ['committee_members', 'select count(*) from committee_members where requisition_id = any($1)'],
  ['bdjobs_posts', 'select count(*) from bdjobs_posts where requisition_id = any($1)'],
  ['talent_bank_matches', 'select count(*) from talent_bank_matches where requisition_id = any($1) or candidate_id in (select id from candidates where requisition_id = any($1))'],
  ['candidates', 'select count(*) from candidates where requisition_id = any($1)'],
  ['interview_rounds', 'select count(*) from interview_rounds where requisition_id = any($1)'],
  ['interview_panelists', 'select count(*) from interview_panelists where round_id in (select id from interview_rounds where requisition_id = any($1))'],
  ['evaluations', 'select count(*) from evaluations where round_id in (select id from interview_rounds where requisition_id = any($1))'],
  ['interview_delegations', 'select count(*) from interview_delegations where requisition_id = any($1)'],
  ['first_interview_approvals', 'select count(*) from first_interview_approvals where requisition_id = any($1)'],
  ['salary_fixations', 'select count(*) from salary_fixations where candidate_id in (select id from candidates where requisition_id = any($1))'],
  ['board_approvals', 'select count(*) from board_approvals where candidate_id in (select id from candidates where requisition_id = any($1))'],
  ['onboardings', 'select count(*) from onboardings where candidate_id in (select id from candidates where requisition_id = any($1))'],
  ['onboarding_docs', 'select count(*) from onboarding_docs where onboarding_id in (select o.id from onboardings o join candidates c on c.id = o.candidate_id where c.requisition_id = any($1))'],
  ['reference_checks', 'select count(*) from reference_checks where candidate_id in (select id from candidates where requisition_id = any($1))'],
  ['ai_proficiency_attempts', 'select count(*) from ai_proficiency_attempts where candidate_id in (select id from candidates where requisition_id = any($1))'],
];

async function count(sql: string, ids: string[]): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(sql, ids);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Notifications whose link points into one of these requisitions. Clearing
 * all of them also takes links to requisitions deleted before this run,
 * which already led nowhere.
 */
function notificationWhere(ids: string[]): Prisma.NotificationWhereInput {
  if (!CODES) return { link: { contains: '/requisitions/' } };
  return { OR: ids.map((id) => ({ link: { contains: id } })) };
}

async function main() {
  const selected = await prisma.requisition.findMany({
    where: CODES ? { code: { in: CODES } } : {},
    select: { id: true, code: true, status: true },
    orderBy: { code: 'asc' },
  });

  if (CODES) {
    const found = new Set(selected.map((r) => r.code));
    const missing = CODES.filter((c) => !found.has(c));
    if (missing.length) {
      console.error(`Not found: ${missing.join(', ')} — nothing was changed.`);
      process.exit(1);
    }
  }
  if (selected.length === 0) {
    console.log('No requisitions to clear.');
    return;
  }

  const ids = selected.map((r) => r.id);
  console.log(
    `${EXECUTE ? 'DELETING' : 'DRY RUN —'} ${selected.length} requisition${selected.length === 1 ? '' : 's'}${CODES ? '' : ' (ALL)'}:`,
  );
  for (const r of selected) console.log(`  ${r.code}  ${r.status}`);
  console.log('\nWith them:');
  for (const [table, sql] of COUNTS) {
    const n = await count(sql, ids);
    if (n) console.log(`  ${table.padEnd(28)} ${n}`);
  }
  const notes = await prisma.notification.count({ where: notificationWhere(ids) });
  if (notes) console.log(`  ${'notifications (by link)'.padEnd(28)} ${notes}`);
  const batches = await prisma.boardApprovalBatch.count({
    where: {
      approvals: { some: { candidate: { requisitionId: { in: ids } } } },
    },
  });
  if (batches) {
    console.log(`  ${'approval sheets touched'.padEnd(28)} ${batches} (removed if left empty)`);
  }

  if (!EXECUTE) {
    console.log(
      `\nNothing changed. To delete, back up first, then run with:\n  --execute --confirm=${selected.length}${CODES ? ` --codes ${CODES.join(',')}` : ''}`,
    );
    return;
  }
  if (CONFIRM !== selected.length) {
    console.error(
      `\n--confirm=${Number.isNaN(CONFIRM) ? '(missing)' : CONFIRM} does not match the ${selected.length} selected — nothing was changed.`,
    );
    process.exit(1);
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const n = await tx.notification.deleteMany({ where: notificationWhere(ids) });
      const r = await tx.requisition.deleteMany({ where: { id: { in: ids } } });
      // Sheets whose every candidate went with these requisitions.
      const b = await tx.boardApprovalBatch.deleteMany({
        where: { approvals: { none: {} } },
      });
      return { requisitions: r.count, notifications: n.count, sheets: b.count };
    },
    { timeout: 120_000 },
  );
  console.log(
    `\nDone: ${result.requisitions} requisitions (with everything above), ${result.notifications} notifications, ${result.sheets} empty approval sheets.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
