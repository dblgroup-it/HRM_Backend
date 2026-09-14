/**
 * Take "anyone with the link" back off every sensitive Drive object.
 *
 * Until this release, uploads were published with
 * `{ type: 'anyone', role: 'reader' }` — a permanent, unauthenticated,
 * unlogged URL for a CV, a national ID, an academic certificate or a Medical
 * Fitness Report. Nothing publishes files that way any more; this sweeps up
 * what earlier uploads left behind.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/revoke-public-drive-access.ts            # dry run (default)
 *   npx ts-node -r tsconfig-paths/register scripts/revoke-public-drive-access.ts --execute  # actually revoke
 *
 * Safe to re-run: revoking a file that is already private is a no-op, and a
 * failure on one file never stops the sweep. Only file ids and record ids are
 * printed — never a candidate's name, email or any document content.
 *
 * TAKE A DATABASE BACKUP FIRST is not required (this writes nothing to the
 * database) but DO confirm with the business which historic email links are
 * expected to stop working — see PHASE 2H in FINAL_GO_LIVE_GATE.md.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { google } from 'googleapis';

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;

const prisma = new PrismaClient();

function driveClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://localhost:4000/callback';
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN must be set (read from HRM_Backend/.env).',
    );
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth });
}

interface Target {
  /** What kind of document this is — for the summary only. */
  kind: string;
  /** Drive file or folder id. */
  fileId: string;
  /** Database row id, so a failure can be traced without naming a person. */
  recordId: string;
}

/** Every sensitive Drive object the database knows about. */
async function collectTargets(): Promise<Target[]> {
  const targets: Target[] = [];

  const candidates = await prisma.candidate.findMany({
    where: { cvFileId: { not: null } },
    select: { id: true, cvFileId: true },
  });
  for (const c of candidates) {
    targets.push({ kind: 'cv', fileId: c.cvFileId!, recordId: c.id });
  }

  // Joining documents: national ID, certificates, photographs — and the
  // Medical Fitness Report, which is filed here too.
  const docs = await prisma.onboardingDoc.findMany({
    select: { id: true, fileId: true, label: true },
  });
  for (const d of docs) {
    targets.push({
      kind: /medical|health|fitness/i.test(d.label)
        ? 'medical-report'
        : 'onboarding-doc',
      fileId: d.fileId,
      recordId: d.id,
    });
  }

  const boardAttachments = await prisma.boardApproval.findMany({
    where: { hrApprovalAttachmentFileId: { not: null } },
    select: { id: true, hrApprovalAttachmentFileId: true },
  });
  for (const b of boardAttachments) {
    targets.push({
      kind: 'board-attachment',
      fileId: b.hrApprovalAttachmentFileId!,
      recordId: b.id,
    });
  }

  // Requisition attachments live in a JSON column.
  const reqs = await prisma.requisition.findMany({
    where: { attachments: { not: Prisma.DbNull } },
    select: { id: true, attachments: true },
  });
  for (const r of reqs) {
    const list = Array.isArray(r.attachments)
      ? (r.attachments as { fileId?: string }[])
      : [];
    for (const a of list) {
      if (a?.fileId) {
        targets.push({
          kind: 'requisition-attachment',
          fileId: a.fileId,
          recordId: r.id,
        });
      }
    }
  }

  // The archived joining-docs FOLDER was published as a whole, which exposes
  // every document inside it regardless of the files' own permissions.
  const archived = await prisma.onboarding.findMany({
    where: { archiveFolderUrl: { not: null } },
    select: { id: true, archiveFolderUrl: true },
  });
  for (const o of archived) {
    const id = folderIdFromUrl(o.archiveFolderUrl!);
    if (id) {
      targets.push({ kind: 'archive-folder', fileId: id, recordId: o.id });
    }
  }

  // De-duplicate: the same file can be referenced twice.
  const seen = new Set<string>();
  return targets.filter((t) => {
    if (seen.has(t.fileId)) return false;
    seen.add(t.fileId);
    return true;
  });
}

function folderIdFromUrl(url: string): string | null {
  const m = url.match(/\/folders\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function run(): Promise<void> {
  console.log(
    DRY_RUN
      ? '=== DRY RUN — nothing will be changed. Re-run with --execute to apply. ==='
      : '=== EXECUTING — public access will be revoked. ===',
  );

  const drive = driveClient();
  const targets = await collectTargets();
  console.log(`Found ${targets.length} distinct Drive objects to check.\n`);

  const byKind: Record<
    string,
    { checked: number; public: number; revoked: number; failed: number }
  > = {};
  const bump = (
    kind: string,
    field: 'checked' | 'public' | 'revoked' | 'failed',
  ) => {
    byKind[kind] ??= { checked: 0, public: 0, revoked: 0, failed: 0 };
    byKind[kind][field]++;
  };

  for (const t of targets) {
    bump(t.kind, 'checked');
    try {
      const res = await drive.permissions.list({
        fileId: t.fileId,
        fields: 'permissions(id,type,role)',
      });
      const publicPerms = (res.data.permissions ?? []).filter(
        (p) => p.type === 'anyone',
      );
      if (publicPerms.length === 0) continue;

      bump(t.kind, 'public');
      console.log(
        `${DRY_RUN ? 'WOULD REVOKE' : 'REVOKING  '} ${t.kind.padEnd(22)} file=${t.fileId} record=${t.recordId} (${publicPerms.length} public grant${publicPerms.length === 1 ? '' : 's'})`,
      );
      if (DRY_RUN) continue;

      for (const p of publicPerms) {
        if (p.id) {
          await drive.permissions.delete({
            fileId: t.fileId,
            permissionId: p.id,
          });
        }
      }
      bump(t.kind, 'revoked');
    } catch (err) {
      bump(t.kind, 'failed');
      // Ids only — never a name or any document content.
      console.warn(
        `FAILED ${t.kind} file=${t.fileId} record=${t.recordId}: ${(err as Error).message}`,
      );
    }
  }

  console.log('\n─── Summary ───────────────────────────────────────────────');
  let totalPublic = 0;
  let totalRevoked = 0;
  let totalFailed = 0;
  for (const [kind, s] of Object.entries(byKind).sort()) {
    console.log(
      `${kind.padEnd(24)} checked ${String(s.checked).padStart(5)}  public ${String(s.public).padStart(5)}  revoked ${String(s.revoked).padStart(5)}  failed ${String(s.failed).padStart(4)}`,
    );
    totalPublic += s.public;
    totalRevoked += s.revoked;
    totalFailed += s.failed;
  }
  console.log(
    `${'TOTAL'.padEnd(24)} checked ${String(targets.length).padStart(5)}  public ${String(totalPublic).padStart(5)}  revoked ${String(totalRevoked).padStart(5)}  failed ${String(totalFailed).padStart(4)}`,
  );

  if (DRY_RUN && totalPublic > 0) {
    console.log(
      `\n${totalPublic} object(s) are currently world-readable by URL. Re-run with --execute to revoke.`,
    );
  }
  // A non-zero exit makes a scheduled run visible as a failure.
  if (totalFailed > 0) process.exitCode = 1;
}

run()
  .catch((err) => {
    console.error(`Sweep aborted: ${(err as Error).message}`);
    process.exitCode = 2;
  })
  .finally(() => void prisma.$disconnect());
