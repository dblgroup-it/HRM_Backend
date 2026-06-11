import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DriveService } from '../integrations/google/drive.service';
import { GoogleAuthService } from '../integrations/google/google-auth.service';
import { AutomationPauseService } from './automation-pause.service';
import { AutomationLogService } from './automation-log.service';

const execFileAsync = promisify(execFile);
const KEEP_BACKUPS = 30;
const BACKUPS_FOLDER = '99 Backups';

export interface BackupReport {
  file: string;
  sizeBytes: number;
  url: string;
  kept: number;
  pruned: number;
}

/**
 * Nightly disaster-recovery: pg_dump (custom format, compressed) uploaded to a
 * private Drive folder on the recruitment account, keeping the last 30.
 * Restore with: pg_restore -d <database_url> <file>.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly drive: DriveService,
    private readonly auth: GoogleAuthService,
    private readonly pauses: AutomationPauseService,
    private readonly console: AutomationLogService,
  ) {}

  @Cron('30 2 * * *')
  async nightly(): Promise<void> {
    if (!this.auth.isConfigured()) return;
    if (await this.pauses.isPaused('backup')) return;
    try {
      const r = await this.run();
      this.logger.log(
        `DB backup uploaded: ${r.file} (${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB), keeping ${r.kept}`,
      );
    } catch (err) {
      this.logger.error(`DB backup FAILED: ${(err as Error).message}`);
    }
  }

  async run(): Promise<BackupReport> {
    // Prisma URLs carry params pg_dump rejects (?schema=…) — strip them.
    const dbUrl = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
    if (!dbUrl) throw new ServiceUnavailableException('DATABASE_URL not set');
    if (!this.auth.isConfigured()) {
      throw new ServiceUnavailableException('Google Drive is not connected');
    }

    const stamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace('T', '-')
      .replace(':', '');
    const name = `hrm-db-${stamp}.dump`;
    const tmpPath = join(tmpdir(), name);

    try {
      this.console.log('backup', '▶ Running pg_dump…');
      // Custom format is compressed and restorable table-by-table.
      await execFileAsync(
        'pg_dump',
        ['--format=custom', `--file=${tmpPath}`, dbUrl],
        { timeout: 10 * 60_000 },
      );
      const buffer = await readFile(tmpPath);
      this.console.log(
        'backup',
        `⬇ Dump ready: ${name} (${(buffer.length / 1024 / 1024).toFixed(1)} MB) — uploading to Drive…`,
      );

      const rootId = await this.drive.ensureRootFolder();
      const folderId = await this.drive.ensureFolder(BACKUPS_FOLDER, rootId);
      const uploaded = await this.drive.uploadFile(folderId, {
        name,
        mimeType: 'application/octet-stream',
        buffer,
      });

      const pruned = await this.prune(folderId);
      this.console.log(
        'backup',
        `✓ Uploaded to ${BACKUPS_FOLDER}${pruned ? ` — pruned ${pruned} old backup(s)` : ''}`,
      );
      return {
        file: name,
        sizeBytes: buffer.length,
        url: uploaded.url,
        kept: Math.min(
          KEEP_BACKUPS,
          (await this.drive.listFiles(folderId)).length,
        ),
        pruned,
      };
    } catch (err) {
      this.console.log('backup', `✗ Backup failed: ${(err as Error).message}`);
      throw err;
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  /** Trash everything beyond the newest KEEP_BACKUPS dumps. */
  private async prune(folderId: string): Promise<number> {
    const files = await this.drive.listFiles(folderId); // ordered by createdTime asc
    const excess = files.length - KEEP_BACKUPS;
    for (let i = 0; i < excess; i++) {
      await this.drive.trashFile(files[i].id);
    }
    return Math.max(0, excess);
  }
}
