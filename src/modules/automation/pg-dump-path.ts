/**
 * Finding `pg_dump` without relying on PATH.
 *
 * The backup ran `execFile('pg_dump', …)`, which resolves through the PATH of
 * whatever started Node. An interactive shell has Homebrew or the Postgres
 * client tools on its PATH because the login profile puts them there; a daemon
 * does not read that profile. Under PM2 — and under `npm start`, which rewrites
 * PATH to its own `node_modules/.bin` chain — `/opt/homebrew/bin` is simply
 * absent, so the lookup failed with `spawn pg_dump ENOENT` and the endpoint
 * returned a bare 500.
 *
 * Same shape as the `PUPPETEER_EXECUTABLE_PATH` escape hatch this project
 * already uses for Chromium: an explicit env var wins, and otherwise we look
 * where these binaries actually live.
 */
import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Directories holding one sub-directory per installed major version, newest
 * of which is the one we want. Debian/Ubuntu use the first, the PGDG RPMs the
 * second.
 */
export const VERSIONED_BIN_ROOTS = ['/usr/lib/postgresql', '/usr/pgsql'];

/**
 * Fixed places to look, in order of preference.
 *
 * `pg_dump` unqualified stays in the list, and stays early: where PATH *is*
 * set up correctly it is the right answer, and it respects a deliberately
 * chosen client version. The absolute paths are the fallback for when it is
 * not.
 */
export function pgDumpCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const explicit = env.PG_DUMP_PATH?.trim();
  const common = ['pg_dump', '/usr/bin/pg_dump', '/usr/local/bin/pg_dump'];
  const byPlatform =
    platform === 'darwin'
      ? [
          '/opt/homebrew/bin/pg_dump',
          '/opt/homebrew/opt/libpq/bin/pg_dump',
          '/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump',
        ]
      : [];

  // An explicit setting is an instruction, not a hint: it goes first, and if it
  // is wrong the error names it rather than quietly falling through to another
  // binary the operator did not choose.
  const all = explicit ? [explicit, ...common, ...byPlatform] : [...common, ...byPlatform];

  // De-duplicate, preserving order.
  return [...new Set(all)];
}

/** Bare command names are resolved by the OS, not by us. */
function isBareCommand(candidate: string): boolean {
  return !candidate.includes('/');
}

/**
 * The versioned directories, newest major first.
 *
 * Sorted numerically — a lexical sort puts "9" after "16", which would pick a
 * decade-old client to dump a modern server.
 */
async function versionedCandidates(): Promise<string[]> {
  const found: { version: number; path: string }[] = [];
  for (const root of VERSIONED_BIN_ROOTS) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue; // root not present on this machine
    }
    for (const entry of entries) {
      const version = Number.parseFloat(entry);
      if (!Number.isFinite(version)) continue;
      found.push({ version, path: join(root, entry, 'bin', 'pg_dump') });
    }
  }
  return found.sort((a, b) => b.version - a.version).map((f) => f.path);
}

export interface PgDumpResolution {
  /** The command or absolute path to run. */
  command: string;
  /** Everything tried, for an error message worth reading. */
  attempted: string[];
}

/**
 * Resolve the binary, or return every place we looked so the failure can say
 * so. Never throws: the caller decides what an absent pg_dump means.
 */
export async function resolvePgDump(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<PgDumpResolution | { command: null; attempted: string[] }> {
  const fixed = pgDumpCandidates(env, platform);
  const versioned = platform === 'linux' ? await versionedCandidates() : [];
  const attempted = [...new Set([...fixed, ...versioned])];

  for (const candidate of attempted) {
    // A bare name is left to the OS — we cannot stat it, and if PATH does
    // resolve it that is the answer we want.
    if (isBareCommand(candidate)) {
      if (await onPath(candidate, env)) return { command: candidate, attempted };
      continue;
    }
    try {
      await access(candidate, constants.X_OK);
      return { command: candidate, attempted };
    } catch {
      // Not here; keep looking.
    }
  }
  return { command: null, attempted };
}

/** Is a bare command resolvable through this process's own PATH? */
async function onPath(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = env.PATH ?? '';
  if (!path) return false;
  for (const dir of path.split(':')) {
    if (!dir) continue;
    try {
      await access(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // next
    }
  }
  return false;
}

/**
 * Turn a pg_dump failure into something an administrator can act on.
 *
 * The three that actually happen, and each needs a different fix:
 * a binary that is not installed, a client older than the server, and a
 * database that refused the connection.
 */
export function explainPgDumpFailure(err: unknown, attempted: string[]): string {
  const e = err as { code?: string; killed?: boolean; stderr?: string; message?: string };
  const stderr = (e?.stderr ?? '').trim();
  const message = stderr || e?.message || String(err);

  if (e?.code === 'ENOENT') {
    return (
      'pg_dump was not found, so no backup can be taken. Install the PostgreSQL ' +
      'client tools on the server, or set PG_DUMP_PATH to the full path of the ' +
      `binary. Looked in: ${attempted.join(', ')}`
    );
  }

  if (e?.killed) {
    return 'pg_dump was still running after 10 minutes and was stopped. The database may be too large for a single dump on this host.';
  }

  // "server version: 18.4; pg_dump version: 16.2" — a real and easily fixed
  // mistake that reads as gibberish without the hint.
  if (/server version|version mismatch/i.test(message)) {
    return (
      'pg_dump is an older version than the database server, and refuses to ' +
      'dump it. Install client tools matching the server\'s major version, or ' +
      `point PG_DUMP_PATH at them. pg_dump said: ${message}`
    );
  }

  if (/authentication|password|role .* does not exist|could not connect/i.test(message)) {
    return `pg_dump could not connect to the database. Check DATABASE_URL. pg_dump said: ${message}`;
  }

  return `pg_dump failed: ${message}`;
}
