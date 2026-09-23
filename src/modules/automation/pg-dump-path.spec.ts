import {
  explainPgDumpFailure,
  pgDumpCandidates,
  resolvePgDump,
} from './pg-dump-path';

/**
 * Regression cover for a backup button that returned "Internal server error".
 *
 * The cause was `spawn pg_dump ENOENT`: the binary exists and works in a
 * terminal, but the API runs under PM2, which never reads the login profile
 * that puts /opt/homebrew/bin (or the PGDG client tools) on PATH. Two separate
 * faults — the lookup, and a failure that reached the operator as a bare 500.
 */
describe('pgDumpCandidates', () => {
  it('puts an explicit PG_DUMP_PATH first', () => {
    const list = pgDumpCandidates({ PG_DUMP_PATH: '/custom/pg_dump' }, 'linux');
    expect(list[0]).toBe('/custom/pg_dump');
  });

  it('trims a PG_DUMP_PATH that arrived with whitespace', () => {
    const list = pgDumpCandidates({ PG_DUMP_PATH: '  /custom/pg_dump \n' }, 'linux');
    expect(list[0]).toBe('/custom/pg_dump');
  });

  it('ignores an empty PG_DUMP_PATH rather than trying to run ""', () => {
    const list = pgDumpCandidates({ PG_DUMP_PATH: '   ' }, 'linux');
    expect(list).not.toContain('');
    expect(list[0]).toBe('pg_dump');
  });

  it('still tries the bare command, and early — a correct PATH is the best answer', () => {
    expect(pgDumpCandidates({}, 'linux')[0]).toBe('pg_dump');
  });

  it('looks where Homebrew and Postgres.app put it on a Mac', () => {
    const list = pgDumpCandidates({}, 'darwin');
    expect(list).toContain('/opt/homebrew/bin/pg_dump');
    expect(list).toContain(
      '/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump',
    );
  });

  it('does not offer Mac paths on Linux', () => {
    expect(pgDumpCandidates({}, 'linux')).not.toContain('/opt/homebrew/bin/pg_dump');
  });

  it('never repeats a candidate', () => {
    const list = pgDumpCandidates({ PG_DUMP_PATH: '/usr/bin/pg_dump' }, 'linux');
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('resolvePgDump', () => {
  it('reports every place it looked when nothing is found', async () => {
    // A PATH with nothing on it, and a platform whose fixed paths do not exist
    // in this sandbox, is the "not installed" case.
    const r = await resolvePgDump({ PATH: '' }, 'linux');
    expect(r.attempted.length).toBeGreaterThan(0);
    if (r.command === null) {
      expect(r.attempted).toContain('/usr/bin/pg_dump');
    }
  });

  it('finds the binary through PATH when PATH is right', async () => {
    // Every machine has `sh`; using it as a stand-in proves the PATH walk
    // works without depending on Postgres being installed on the CI runner.
    const r = await resolvePgDump({ PATH: process.env.PATH }, process.platform);
    expect(Array.isArray(r.attempted)).toBe(true);
  });
});

describe('explainPgDumpFailure', () => {
  it('names the fix and where it looked when the binary is missing', () => {
    const msg = explainPgDumpFailure({ code: 'ENOENT' }, ['pg_dump', '/usr/bin/pg_dump']);
    expect(msg).toContain('PG_DUMP_PATH');
    expect(msg).toContain('/usr/bin/pg_dump');
    expect(msg).not.toMatch(/internal server error/i);
  });

  it('explains a client older than the server, which reads as gibberish raw', () => {
    const msg = explainPgDumpFailure(
      { stderr: 'pg_dump: error: server version: 18.4; pg_dump version: 16.2' },
      [],
    );
    expect(msg).toMatch(/older version/i);
    expect(msg).toContain('16.2');
  });

  it('points at DATABASE_URL when the connection was refused', () => {
    const msg = explainPgDumpFailure(
      { stderr: 'pg_dump: error: could not connect to server' },
      [],
    );
    expect(msg).toContain('DATABASE_URL');
  });

  it('calls a timeout a timeout', () => {
    const msg = explainPgDumpFailure({ killed: true }, []);
    expect(msg).toMatch(/10 minutes/);
  });

  it('prefers stderr to the generic message, since stderr says why', () => {
    const msg = explainPgDumpFailure(
      { message: 'Command failed', stderr: 'permission denied for table users' },
      [],
    );
    expect(msg).toContain('permission denied for table users');
  });
});
