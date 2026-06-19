import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { SettingsService } from '../../settings/settings.service';

export interface SendMailInput {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}

/** Sends mail through the recruitment Gmail account (app password, SMTP). */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly appSettings: SettingsService,
  ) {}

  isConfigured(): boolean {
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

  async send(input: SendMailInput): Promise<{ messageId: string }> {
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
    });
    this.logger.log(`Email sent to ${input.to} (${info.messageId})`);
    return { messageId: info.messageId };
  }
}
