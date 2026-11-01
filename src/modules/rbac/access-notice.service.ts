import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../integrations/mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { defaultPasswordFor } from '../auth/default-password';
import { accessGrantedEmail, passwordResetEmail } from '../auth/account-emails';

/** Whether an email about someone's account is on its way, and if not, why. */
export type AccessEmailStatus = 'queued' | 'no_email' | 'mail_off' | 'inactive';

export interface AccessEmailNotice {
  status: AccessEmailStatus;
  email: string | null;
}

/** One bulk send of sign-in details, as the page shows its progress. */
export interface DefaultPasswordRun {
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
  total: number;
  sent: number;
  failed: number;
}

/**
 * Grants made this close together go out as one email: an administrator
 * giving someone three roles in a row should not send three letters. Held in
 * memory, so a restart inside the window loses that one email (the app has no
 * shutdown hooks to flush it); kept short for that reason.
 */
export const GRANT_QUIET_MS = 45_000;
/** Between two letters of a bulk send — Gmail throttles a burst. */
const BULK_GAP_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The emails a person gets about their own account (owner's request,
 * 2026-11-01): when they are given a role, when a super user resets their
 * password, and — once, for the accounts moved to the shared default on
 * 2026-10-30 — their sign-in details in bulk. Letters in
 * `auth/account-emails.ts`.
 *
 * Every send goes through MailService, so the dev server's outbox and the
 * Integrations master switch apply. None of them can fail what triggered it:
 * a grant or a reset stands whether or not Gmail answers.
 */
@Injectable()
export class AccessNoticeService {
  private readonly logger = new Logger(AccessNoticeService.name);
  private readonly pending = new Map<
    string,
    { assignmentIds: Set<string>; timer: NodeJS.Timeout }
  >();
  private bulk: DefaultPasswordRun | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private signInUrl(): string {
    const base =
      this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';
    return `${base}/login`;
  }

  /** Can a letter reach this person? If not, says why, for the page. */
  private async reach(user: {
    status: UserStatus;
    email: string | null;
  }): Promise<AccessEmailNotice> {
    const email = user.email?.trim() || null;
    if (user.status !== 'ACTIVE') return { status: 'inactive', email };
    if (!email) return { status: 'no_email', email: null };
    if (!(await this.mail.canDeliver())) return { status: 'mail_off', email };
    return { status: 'queued', email };
  }

  /**
   * The default password, when this account still holds it — checked against
   * its hash, never assumed, so a letter cannot hand out a password that no
   * longer works.
   */
  private async heldDefault(user: {
    employeeCode: string;
    passwordHash: string;
    mustChangePassword: boolean;
  }): Promise<string | null> {
    if (!user.mustChangePassword) return null;
    const pw = defaultPasswordFor(user.employeeCode);
    return (await bcrypt.compare(pw, user.passwordHash)) ? pw : null;
  }

  // --- a role was given --------------------------------------------------

