/**
 * Which database a sandbox (dev) server opens, decided before Nest boots.
 *
 * The dev server works on dated copies of the live database
 * (`dbl_hrm_dev_20261002`, made nightly by deploy/ubuntu/dev-clone-db.sh).
 * The admin picks one on the dev site; the pick is written to a small file
 * and the app restarts onto it. "latest" (or no file) means the newest copy.
 *
 * Pure apart from the file read, so the rules are pinned by a spec.
 */
import * as fs from 'node:fs';

/** A copy's database name: the prefix and a date, nothing else. */
export function isCopyName(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && /^\d{8}$/.test(name.slice(prefix.length));
}

/** "dbl_hrm_dev_20261002" → "2026-10-02"; null for anything else. */
export function copyDate(name: string, prefix: string): string | null {
  if (!isCopyName(name, prefix)) return null;
  const d = name.slice(prefix.length);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** The database a connection URL names. */
export function databaseOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/** The same URL pointed at another database on the same server. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * The database to open: the one picked in the file if it is a copy, else
 * the newest copy when "latest" is asked for and `available` is known, else
 * whatever DATABASE_URL already names.
 */
export function chooseDatabase(input: {
  picked: string | null;
  prefix: string;
  available?: string[];
}): string | null {
  const picked = input.picked?.trim() || 'latest';
  if (picked !== 'latest') {
    return isCopyName(picked, input.prefix) ? picked : null;
  }
  const newest = (input.available ?? [])
    .filter((n) => isCopyName(n, input.prefix))
    .sort()
    .pop();
  return newest ?? null;
}

export function readPicked(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
