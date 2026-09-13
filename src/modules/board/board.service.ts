import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as ExcelJS from 'exceljs';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { NotificationsService } from '../realtime/notifications.service';
import { MailService } from '../integrations/mail/mail.service';
import { DriveService } from '../integrations/google/drive.service';
import { RecruitmentService } from '../candidates/recruitment.service';

/**
 * The requisition's sign-off chain written as one line.
 *
 * An approver being asked to sanction a hire wants to know who already
 * sanctioned the vacancy. The full activity trail is a page of its own; what
 * belongs on a sheet is the shape of the chain — who, in what order, on what
 * date — short enough to sit under the row that it explains.
 */
function approvalChainLine(
  steps: {
    orderIndex: number;
    title: string;
    assignee: string;
    status: string;
    actedAt: Date | null;
  }[],
  raisedBy: string | null,
): string {
  const day = (d: Date | null) =>
    d
      ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : null;

  const links = [...steps]
    .sort((a, z) => a.orderIndex - z.orderIndex)
    .filter((st) => st.status === 'APPROVED')
    .map((st) => {
      const when = day(st.actedAt);
      const who = st.assignee || st.title;
      return when ? `${who} (${when})` : who;
    });

  if (!links.length) return '';
  // The raiser is not a sign-off step, but the chain starts with them and a
  // reader needs to know whose requisition this was.
  return [raisedBy ? `Raised by ${raisedBy}` : null, ...links]
    .filter(Boolean)
    .join(' → ');
}

/**
 * The derived block of a stored `CvProfile`, if the candidate has one.
 *
 * Read defensively: the column is JSON written by an earlier import, so its
 * shape is whatever that version of the mapper produced.
 */
function cvSummary(cvProfile: unknown): {
  latestEducation?: string;
  totalExperienceLabel?: string;
  lastOrganization?: string;
} | null {
  if (!cvProfile || typeof cvProfile !== 'object') return null;
  const summary = (cvProfile as { summary?: unknown }).summary;
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as Record<string, unknown>;
  const str = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v : undefined;
  return {
    latestEducation: str(s.latestEducation),
    totalExperienceLabel: str(s.totalExperienceLabel),
    lastOrganization: str(s.lastOrganization),
  };
}

