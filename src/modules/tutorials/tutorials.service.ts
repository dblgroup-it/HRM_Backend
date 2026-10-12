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
  canSee,
  readManifest,
  type TutorialEntry,
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
   * The guides for the roles this person holds — each with a signed link,
   * since a link opened in a new tab carries no session token. Super users
   * and the platform administrator get every guide.
   */
  async list(user: { id: string; role: string }) {
    const perms = await this.permissions.getUserPermissions(user.id);
    const keys = [...new Set(perms.roles.map((r) => r.key))];
    const everything = perms.isSuperUser || user.role === 'ADMIN';
    const roles = [
      ...new Map(perms.roles.map((r) => [r.key, r.name])).entries(),
    ].map(([key, name]) => ({ key, name }));
    if (user.role === 'ADMIN' && !roles.length) {
      roles.push({ key: 'admin', name: 'Administrator' });
    }

    const m = this.manifest();
    const visible = (m?.guides ?? []).filter((g) =>
      canSee(g, keys, everything),
    );
    return {
      version: m?.version || null,
      date: m?.date || null,
      scope: everything ? ('all' as const) : ('roles' as const),
      roles,
      guides: visible.map((g) => this.view(g)),
    };
  }

  private view(g: TutorialEntry) {
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
      group: g.group,
      contents: g.contents,
      pages: g.pages,
      bytes: g.bytes,
      url: `/api/tutorials/file/${grant}`,
      downloadUrl: `/api/tutorials/file/${grant}?download=1`,
      thumbUrl: g.thumb ? `/api/tutorials/thumb/${grant}` : null,
    };
  }

  /** The guide a signed link names. */
  private guideFor(grant: string): TutorialEntry {
    const { fileId: slug, purpose } = this.grants.verify(grant);
    if (purpose !== 'tutorial') {
      throw new ForbiddenException('This link does not open a tutorial.');
    }
    const guide = this.manifest()?.guides.find((g) => g.slug === slug);
    if (!guide)
      throw new NotFoundException('This guide is no longer available.');
    return guide;
  }

  /** The cover picture on a guide's card. */
  async thumb(grant: string, res: Response): Promise<void> {
    const guide = this.guideFor(grant);
    if (!guide.thumb) throw new NotFoundException('No cover picture.');
    const file = path.join(this.dir, guide.thumb);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new NotFoundException('No cover picture.');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(file).pipe(res);
  }

  /** Stream one guide named by a signed link. */
  async stream(grant: string, download: boolean, res: Response): Promise<void> {
    const guide = this.guideFor(grant);
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
