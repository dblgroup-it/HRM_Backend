import { Injectable } from '@nestjs/common';

const MAX_LINES = 300;

/**
 * In-memory rolling console for the automation jobs — every cron and manual
 * run appends here, and the Integrations page renders it like the ZingHR
 * terminal. Process-local by design (it's a live console, not an audit log).
 */
@Injectable()
export class AutomationLogService {
  private lines: string[] = [];

  log(job: 'ingest' | 'nudges' | 'backup', message: string): void {
    const at = new Date().toLocaleTimeString('en-GB', { hour12: false });
    this.lines.push(`[${at}] [${job}] ${message}`);
    if (this.lines.length > MAX_LINES) {
      this.lines = this.lines.slice(-MAX_LINES);
    }
  }

  tail(count = 200): string[] {
    return this.lines.slice(-count);
  }
}
