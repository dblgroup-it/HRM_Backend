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
import { DriveService } from '../integrations/google/drive.service';
import { RecruitmentService } from '../candidates/recruitment.service';

/** Multer file subset we use for the HR-approval attachment upload. */
export interface UploadedAttachment {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

const STAGE_SUBJECT: Record<string, string> = {
  corporate_hr: 'Corporate HR Approval Required',
  chro: 'CHRO Approval Required',
  board: 'Board Approval Request',
};

const STAGE_LABEL: Record<string, string> = {
  corporate_hr: 'Corporate HR',
  chro: 'CHRO',
  board: 'Board',
};

/** The link that follows each stage; `null` ends the chain. */
const NEXT_STAGE: Record<string, 'chro' | 'board' | null> = {
  corporate_hr: 'chro',
  chro: 'board',
  board: null,
};

@Injectable()
export class BoardService {
  private readonly logger = new Logger(BoardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly drive: DriveService,
    private readonly recruitment: RecruitmentService,
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

  async sendForApproval(
    candidateId: string,
    memberIds: string[],
    requestedById: string,
    corporateHrId?: string,
    chroId?: string,
  ) {
    await this.requireRecruitmentRole(requestedById, candidateId);

    const candidate = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');
    const ob = await this.prisma.onboarding.findUnique({ where: { candidateId } });
    if (!ob) throw new BadRequestException('Candidate is not in the onboarding stage');

    if (!memberIds.length) throw new BadRequestException('Select at least one board member');

    // The whole chain signs off on this figure, so refuse to start without it.
    await this.fixedSalary(candidateId);

    const users = await this.prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true },
    });
    if (!users.length) throw new NotFoundException('No valid board members found');

    const stage = await this.startingStage(
      requestedById,
      candidate.requisition.unitFactory,
    );

    // Only meaningful when the chain actually starts at Corporate HR.
    let chosenCorporateHrId: string | null = null;
    if (stage === 'corporate_hr') {
      const holders = await this.permissions.roleHolders(
        'corporate_hr',
        candidate.requisition.unitFactory,
      );
      if (!holders.length) {
        throw new BadRequestException(
          `Nobody holds Corporate HR for ${candidate.requisition.unitFactory}, so this cannot be sent for approval.`,
        );
      }
      if (!corporateHrId) {
        throw new BadRequestException(
          'Choose which Corporate HR should approve this.',
        );
      }
      if (!holders.some((h) => h.id === corporateHrId)) {
        throw new BadRequestException(
          'That person does not hold Corporate HR for this unit.',
        );
      }
      chosenCorporateHrId = corporateHrId;
    }

    // The CHRO link is reached from both the corporate_hr and chro starts, so
    // it is named in either case.
    let chosenChroId: string | null = null;
    if (stage === 'corporate_hr' || stage === 'chro') {
      const holders = await this.permissions.roleHolders(
        'chro',
        candidate.requisition.unitFactory,
      );
      if (!holders.length) {
        throw new BadRequestException(
          `Nobody holds the CHRO role for ${candidate.requisition.unitFactory}, so this cannot be sent for approval.`,
        );
      }
      if (!chroId) {
        throw new BadRequestException('Choose which CHRO should approve this.');
      }
      if (!holders.some((h) => h.id === chroId)) {
        throw new BadRequestException(
          'That person does not hold the CHRO role for this unit.',
        );
      }
      chosenChroId = chroId;
    }

    const existing = await this.prisma.boardApproval.findFirst({
      where: { candidateId },
    });

    const approval = existing
      ? await this.prisma.boardApproval.update({
          where: { id: existing.id },
          data: {
            requestedById,
            status: 'pending',
            currentStage: stage,
            corporateHrId: chosenCorporateHrId,
            chroId: chosenChroId,
            boardMemberIds: users.map((u) => u.id),
            rejectedReason: null,
            rejectedAt: null,
            updatedAt: new Date(),
          },
        })
      : await this.prisma.boardApproval.create({
          data: {
            candidateId,
            requestedById,
            status: 'pending',
            currentStage: stage,
            corporateHrId: chosenCorporateHrId,
            chroId: chosenChroId,
            boardMemberIds: users.map((u) => u.id),
          },
        });