/** Multer file subset we use for the HR-approval attachment upload. */
export interface UploadedAttachment {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

const STAGE_SUBJECT: Record<string, string> = {
  corporate_hr: 'Head of Talent Acquisition Approval Required',
  chro: 'CHRO Approval Required',
  board: 'Board Approval Request',
};

const STAGE_LABEL: Record<string, string> = {
  corporate_hr: 'Head of Talent Acquisition',
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
              select: {
                id: true,
                name: true,
                email: true,
                employeeCode: true,
                employee: { select: { designation: true, department: true } },
              },
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
    return this.prisma.boardGroup.update({
      where: { id },
      data: { name, description },
    });
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
    await this.prisma.boardGroupMember.deleteMany({
      where: { groupId, userId },
    });
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
    const ob = await this.prisma.onboarding.findUnique({
      where: { candidateId },
    });
    if (!ob)
      throw new BadRequestException('Candidate is not in the onboarding stage');

    if (!memberIds.length)
      throw new BadRequestException('Select at least one board member');

    // The whole chain signs off on this figure, so refuse to start without it.
    await this.fixedSalary(candidateId);

    const users = await this.prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true },
    });
    if (!users.length)
      throw new NotFoundException('No valid board members found');

    const stage = await this.startingStage(
      requestedById,
      candidate.requisition.unitFactory,
    );

    // Only meaningful when the chain actually starts at Head of Talent Acquisition.
    let chosenCorporateHrId: string | null = null;
    if (stage === 'corporate_hr') {
      const holders = await this.permissions.roleHolders(
        'corporate_hr',
        candidate.requisition.unitFactory,
      );
      if (!holders.length) {
        throw new BadRequestException(
          `Nobody holds Head of Talent Acquisition for ${candidate.requisition.unitFactory}, so this cannot be sent for approval.`,
        );
      }
      if (!corporateHrId) {
        throw new BadRequestException(
          'Choose which Head of Talent Acquisition should approve this.',
        );
      }
      if (!holders.some((h) => h.id === corporateHrId)) {
        throw new BadRequestException(
          'That person does not hold Head of Talent Acquisition for this unit.',
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
   * Several people hold Head of Talent Acquisition, so the chain names one rather than
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
      this.permissions.roleHolders(
        'corporate_hr',
        cand.requisition.unitFactory,
      ),
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
      select: {
        status: true,
        proposedSalary: true,
        proposedSalaryOverride: true,
      },
    });
    const amount = sf?.proposedSalaryOverride ?? sf?.proposedSalary ?? null;
    if (sf?.status !== 'fixed' || amount == null) {
      throw new BadRequestException(
        "Fix this candidate's salary before sending for approval — Head of Talent Acquisition, the CHRO and the board are signing off on that figure.",
      );
    }
    return amount;
  }

  /**
   * Create and email the votes for one link in the chain.
   *
   * Head of Talent Acquisition and CHRO steps go to the role's holders for the unit; the
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

    // Head of Talent Acquisition was named by the requester; the CHRO link goes to whoever
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
          : `Nobody holds the ${stage === 'chro' ? 'CHRO' : 'Head of Talent Acquisition'} role for ${candidate.requisition.unitFactory}, so the chain cannot continue.`,
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
    const ob = await this.prisma.onboarding.findUnique({
      where: { candidateId },
    });
    if (!ob)
      throw new BadRequestException('Candidate is not in the onboarding stage');

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
      this.logger.error(
        `Failed to upload board HR approval attachment: ${(e as Error).message}`,
      );
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

    const existing = await this.prisma.boardApproval.findFirst({
      where: { candidateId },
    });
    if (existing) {
      await this.prisma.boardApproval.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await this.prisma.boardApproval.create({
        data: { candidateId, requestedById: userId, ...data },
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

    if (!vote)
      throw new NotFoundException(
        'This approval link is invalid or has been removed.',
      );
    if (new Date() > vote.tokenExpiresAt)
      throw new BadRequestException('This approval link has expired.');
    if (vote.status !== 'pending') {
      return {
        alreadyVoted: true,
        memberName: vote.user.name,
        decision: vote.status,
      };
    }

    // A sheet token is read through getSheetVoteInfo — this path only handles
    // the single-candidate link.
    if (!vote.boardApproval) {
      throw new BadRequestException(
        'This link belongs to an approval sheet, not a single candidate.',
      );
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
          include: {
            candidate: { include: { requisition: true } },
            requestedBy: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!vote) throw new NotFoundException('Invalid approval link.');
    if (new Date() > vote.tokenExpiresAt)
      throw new BadRequestException('This link has expired.');
    if (vote.status !== 'pending') return { ok: true, alreadyVoted: true };

    if (decision === 'rejected' && !notes?.trim()) {
      throw new BadRequestException('Give a reason when rejecting.');
    }
    if (!vote.boardApproval || !vote.boardApprovalId) {
      throw new BadRequestException(
        'This link belongs to an approval sheet — submit it there instead.',
      );
    }
    const approvalId = vote.boardApprovalId;

    await this.prisma.boardApprovalVote.update({
      where: { id: vote.id },
      data: { status: decision, notes: notes ?? null, respondedAt: new Date() },
    });

    const { candidate } = vote.boardApproval;
    const stageLabel = STAGE_LABEL[vote.stage] ?? 'Board';

    if (decision === 'rejected') {
      // One rejection stops the chain — later links are never opened.
      await this.prisma.boardApproval.update({
        where: { id: approvalId },
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
      await this.openStage(approvalId, next);
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
      where: { id: approvalId },
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

  // --- Hiring Approval Sheets (Head of Talent Acquisition onward) ------------------------

  /**
   * Everything sitting on this Head of Talent Acquisition's desk.
   *
   * The recruiter forwards candidates one at a time, so they arrive as a
   * trickle; this is the one page that shows the whole queue, ready to be put
   * onto a sheet together.
   */
  async hrInbox(userId: string) {
    await this.requireRecruitmentRole(userId);
    const isSuper = await this.permissions.isSuperUser(userId);

    const rows = await this.prisma.boardApproval.findMany({
      where: {
        status: 'pending',
        currentStage: 'corporate_hr',
        batchId: null,
        // A super user sees the lot; everyone else only what was addressed to
        // them, since the requester names one Head of Talent Acquisition per candidate.
        ...(isSuper ? {} : { corporateHrId: userId }),
      },
      include: {
        candidate: {
          include: {
            requisition: {
              select: {
                id: true,
                code: true,
                designation: true,
                department: true,
                unitFactory: true,
                requirementType: true,
                replaceOfName: true,
                replaceOfEmployeeCode: true,
                raisedBy: true,
                approvalSteps: {
                  select: {
                    orderIndex: true,
                    title: true,
                    assignee: true,
                    status: true,
                    actedAt: true,
                  },
                  orderBy: { orderIndex: 'asc' },
                },
              },
            },
            salaryFixation: { select: { proposedSalary: true, status: true } },
          },
        },
        requestedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((r) => this.sheetRow(r));
  }

  /**
   * Read the three CV-derived columns out of the AI screening extract.
   *
   * `matchDetails` holds one entry per criterion with what the CV said under
   * `applicant`. Education and Experience map straight across. Last employer
   * has no criterion of its own, so it is left for Head of Talent Acquisition to fill —
   * better blank than invented.
   *
   * Prose is trimmed to something a table cell can carry; HR corrects it
   * before the sheet goes out.
   */
  private fromCvExtract(matchDetails: unknown): {
    education: string | null;
    experience: string | null;
  } {
    if (!Array.isArray(matchDetails))
      return { education: null, experience: null };
    const find = (label: string) => {
      const hit = (
        matchDetails as { label?: string; applicant?: string }[]
      ).find((d) => (d?.label ?? '').toLowerCase() === label);
      const text = (hit?.applicant ?? '').trim();
      if (!text) return null;
      // The extract answers in prose, and when the CV says nothing useful it
      // says so at length ("the provided document contains no information
      // about..."). Those are non-answers, not data — leave the cell blank for
      // HR rather than printing an apology onto the board's sheet.
      const nonAnswer =
        /^(not |none|n\/a|unknown)/i.test(text) ||
        /(no |not )(information|mention|detail|evidence|reference)/i.test(
          text,
        ) ||
        /(does not|doesn't|did not|didn't|cannot|can't|could not|couldn't|unable to)\s+(contain|mention|specify|state|provide|include|determine)/i.test(
          text,
        ) ||
        /provided document|the document (is|appears)|not (specified|mentioned|provided|stated|available)/i.test(
          text,
        );
      if (nonAnswer) return null;
      // First sentence only — the extract is a paragraph, the sheet is a cell.
      const first = text.split(/(?<=\.)\s+/)[0] ?? text;
      return first.length > 180 ? `${first.slice(0, 177)}…` : first;
    };
    return { education: find('education'), experience: find('experience') };
  }

  /** One line of the approval sheet, shaped like DBL's paper form. */
  private sheetRow(r: {
    id: string;
    createdAt: Date;
    sheetEducation: string | null;
    sheetExperience: string | null;
    sheetLastOrg: string | null;
    requestedBy: { id: string; name: string };
    candidate: {
      id: string;
      name: string;
      cvUrl: string | null;
      cvProfile?: unknown;
      matchDetails?: unknown;
      salaryFixation: { proposedSalary: number | null; status: string } | null;
      requisition: {
        id: string;
        code: string;
        designation: string;
        department: string;
        unitFactory: string;
        requirementType: string;
        replaceOfName: string | null;
        replaceOfEmployeeCode: string | null;
        raisedBy: string | null;
        approvalSteps?: {
          orderIndex: number;
          title: string;
          assignee: string;
          status: string;
          actedAt: Date | null;
        }[];
      };
    };
  }) {
    const req = r.candidate.requisition;
    const isReplacement = req.requirementType === 'existing';
    // Three sources, most trustworthy first: HR's own correction, then a
    // structured CV the applicant filled in themselves (Bdjobs), then the AI's
    // reading of a CV document.
    const cv = this.fromCvExtract(r.candidate.matchDetails);
    const profile = cvSummary(r.candidate.cvProfile);
    return {
      approvalId: r.id,
      candidateId: r.candidate.id,
      name: r.candidate.name,
      cvUrl: r.candidate.cvUrl,
      position: req.designation,
      department: req.department,
      unit: req.unitFactory,
      requisitionCode: req.code,
      /** "New" or "Replacement", the way the paper sheet reads. */
      requirement: isReplacement ? 'Replacement' : 'New',
      /** The manager the vacancy was raised for. */
      team: req.raisedBy ?? '',
      education: r.sheetEducation ?? profile?.latestEducation ?? cv.education,
      totalExperience:
        r.sheetExperience ?? profile?.totalExperienceLabel ?? null,
      lastOrganization: r.sheetLastOrg ?? profile?.lastOrganization ?? null,
      /** True when a column is still showing a reading nobody has confirmed. */
      educationFromCv:
        !r.sheetEducation && Boolean(profile?.latestEducation ?? cv.education),
      salary: r.candidate.salaryFixation?.proposedSalary ?? null,
      /** Who is being replaced, or "New". */
      remark: isReplacement
        ? [
            req.replaceOfName,
            req.replaceOfEmployeeCode ? `(${req.replaceOfEmployeeCode})` : '',
          ]
            .filter(Boolean)
            .join(' ')
            .trim() || 'Replacement'
        : 'New',
      /** Who signed the vacancy off before it reached this sheet. */
      approvalChain: approvalChainLine(req.approvalSteps ?? [], req.raisedBy),
      forwardedBy: r.requestedBy.name,
      forwardedAt: r.createdAt.toISOString(),
    };
  }

  /**
   * Correct the CV-derived columns on one row before the sheet goes out.
   *
   * Only reachable while the candidate is still on Head of Talent Acquisition's desk —
   * once a sheet has been mailed, its contents are what the CHRO and board
   * were asked to sign, so they stop being editable.
   */
  async updateSheetRow(
    approvalId: string,
    userId: string,
    patch: {
      education?: string | null;
      totalExperience?: string | null;
      lastOrganization?: string | null;
    },
  ) {
    await this.requireRecruitmentRole(userId);
    const approval = await this.prisma.boardApproval.findUnique({
      where: { id: approvalId },
      select: { id: true, batchId: true, status: true },
    });
    if (!approval) throw new NotFoundException('Approval not found');
    if (approval.batchId) {
      throw new BadRequestException(
        'This candidate is already on a sheet that has been sent — its contents can no longer be changed.',
      );
    }

    const clean = (v: string | null | undefined) =>
      v === undefined ? undefined : v?.trim() ? v.trim() : null;

    await this.prisma.boardApproval.update({
      where: { id: approvalId },
      data: {
        sheetEducation: clean(patch.education),
        sheetExperience: clean(patch.totalExperience),
        sheetLastOrg: clean(patch.lastOrganization),
      },
    });
    return { ok: true };
  }

  /**
   * Put candidates onto one sheet and send it to the CHRO.
   *
   * One candidate or twenty — the same path, because "send this one now" and
   * "send the batch I have been collecting" are the same act with a different
   * selection.
   */
  async sendSheet(
    approvalIds: string[],
    chroId: string,
    boardMemberIds: string[],
    userId: string,
  ) {
    await this.requireRecruitmentRole(userId);
    if (!approvalIds.length) {
      throw new BadRequestException('Select at least one candidate to send.');
    }
    if (!boardMemberIds.length) {
      throw new BadRequestException('Select at least one board member.');
    }

    const approvals = await this.prisma.boardApproval.findMany({
      where: { id: { in: approvalIds }, status: 'pending', batchId: null },
      include: { candidate: { include: { requisition: true } } },
    });
    if (approvals.length !== approvalIds.length) {
      throw new BadRequestException(
        'Some of those candidates are no longer waiting at Head of Talent Acquisition — reload and try again.',
      );
    }

    // A sheet can span units, so the CHRO is checked against the role itself
    // rather than against one unit's holders.
    const chroHolders = await this.sheetChroHolders();
    if (!chroHolders.some((h) => h.id === chroId)) {
      throw new BadRequestException('That person does not hold the CHRO role.');
    }

    // Every candidate on the sheet must carry an agreed figure: the whole
    // point of the sheet is the salary column.
    for (const a of approvals) {
      await this.fixedSalary(a.candidateId);
    }

    const reference = await this.nextSheetReference();
    const batch = await this.prisma.boardApprovalBatch.create({
      data: {
        reference,
        createdById: userId,
        chroId,
        boardMemberIds,
        currentStage: 'chro',
      },
    });

    await this.prisma.boardApproval.updateMany({
      where: { id: { in: approvalIds } },
      data: {
        batchId: batch.id,
        currentStage: 'chro',
        hrApprovedById: userId,
        hrApprovedAt: new Date(),
      },
    });

    await this.openSheetStage(batch.id, 'chro');
    return { id: batch.id, reference, candidates: approvals.length };
  }

  /** Who may sign a sheet as CHRO, and the board members available to it. */
  async sheetApprovers(userId: string) {
    await this.requireRecruitmentRole(userId);
    const [chro, groups] = await Promise.all([
      this.sheetChroHolders(),
      this.prisma.boardGroup.findMany({
        include: {
          members: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      chro,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        members: g.members.map((m) => ({
          id: m.user.id,
          name: m.user.name,
          hasEmail: Boolean(m.user.email),
        })),
      })),
    };
  }

  /** CHRO holders across every unit — a sheet is not tied to one. */
  private async sheetChroHolders() {
    const assignments = await this.prisma.roleAssignment.findMany({
      where: { role: { key: 'chro' } },
      select: { userId: true },
    });
    if (!assignments.length) return [];
    return this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(assignments.map((a) => a.userId))] },
        status: 'ACTIVE',
      },
      select: { id: true, name: true, employeeCode: true },
      orderBy: { name: 'asc' },
    });
  }

  /** HAS-2026-0007 — sequential within the year. */
  private async nextSheetReference(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `HAS-${year}-`;
    const last = await this.prisma.boardApprovalBatch.findFirst({
      where: { reference: { startsWith: prefix } },
      orderBy: { reference: 'desc' },
      select: { reference: true },
    });
    const n = last ? Number(last.reference.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(n).padStart(4, '0')}`;
  }

  /** Mail the sheet to whoever this stage belongs to. */
  private async openSheetStage(
    batchId: string,
    stage: 'chro' | 'board',
  ): Promise<void> {
    const batch = await this.prisma.boardApprovalBatch.findUniqueOrThrow({
      where: { id: batchId },
      include: {
        createdBy: { select: { name: true } },
        approvals: {
          include: {
            candidate: {
              include: {
                requisition: {
                  select: {
                    id: true,
                    code: true,
                    designation: true,
                    department: true,
                    unitFactory: true,
                    requirementType: true,
                    replaceOfName: true,
                    replaceOfEmployeeCode: true,
                    raisedBy: true,
                    approvalSteps: {
                      select: {
                        orderIndex: true,
                        title: true,
                        assignee: true,
                        status: true,
                        actedAt: true,
                      },
                      orderBy: { orderIndex: 'asc' },
                    },
                  },
                },
                salaryFixation: {
                  select: { proposedSalary: true, status: true },
                },
              },
            },
            requestedBy: { select: { id: true, name: true } },
          },
        },
      },
    });

    const recipientIds =
      stage === 'board'
        ? batch.boardMemberIds
        : batch.chroId
          ? [batch.chroId]
          : [];
    if (!recipientIds.length) {
      throw new BadRequestException(
        stage === 'board'
          ? 'No board members were selected for this sheet.'
          : 'No CHRO was chosen for this sheet.',
      );
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, name: true, email: true },
    });

    await this.prisma.boardApprovalBatch.update({
      where: { id: batchId },
      data: { currentStage: stage },
    });
    await this.prisma.boardApproval.updateMany({
      where: { batchId },
      data: { currentStage: stage },
    });

    // Clear stale pending votes before re-opening a stage.
    await this.prisma.boardApprovalVote.deleteMany({
      where: { batchId, stage, status: 'pending' },
    });

    const rows = batch.approvals.map((a) => this.sheetRow(a));
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const frontendUrl =
      this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';

    for (const user of users) {
      if (!user.email) {
        this.logger.warn(`${user.name} has no email — skipping`);
        continue;
      }
      const token = crypto.randomBytes(32).toString('hex');
      await this.prisma.boardApprovalVote.create({
        data: {
          batchId,
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
          subject: `${STAGE_SUBJECT[stage]} — ${batch.reference} (${rows.length} candidate${rows.length === 1 ? '' : 's'})`,
          html: this.buildSheetEmail(
            user.name,
            batch.reference,
            rows,
            `${frontendUrl}/board-sheet/${token}`,
            stage,
          ),
        });
      } catch (e) {
        this.logger.error(
          `Failed to send ${stage} sheet email to ${user.email}: ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * Send the sheet's current stage out again.
   *
   * For the ordinary case where a link was lost or never arrived. It re-mails
   * only the people still to respond — someone who has already signed keeps
   * their decision and is not asked twice — and issues them a fresh link, so
   * the old one stops working.
   */
  async resendSheet(batchId: string, userId: string) {
    await this.requireRecruitmentRole(userId);

    const batch = await this.prisma.boardApprovalBatch.findUnique({
      where: { id: batchId },
      include: {
        votes: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        createdBy: { select: { name: true } },
        approvals: {
          include: {
            candidate: {
              include: {
                requisition: {
                  select: {
                    id: true,
                    code: true,
                    designation: true,
                    department: true,
                    unitFactory: true,
                    requirementType: true,
                    replaceOfName: true,
                    replaceOfEmployeeCode: true,
                    raisedBy: true,
                    approvalSteps: {
                      select: {
                        orderIndex: true,
                        title: true,
                        assignee: true,
                        status: true,
                        actedAt: true,
                      },
                      orderBy: { orderIndex: 'asc' },
                    },
                  },
                },
                salaryFixation: {
                  select: { proposedSalary: true, status: true },
                },
              },
            },
            requestedBy: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!batch) throw new NotFoundException('Sheet not found');
    if (batch.status !== 'pending') {
      throw new BadRequestException(
        `${batch.reference} is already ${batch.status} — there is nothing left to send.`,
      );
    }

    const stage = batch.currentStage as 'chro' | 'board';
    const expected =
      stage === 'board'
        ? batch.boardMemberIds
        : batch.chroId
          ? [batch.chroId]
          : [];
    const settled = new Set(
      batch.votes
        .filter((v) => v.stage === stage && v.status !== 'pending')
        .map((v) => v.userId),
    );
    const targetIds = expected.filter((id) => !settled.has(id));
    if (!targetIds.length) {
      throw new BadRequestException(
        'Everyone at this stage has already responded.',
      );
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: targetIds } },
      select: { id: true, name: true, email: true },
    });

    // Fresh links: the old ones are dropped so a forwarded stale link cannot
    // be used after a resend.
    await this.prisma.boardApprovalVote.deleteMany({
      where: { batchId, stage, status: 'pending' },
    });

    const rows = batch.approvals.map((a) => this.sheetRow(a));
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const frontendUrl =
      this.config.get<string>('frontendUrl') ?? 'http://localhost:3000';

    let sent = 0;
    const skipped: string[] = [];
    for (const user of users) {
      if (!user.email) {
        skipped.push(user.name);
        continue;
      }
      const token = crypto.randomBytes(32).toString('hex');
      await this.prisma.boardApprovalVote.create({
        data: {
          batchId,
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
          subject: `Reminder — ${STAGE_SUBJECT[stage]} — ${batch.reference} (${rows.length} candidate${rows.length === 1 ? '' : 's'})`,
          html: this.buildSheetEmail(
            user.name,
            batch.reference,
            rows,
            `${frontendUrl}/board-sheet/${token}`,
            stage,
          ),
        });
        sent += 1;
      } catch (e) {
        skipped.push(user.name);
        this.logger.error(
          `Failed to resend ${batch.reference} to ${user.email}: ${(e as Error).message}`,
        );
      }
    }

    return { sent, skipped, stage, reference: batch.reference };
  }

  /** What the recipient of a sheet link sees. */
  async getSheetVoteInfo(token: string) {
    const vote = await this.prisma.boardApprovalVote.findUnique({
      where: { token },
      include: {
        user: { select: { name: true } },
        batch: {
          include: {
            createdBy: { select: { name: true } },
            approvals: {
              include: {
                candidate: {
                  include: {
                    requisition: {
                      select: {
                        id: true,
                        code: true,
                        designation: true,
                        department: true,
                        unitFactory: true,
                        requirementType: true,
                        replaceOfName: true,
                        replaceOfEmployeeCode: true,
                        raisedBy: true,
                        approvalSteps: {
                          select: {
                            orderIndex: true,
                            title: true,
                            assignee: true,
                            status: true,
                            actedAt: true,
                          },
                          orderBy: { orderIndex: 'asc' },
                        },
                      },
                    },
                    salaryFixation: {
                      select: { proposedSalary: true, status: true },
                    },
                  },
                },
                requestedBy: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    if (!vote || !vote.batch) {
      throw new NotFoundException('Invalid approval link.');
    }
    if (new Date() > vote.tokenExpiresAt) {
      throw new BadRequestException('This link has expired.');
    }

    return {
      reference: vote.batch.reference,
      memberName: vote.user.name,
      stageLabel: STAGE_LABEL[vote.stage] ?? 'Board',
      preparedBy: vote.batch.createdBy.name,
      status: vote.status,
      alreadyVoted: vote.status !== 'pending',
      batchStatus: vote.batch.status,
      rejectedReason: vote.batch.rejectedReason,
      rows: vote.batch.approvals.map((a) => this.sheetRow(a)),
    };
  }

  /**
   * One decision for the whole sheet, the way the paper form is signed.
   *
   * Approving at CHRO hands the same sheet to the board; approving at board
   * completes every candidate on it. A rejection stops the sheet — and every
   * candidate on it — with the reason recorded against each.
   */
  async submitSheetVote(
    token: string,
    notes?: string,
    decision: 'approved' | 'rejected' = 'approved',
  ) {
    const vote = await this.prisma.boardApprovalVote.findUnique({
      where: { token },
      include: {
        user: { select: { id: true, name: true } },
        batch: { include: { approvals: true } },
      },
    });

    if (!vote || !vote.batch)
      throw new NotFoundException('Invalid approval link.');
    if (new Date() > vote.tokenExpiresAt) {
      throw new BadRequestException('This link has expired.');
    }
    if (vote.status !== 'pending') return { ok: true, alreadyVoted: true };
    if (decision === 'rejected' && !notes?.trim()) {
      throw new BadRequestException('Give a reason when rejecting.');
    }

    const batch = vote.batch;
    const count = batch.approvals.length;
    const stageLabel = STAGE_LABEL[vote.stage] ?? 'Board';

    await this.prisma.boardApprovalVote.update({
      where: { id: vote.id },
      data: { status: decision, notes: notes ?? null, respondedAt: new Date() },
    });

    if (decision === 'rejected') {
      await this.prisma.boardApprovalBatch.update({
        where: { id: batch.id },
        data: {
          status: 'rejected',
          rejectedReason: notes?.trim() ?? null,
          rejectedAt: new Date(),
        },
      });
      await this.prisma.boardApproval.updateMany({
        where: { batchId: batch.id },
        data: {
          status: 'rejected',
          rejectedReason: notes?.trim() ?? null,
          rejectedAt: new Date(),
        },
      });
      await this.notifyBatchOwner(
        batch.createdById,
        `${stageLabel} rejected ${batch.reference}`,
        `${vote.user.name} rejected the whole sheet ${batch.reference} (${count} candidate${count === 1 ? '' : 's'}) — "${notes?.trim() ?? ''}"`,
      );
      return { ok: true, alreadyVoted: false, decision: 'rejected' as const };
    }

    if (vote.stage === 'chro') {
      await this.openSheetStage(batch.id, 'board');
      await this.notifyBatchOwner(
        batch.createdById,
        `CHRO approved ${batch.reference}`,
        `${vote.user.name} approved ${batch.reference} (${count} candidate${count === 1 ? '' : 's'}). Sent on to the Board.`,
      );
      return { ok: true, alreadyVoted: false, decision: 'approved' as const };
    }

    // Board — one member approving completes the sheet, matching the
    // single-candidate chain's existing rule.
    await this.prisma.boardApprovalBatch.update({
      where: { id: batch.id },
      data: { status: 'approved' },
    });
    await this.prisma.boardApproval.updateMany({
      where: { batchId: batch.id },
      data: { status: 'approved' },
    });
    await this.notifyBatchOwner(
      batch.createdById,
      `Board approved ${batch.reference}`,
      `${vote.user.name} approved ${batch.reference} — ${count} candidate${count === 1 ? '' : 's'} cleared for appointment.`,
    );
    return { ok: true, alreadyVoted: false, decision: 'approved' as const };
  }

  /** Sheets this user prepared, newest first. */
  /**
   * One sent sheet with its full rows — what HR needs to print it or hand it
   * to someone as a spreadsheet.
   *
   * The list endpoint carries only summaries, and the rows otherwise exist
   * solely inside the email and the approver's token page; neither is
   * reachable once a sheet has gone out.
   */
  async sheetDetail(batchId: string, userId: string) {
    await this.requireRecruitmentRole(userId);
    const isSuper = await this.permissions.isSuperUser(userId);
    const batch = await this.prisma.boardApprovalBatch.findFirst({
      where: { id: batchId, ...(isSuper ? {} : { createdById: userId }) },
      include: {
        createdBy: { select: { name: true } },
        chro: { select: { name: true } },
        approvals: {
          include: {
            requestedBy: { select: { id: true, name: true } },
            candidate: {
              include: {
                requisition: {
                  select: {
                    id: true,
                    code: true,
                    designation: true,
                    department: true,
                    unitFactory: true,
                    requirementType: true,
                    replaceOfName: true,
                    replaceOfEmployeeCode: true,
                    raisedBy: true,
                    approvalSteps: {
                      select: {
                        orderIndex: true,
                        title: true,
                        assignee: true,
                        status: true,
                        actedAt: true,
                      },
                      orderBy: { orderIndex: 'asc' },
                    },
                  },
                },
                salaryFixation: {
                  select: { proposedSalary: true, status: true },
                },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        votes: {
          include: { user: { select: { name: true } } },
          orderBy: { respondedAt: { sort: 'asc', nulls: 'last' } },
        },
      },
    });
    if (!batch) throw new NotFoundException('Sheet not found');

    return {
      id: batch.id,
      reference: batch.reference,
      status: batch.status,
      currentStage: batch.currentStage,
      preparedBy: batch.createdBy.name,
      chroName: batch.chro?.name ?? null,
      createdAt: batch.createdAt.toISOString(),
      rows: batch.approvals.map((a) => this.sheetRow(a)),
      votes: batch.votes.map((v) => ({
        name: v.user.name,
        stage: v.stage,
        status: v.status,
        notes: v.notes,
        respondedAt: v.respondedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * One approval sheet as a working Excel file.
   *
   * Not a CSV dump: a sheet gets circulated, annotated and filed, so it opens
   * with the header frozen and filterable, salaries as real numbers, the CV as
   * a live link, the sign-off trail on its own tab, and print settings already
   * set to one landscape page wide — the things that make the difference
   * between data and a document somebody can work in.
   *
   * Deliberately no totals row: DBL's paper form has none, and a sum of
   * salaries across unrelated vacancies would not mean anything.
   */
  async exportSheet(batchId: string, userId: string) {
    const sheet = await this.sheetDetail(batchId, userId);

    const BRAND = 'FF1877C0';
    const INK = 'FF12202F';
    const MUTED = 'FF5A6B7F';
    const RULE = 'FFDCE4EE';
    const ZEBRA = 'FFF7FAFD';

    const wb = new ExcelJS.Workbook();
    wb.creator = 'DBL HRM';
    wb.created = new Date();
    wb.title = `Hiring Approval Sheet ${sheet.reference}`;

    const ws = wb.addWorksheet('Approval Sheet', {
      views: [{ state: 'frozen', ySplit: 5 }],
      pageSetup: {
        orientation: 'landscape',
        paperSize: 9, // A4
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: {
          left: 0.4,
          right: 0.4,
          top: 0.5,
          bottom: 0.5,
          header: 0.2,
          footer: 0.2,
        },
        printTitlesRow: '5:5',
      },
    });

    ws.columns = [
      { header: 'SL', key: 'sl', width: 5 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Position', key: 'position', width: 22 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'Unit', key: 'unit', width: 24 },
      { header: 'Education', key: 'education', width: 32 },
      { header: 'Req.', key: 'requirement', width: 12 },
      { header: 'Team', key: 'team', width: 20 },
      { header: 'Total Exp.', key: 'experience', width: 14 },
      { header: 'Last Organization', key: 'lastOrg', width: 24 },
      { header: 'Salary', key: 'salary', width: 13 },
      { header: 'Remark', key: 'remark', width: 22 },
      { header: 'Requisition', key: 'code', width: 15 },
      { header: 'Vacancy approved by', key: 'chain', width: 46 },
      { header: 'CV', key: 'cv', width: 10 },
    ];
    const LAST_COL = 'O';

    // ── Title block ────────────────────────────────────────────────────
    ws.mergeCells(`A1:${LAST_COL}1`);
    const title = ws.getCell('A1');
    title.value = 'DBL Group — Hiring Approval Sheet';
    title.font = { bold: true, size: 15, color: { argb: BRAND } };
    title.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 24;

    ws.mergeCells(`A2:${LAST_COL}2`);
    const sub = ws.getCell('A2');
    sub.value = `Ref ${sheet.reference}   ·   Prepared by ${sheet.preparedBy}   ·   ${new Date(
      sheet.createdAt,
    ).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })}   ·   Status: ${sheet.status}`;
    sub.font = { size: 10, color: { argb: MUTED } };
    ws.getRow(3).height = 6;

    // ── Header ─────────────────────────────────────────────────────────
    const header = ws.getRow(5);
    ws.columns.forEach((c, i) => {
      header.getCell(i + 1).value = c.header as string;
    });
    header.height = 26;
    header.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: BRAND },
      };
      cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'center',
        wrapText: true,
      };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF0F5999' } } };
    });

    // ── Rows ───────────────────────────────────────────────────────────
    sheet.rows.forEach((r, i) => {
      const row = ws.addRow({
        sl: i + 1,
        name: r.name,
        position: r.position,
        department: r.department,
        unit: r.unit,
        education: r.education ?? '',
        requirement: r.requirement,
        team: r.team,
        experience: r.totalExperience ?? '',
        lastOrg: r.lastOrganization ?? '',
        salary: r.salary ?? null,
        remark: r.remark,
        code: r.requisitionCode,
        chain: r.approvalChain,
        cv: r.cvUrl ? 'Open CV' : '',
      });
      const bg = i % 2 === 0 ? 'FFFFFFFF' : ZEBRA;
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.font = { size: 10, color: { argb: INK } };
        cell.alignment = { vertical: 'top', wrapText: col >= 6 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bg },
        };
        cell.border = {
          top: { style: 'hair', color: { argb: RULE } },
          bottom: { style: 'hair', color: { argb: RULE } },
          left: { style: 'hair', color: { argb: RULE } },
          right: { style: 'hair', color: { argb: RULE } },
        };
      });
      row.getCell('sl').alignment = { vertical: 'top', horizontal: 'center' };
      row.getCell('name').font = { size: 10, bold: true, color: { argb: INK } };
      row.getCell('requirement').alignment = {
        vertical: 'top',
        horizontal: 'center',
      };
      // A real number, so it can be sorted, filtered and added up by whoever
      // needs to — rather than text that merely looks like money.
      const salary = row.getCell('salary');
      salary.numFmt = '#,##0';
      salary.alignment = { vertical: 'top', horizontal: 'right' };
      salary.font = { size: 10, bold: true, color: { argb: INK } };
      if (r.cvUrl) {
        const cv = row.getCell('cv');
        cv.value = { text: 'Open CV', hyperlink: r.cvUrl };
        cv.font = { size: 10, color: { argb: BRAND }, underline: true };
      }
      row.getCell('chain').font = { size: 9, color: { argb: MUTED } };
    });

    ws.autoFilter = { from: 'A5', to: `${LAST_COL}5` };

    // ── The sign-off trail, on its own tab ─────────────────────────────
    const votes = wb.addWorksheet('Approvals', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    votes.columns = [
      { header: 'Approver', key: 'name', width: 28 },
      { header: 'Stage', key: 'stage', width: 12 },
      { header: 'Decision', key: 'status', width: 14 },
      { header: 'Responded', key: 'at', width: 16 },
      { header: 'Note', key: 'notes', width: 60 },
    ];
    const vh = votes.getRow(1);
    vh.height = 22;
    vh.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: BRAND },
      };
      cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    sheet.votes.forEach((v) => {
      const row = votes.addRow({
        name: v.name,
        stage: v.stage,
        status: v.status,
        at: v.respondedAt
          ? new Date(v.respondedAt).toLocaleDateString('en-GB', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })
          : '',
        notes: v.notes ?? '',
      });
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { size: 10 };
        cell.alignment = { vertical: 'top', wrapText: true };
      });
      const decision = row.getCell('status');
      const fill =
        v.status === 'approved'
          ? 'FFD1FAE5'
          : v.status === 'rejected'
            ? 'FFFEE2E2'
            : 'FFFEF4D3';
      decision.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: fill },
      };
      decision.font = { size: 10, bold: true };
      decision.alignment = { vertical: 'top', horizontal: 'center' };
    });

    const buffer = await wb.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(buffer),
      filename: `${sheet.reference.replace(/[^\w-]+/g, '_')}.xlsx`,
    };
  }

  async listSheets(userId: string) {
    await this.requireRecruitmentRole(userId);
    const isSuper = await this.permissions.isSuperUser(userId);
    const batches = await this.prisma.boardApprovalBatch.findMany({
      where: isSuper ? {} : { createdById: userId },
      include: {
        createdBy: { select: { name: true } },
        chro: { select: { name: true } },
        approvals: {
          select: { id: true, candidate: { select: { name: true } } },
        },
        votes: {
          include: { user: { select: { name: true } } },
          orderBy: { respondedAt: { sort: 'asc', nulls: 'last' } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return batches.map((b) => ({
      id: b.id,
      reference: b.reference,
      status: b.status,
      currentStage: b.currentStage,
      chroName: b.chro?.name ?? null,
      preparedBy: b.createdBy.name,
      candidateCount: b.approvals.length,
      candidateNames: b.approvals.map((a) => a.candidate.name),
      rejectedReason: b.rejectedReason,
      createdAt: b.createdAt.toISOString(),
      votes: b.votes.map((v) => ({
        name: v.user.name,
        stage: v.stage,
        status: v.status,
        notes: v.notes,
        respondedAt: v.respondedAt?.toISOString() ?? null,
      })),
    }));
  }

  /**
   * The approval sheet as an email — DBL's paper form, in a table.
   *
   * Everything on it is what the system already holds: the columns the paper
   * sheet fills in by hand (the candidate's own education, total experience,
   * last employer) are deliberately left off rather than shown empty or
   * guessed at from CV text.
   */
  /**
   * The Hiring Approval Sheet as it reaches a CHRO or board member.
   *
   * Twelve columns is DBL's paper form, and at email width every one of them
   * was shredding — "DBL Group — Head Office" came out over four lines. Two
   * things fix that. The table is now fixed-layout with a width budgeted per
   * column, so a name or a unit breaks once at a space if at all, never into
   * a stack of fragments. And below ~620px the table steps aside for one
   * block per candidate, because no twelve-column grid survives a phone.
   *
   * The blocks are hidden inline and revealed by the media query, so a client
   * that strips <style> simply shows the table — the behaviour before this
   * change, never both.
   */
  private buildSheetEmail(
    memberName: string,
    reference: string,
    rows: {
      name: string;
      cvUrl: string | null;
      position: string;
      department: string;
      unit: string;
      education: string | null;
      totalExperience: string | null;
      lastOrganization: string | null;
      requirement: string;
      team: string;
      salary: number | null;
      remark: string;
      approvalChain: string;
    }[],
    voteUrl: string,
    stage: 'chro' | 'board',
  ): string {
    const today = new Date().toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const esc = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const money = (n: number | null) =>
      n == null
        ? '—'
        : `${new Intl.NumberFormat('en-BD', { maximumFractionDigits: 0 }).format(n)}/-`;
    const val = (v: string | null) => (v && v.trim() ? esc(v) : '—');

    const td =
      'padding:8px;border:1px solid #dce4ee;font-size:11px;line-height:1.45;color:#1a2330;vertical-align:top';
    const th =
      'padding:8px;border:1px solid #c9d6e6;background:#eef4fa;font-size:9.5px;font-weight:700;color:#3d556e;text-transform:uppercase;letter-spacing:.3px;text-align:left;line-height:1.3';
    const nowrap = 'white-space:nowrap';
    const cvLink = (url: string | null, size: string) =>
      url
        ? `<a href="${esc(url)}" target="_blank" rel="noreferrer" style="display:inline-block;white-space:nowrap;font-weight:400;font-size:${size};color:#1877c0;text-decoration:underline">View CV</a>`
        : '';

    // Budgeted so the long fields have room; the short ones never wrap at all.
    const cols = [3, 12, 9, 8, 10, 10, 8, 8, 8, 9, 6, 9]
      .map((w) => `<col style="width:${w}%">`)
      .join('');

    const deskRows = rows
      .map(
        (r, i) => `
      <tr>
        <td style="${td};${nowrap};text-align:center;color:#7b8a9c">${i + 1}</td>
        <td style="${td}">
          <span style="font-weight:700">${esc(r.name)}</span>
          ${r.cvUrl ? `<br>${cvLink(r.cvUrl, '10.5px')}` : ''}
        </td>
        <td style="${td}">${esc(r.position)}</td>
        <td style="${td}">${esc(r.department)}</td>
        <td style="${td}">${esc(r.unit)}</td>
        <td style="${td}">${val(r.education)}</td>
        <td style="${td};text-align:center">${esc(r.requirement)}</td>
        <td style="${td}">${val(r.team)}</td>
        <td style="${td};text-align:center">${val(r.totalExperience)}</td>
        <td style="${td}">${val(r.lastOrganization)}</td>
        <td style="${td};${nowrap};text-align:right;font-weight:700">${money(r.salary)}</td>
        <td style="${td}">${esc(r.remark)}</td>
      </tr>${
        // The vacancy's own sign-off chain, under the row rather than in a
        // thirteenth column: an approver asked to sanction a hire wants to
        // see who sanctioned the post, without the table getting narrower.
        r.approvalChain
          ? `
      <tr>
        <td colspan="12" style="padding:6px 10px 8px;border:1px solid #dce4ee;border-top:0;background:#fafcfe;font-size:10.5px;line-height:1.5;color:#5a6b7f">
          <span style="color:#8795a8">Vacancy approved:</span> ${esc(r.approvalChain)}
        </td>
      </tr>`
          : ''
      }`,
      )
      .join('');

    const kv = (k: string, v: string) => `
        <tr>
          <td style="padding:4px 0;font-size:11.5px;color:#7b8a9c;width:44%;vertical-align:top">${k}</td>
          <td style="padding:4px 0;font-size:11.5px;color:#1a2330;vertical-align:top">${v}</td>
        </tr>`;

    const mobileCards = rows
      .map(
        (r, i) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce4ee;border-radius:8px;margin:0 0 12px">
        <tr><td style="padding:12px 14px;background:#f7fafd;border-bottom:1px solid #e4ecf5;border-radius:8px 8px 0 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:14px;font-weight:700;color:#12202f;line-height:1.35">${i + 1}. ${esc(r.name)}</td>
              <td style="${nowrap};text-align:right;font-size:14px;font-weight:700;color:#12202f;vertical-align:top">${money(r.salary)}</td>
            </tr>
          </table>
          <p style="margin:4px 0 0;font-size:12px;color:#5a6b7f;line-height:1.5">${esc(r.position)} · ${esc(r.department)}</p>
          <p style="margin:1px 0 0;font-size:12px;color:#5a6b7f;line-height:1.5">${esc(r.unit)}</p>
          ${r.cvUrl ? `<p style="margin:7px 0 0">${cvLink(r.cvUrl, '12px')}</p>` : ''}
        </td></tr>
        <tr><td style="padding:10px 14px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${kv('Education', val(r.education))}
            ${kv('Total experience', val(r.totalExperience))}
            ${kv('Last organization', val(r.lastOrganization))}
            ${kv('Requirement', esc(r.requirement))}
            ${kv('Team', val(r.team))}
            ${kv('Remark', esc(r.remark))}
          </table>
          ${
            r.approvalChain
              ? `<p style="margin:9px 0 0;padding-top:8px;border-top:1px solid #eef3f8;font-size:11px;line-height:1.6;color:#5a6b7f"><span style="color:#8795a8">Vacancy approved:</span> ${esc(r.approvalChain)}</p>`
              : ''
          }
        </td></tr>
      </table>`,
      )
      .join('');

    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hiring Approval Sheet ${esc(reference)}</title>
<style>
  /* Twelve columns each need room for an eleven-character word
     ("Replacement", "Engineering"), which is about 960px of table. Below
     that the grid starts colliding, so the per-candidate blocks take over —
     well before a reading pane or a phone can shred it. */
  @media only screen and (max-width:1000px) {
    .shell { width:100% !important; }
    .pad { padding-left:18px !important; padding-right:18px !important; }
    .desk { display:none !important; mso-hide:all; }
    .mob { display:block !important; max-height:none !important; overflow:visible !important; }
    .cta { display:block !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f7">
<div style="background:#eef2f7;padding:26px 0;font-family:-apple-system,'Segoe UI',Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" class="shell" width="1080" cellpadding="0" cellspacing="0" style="max-width:1080px;width:100%;background:#ffffff;border:1px solid #d9e2ee;border-radius:10px;overflow:hidden">

    <tr><td style="background:#1877c0;padding:24px 32px;text-align:center">
      <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:.3px">DBL Group</p>
      <p style="margin:5px 0 0;font-size:13px;color:#cfe4f7;letter-spacing:.4px;text-transform:uppercase">Hiring Approval Sheet</p>
    </td></tr>

    <tr><td class="pad" style="padding:24px 32px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:12.5px;color:#5a6b7f">Ref <strong style="color:#12202f;font-size:13px">${esc(reference)}</strong></td>
          <td style="font-size:12.5px;color:#5a6b7f;text-align:right;${nowrap}">${today}</td>
        </tr>
      </table>
      <p style="margin:20px 0 6px;font-size:15px;color:#12202f">Dear <strong>${esc(memberName)}</strong>,</p>
      <p style="margin:0 0 20px;font-size:13.5px;color:#4a5b6e;line-height:1.75">
        The HR Department requests your ${stage === 'board' ? 'board-level approval' : 'approval as CHRO'}
        for the appointment of the ${rows.length} candidate${rows.length === 1 ? '' : 's'} below.
        This sheet is approved or returned as a whole.
      </p>
    </td></tr>

    <tr><td class="pad" style="padding:0 32px">
      <table role="presentation" class="desk" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed">
        <colgroup>${cols}</colgroup>
        <tr>
          <th style="${th};text-align:center">SL</th>
          <th style="${th}">Name</th>
          <th style="${th}">Position</th>
          <th style="${th}">Dept.</th>
          <th style="${th}">Unit</th>
          <th style="${th}">Education</th>
          <th style="${th};text-align:center">Req.</th>
          <th style="${th}">Team</th>
          <th style="${th};text-align:center">Exp.</th>
          <th style="${th}">Last Organization</th>
          <th style="${th};text-align:right">Salary</th>
          <th style="${th}">Remark</th>
        </tr>
        ${deskRows}
      </table>

      <div class="mob" style="display:none;max-height:0;overflow:hidden">
        ${mobileCards}
      </div>
    </td></tr>

    <tr><td class="pad" style="padding:26px 32px 30px;text-align:center">
      <a href="${voteUrl}" class="cta" style="display:inline-block;background:#1877c0;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 38px;border-radius:6px">
        Review &amp; approve this sheet
      </a>
      <p style="margin:14px 0 0;font-size:11.5px;color:#8795a8;line-height:1.6">
        Opens a secure page where you can approve or return the sheet. The link expires in 30 days.
      </p>
    </td></tr>

    <tr><td style="background:#f6f9fc;border-top:1px solid #e4ecf5;padding:16px 32px;text-align:center">
      <p style="margin:0;font-size:11px;color:#8795a8">This is an automated message from DBL HRM. Please do not reply.</p>
    </td></tr>
  </table>
  </td></tr></table>
</div>
</body></html>`;
  }

  private async notifyBatchOwner(
    userId: string,
    title: string,
    message: string,
  ): Promise<void> {
    try {
      await this.notifications.notify(userId, {
        type: 'board_approval',
        title,
        message,
        link: '/board-sheets',
      });
    } catch {
      this.logger.warn('Could not notify the sheet owner');
    }
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
              select: {
                id: true,
                name: true,
                email: true,
                employeeCode: true,
                employee: { select: { designation: true, department: true } },
              },
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
      Boolean(
        await this.prisma.roleAssignment.findFirst({
          where: { userId, role: { key: { in: ['corporate_hr', 'chro'] } } },
        }),
      );
    if (!ok)
      throw new ForbiddenException(
        'Only Head of Talent Acquisition, CHRO or super users can manage board approvals',
      );
  }

  private buildApprovalEmail(
    memberName: string,
    candidate: { name: string; cvUrl: string | null; salary: number },
    req: {
      code: string;
      designation: string;
      unitFactory: string;
      department: string;
    },
    voteUrl: string,
    stage: 'corporate_hr' | 'chro' | 'board' = 'board',
  ): string {
    const today = new Date().toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

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

    const cvRow = candidate.cvUrl
      ? `
      <tr>
        <td style="padding:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b7c93;vertical-align:middle">Curriculum Vitae</td>
        <td style="padding:14px 0 0 20px;font-family:Arial,Helvetica,sans-serif;vertical-align:middle">
          <a href="${candidate.cvUrl}" style="color:#1877c0;font-size:13px;font-weight:600;text-decoration:none">
            View CV / Resume →
          </a>
        </td>
      </tr>`
      : '';

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
