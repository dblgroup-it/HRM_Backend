import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../integrations/mail/mail.service';
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  codeUnusable,
  normaliseEmail,
  readVerification,
  sendDecision,
  signVerification,
  verificationKey,
} from './apply-email-verification';
import { applyEmailCodeEmail } from './recruitment-emails';

/** Rows untouched for this long are deleted: the address of someone who never applied is not kept. */
const KEEP_MS = 24 * 60 * 60_000;

/** On the 400 a missing or stale verification gets, so the page can ask again. */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

/**
 * The email check on the careers-page application. The rules — timings,
 * limits and the signed verification — are in `apply-email-verification.ts`;
 * this stores the codes and sends the mail.
 *
 * The check only applies while mail can actually be delivered. With the
 * Settings master switch off (or no mail account configured) no code could
 * arrive, and requiring one would close applications altogether — so the
 * page is told not to ask, and the application is taken as before.
 */
@Injectable()
export class ApplyEmailService {
  private readonly logger = new Logger(ApplyEmailService.name);
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.key = verificationKey(config.get<string>('jwt.secret') ?? '');
  }

  /** Whether an application must carry a verified address right now. */
  required(): Promise<boolean> {
    return this.mail.canDeliver();
  }

  async sendCode(
    rawEmail: string,
    letter: { name?: string; position: string },
  ): Promise<{ sentTo: string; resendInSeconds: number }> {
    const email = normaliseEmail(rawEmail);
    const now = new Date();
    const state = await this.prisma.applyEmailCode.findUnique({
      where: { email },
    });
    const decision = sendDecision(state, now);
    if (decision.action === 'wait') {
      return { sentTo: email, resendInSeconds: decision.resendInSeconds };
    }
    if (decision.action === 'limit') {
      const m = decision.retryInMinutes;
      throw new HttpException(
        `Too many codes have been sent to this address. Please try again in ${m} minute${m === 1 ? '' : 's'}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // randomInt, not Math.random; the whole range, leading zeros included.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const data = {
      codeHash: await bcrypt.hash(code, 8),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      attempts: 0,
      sentAt: now,
      windowStart: decision.windowStart,
      windowCount: decision.windowCount,
    };
    await this.prisma.applyEmailCode.upsert({
      where: { email },
      create: { email, ...data },
      update: data,
    });

    try {
      await this.mail.send({
        to: rawEmail.trim(),
        ...applyEmailCodeEmail({
          candidateName: letter.name,
          position: letter.position,
          code,
          validMinutes: CODE_TTL_MS / 60_000,
        }),
      });
    } catch (err) {
      this.logger.error(
        `Application email code was not delivered to ${email}: ${String(err)}`,
      );
      // Nothing arrived, so nothing to wait for and nothing counted.
      await this.prisma.applyEmailCode.update({
        where: { email },
        data: {
          codeHash: null,
          expiresAt: null,
          sentAt: null,
          windowCount: decision.windowCount - 1,
        },
      });
      throw new ServiceUnavailableException(
        'We could not send a code to this address just now. Please check the address and try again.',
      );
    }
    return { sentTo: email, resendInSeconds: RESEND_COOLDOWN_MS / 1000 };
  }

  async verifyCode(
    rawEmail: string,
    rawCode: string,
  ): Promise<{ verificationToken: string; expiresAt: string }> {
    const email = normaliseEmail(rawEmail);
    const now = new Date();
    const state = await this.prisma.applyEmailCode.findUnique({
      where: { email },
    });
    // The applicant owns this address, so saying exactly what is wrong gives
    // nobody anything; a vague "invalid code" just sends them round again.
    switch (codeUnusable(state, now)) {
      case 'none':
        throw new BadRequestException(
          'No code is waiting for this address. Please request a new code.',
        );
      case 'expired':
        throw new BadRequestException(
          'This code has expired. Please request a new code.',
        );
      case 'exhausted':
        throw new BadRequestException(
          'Too many incorrect attempts. Please request a new code.',
        );
    }

    if (!(await bcrypt.compare(rawCode.trim(), state!.codeHash!))) {
      // Counted in the database, so a fresh tab is not a fresh budget.
      const updated = await this.prisma.applyEmailCode.update({
        where: { email },
        data: { attempts: { increment: 1 } },
      });
      const left = MAX_ATTEMPTS - updated.attempts;
      if (left <= 0) {
        await this.prisma.applyEmailCode.update({
          where: { email },
          data: { codeHash: null, expiresAt: null },
        });
        throw new BadRequestException(
          'Too many incorrect attempts. Please request a new code.',
        );
      }
      throw new BadRequestException(
        `That code is not correct. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`,
      );
    }

    // Single use: spent the moment it is accepted.
    await this.prisma.applyEmailCode.update({
      where: { email },
      data: { codeHash: null, expiresAt: null, attempts: 0 },
    });
    const { token, expiresAt } = signVerification(email, this.key, now);
    return { verificationToken: token, expiresAt: expiresAt.toISOString() };
  }

  /** Refuses an application whose address has not been proved, while proving is possible. */
  async assertVerified(
    rawEmail: string,
    token: string | undefined,
  ): Promise<void> {
    if (!(await this.required())) return;
    const proved = readVerification(token, this.key, new Date());
    if (proved !== null && proved === normaliseEmail(rawEmail)) return;
    throw new BadRequestException({
      message: !token
        ? 'Please verify your email address before submitting your application.'
        : proved !== null
          ? 'The email address was changed after it was verified. Please verify the new address.'
          : 'Your email verification has expired. Please verify your email address again.',
      code: EMAIL_NOT_VERIFIED,
    });
  }

  /** Nightly: forget addresses nobody has used for a day. Never throws. */
  @Cron('40 3 * * *', {
    name: 'apply-email-code-cleanup',
    timeZone: 'Asia/Dhaka',
  })
  async purgeStale(now: Date = new Date()): Promise<number> {
    try {
      const { count } = await this.prisma.applyEmailCode.deleteMany({
        where: { updatedAt: { lt: new Date(now.getTime() - KEEP_MS) } },
      });
      return count;
    } catch (err) {
      this.logger.error(
        `Application email code cleanup failed: ${String(err)}`,
      );
      return 0;
    }
  }
}