    await this.openStage(approval.id, stage);

    return this.getApprovalStatus(candidateId);
  }

  /**
   * Who the requester may send the first link to.
   *
   * Several people hold Corporate HR, so the chain names one rather than
   * mailing them all — this is the list the send dialog offers.
   */
  async listChainApprovers(candidateId: string, userId: string) {
    await this.requireRecruitmentRole(userId, candidateId);
    const cand = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: { select: { unitFactory: true } } },
    });
    if (!cand) throw new NotFoundException('Candidate not found');

    const [corporateHr, chro] = await Promise.all([
      this.permissions.roleHolders('corporate_hr', cand.requisition.unitFactory),
      this.permissions.roleHolders('chro', cand.requisition.unitFactory),
    ]);
    const startsAt = await this.startingStage(
      userId,
      cand.requisition.unitFactory,
    );
    return { corporateHr, chro, startsAt };
  }

  /** The stage a request starts at — whoever raises it skips their own link. */
  private async startingStage(
    requesterId: string,
    unitName: string,
  ): Promise<'corporate_hr' | 'chro' | 'board'> {
    // Deliberately checks actual role holders rather than hasRoleForUnitName:
    // that helper bypasses for super users, which made a super user look like
    // the CHRO and skip the whole chain straight to the board.
    const [chro, corporateHr] = await Promise.all([
      this.permissions.roleHolders('chro', unitName),
      this.permissions.roleHolders('corporate_hr', unitName),
    ]);
    if (chro.some((h) => h.id === requesterId)) return 'board';
    if (corporateHr.some((h) => h.id === requesterId)) return 'chro';
    return 'corporate_hr';
  }

  /** The fixed salary these approvers are signing off on. */
  private async fixedSalary(candidateId: string): Promise<number> {
    const sf = await this.prisma.salaryFixation.findUnique({
      where: { candidateId },
      select: { status: true, proposedSalary: true, proposedSalaryOverride: true },
    });
    const amount = sf?.proposedSalaryOverride ?? sf?.proposedSalary ?? null;
    if (sf?.status !== 'fixed' || amount == null) {
      throw new BadRequestException(
        'Fix this candidate\'s salary before sending for approval — Corporate HR, the CHRO and the board are signing off on that figure.',
      );
    }
    return amount;
  }

  /**
   * Create and email the votes for one link in the chain.
   *
   * Corporate HR and CHRO steps go to the role's holders for the unit; the
   * board step goes to the members picked when the request was raised.
   */
  private async openStage(
    approvalId: string,
    stage: 'corporate_hr' | 'chro' | 'board',
  ): Promise<void> {
    const approval = await this.prisma.boardApproval.findUniqueOrThrow({
      where: { id: approvalId },
      include: { candidate: { include: { requisition: true } } },
    });
    const { candidate } = approval;

    // Corporate HR was named by the requester; the CHRO link goes to whoever
    // holds that role for the unit (any one of them may sign).
    const recipientIds =
      stage === 'board'
        ? approval.boardMemberIds
        : stage === 'corporate_hr' && approval.corporateHrId
          ? [approval.corporateHrId]
          : stage === 'chro' && approval.chroId
            ? [approval.chroId]
          : (
              await this.permissions.roleHolders(
                stage,
                candidate.requisition.unitFactory,
              )
            ).map((h) => h.id);

    if (!recipientIds.length) {
      throw new BadRequestException(
        stage === 'board'
          ? 'No board members were selected for this request.'
          : `Nobody holds the ${stage === 'chro' ? 'CHRO' : 'Corporate HR'} role for ${candidate.requisition.unitFactory}, so the chain cannot continue.`,
      );
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, name: true, email: true },
    });

    const salary = await this.fixedSalary(candidate.id);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const frontendUrl =
      this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';

    await this.prisma.boardApproval.update({
      where: { id: approvalId },
      data: { currentStage: stage },
    });

    // Clear any stale pending votes for this stage before re-opening it.
    await this.prisma.boardApprovalVote.deleteMany({
      where: { boardApprovalId: approvalId, stage, status: 'pending' },
    });

    for (const user of users) {
      if (!user.email) {
        this.logger.warn(`${user.name} has no email — skipping`);
        continue;
      }
      const token = crypto.randomBytes(32).toString('hex');
      await this.prisma.boardApprovalVote.create({
        data: {
          boardApprovalId: approvalId,
          userId: user.id,
          token,
          tokenExpiresAt: expiresAt,
          stage,
          status: 'pending',
        },
      });
      try {
        await this.mail.send({
          to: user.email,
          subject: `${STAGE_SUBJECT[stage]} — ${candidate.name} for ${candidate.requisition.designation}`,
          html: this.buildApprovalEmail(
            user.name,
            { ...candidate, salary },
            candidate.requisition,
            `${frontendUrl}/board-vote/${token}`,
            stage,
          ),
        });
      } catch (e) {
        this.logger.error(
          `Failed to send ${stage} approval email to ${user.email}: ${(e as Error).message}`,
        );
      }
    }
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
        corporateHr: { select: { id: true, name: true } },
        chro: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) return null;
    return serializeApproval(approval);
  }

  async hrApprove(
    candidateId: string,
    userId: string,
    note: string | undefined,
    file: UploadedAttachment | undefined,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Attach a document justifying the approval (a note alone is not enough).',
      );
    }

    const candidate = await this.prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { requisition: true },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');

    // Requisition-scoped, so the assigned recruiter counts too — hence this
    // runs after the candidate load rather than the global role check.
    await this.permissions.requireRecruitmentAccess(
      userId,
      candidate.requisition.unitFactory,
      candidate.requisition.recruiterId,
      'approve this board approval',
    );
    const ob = await this.prisma.onboarding.findUnique({ where: { candidateId } });
    if (!ob) throw new BadRequestException('Candidate is not in the onboarding stage');

    const ws = await this.recruitment.ensureWorkspace(candidate.requisition);
    if (!ws) {
      throw new BadRequestException(
        'Document upload is temporarily unavailable. Please try again later.',
      );
    }
    let uploaded: { id: string; url: string };
    try {
      const folder = await this.drive.ensureFolder(
        `${candidate.name} — Joining Docs`,
        ws.joiningFolderId,
      );
      uploaded = await this.drive.uploadFile(folder, {
        name: `Board HR Approval — ${file.originalname}`,
        mimeType: file.mimetype,
        buffer: file.buffer,
      });
      await this.drive.shareAnyoneWithLink(uploaded.id, 'reader');
    } catch (e) {
      this.logger.error(`Failed to upload board HR approval attachment: ${(e as Error).message}`);
      throw new BadRequestException(
        'Could not upload the attachment. Please try again later.',
      );
    }

    const data = {
      status: 'approved' as const,
      hrApprovedById: userId,
      hrApprovalNote: note ?? null,
      hrApprovalAttachmentFileId: uploaded.id,
      hrApprovalAttachmentUrl: uploaded.url,
      hrApprovalAttachmentName: file.originalname,
      hrApprovedAt: new Date(),
    };

    const existing = await this.prisma.boardApproval.findFirst({ where: { candidateId } });
    if (existing) {
      await this.prisma.boardApproval.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.boardApproval.create({ data: { candidateId, requestedById: userId, ...data } });
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
    if (vote.status !== 'pending') {
      return {
        alreadyVoted: true,
        memberName: vote.user.name,
        decision: vote.status,
      };
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
        // The AI match score is deliberately withheld: this chain signs off on
        // the agreed salary, which is the figure that matters here.
        salary: await this.fixedSalary(candidate.id).catch(() => null),
      },
      stage: vote.stage,
      stageLabel: STAGE_LABEL[vote.stage] ?? 'Board',
    };
  }

  async submitVote(
    token: string,
    notes?: string,
    decision: 'approved' | 'rejected' = 'approved',
  ) {
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
    if (vote.status !== 'pending') return { ok: true, alreadyVoted: true };

    if (decision === 'rejected' && !notes?.trim()) {
      throw new BadRequestException('Give a reason when rejecting.');
    }

    await this.prisma.boardApprovalVote.update({
      where: { id: vote.id },
      data: { status: decision, notes: notes ?? null, respondedAt: new Date() },
    });

    const { candidate } = vote.boardApproval;
    const stageLabel = STAGE_LABEL[vote.stage] ?? 'Board';

    if (decision === 'rejected') {
      // One rejection stops the chain — later links are never opened.
      await this.prisma.boardApproval.update({
        where: { id: vote.boardApprovalId },
        data: {
          status: 'rejected',
          rejectedReason: notes?.trim() ?? null,
          rejectedAt: new Date(),
        },
      });
      await this.notifyRequester(
        vote.boardApproval.requestedBy.id,
        `${stageLabel} rejected ${candidate.name}`,
        `${vote.user.name} rejected ${candidate.name} for ${candidate.requisition.designation} — "${notes?.trim() ?? ''}"`,
        candidate.id,
      );
      return { ok: true, alreadyVoted: false, decision: 'rejected' as const };
    }

    const next = NEXT_STAGE[vote.stage] ?? null;
    if (next) {
      // Hand on to the next link rather than completing the approval.
      await this.openStage(vote.boardApprovalId, next);
      await this.notifyRequester(
        vote.boardApproval.requestedBy.id,
        `${stageLabel} approved ${candidate.name}`,
        `${vote.user.name} approved ${candidate.name}. Sent on to ${STAGE_LABEL[next]}.`,
        candidate.id,
      );
      return { ok: true, alreadyVoted: false, decision: 'approved' as const };
    }

    // Board stage — any single member approving completes it, as before.
    await this.prisma.boardApproval.update({
      where: { id: vote.boardApprovalId },
      data: { status: 'approved' },
    });
    await this.notifyRequester(
      vote.boardApproval.requestedBy.id,
      'Board Approval Received',
      `${vote.user.name} approved ${candidate.name} for ${candidate.requisition.designation}.`,
      candidate.id,
    );

    return { ok: true, alreadyVoted: false, decision: 'approved' as const };
  }

  private async notifyRequester(
    userId: string,
    title: string,
    message: string,
    candidateId: string,
  ): Promise<void> {
    try {
      await this.notifications.notify(userId, {
        type: 'board_approval',
        title,
        message,
        link: `/onboarding/manage/${candidateId}`,
      });
    } catch {
      this.logger.warn('Failed to send board approval notification');
    }
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

  /**
   * Who may raise a board approval.
   *
   * Includes the Corporate Recruiter assigned to the requisition — they own
   * the candidate at this point and are the usual starter of the chain, which
   * a corporate_hr/chro-only check made impossible.
   */
  private async requireRecruitmentRole(userId: string, candidateId?: string) {
    if (candidateId) {
      const cand = await this.prisma.candidate.findUnique({
        where: { id: candidateId },
        select: {
          requisition: { select: { unitFactory: true, recruiterId: true } },
        },
      });
      if (cand) {
        await this.permissions.requireRecruitmentAccess(
          userId,
          cand.requisition.unitFactory,
          cand.requisition.recruiterId,
          'manage board approvals for this candidate',
        );
        return;
      }
    }
    const ok =
      (await this.permissions.isSuperUser(userId)) ||
      Boolean(await this.prisma.roleAssignment.findFirst({
        where: { userId, role: { key: { in: ['corporate_hr', 'chro'] } } },
      }));
    if (!ok) throw new ForbiddenException('Only Corporate HR, CHRO or super users can manage board approvals');
  }

  private buildApprovalEmail(
    memberName: string,
    candidate: { name: string; cvUrl: string | null; salary: number },
    req: { code: string; designation: string; unitFactory: string; department: string },
    voteUrl: string,
    stage: 'corporate_hr' | 'chro' | 'board' = 'board',
  ): string {
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // The AI match score is deliberately not shown: this chain signs off on
    // the agreed salary, and a screening percentage was noise beside it.
    const salaryText = new Intl.NumberFormat('en-BD', {
      style: 'currency',
      currency: 'BDT',
      maximumFractionDigits: 0,
    }).format(candidate.salary);

    const scoreRow = `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e9eef4;color:#6b7c93;font-size:13px;font-family:Arial,Helvetica,sans-serif;width:150px;vertical-align:middle">Salary Fixed Amount</td>
        <td style="padding:10px 0 10px 20px;border-bottom:1px solid #e9eef4;font-family:Arial,Helvetica,sans-serif;vertical-align:middle">
          <span style="display:inline-block;background:#eafaf1;color:#127a45;font-size:13px;font-weight:700;padding:4px 12px;border-radius:20px;border:1px solid #b7e4cd;letter-spacing:0.3px">
            ${salaryText}
          </span>
        </td>
      </tr>`;

    const stageNote =
      stage === 'board'
        ? ''
        : `<p style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b7c93;line-height:1.6">
             You are being asked as <strong style="color:#33475b">${STAGE_LABEL[stage]}</strong>.
             ${
               stage === 'corporate_hr'
                 ? 'Once you approve, this goes to the CHRO, and then to the board.'
                 : 'Once you approve, this goes to the board.'
             }
           </p>`;

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
      ${
        stage === 'board'
          ? 'The HR Department of DBL Group respectfully requests your board-level approval for the appointment of the candidate below.'
          : `The HR Department of DBL Group respectfully requests your approval, as ${STAGE_LABEL[stage]}, for the appointment of the candidate below.`
      }
      Your authorisation is required as part of our formal hiring governance process before we proceed with onboarding.
    </p>
    ${stageNote}

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
      You may also add any remarks you consider appropriate.
      ${
        stage === 'corporate_hr'
          ? 'Once you approve, the request goes to the CHRO, and then to the board.'
          : stage === 'chro'
            ? 'Once you approve, the request goes to the board.'
            : 'A single board approval is sufficient to proceed.'
      }
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
  currentStage: string;
  rejectedReason: string | null;
  rejectedAt: Date | null;
  corporateHr: { id: string; name: string } | null;
  chro: { id: string; name: string } | null;
  boardMemberIds: string[];
  createdAt: Date;
  updatedAt: Date;
  requestedBy: { id: string; name: string };
  hrApprovedBy: { id: string; name: string } | null;
  hrApprovalNote: string | null;
  hrApprovalAttachmentUrl: string | null;
  hrApprovalAttachmentName: string | null;
  hrApprovedAt: Date | null;
  votes: Array<{
    id: string;
    status: string;
    stage: string;
    notes: string | null;
    respondedAt: Date | null;
    tokenExpiresAt: Date;
    user: { id: string; name: string; email: string | null };
  }>;
}) {
  return {
    id: approval.id,
    status: approval.status,
    currentStage: approval.currentStage,
    rejectedReason: approval.rejectedReason,
    rejectedAt: approval.rejectedAt?.toISOString() ?? null,
    corporateHr: approval.corporateHr,
    chro: approval.chro,
    boardMemberCount: approval.boardMemberIds.length,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
    requestedBy: approval.requestedBy,
    hrApprovedBy: approval.hrApprovedBy,
    hrApprovalNote: approval.hrApprovalNote,
    hrApprovalAttachmentUrl: approval.hrApprovalAttachmentUrl,
    hrApprovalAttachmentName: approval.hrApprovalAttachmentName,
    hrApprovedAt: approval.hrApprovedAt?.toISOString() ?? null,
    votes: approval.votes.map((v) => ({
      id: v.id,
      stage: v.stage,
      status: v.status,
      notes: v.notes,
      respondedAt: v.respondedAt?.toISOString() ?? null,
      tokenExpiresAt: v.tokenExpiresAt.toISOString(),
      member: v.user,
    })),
  };
}
