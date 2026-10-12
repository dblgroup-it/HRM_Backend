import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FileGrantService } from '../../common/files/file-grant.service';
import { PermissionsService } from '../rbac/permissions.service';
import {
  isForYou,
  readManifest,
  type TutorialManifest,
} from './tutorial-catalogue';

/**
 * A guide link stays good for a working day. Each opens one internal PDF and
 * nothing else, and the page refreshes its links whenever it is looked at.
 */
const LINK_TTL_SECONDS = 12 * 60 * 60;

/** Re-read the manifest at most this often; it only changes with a deploy. */
const CACHE_MS = 5 * 60 * 1000;

@Injectable()
export class TutorialsService {
  /** `HRM_Backend/assets/tutorials` — the same depth from `src/` and `dist/`. */
  private readonly dir =
    process.env.TUTORIALS_DIR ||
    path.resolve(__dirname, '..', '..', '..', 'assets', 'tutorials');
  private cache: { at: number; manifest: TutorialManifest | null } | null =
    null;

  constructor(
    private readonly permissions: PermissionsService,
    private readonly grants: FileGrantService,
  ) {}

  private manifest(): TutorialManifest | null {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      this.cache = { at: Date.now(), manifest: readManifest(this.dir) };
    }
    return this.cache.manifest;
  }

  /**
   * Every guide, the ones written for this person's roles marked, each with
   * a signed link — the session token is not sent with a link opened in a
   * new tab, so the link carries its own short-lived permission.
   */
  async list(user: { id: string; role: string }) {
    const m = this.manifest();
    if (!m) return { version: null, date: null, guides: [] };
    const perms = await this.permissions.getUserPermissions(user.id);
    const keys = perms.roles.map((r) => r.key);
    return {
      version: m.version,
      date: m.date,
      guides: m.guides.map((g) => {
        const grant = this.grants.mint(g.slug, 'tutorial', {
          filename: g.file,
          ttlSeconds: LINK_TTL_SECONDS,
        });
        return {
          slug: g.slug,
          number: g.number,
          title: g.title,
          kicker: g.kicker,
          subtitle: g.subtitle,
          audience: g.audience,
          pages: g.pages,
          bytes: g.bytes,
          forYou: isForYou(g, keys, user.role === 'ADMIN'),
          url: `/api/tutorials/file/${grant}`,
          downloadUrl: `/api/tutorials/file/${grant}?download=1`,
        };
      }),
    };
  }

  /** Stream one guide named by a signed link. */
  async stream(grant: string, download: boolean, res: Response): Promise<void> {
    const { fileId: slug, purpose } = this.grants.verify(grant);
    if (purpose !== 'tutorial') {
      throw new ForbiddenException('This link does not open a tutorial.');
    }
    const guide = this.manifest()?.guides.find((g) => g.slug === slug);
    if (!guide)
      throw new NotFoundException('This guide is no longer available.');
    const file = path.join(this.dir, guide.file);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      throw new NotFoundException('This guide is no longer available.');
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${guide.file}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(file).pipe(res);
  }
}
