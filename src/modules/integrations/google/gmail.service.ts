import { Injectable, Logger } from '@nestjs/common';
import { google, gmail_v1 } from 'googleapis';

import { GoogleAuthService } from './google-auth.service';

/** Attachment types we accept as CVs (mirrors the upload allowlist). */
const CV_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // same 10MB cap as uploads

export interface InboxCv {
  messageId: string;
  subject: string;
  /** Plain-text body (first 1500 chars) — used for routing hints. */
  bodyText: string;
  fromName: string;
  fromEmail: string;
  receivedAt: Date;
  attachment: { filename: string; mimeType: string; buffer: Buffer };
}

/**
 * Reads the recruitment mailbox (the OAuth account's own inbox) for emailed
 * CVs. Read-only + mark-as-read — needs the gmail.modify scope, so a consent
 * done before this feature simply yields zero messages until it's redone.
 */
@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);

  constructor(private readonly auth: GoogleAuthService) {}

  isConfigured(): boolean {
    return this.auth.isConfigured();
  }

  private api(): gmail_v1.Gmail {
    return google.gmail({
      version: 'v1',
      auth: this.auth.getAuthorizedClient(),
    });
  }

  /** Unread inbox messages (recent) carrying at least one CV-type attachment. */
  async listUnreadCvs(max = 15): Promise<InboxCv[]> {
    if (!this.isConfigured()) return [];
    const gmail = this.api();
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: 'in:inbox is:unread has:attachment newer_than:30d',
      maxResults: max,
    });
    const out: InboxCv[] = [];
    for (const m of list.data.messages ?? []) {
      if (!m.id) continue;
      try {
        const cv = await this.readMessage(gmail, m.id);
        if (cv) out.push(cv);
      } catch (err) {
        this.logger.warn(
          `Could not read message ${m.id}: ${(err as Error).message}`,
        );
      }
    }
    return out;
  }

  /** Mark a message read so the next poll skips it (matched or not). */
  async markProcessed(messageId: string): Promise<void> {
    try {
      await this.api().users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (err) {
      this.logger.warn(
        `Could not mark message ${messageId} read: ${(err as Error).message}`,
      );
    }
  }

  private async readMessage(
    gmail: gmail_v1.Gmail,
    id: string,
  ): Promise<InboxCv | null> {
    const res = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    const msg = res.data;
    const headers = msg.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? '';

    const from = header('From');
    const fromEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
    const fromName =
      from
        .replace(/<[^>]*>/, '')
        .replace(/"/g, '')
        .trim() || fromEmail.split('@')[0];

    const part = this.findCvPart(msg.payload);
    if (!part?.body?.attachmentId || !part.filename) return null;
    if ((part.body.size ?? 0) > MAX_ATTACHMENT_BYTES) return null;

    const att = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: id,
      id: part.body.attachmentId,
    });
    const data = att.data.data;
    if (!data) return null;

    return {
      messageId: id,
      subject: header('Subject'),
      bodyText: this.extractBodyText(msg.payload),
      fromName,
      fromEmail,
      receivedAt: msg.internalDate
        ? new Date(Number(msg.internalDate))
        : new Date(),
      attachment: {
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        buffer: Buffer.from(data, 'base64url'),
      },
    };
  }

  /** First text/plain part of the MIME tree, decoded and truncated. */
  private extractBodyText(
    part: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!part) return '';
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url')
        .toString('utf8')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1500);
    }
    for (const child of part.parts ?? []) {
      const text = this.extractBodyText(child);
      if (text) return text;
    }
    return '';
  }

  /** Depth-first search of the MIME tree for the first CV-type attachment. */
  private findCvPart(
    part: gmail_v1.Schema$MessagePart | undefined,
  ): gmail_v1.Schema$MessagePart | null {
    if (!part) return null;
    if (
      part.filename &&
      part.body?.attachmentId &&
      CV_MIME_TYPES.has(part.mimeType ?? '')
    ) {
      return part;
    }
    for (const child of part.parts ?? []) {
      const found = this.findCvPart(child);
      if (found) return found;
    }
    return null;
  }
}
