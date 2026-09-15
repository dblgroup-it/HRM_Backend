import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';

import { PrismaService } from '../../prisma/prisma.service';
import { DriveService } from '../integrations/google/drive.service';
import { buildAvatarUrl } from '../../common/avatar.util';
import { signatureRatioError } from '../../common/signature.util';
import { FileGrantService } from '../../common/files/file-grant.service';
import { imageSize } from '../../common/upload/image-size';
import { SIGNATURE_MIME } from '../../common/upload/file-upload';
import { PermissionsService } from '../rbac/permissions.service';

export interface UploadedImage {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/** 2 MB hard cap (also enforced by the upload interceptor + the frontend). */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** Same cap as a profile picture — a signature is a small crop, not a scan. */
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly drive: DriveService,
    private readonly permissions: PermissionsService,
    private readonly grants: FileGrantService,
  ) {}

  async getPreferences(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailNotifications: true, email: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      emailNotifications: user.emailNotifications,
      hasEmail: Boolean(user.email),
    };
  }

  async updatePreferences(userId: string, emailNotifications: boolean) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailNotifications },
    });
    return { emailNotifications };
  }

  async uploadAvatar(userId: string, file?: UploadedImage) {
    if (!file) throw new BadRequestException('Please choose an image');
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Only image files are allowed');
    }
    if (file.size > MAX_AVATAR_BYTES) {
      throw new BadRequestException('Image must be 2 MB or smaller');
    }
    if (!this.drive.isConfigured()) {
      throw new ServiceUnavailableException('Google Drive is not connected');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // A dedicated top-level folder — kept fully separate from the recruitment tree.
    const folder = await this.drive.ensureFolder('DBL HRM Profile Pictures');
    const dot = file.originalname.lastIndexOf('.');
    const ext = dot >= 0 ? file.originalname.slice(dot) : '';
    const uploaded = await this.drive.uploadFile(folder, {
      name: `${user.employeeCode} — ${user.name}${ext}`,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });

    // Remove the previous picture so they don't pile up.
    if (user.avatarFileId) {
      try {
        await this.drive.discardFile(user.avatarFileId);
      } catch (err) {
        this.logger.warn(
          `Old avatar cleanup failed: ${(err as Error).message}`,
        );
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarFileId: uploaded.id },
    });
    return { avatarUrl: buildAvatarUrl(userId, uploaded.id) };
  }

  /**
   * Place an e-signature on a profile.
   *
   * Who may do this:
   *   * the person themselves, always;
   *   * a super user, CHRO, Head of Talent Acquisition or Corporate Recruiter,
   *     on someone else's profile — but only while that person has not signed
   *     for themselves.
   *
   * That last clause is the point of the feature. A signature is the person's
   * own mark; once they have uploaded it, nobody overwrites it on their behalf.
   * HR uploading one first is a convenience for staff who will not do it
   * themselves, not a claim on it — and the moment the owner replaces it, it
   * stops being HR's to change.
   */
  async uploadSignature(
    targetUserId: string,
    actorId: string,
    file?: UploadedImage,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        signatureFileId: true,
        signatureUploadedById: true,
      },
    });
    if (!target) throw new NotFoundException('User not found');

    await this.requireSignatureRights(target, actorId);

    if (!file) throw new BadRequestException('Please choose an image');
    // Checked here as well as in the multer filter: the filter guards the
    // route, this guards the method, and only one of them is visible to
    // someone reading the service.
    if (!SIGNATURE_MIME.includes(file.mimetype.toLowerCase())) {
      throw new BadRequestException('A signature must be a PNG or JPEG image.');
    }
    if (file.size > MAX_SIGNATURE_BYTES) {
      throw new BadRequestException('Signature image must be 2 MB or smaller');
    }

    // Ratio is checked from the header. An unreadable format is allowed
    // through rather than refused: failing an upload because the format is
    // unfamiliar is a worse outcome than not checking its shape.
    const size = imageSize(file.buffer);
    if (size) {
      const problem = signatureRatioError(size.width, size.height);
      if (problem) throw new BadRequestException(problem);
    }

    if (!this.drive.isConfigured()) {
      throw new ServiceUnavailableException('Google Drive is not connected');
    }

    const folder = await this.drive.ensureFolder('DBL HRM Signatures');
    const dot = file.originalname.lastIndexOf('.');
    const ext = dot >= 0 ? file.originalname.slice(dot) : '';
    const uploaded = await this.drive.uploadFile(folder, {
      name: `${target.employeeCode} — ${target.name} signature${ext}`,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });

    const previous = target.signatureFileId;
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        signatureFileId: uploaded.id,
        signatureUploadedById: actorId,
        signatureUploadedAt: new Date(),
      },
    });

    // Only after the record points at the new file — a failed cleanup must not
    // leave a profile referring to a signature that has been deleted.
    if (previous) {
      try {
        await this.drive.discardFile(previous);
      } catch (err) {
        this.logger.warn(
          `Old signature cleanup failed: ${(err as Error).message}`,
        );
      }
    }

    return {
      signatureUrl: this.grants.url(uploaded.id, 'signature', {
        filename: `${target.name} signature`,
      }),
      signatureSelfUploaded: actorId === targetUserId,
    };
  }

  /** Remove an e-signature. Same rule as replacing one. */
  async deleteSignature(targetUserId: string, actorId: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        signatureFileId: true,
        signatureUploadedById: true,
      },
    });
    if (!target) throw new NotFoundException('User not found');
    await this.requireSignatureRights(target, actorId);

    if (target.signatureFileId) {
      try {
        await this.drive.discardFile(target.signatureFileId);
      } catch (err) {
        this.logger.warn(`Signature removal failed: ${(err as Error).message}`);
      }
      await this.prisma.user.update({
        where: { id: targetUserId },
        data: {
          signatureFileId: null,
          signatureUploadedById: null,
          signatureUploadedAt: null,
        },
      });
    }
    return { signatureUrl: null, signatureSelfUploaded: false };
  }

  private async requireSignatureRights(
    target: { id: string; signatureUploadedById: string | null },
    actorId: string,
  ): Promise<void> {
    if (actorId === target.id) return; // Your own signature is always yours.

    if (!(await this.permissions.isEmployeeAdmin(actorId))) {
      throw new ForbiddenException(
        "Only a super user, CHRO, Head of Talent Acquisition or Corporate Recruiter can manage another person's signature",
      );
    }
    if (target.signatureUploadedById === target.id) {
      throw new ForbiddenException(
        'This person uploaded their own signature, so it cannot be changed on their behalf. Ask them to replace it themselves.',
      );
    }
  }

  async deleteAvatar(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.avatarFileId) {
      try {
        await this.drive.discardFile(user.avatarFileId);
      } catch (err) {
        this.logger.warn(`Avatar removal failed: ${(err as Error).message}`);
      }
      await this.prisma.user.update({
        where: { id: userId },
        data: { avatarFileId: null },
      });
    }
    return { avatarUrl: null };
  }

  async getAvatarMedia(
    userId: string,
  ): Promise<{ stream: Readable; mimeType: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarFileId: true },
    });
    if (!user?.avatarFileId) throw new NotFoundException('No avatar');
    return this.drive.getFileMedia(user.avatarFileId);
  }
}
