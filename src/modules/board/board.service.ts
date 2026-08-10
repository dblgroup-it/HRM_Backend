import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { MailService } from '../integrations/mail/mail.service';

@Injectable()
export class BoardService {
  private readonly logger = new Logger(BoardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /* ─── Board Groups ─── */

  listGroups() {
    return this.prisma.boardGroup.findMany({
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, employeeCode: true,
                employee: { select: { designation: true, department: true } } },
            },
          },
          orderBy: { addedAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createGroup(name: string, description?: string) {
    return this.prisma.boardGroup.create({ data: { name, description } });
  }

  async updateGroup(id: string, name?: string, description?: string) {
    await this.requireGroup(id);
    return this.prisma.boardGroup.update({ where: { id }, data: { name, description } });
  }

  async deleteGroup(id: string) {
    await this.requireGroup(id);
    await this.prisma.boardGroup.delete({ where: { id } });
    return { ok: true };
  }

  async addMembers(groupId: string, userIds: string[]) {
    await this.requireGroup(groupId);
    await this.prisma.boardGroupMember.createMany({
      data: userIds.map((userId) => ({ groupId, userId })),
      skipDuplicates: true,
    });
    return this.groupById(groupId);
  }

  async removeMember(groupId: string, userId: string) {
    await this.requireGroup(groupId);
    await this.prisma.boardGroupMember.deleteMany({ where: { groupId, userId } });
    return this.groupById(groupId);
  }

  /* ─── Board Approval ─── */

  async sendForApproval(candidateId: string, memberIds: string[], requestedById: string) {
    await this.requireRecruitmentRole(requestedById);

    const candidate = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');
    const ob = await this.prisma.onboarding.findUnique({ where: { candidateId } });
    if (!ob) throw new BadRequestException('Candidate is not in the onboarding stage');

    if (!memberIds.length) throw new BadRequestException('Select at least one board member');

    const users = await this.prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, name: true, email: true },
    });
    if (!users.length) throw new NotFoundException('No valid board members found');

    // Create or update approval request
    const existing = await this.prisma.boardApproval.findFirst({
      where: { candidateId },
    });

    let approval: { id: string };
    if (existing) {
      approval = await this.prisma.boardApproval.update({
        where: { id: existing.id },
        data: { requestedById, status: 'pending', updatedAt: new Date() },
      });
    } else {
      approval = await this.prisma.boardApproval.create({
        data: { candidateId, requestedById, status: 'pending' },
      });
    }

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    const frontendUrl = this.config.get<string>('corsOrigin') ?? 'http://localhost:3000';

    // Delete any existing pending votes for these members on this approval
    await this.prisma.boardApprovalVote.deleteMany({
      where: { boardApprovalId: approval.id, userId: { in: users.map((u) => u.id) }, status: 'pending' },
    });

    for (const user of users) {
      if (!user.email) {
        this.logger.warn(`Board member ${user.name} has no email — skipping`);
        continue;
      }

      const token = crypto.randomBytes(32).toString('hex');

      await this.prisma.boardApprovalVote.create({
        data: { boardApprovalId: approval.id, userId: user.id, token, tokenExpiresAt: expiresAt, status: 'pending' },
      });

      // Send email
      const voteUrl = `${frontendUrl}/board-vote/${token}`;
      try {
        await this.mail.send({
          to: user.email,
          subject: `Board Approval Request — ${candidate.name} for ${candidate.requisition.designation}`,
          html: this.buildApprovalEmail(user.name, candidate, candidate.requisition, voteUrl),
        });
      } catch (e) {
        this.logger.error(`Failed to send board approval email to ${user.email}: ${(e as Error).message}`);
      }
    }

