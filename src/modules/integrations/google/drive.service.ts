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
  return (
    name
      .replace(/[\\/]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
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
    return google.drive({
      version: 'v3',
      auth: this.auth.getAuthorizedClient(),
    });
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
    const name =
      this.config.get<string>('google.rootFolderName') ?? 'DBL HRM Recruitment';
    return this.ensureFolder(name);
  }

  /**
   * Publish a file or folder as "anyone with the link".
   *
   * **Do not call this for anything containing personal data.** A CV, a medical
   * report, a national ID or a certificate published this way gets a permanent,
   * unauthenticated, non-expiring, unlogged URL that cannot be recalled once it
   * has been forwarded. Every such call site was removed; documents are now
   * streamed by this API instead (see `common/files/`).
   *
   * The method is kept for the one thing that legitimately needs it: the
   * "01 All CVs" *drop-box folder*, whose whole purpose is that an external
   * applicant can put a CV into it. Callers must pass `reason` so an
   * inappropriate use is visible in review and in the log.
   */
  async shareAnyoneWithLink(
    fileId: string,
    role: 'reader' | 'writer',
    reason: 'cv-dropbox-folder',
  ) {
    this.logger.log(
      `Publishing Drive object ${fileId} as anyone-with-link (${role}) — reason: ${reason}`,
    );
    await this.api().permissions.create({
      fileId,
      requestBody: { type: 'anyone', role },
    });
  }

  /**
   * Revoke any public ("anyone with the link") access on a file/folder, leaving
   * it private to the recruitment account. Used to lock down CV folders so
   * external people can't view or delete each other's CVs.
   */
  async revokeAnyoneAccess(fileId: string): Promise<void> {
    const res = await this.api().permissions.list({
      fileId,
      fields: 'permissions(id,type)',
    });
    for (const p of res.data.permissions ?? []) {
      if (p.type === 'anyone' && p.id) {
        await this.api().permissions.delete({ fileId, permissionId: p.id });
      }
    }
  }

  /** Build (idempotently) the full folder tree for a requisition. */
  async createRequisitionTree(
    input: DriveTreeInput,
  ): Promise<RequisitionDriveMap> {
    const root = await this.ensureRootFolder();
    const unitFolder = await this.ensureFolder(
      input.unit || 'Unassigned Unit',
      root,
    );
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
    const aiShortlistedFolderId = await this.ensureFolder(
      '02 AI Shortlisted',
      reqFolder,
    );
    const shortlistedFolderId = await this.ensureFolder(
      '03 Shortlisted',
      reqFolder,
    );
    const interviewFolderId = await this.ensureFolder(
      '04 Interview Docs',
      reqFolder,
    );
    const finalFolderId = await this.ensureFolder(
      '05 Final Candidate',
      reqFolder,
    );
    const joiningFolderId = await this.ensureFolder(
      '06 Selected — Joining Docs',
      reqFolder,
    );

    // The folders stay PRIVATE to the recruitment account — never shared
    // "anyone with the link". External candidates submit through the secure
    // Application page (server-side upload), so they can't view or delete other
    // candidates' CVs.

    return {
      rootFolderId: reqFolder,
      rootFolderUrl: this.folderUrl(reqFolder),
      allCvFolderId,
      allCvFolderUrl: this.folderUrl(allCvFolderId),
      aiShortlistedFolderId,
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
  ): Promise<{ stream: Readable; mimeType: string; name?: string }> {
    const api = this.api();
    // `name` comes back too so the API can offer a sensible download filename
    // — files are streamed through this server now rather than opened on
    // drive.google.com, and without it every document saves as "download".
    const meta = await api.files.get({ fileId, fields: 'mimeType,name' });
    const sourceMime = meta.data.mimeType ?? 'application/octet-stream';
    const name = meta.data.name ?? undefined;

    // Google-native files (Docs, Sheets, Slides) hold no binary content, so
    // `alt: 'media'` fails on them outright. They reach us because
    // `syncFromDrive` imports whatever is sitting in the "01 All CVs" folder,
    // and somebody can drop a Google Doc CV there. Export converts one to a
    // real document instead of failing the download.
    const exportMime = GOOGLE_NATIVE_EXPORT[sourceMime];
    if (exportMime) {
      const exported = await api.files.export(
        { fileId, mimeType: exportMime },
        { responseType: 'stream' },
      );
      return {
        stream: exported.data as unknown as Readable,
        mimeType: exportMime,
        name: name ? `${name}${EXPORT_EXTENSION[exportMime] ?? ''}` : undefined,
      };
    }

    const res = await api.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' },
    );
    return {
      stream: res.data as unknown as Readable,
      mimeType: sourceMime,
      name,
    };
  }

  /** Download a file's full bytes + real mime type (used by AI doc extraction). */
  async getFileBuffer(
    fileId: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const api = this.api();
    const meta = await api.files.get({ fileId, fields: 'mimeType' });
    const mimeType = meta.data.mimeType ?? 'application/octet-stream';
    const res = await api.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' },
    );
    return { buffer: Buffer.from(res.data as ArrayBuffer), mimeType };
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
    const out: { id: string; name: string; mimeType: string; url: string }[] =
      [];
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
      case 'AI_SHORTLISTED':
        return map.aiShortlistedFolderId ?? map.allCvFolderId;
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

/**
 * What to convert a Google-native file into when someone asks to view it.
 *
 * PDF for anything document-shaped: it renders in the browser, preserves the
 * layout, and is what a reader of a CV or a certificate expects. Sheets export
 * as XLSX because a spreadsheet flattened to PDF loses the thing that makes it
 * a spreadsheet.
 */
const GOOGLE_NATIVE_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'application/pdf',
  'application/vnd.google-apps.script': 'application/json',
  'application/vnd.google-apps.spreadsheet':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Extension to append to an exported file's name, so it saves sensibly. */
const EXPORT_EXTENSION: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/json': '.json',
};
