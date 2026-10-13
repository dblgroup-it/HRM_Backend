/**
 * Rebuild BDJobs candidates' CVs from the payloads BDJobs sent.
 *
 * Every BDJobs application's payload is kept (`candidate_bdjobs_payloads`,
 * from 2026-10-13). When the way a payload is read changes — a field that was
 * dropped, a quirk now cleaned — this runs the stored payloads through the
 * current adapter and mapper and writes the CV again, without asking BDJobs
 * to send anything. Applications imported before payloads were kept have no
 * copy; for those BDJobs re-sends, which refreshes them on arrival.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/rebuild-bdjobs-cvs.ts             # dry run (default)
 *   npx ts-node -r tsconfig-paths/register scripts/rebuild-bdjobs-cvs.ts --execute   # write
 *   ... --candidate <id>                                                             # just one
 *
 * Each payload is rebuilt as of the day it arrived, so a CV only shows as
 * changed when the reading changed — not because time has passed. Only the
 * CV is written: stage, interviews, notes and contact details are untouched,
 * and nothing is re-screened (use Re-scan on the row where it matters).
 * Only ids and counts are printed.
 */
import { Prisma, PrismaClient } from '@prisma/client';

import { bdjobsToCvProfile } from '../src/modules/candidates/cv/bdjobs-cv.mapper';
import { bdjobsProfileToCandidateData } from '../src/modules/candidates/cv/bdjobs-profile.adapter';
import type { BdJobsCandidateData } from '../src/modules/candidates/cv/bdjobs-cv.mapper';

const EXECUTE = process.argv.includes('--execute');
const only = process.argv.indexOf('--candidate');
const CANDIDATE = only > -1 ? process.argv[only + 1] : undefined;

/** JSON with keys in a fixed order, and without the capture time. */
function comparable(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .filter((k) => k !== 'capturedAt' && o[k] !== undefined)
          .sort()
          .map((k) => [k, walk(o[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.candidateBdjobsPayload.findMany({
      where: CANDIDATE ? { candidateId: CANDIDATE } : {},
      select: {
        candidateId: true,
        payload: true,
        receivedAt: true,
        candidate: { select: { cvProfile: true } },
      },
    });
    console.log(`Stored BDJobs payloads: ${rows.length}`);

    let changed = 0;
    let unreadable = 0;
    for (const row of rows) {
      const p = row.payload as Record<string, unknown>;
      const data =
        (p.CandidateData as BdJobsCandidateData | undefined) ??
        bdjobsProfileToCandidateData(
          p.profile as Record<string, unknown> | undefined,
          p.candidate as { name?: string; email?: string; phone?: string },
        );
      if (!data) {
        unreadable++;
        continue;
      }
      const cv = bdjobsToCvProfile(data, row.receivedAt);
      if (comparable(cv) === comparable(row.candidate.cvProfile)) continue;
      changed++;
      console.log(`  would change: ${row.candidateId}`);
      if (EXECUTE) {
        await prisma.candidate.update({
          where: { id: row.candidateId },
          data: {
            cvProfile: cv as unknown as Prisma.InputJsonValue,
            cvProfileAt: new Date(),
          },
        });
      }
    }

    console.log(
      `${changed} CV${changed === 1 ? ' differs' : 's differ'} from a fresh reading` +
        (unreadable ? `; ${unreadable} payload(s) carried no CV` : '') +
        '.',
    );
    console.log(
      EXECUTE
        ? `Rewrote ${changed}.`
        : 'Dry run — nothing written. Add --execute to rewrite them.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
