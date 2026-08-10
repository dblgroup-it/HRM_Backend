/**
 * One-time script: mark all existing FINAL and SELECTED candidates as
 * talentPool = true so they appear in the Talent Bank.
 *
 * Run once:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-talent-bank.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.candidate.updateMany({
    where: {
      stage: { in: ['FINAL', 'SELECTED'] },
      deletedAt: null,
    },
    data: { talentPool: true },
  });

  console.log(`✅  Talent Bank backfill complete — ${result.count} candidate(s) updated.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
