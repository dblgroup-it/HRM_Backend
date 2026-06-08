import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, type drive_v3 } from 'googleapis';
import { Readable } from 'node:stream';
import type { CandidateStage } from '@prisma/client';

import { GoogleAuthService } from './google-auth.service';
import type { DriveTreeInput, RequisitionDriveMap } from './google.types';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Drive folder names allow most characters; just keep them tidy and safe. */
function clean(name: string): string {
  return name.replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim() || 'Untitled';
}

/**
 * Thin wrapper over the Google Drive v3 API that builds and maintains each
 * requisition's recruitment folder tree and moves CV files between stages.
 */
@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);

  constructor(
    private readonly auth: GoogleAuthService,
    private readonly config: ConfigService,
  ) {}

  isConfigured(): boolean {
    return this.auth.isConfigured();
  }

  private api(): drive_v3.Drive {
    return google.drive({ version: 'v3', auth: this.auth.getAuthorizedClient() });
  }

  folderUrl(id: string): string {
    return `https://drive.google.com/drive/folders/${id}`;
  }

  fileUrl(id: string): string {
    return `https://drive.google.com/file/d/${id}/view`;
  }

  private async findFolder(name: string, parentId?: string) {
    const safe = name.replace(/'/g, "\\'");
    const parentClause = parentId ? ` and '${parentId}' in parents` : '';
    const res = await this.api().files.list({
      q: `mimeType='${FOLDER_MIME}' and name='${safe}' and trashed=false${parentClause}`,
      fields: 'files(id,name)',
      pageSize: 1,
      spaces: 'drive',
    });
    return res.data.files?.[0] ?? null;
  }

  /** Find-or-create a folder by name under a parent (or My Drive root). */
  async ensureFolder(name: string, parentId?: string): Promise<string> {
    const tidy = clean(name);
    const existing = await this.findFolder(tidy, parentId);
    if (existing?.id) return existing.id;
    const res = await this.api().files.create({
      requestBody: {
        name: tidy,
        mimeType: FOLDER_MIME,
        parents: parentId ? [parentId] : undefined,
      },
      fields: 'id',
    });
    return res.data.id as string;
  }

  /** The top-level "DBL HRM Recruitment" folder (or a configured existing one). */
  async ensureRootFolder(): Promise<string> {
    const fixedId = this.config.get<string>('google.rootFolderId');
    if (fixedId) return fixedId;
    const name = this.config.get<string>('google.rootFolderName') ?? 'DBL HRM Recruitment';
    return this.ensureFolder(name);
  }

  async shareAnyoneWithLink(fileId: string, role: 'reader' | 'writer' = 'writer') {
    await this.api().permissions.create({
      fileId,
      requestBody: { type: 'anyone', role },
    });
  }

  /** Build (idempotently) the full folder tree for a requisition. */
  async createRequisitionTree(input: DriveTreeInput): Promise<RequisitionDriveMap> {
    const root = await this.ensureRootFolder();
    const unitFolder = await this.ensureFolder(input.unit || 'Unassigned Unit', root);
    const deptFolder = await this.ensureFolder(
      `${input.department || 'General'} — ${input.designation}`,
      unitFolder,
    );
    const reqFolder = await this.ensureFolder(
      `${input.code} — ${input.designation}`,
      deptFolder,
    );

    // Subfolders are created sequentially to avoid duplicate-name races.
    const allCvFolderId = await this.ensureFolder('01 All CVs', reqFolder);
    const shortlistedFolderId = await this.ensureFolder('02 Shortlisted', reqFolder);
    const interviewFolderId = await this.ensureFolder('03 Interview Docs', reqFolder);
    const finalFolderId = await this.ensureFolder('04 Final Candidate', reqFolder);
    const joiningFolderId = await this.ensureFolder('05 Selected — Joining Docs', reqFolder);

    // The All CVs folder doubles as the public collection link.
    await this.shareAnyoneWithLink(allCvFolderId, 'writer');

    return {
      rootFolderId: reqFolder,
      rootFolderUrl: this.folderUrl(reqFolder),
      allCvFolderId,
      allCvFolderUrl: this.folderUrl(allCvFolderId),
      shortlistedFolderId,
      interviewFolderId,
      finalFolderId,
      joiningFolderId,
      createdAt: new Date().toISOString(),
    };
  }

  /** Stream a file's bytes + its real mime type (used by the avatar proxy). */
  async getFileMedia(
    fileId: string,
  ): Promise<{ stream: Readable; mimeType: string }> {
    const api = this.api();
    const meta = await api.files.get({ fileId, fields: 'mimeType' });
    const mimeType = meta.data.mimeType ?? 'application/octet-stream';
    const res = await api.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' },
    );
    return { stream: res.data as unknown as Readable, mimeType };
  }

  async uploadFile(
    parentId: string,
    file: { name: string; mimeType: string; buffer: Buffer },
  ): Promise<{ id: string; url: string }> {
    const res = await this.api().files.create({
      requestBody: { name: clean(file.name), parents: [parentId] },
      media: { mimeType: file.mimeType, body: Readable.from(file.buffer) },
      fields: 'id,webViewLink',
    });
    const id = res.data.id as string;
    return { id, url: res.data.webViewLink ?? this.fileUrl(id) };
  }

  /** List non-folder files directly inside a folder (paginated). */
  async listFiles(
    parentId: string,
  ): Promise<{ id: string; name: string; mimeType: string; url: string }[]> {
    const out: { id: string; name: string; mimeType: string; url: string }[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.api().files.list({
        q: `'${parentId}' in parents and trashed=false and mimeType != '${FOLDER_MIME}'`,
        fields: 'nextPageToken, files(id,name,mimeType,webViewLink)',
        pageSize: 200,
        pageToken,
        spaces: 'drive',
        orderBy: 'createdTime',
      });
      for (const f of res.data.files ?? []) {
        if (!f.id) continue;
        out.push({
          id: f.id,
          name: f.name ?? 'CV',
          mimeType: f.mimeType ?? '',
          url: f.webViewLink ?? this.fileUrl(f.id),
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  /** Send a file to Drive trash (recoverable). Only works on files we own. */
  async trashFile(fileId: string): Promise<void> {
    await this.api().files.update({
      fileId,
      requestBody: { trashed: true },
    });
  }

  /** Detach a file from every folder it lives in (removes it from our workspace). */
  async removeFromParents(fileId: string): Promise<void> {
    const meta = await this.api().files.get({ fileId, fields: 'parents' });
    const parents = meta.data.parents ?? [];
    if (parents.length === 0) return;
    await this.api().files.update({
      fileId,
      removeParents: parents.join(','),
      fields: 'id',
    });
  }

  /**
   * Remove a CV from the recruitment workspace. Trashes it if we own it
   * (CVs uploaded through the app); for files uploaded by an external person
   * via the share link — which they own, so we can't trash — we instead detach
   * it from our folder so it disappears from the workspace and won't re-import.
   */
  async discardFile(fileId: string): Promise<void> {
    try {
      await this.trashFile(fileId);
    } catch {
      await this.removeFromParents(fileId);
    }
  }

  /** Move a file into a new folder (used when a candidate changes stage). */
  async moveFile(fileId: string, toParentId: string): Promise<void> {
    const meta = await this.api().files.get({ fileId, fields: 'parents' });
    const removeParents = (meta.data.parents ?? []).join(',');
    await this.api().files.update({
      fileId,
      addParents: toParentId,
      removeParents: removeParents || undefined,
      fields: 'id,parents',
    });
  }

  /** Destination folder for a candidate's CV given their pipeline stage. */
  stageFolderId(map: RequisitionDriveMap, stage: CandidateStage): string {
    switch (stage) {
      case 'SHORTLISTED':
        return map.shortlistedFolderId;
      case 'INTERVIEW':
        return map.interviewFolderId;
      case 'FINAL':
        return map.finalFolderId;
      case 'SELECTED':
        return map.joiningFolderId;
      default:
        return map.allCvFolderId;
    }
  }
}
