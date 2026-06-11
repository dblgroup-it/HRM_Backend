import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { GmailService, InboxCv } from '../integrations/google/gmail.service';
import { AiGraderService } from '../integrations/ai/ai-grader.service';
import { CandidatesService } from '../candidates/candidates.service';
import { NotificationsService } from '../realtime/notifications.service';
import { PermissionsService } from '../rbac/permissions.service';
import { AutomationPauseService } from './automation-pause.service';
import { AutomationLogService } from './automation-log.service';

/** Matches "REQ-2026-007" (also REQ 2026 7 / req_2026_07 variants). */
const CODE_RE = /\bREQ[\s_-]?(\d{4})[\s_-]?(\d{1,4})\b/i;

export interface IngestReport {
  scanned: number;
  imported: number;
  duplicates: number;
  unmatched: number;
}

/**
 * Emailed-CV ingestion: polls the recruitment inbox for unread mails with CV
 * attachments, matches the requisition code in the subject and drops the
 * candidate straight into that pipeline (Drive upload + AI screen included).
 */
@Injectable()
export class GmailIngestService {
  private readonly logger = new Logger(GmailIngestService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmail: GmailService,
    private readonly candidates: CandidatesService,
    private readonly notifications: NotificationsService,
    private readonly permissions: PermissionsService,
    private readonly pauses: AutomationPauseService,
    private readonly ai: AiGraderService,
    private readonly console: AutomationLogService,
  ) {}

  @Cron('*/15 * * * *')
  async poll(): Promise<void> {
    if (!this.gmail.isConfigured()) return;
    if (await this.pauses.isPaused('ingest')) return;
    try {
      await this.ingest();
    } catch (err) {
      this.logger.warn(`Inbox poll failed: ${(err as Error).message}`);
    }
  }

  async ingest(): Promise<IngestReport> {
    const report: IngestReport = {
      scanned: 0,
      imported: 0,
      duplicates: 0,
      unmatched: 0,
    };
    this.console.log('ingest', '▶ Scanning recruitment inbox…');
    let mails;
    try {
      mails = await this.gmail.listUnreadCvs();
    } catch (err) {
      this.console.log(
        'ingest',
        `✗ Inbox read failed: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        `Could not read the recruitment inbox (${(err as Error).message}). If this mentions scopes, redo the one-time Google consent — it now includes Gmail.`,
      );
    }
    this.console.log(
      'ingest',
      mails.length
        ? `⬇ ${mails.length} unread mail(s) with CV attachments`
        : '✓ Inbox clean — no new CVs',
    );
    for (const mail of mails) {
      report.scanned++;
      try {
        const req = await this.matchRequisition(mail);
        if (!req) {
          report.unmatched++;
          this.console.log(
            'ingest',
            `✗ Could not route "${mail.subject.slice(0, 60)}" from ${mail.fromName} — HR notified`,
          );
          await this.notifyUnmatched(mail.fromName, mail.subject);
        } else {
          const created = await this.candidates.importEmailedCv(
            req.id,
            { name: mail.fromName, email: mail.fromEmail },
            {
              originalname: mail.attachment.filename,
              mimetype: mail.attachment.mimeType,
              buffer: mail.attachment.buffer,
              size: mail.attachment.buffer.length,
            },
          );
          if (created) {
            report.imported++;
            this.console.log(
              'ingest',
              `✓ Imported ${mail.fromName} → ${req.code} (AI screening queued)`,
            );
            this.logger.log(
              `Imported emailed CV: ${mail.fromName} → ${req.code}`,
            );
          } else {
            report.duplicates++;
            this.console.log(
              'ingest',
              `＝ Skipped ${mail.fromName} — already in ${req.code}`,
            );
          }
        }
        // Processed either way — never re-scan this mail.
        await this.gmail.markProcessed(mail.messageId);
      } catch (err) {
        this.console.log(
          'ingest',
          `✗ Failed on "${mail.subject.slice(0, 50)}": ${(err as Error).message}`,
        );
        this.logger.warn(
          `Could not ingest mail "${mail.subject}": ${(err as Error).message}`,
        );
      }
    }
    if (mails.length) {
      this.console.log(
        'ingest',
        `✓ Done — imported ${report.imported}, duplicates ${report.duplicates}, unmatched ${report.unmatched}`,
      );
    }
    return report;
  }

  /**
   * Layered routing — most applicants won't follow a subject format, so:
   * 1. requisition code anywhere in the subject or body (fast path);
   * 2. exactly one posted designation named in the subject/body;
   * 3. AI reads the email + CV and picks the opening (high confidence only).
   */
  private async matchRequisition(mail: InboxCv) {
    const text = `${mail.subject} ${mail.bodyText}`;

    // 1 · explicit code
    const m = text.match(CODE_RE);
    if (m) {
      const code = `REQ-${m[1]}-${m[2].padStart(3, '0')}`;
      const byCode = await this.prisma.requisition.findFirst({
        where: {
          code: { equals: code, mode: 'insensitive' },
          status: 'POSTED',
        },
        select: { id: true, code: true },
      });
      if (byCode) return byCode;
    }

    const open = await this.prisma.requisition.findMany({
      where: { status: 'POSTED' },
      select: {
        id: true,
        code: true,
        designation: true,
        department: true,
        unitFactory: true,
      },
    });
    if (!open.length) return null;

    // 2 · designation named in the email — only when it's unambiguous
    const lower = text.toLowerCase();
    const named = open.filter((r) =>
      lower.includes(r.designation.trim().toLowerCase()),
    );
    if (named.length === 1) return named[0];

    // 3 · AI mail-room routing (email text + the CV itself)
    if (this.ai.isConfigured()) {
      try {
        const routed = await this.ai.routeCv({
          subject: mail.subject,
          bodyText: mail.bodyText,
          cvMimeType: mail.attachment.mimeType,
          cvBase64: mail.attachment.buffer.toString('base64'),
          openings: open.map((r) => ({
            code: r.code,
            designation: r.designation,
            department: r.department,
            unit: r.unitFactory,
          })),
        });
        if (routed.code && routed.confidence === 'high') {
          const match = open.find((r) => r.code === routed.code);
          if (match) {
            this.console.log(
              'ingest',
              `⚙ AI routed to ${match.code} — ${routed.reason}`,
            );
            this.logger.log(
              `AI-routed emailed CV to ${match.code}: ${routed.reason}`,
            );
            return match;
          }
        }
      } catch (err) {
        this.logger.warn(`AI routing failed: ${(err as Error).message}`);
      }
    }
    return null;
  }

  /** Tell global Corporate HR a CV arrived that we couldn't route. */
  private async notifyUnmatched(sender: string, subject: string) {
    const hrIds = await this.permissions.roleHolderUserIds('corporate_hr', '');
    await this.notifications.notifyMany(hrIds, {
      type: 'recruitment',
      title: 'Emailed CV needs routing',
      message: `${sender} emailed a CV ("${subject.slice(0, 80)}") but no posted requisition code was found in the subject — check the recruitment inbox.`,
      link: '/recruitment',
    });
  }
}
