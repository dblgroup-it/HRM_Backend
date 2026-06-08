import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';

import { PrismaService } from '../../prisma/prisma.service';
import { DriveService } from '../integrations/google/drive.service';
import { buildAvatarUrl } from '../../common/avatar.util';

export interface UploadedImage {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/** 2 MB hard cap (also enforced by the upload interceptor + the frontend). */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly drive: DriveService,
  ) {}

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
        this.logger.warn(`Old avatar cleanup failed: ${(err as Error).message}`);
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarFileId: uploaded.id },
    });
    return { avatarUrl: buildAvatarUrl(userId, uploaded.id) };
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
