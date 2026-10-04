import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { SettingsService } from '../../settings/settings.service';
import { SandboxService } from '../../sandbox/sandbox.service';
import { finaliseOutgoing, previewHtml } from './automated-notice';

/** One file travelling with the message — an offer letter PDF, say. */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Content id of an image shown inside the message (the logo). */
  cid?: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  attachments?: MailAttachment[];
}

/** Sends mail through the recruitment Gmail account (app password, SMTP). */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly appSettings: SettingsService,
    private readonly sandbox: SandboxService,
  ) {}

  isConfigured(): boolean {
    // The dev server "sends" everything into its outbox, credentials or not,
    // so flows that check this before mailing behave as they do live.
    if (this.sandbox.enabled) return true;
    return Boolean(
      this.config.get<string>('mail.user') &&
      this.config.get<string>('mail.appPassword'),
    );
  }

  private getTransporter(): Transporter {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Email is not configured. Set MAIL_USER and MAIL_APP_PASSWORD.',
      );
    }
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: this.config.get<string>('mail.user'),
          pass: this.config.get<string>('mail.appPassword'),
        },
      });
    }
    return this.transporter;
  }

  async send(message: SendMailInput): Promise<{ messageId: string }> {
    // Every message leaves with the automated-email notice at its foot, and
    // with the logo when its HTML shows it — added here so no sender can
    // forget either.
    const input = finaliseOutgoing(message);
    // Dev server: recorded, never sent — and counted as sent, so the flow
    // under test carries on exactly as it would live.
    if (
      await this.sandbox.intercept('email', {
        target: input.to,
        subject: input.subject,
        body: input.text ?? input.html ?? '',
        meta: {
          // The outbox shows the HTML in a browser frame, where the inline
          // logo's cid: reference would be a broken image.
          html: input.html ? previewHtml(input.html) : null,
          attachments: (input.attachments ?? [])
            .filter((a) => !a.cid)
            .map((a) => a.filename),
        },
      })
    ) {
      return { messageId: 'sandbox' };
    }
    const { emailEnabled } = await this.appSettings.getNotificationConfig();
    if (!emailEnabled) {
      this.logger.debug(
        `Email suppressed (master switch off) — would have sent to ${input.to}: "${input.subject}"`,
      );
      return { messageId: 'suppressed' };
    }
    const from =
      this.config.get<string>('mail.from') ||
      this.config.get<string>('mail.user') ||
      '';
    const info = await this.getTransporter().sendMail({
      from: `DBL Group Recruitment <${from}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo,
      attachments: input.attachments,
    });
    this.logger.log(`Email sent to ${input.to} (${info.messageId})`);
    return { messageId: info.messageId };
  }
}