  /**
   * Called after any grant — Access Control, or the automatic ones from
   * Approval Paths and interview hand-offs. The letter goes once the grants
   * stop for `GRANT_QUIET_MS`.
   */
  async roleGranted(
    userId: string,
    assignmentId: string,
  ): Promise<AccessEmailNotice> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { status: true, email: true },
      });
      if (!user) return { status: 'no_email', email: null };
      const notice = await this.reach(user);
      if (notice.status !== 'queued') return notice;

      const entry = this.pending.get(userId);
      if (entry) clearTimeout(entry.timer);
      const assignmentIds = entry?.assignmentIds ?? new Set<string>();
      assignmentIds.add(assignmentId);
      const timer = setTimeout(
        () => void this.flushGrants(userId),
        GRANT_QUIET_MS,
      );
      timer.unref?.();
      this.pending.set(userId, { assignmentIds, timer });
      return notice;
    } catch (e) {
      this.logger.warn(
        `Could not queue the access email for user ${userId}: ${(e as Error).message}`,
      );
      return { status: 'no_email', email: null };
    }
  }

  /** The one letter for everything given to `userId` in the window. */
  async flushGrants(userId: string): Promise<void> {
    const entry = this.pending.get(userId);
    if (!entry) return;
    this.pending.delete(userId);
    clearTimeout(entry.timer);
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          role: true,
          employeeCode: true,
          passwordHash: true,
          mustChangePassword: true,
        },
      });
      const to = user?.email?.trim();
      if (!user || user.status !== 'ACTIVE' || !to) return;

      const held = await this.prisma.roleAssignment.findMany({
        where: { userId },
        include: { role: true, unit: true },
        orderBy: { createdAt: 'asc' },
      });
      // A grant taken back inside the window is not announced.
      const granted = held.filter((a) => entry.assignmentIds.has(a.id));
      if (!granted.length) return;

      const roles = granted.map((a) => ({
        role: a.role.name,
        unit: a.unit?.name ?? null,
      }));
      // Only someone's first access carries the user ID and password; a later
      // unit or role is told without them (owner's decision, 2026-11-01).
      const firstAccess =
        user.role !== 'ADMIN' && held.length === granted.length;
      const letter = accessGrantedEmail({
        name: user.name,
        employeeCode: user.employeeCode,
        signInUrl: this.signInUrl(),
        defaultPassword: firstAccess ? await this.heldDefault(user) : null,
        granted: roles,
        firstAccess,
      });
      await this.mail.send({ to, ...letter });
      await this.audit.record({
        action: 'access_email_sent',
        entity: 'User',
        entityId: user.id,
        entityLabel: user.name,
        summary: `Access email sent: ${roles
          .map((r) => (r.unit ? `${r.role} (${r.unit})` : r.role))
          .join(', ')}`,
        source: 'system',
      });
    } catch (e) {
      this.logger.warn(
        `Access email for user ${userId} failed: ${(e as Error).message}`,
      );
    }
  }

  // --- a super user reset the password -----------------------------------

  /** Sent at once; the reset itself is already done. */
  async passwordReset(
    user: {
      name: string;
      employeeCode: string;
      email: string | null;
      status: UserStatus;
    },
    defaultPassword: string,
    twoFactorWasOn: boolean,
  ): Promise<AccessEmailNotice> {
    try {
      const notice = await this.reach(user);
      if (notice.status !== 'queued' || !notice.email) return notice;
      const letter = passwordResetEmail({
        name: user.name,
        employeeCode: user.employeeCode,
        signInUrl: this.signInUrl(),
        defaultPassword,
        twoFactorWasOn,
      });
      // Not awaited: the page should not wait on Gmail.
      void this.mail
        .send({ to: notice.email, ...letter })
        .catch((e) =>
          this.logger.warn(
            `Password-reset email to ${user.employeeCode} failed: ${(e as Error).message}`,
          ),
        );
      return notice;
    } catch (e) {
      this.logger.warn(
        `Could not send the password-reset email: ${(e as Error).message}`,
      );
      return { status: 'no_email', email: null };
    }
  }

  // --- everyone still on the default, in one go --------------------------

  /** Who can sign in (ADMIN or a role) and still holds the default. */
  private async defaultPasswordHolders() {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        mustChangePassword: true,
        OR: [{ role: 'ADMIN' }, { roleAssignments: { some: {} } }],
      },
      select: {
        id: true,
        name: true,
        email: true,
        employeeCode: true,
        passwordHash: true,
        mustChangePassword: true,
      },
      orderBy: { employeeCode: 'asc' },
    });
    const holders: typeof users = [];
    for (const u of users) if (await this.heldDefault(u)) holders.push(u);
    return holders;
  }

  /** What the bulk send would do, for the page to confirm. */
  async defaultPasswordAudience() {
    const holders = await this.defaultPasswordHolders();
    return {
      recipients: holders.filter((h) => h.email?.trim()).length,
      withoutEmail: holders
        .filter((h) => !h.email?.trim())
        .map((h) => ({ employeeCode: h.employeeCode, name: h.name })),
      mailOn: await this.mail.canDeliver(),
      run: this.bulk,
    };
  }

  /** The current or last bulk send — cheap, for polling while it runs. */
  defaultPasswordRun(): DefaultPasswordRun | null {
    return this.bulk;
  }

  /**
   * Emails each person who can sign in and still holds the default their
   * sign-in details, one letter each, in the background. Answers at once
   * with the run, which `defaultPasswordRun` then reports on.
   */
  async sendDefaultPasswordNotices(actor: {
    id: string;
    name: string;
  }): Promise<DefaultPasswordRun> {
    if (this.bulk && !this.bulk.finishedAt) {
      throw new ConflictException(
        'The sign-in details are already being sent — wait for that to finish',
      );
    }
    if (!(await this.mail.canDeliver())) {
      throw new BadRequestException(
        'Email is switched off on Integrations, so nothing can be sent',
      );
    }
    const holders = (await this.defaultPasswordHolders()).filter((h) =>
      h.email?.trim(),
    );
    if (!holders.length) {
      throw new BadRequestException(
        'Nobody with access is still on the default password',
      );
    }
    const run: DefaultPasswordRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      startedBy: actor.name,
      total: holders.length,
      sent: 0,
      failed: 0,
    };
    this.bulk = run;
    void this.runBulk(run, holders, actor);
    return run;
  }

  private async runBulk(
    run: DefaultPasswordRun,
    holders: { name: string; email: string | null; employeeCode: string }[],
    actor: { id: string; name: string },
  ): Promise<void> {
    const signInUrl = this.signInUrl();
    for (const [i, h] of holders.entries()) {
      try {
        const letter = passwordResetEmail({
          name: h.name,
          employeeCode: h.employeeCode,
          signInUrl,
          defaultPassword: defaultPasswordFor(h.employeeCode),
          twoFactorWasOn: false,
        });
        await this.mail.send({ to: h.email!.trim(), ...letter });
        run.sent++;
      } catch (e) {
        run.failed++;
        this.logger.warn(
          `Sign-in details to ${h.employeeCode} failed: ${(e as Error).message}`,
        );
      }
      if (i < holders.length - 1) await sleep(BULK_GAP_MS);
    }
    run.finishedAt = new Date().toISOString();
    await this.audit.record({
      actor: { id: actor.id, name: actor.name, type: 'user' },
      action: 'default_password_notices_sent',
      entity: 'User',
      summary: `Sign-in details emailed to ${run.sent} of ${run.total} people still on the default password${run.failed ? ` (${run.failed} failed)` : ''}`,
      source: 'system',
    });
  }
}
