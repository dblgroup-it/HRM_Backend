/**
 * Give existing candidates the gender indicator.
 *
 * New CVs are read by the AI as they are added, and BDJobs candidates carry
 * gender in what BDJobs sends — the migration copied that across. What is
 * left are candidates whose CV was uploaded before the AI was asked for
 * gender. This reads each of those CVs again, one at a time, and stores what
 * it finds. A CV that does not say leaves the candidate without an indicator,
 * as it should.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-candidate-gender.ts            # dry run (default)
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-candidate-gender.ts --execute  # read the CVs
 *   ... --execute --limit 50                                                              # a batch at a time
 *
 * Each read is one AI call on the CV, so the dry run says how many there are
 * before anything is spent. Re-running is safe: only candidates still without
 * a gender are touched. The same read also fills in a missing email or mobile,
 * which is what "Applied 2×" matches on. Only ids and counts are printed.
 */
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidatesService } from '../src/modules/candidates/candidates.service';

const EXECUTE = process.argv.includes('--execute');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) || undefined : undefined;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  // This is a one-off: the nightly backup, the ZingHR sync and the rest must
  // not fire from inside it.
  const scheduler = app.get(SchedulerRegistry);
  for (const job of scheduler.getCronJobs().values()) void job.stop();

  const prisma = app.get(PrismaService);
  const candidates = app.get(CandidatesService);

  const pending = await prisma.candidate.findMany({
    where: { gender: null, deletedAt: null, cvFileId: { not: null } },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
  });
  console.log(`Candidates with a CV and no gender: ${pending.length}`);

  if (!EXECUTE) {
    console.log('Dry run — nothing read. Add --execute to read these CVs.');
    await app.close();
    return;
  }

  let found = 0;
  let failed = 0;
  for (const [i, { id }] of pending.entries()) {
    const ok = await candidates.ensureCvProfile(id, true);
    if (!ok) failed++;
    const row = await prisma.candidate.findUnique({
      where: { id },
      select: { gender: true },
    });
    if (row?.gender) found++;
    if ((i + 1) % 10 === 0 || i + 1 === pending.length) {
      console.log(`  ${i + 1}/${pending.length} read · ${found} with a gender · ${failed} unreadable`);
    }
  }
  console.log(`Done. ${found} candidates now show an indicator.`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