    return this.getApprovalStatus(candidateId);
  }

  async getApprovalStatus(candidateId: string) {
    const approval = await this.prisma.boardApproval.findFirst({
      where: { candidateId },
      include: {
        votes: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { respondedAt: { sort: 'asc', nulls: 'last' } },
        },
        requestedBy: { select: { id: true, name: true } },
        hrApprovedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) return null;
    return serializeApproval(approval);
  }

  async hrApprove(candidateId: string, userId: string, note?: string) {
    await this.requireRecruitmentRole(userId);

    const candidate = await this.prisma.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new NotFoundException('Candidate not found');
    const ob = await this.prisma.onboarding.findUnique({ where: { candidateId } });
    if (!ob) throw new BadRequestException('Candidate is not in the onboarding stage');

    const existing = await this.prisma.boardApproval.findFirst({ where: { candidateId } });
    if (existing) {
      await this.prisma.boardApproval.update({
        where: { id: existing.id },
        data: { status: 'approved', hrApprovedById: userId, hrApprovalNote: note ?? null, hrApprovedAt: new Date() },
      });
    } else {
      await this.prisma.boardApproval.create({
        data: { candidateId, requestedById: userId, status: 'approved', hrApprovedById: userId, hrApprovalNote: note ?? null, hrApprovedAt: new Date() },
      });
    }
    return this.getApprovalStatus(candidateId);
  }

  /* ─── Public vote ─── */

  async getVoteInfo(token: string) {
    const vote = await this.prisma.boardApprovalVote.findUnique({
      where: { token },
      include: {
        user: { select: { id: true, name: true } },
        boardApproval: {
          include: {
            candidate: { include: { requisition: true } },
          },
        },
      },
    });

    if (!vote) throw new NotFoundException('This approval link is invalid or has been removed.');
    if (new Date() > vote.tokenExpiresAt) throw new BadRequestException('This approval link has expired.');
    if (vote.status === 'approved') {
      return { alreadyVoted: true, memberName: vote.user.name };
    }

    const { candidate } = vote.boardApproval;
    return {
      alreadyVoted: false,
      memberName: vote.user.name,
      candidate: {
        name: candidate.name,
        designation: candidate.requisition.designation,
        unit: candidate.requisition.unitFactory,
        department: candidate.requisition.department,
        code: candidate.requisition.code,
        cvUrl: candidate.cvUrl,
        matchScore: candidate.matchScore,
        matchSummary: candidate.matchSummary,
      },
    };
  }

  async submitVote(token: string, notes?: string) {
    const vote = await this.prisma.boardApprovalVote.findUnique({
      where: { token },
      include: {
        user: { select: { id: true, name: true } },
        boardApproval: {
          include: { candidate: { include: { requisition: true } }, requestedBy: { select: { id: true, name: true } } },
        },
      },
    });

    if (!vote) throw new NotFoundException('Invalid approval link.');
    if (new Date() > vote.tokenExpiresAt) throw new BadRequestException('This link has expired.');
    if (vote.status === 'approved') return { ok: true, alreadyVoted: true };

    await this.prisma.boardApprovalVote.update({
      where: { id: vote.id },
      data: { status: 'approved', notes: notes ?? null, respondedAt: new Date() },
    });

    // Any single approval → mark parent as approved
    await this.prisma.boardApproval.update({
      where: { id: vote.boardApprovalId },
      data: { status: 'approved' },
    });

    // Notify HR (in-app)
    const { candidate } = vote.boardApproval;
    try {
      await this.notifications.notify(vote.boardApproval.requestedBy.id, {
        type: 'board_approval',
        title: 'Board Approval Received',
        message: `${vote.user.name} approved ${candidate.name} for ${candidate.requisition.designation}.`,
        link: `/onboarding/manage/${candidate.id}`,
      });
    } catch (e) {
      this.logger.warn('Failed to send board approval notification');
    }

    return { ok: true, alreadyVoted: false };
  }

  /* ─── Helpers ─── */

  private async requireGroup(id: string) {
    const g = await this.prisma.boardGroup.findUnique({ where: { id } });
    if (!g) throw new NotFoundException('Board group not found');
    return g;
  }

  private groupById(id: string) {
    return this.prisma.boardGroup.findUnique({
      where: { id },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, employeeCode: true,
                employee: { select: { designation: true, department: true } } },
            },
          },
        },
      },
    });
  }

  private async requireRecruitmentRole(userId: string) {
    const ok =
      (await this.permissions.isSuperUser(userId)) ||
      Boolean(await this.prisma.roleAssignment.findFirst({
        where: { userId, role: { key: { in: ['corporate_hr', 'chro'] } } },
      }));
    if (!ok) throw new ForbiddenException('Only Corporate HR, CHRO or super users can manage board approvals');
  }

  private buildApprovalEmail(
    memberName: string,
    candidate: { name: string; cvUrl: string | null; matchScore: number | null; matchSummary: string | null },
    req: { code: string; designation: string; unitFactory: string; department: string },
    voteUrl: string,
  ): string {
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const scoreRow = candidate.matchScore != null ? `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e9eef4;color:#6b7c93;font-size:13px;font-family:Arial,Helvetica,sans-serif;width:150px;vertical-align:middle">AI Match Score</td>
        <td style="padding:10px 0 10px 20px;border-bottom:1px solid #e9eef4;font-family:Arial,Helvetica,sans-serif;vertical-align:middle">
          <span style="display:inline-block;background:#eef4ff;color:#1877c0;font-size:12px;font-weight:700;padding:3px 11px;border-radius:20px;border:1px solid #c3d9f8;letter-spacing:0.3px">
            ${Math.round(candidate.matchScore)}% Match
          </span>
        </td>
      </tr>` : '';

    const cvRow = candidate.cvUrl ? `
      <tr>
        <td style="padding:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b7c93;vertical-align:middle">Curriculum Vitae</td>
        <td style="padding:14px 0 0 20px;font-family:Arial,Helvetica,sans-serif;vertical-align:middle">
          <a href="${candidate.cvUrl}" style="color:#1877c0;font-size:13px;font-weight:600;text-decoration:none">
            View CV / Resume →
          </a>
        </td>
      </tr>` : '';

    return `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#1a202c">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:36px 16px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.08)">

  <!-- Top accent bar -->
  <tr><td style="background:linear-gradient(to right,#1877c0,#8cc63f);height:4px;font-size:0;line-height:0">&nbsp;</td></tr>

  <!-- Header -->
  <tr><td style="background:#ffffff;padding:28px 36px 20px;border-bottom:1px solid #e9eef4">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align:middle">
          <p style="margin:0;font-size:18px;font-weight:700;color:#1877c0;letter-spacing:-0.2px">DBL Group</p>
          <p style="margin:3px 0 0;font-size:12px;color:#6b7c93;letter-spacing:0.3px">HR Department &nbsp;·&nbsp; Board Approval Notice</p>
        </td>
        <td style="vertical-align:middle;text-align:right">
          <p style="margin:0;font-size:12px;color:#6b7c93">${today}</p>
          <p style="margin:3px 0 0;font-size:11px;color:#a0aec0">Ref: ${req.code}</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:36px 36px 40px">

    <!-- Salutation -->
    <p style="margin:0 0 6px;font-size:15px;color:#1a202c">Dear <strong>${memberName}</strong>,</p>
    <p style="margin:0 0 28px;font-size:14px;color:#4a5568;line-height:1.8">
      The HR Department of DBL Group respectfully requests your board-level approval for the appointment of the candidate below.
      Your authorisation is required as part of our formal hiring governance process before we proceed with onboarding.
    </p>

    <!-- Candidate card -->
    <div style="background:#f7faff;border:1px solid #c3d9f8;border-radius:8px;padding:20px 24px;margin-bottom:28px">
      <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#1a202c">${candidate.name}</p>
      <p style="margin:0;font-size:13px;color:#6b7c93">Proposed for: <strong style="color:#1877c0">${req.designation}</strong></p>
    </div>

    <!-- Details table -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;margin-bottom:28px">
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e9eef4;color:#6b7c93;width:150px;vertical-align:middle">Business Unit</td>
        <td style="padding:10px 0 10px 20px;border-bottom:1px solid #e9eef4;color:#1a202c;font-weight:600;vertical-align:middle">${req.unitFactory}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e9eef4;color:#6b7c93;vertical-align:middle">Department</td>
        <td style="padding:10px 0 10px 20px;border-bottom:1px solid #e9eef4;color:#1a202c;font-weight:600;vertical-align:middle">${req.department}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e9eef4;color:#6b7c93;vertical-align:middle">Requisition Ref.</td>
        <td style="padding:10px 0 10px 20px;border-bottom:1px solid #e9eef4;color:#1a202c;font-weight:600;vertical-align:middle">${req.code}</td>
      </tr>
      ${scoreRow}
      ${cvRow}
    </table>

    <!-- Divider -->
    <div style="height:1px;background:#e9eef4;margin-bottom:28px"></div>

    <!-- Action text -->
    <p style="margin:0 0 20px;font-size:14px;color:#4a5568;line-height:1.8">
      Kindly review the candidate's profile and, if you are satisfied, record your approval using the button below.
      You may also add any remarks you consider appropriate. A single board approval is sufficient to proceed.
    </p>

    <!-- CTA Button -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center" style="padding:4px 0 32px">
        <a href="${voteUrl}"
          style="display:inline-block;background:#1877c0;color:#ffffff;font-size:14px;font-weight:700;padding:15px 48px;border-radius:6px;text-decoration:none;letter-spacing:0.3px">
          Record Your Approval
        </a>
      </td></tr>
    </table>

    <!-- Closing -->
    <p style="margin:0 0 4px;font-size:14px;color:#4a5568">Yours sincerely,</p>
    <p style="margin:0 0 2px;font-size:14px;font-weight:700;color:#1a202c">HR Department</p>
    <p style="margin:0;font-size:13px;color:#6b7c93">DBL Group</p>

  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f4f6f9;border-top:1px solid #e9eef4;padding:18px 36px">
    <p style="margin:0;font-size:11px;color:#a0aec0;line-height:1.7">
      <strong style="color:#6b7c93">CONFIDENTIAL</strong> — This notice is intended solely for the named recipient.
      The approval link is personal, valid for 30 days, and must not be forwarded or shared.
    </p>
    <p style="margin:8px 0 0;font-size:11px;color:#a0aec0">DBL Group · HR Department · Automated Notice</p>
  </td></tr>

  <!-- Bottom accent bar -->
  <tr><td style="background:linear-gradient(to right,#1877c0,#8cc63f);height:3px;font-size:0;line-height:0">&nbsp;</td></tr>

</table>
</td></tr></table>
</body></html>`;
  }
}

/* ─── Serializer ─── */
function serializeApproval(approval: {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  requestedBy: { id: string; name: string };
  hrApprovedBy: { id: string; name: string } | null;
  hrApprovalNote: string | null;
  hrApprovedAt: Date | null;
  votes: Array<{
    id: string;
    status: string;
    notes: string | null;
    respondedAt: Date | null;
    tokenExpiresAt: Date;
    user: { id: string; name: string; email: string | null };
  }>;
}) {
  return {
    id: approval.id,
    status: approval.status,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
    requestedBy: approval.requestedBy,
    hrApprovedBy: approval.hrApprovedBy,
    hrApprovalNote: approval.hrApprovalNote,
    hrApprovedAt: approval.hrApprovedAt?.toISOString() ?? null,
    votes: approval.votes.map((v) => ({
      id: v.id,
      status: v.status,
      notes: v.notes,
      respondedAt: v.respondedAt?.toISOString() ?? null,
      tokenExpiresAt: v.tokenExpiresAt.toISOString(),
      member: v.user,
    })),
  };
}
