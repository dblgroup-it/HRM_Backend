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
import { SettingsService } from '../settings/settings.service';
import {
  canSee,
  readManifest,
  type TutorialEntry,
  type TutorialManifest,
} from './tutorial-catalogue';
import {
  byteRange,
  readVideoCatalogue,
  RENDITIONS,
  type Rendition,
  type TutorialVideoCatalogue,
  type TutorialVideoEntry,
} from './tutorial-video-catalogue';
import { playlistLinks } from './tutorial-videos';

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
  /** `HRM_Backend/assets/tutorial-videos` — the recorded role-guide videos. */
  private readonly videoDir =
    process.env.TUTORIAL_VIDEOS_DIR ||
    path.resolve(__dirname, '..', '..', '..', 'assets', 'tutorial-videos');
  private videoCache: {
    at: number;
    catalogue: TutorialVideoCatalogue | null;
  } | null = null;

  constructor(
    private readonly permissions: PermissionsService,
    private readonly grants: FileGrantService,
    private readonly settings: SettingsService,
  ) {}

  private manifest(): TutorialManifest | null {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      this.cache = { at: Date.now(), manifest: readManifest(this.dir) };
    }
    return this.cache.manifest;
  }

  private videoCatalogue(): TutorialVideoCatalogue | null {
    if (!this.videoCache || Date.now() - this.videoCache.at > CACHE_MS) {
      this.videoCache = {
        at: Date.now(),
        catalogue: readVideoCatalogue(this.videoDir),
      };
    }
    return this.videoCache.catalogue;
  }

  private videoFor(slug: string): TutorialVideoEntry | undefined {
    return this.videoCatalogue()?.videos.find((v) => v.slug === slug);
  }

  /**
   * The guides for the roles this person holds — each with a signed link,
   * since a link opened in a new tab carries no session token. Super users
   * and the platform administrator get every guide. The video playlist is
   * for everyone, whatever their roles.
   */
  async list(user: { id: string; role: string }) {
    const [perms, video] = await Promise.all([
      this.permissions.getUserPermissions(user.id),
      this.settings.getTutorialVideoConfig(),
    ]);
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
      videos: video.playlistId
        ? {
            playlistId: video.playlistId,
            title: video.title,
            channel: video.channel || null,
            ...playlistLinks(video.playlistId),
          }
        : null,
    };
  }

  private view(g: TutorialEntry) {
    const grant = this.grants.mint(g.slug, 'tutorial', {
      filename: g.file,
      ttlSeconds: LINK_TTL_SECONDS,
    });
    const video = this.videoFor(g.slug);
    return {
      slug: g.slug,
      number: g.number,
      title: g.title,
      kicker: g.kicker,
      subtitle: g.subtitle,
      audience: g.audience,
      group: g.group,
      contents: g.contents,
      chapters: g.chapters,
      pages: g.pages,
      bytes: g.bytes,
      url: `/api/tutorials/file/${grant}`,
      downloadUrl: `/api/tutorials/file/${grant}?download=1`,
      thumbUrl: g.thumb ? `/api/tutorials/thumb/${grant}` : null,
      // The guide's video, cut into its chapters — the same signed link, so a
      // person who may read the guide may watch it, and nobody else.
      video: video
        ? {
            url: `/api/tutorials/video/${grant}`,
            // The recorded 1080p, and each lighter rendition on the server.
            sources: {
              '1080': `/api/tutorials/video/${grant}`,
              ...Object.fromEntries(
                Object.keys(video.renditions ?? {}).map((q) => [
                  q,
                  `/api/tutorials/video/${grant}?q=${q}`,
                ]),
              ),
            },
            durationMs: video.durationMs,
            bytes: video.bytes,
            chapters: video.chapters,
            subtitles: Object.fromEntries(
              Object.keys(video.subtitles).map((lang) => [
                lang,
                `/api/tutorials/video/${grant}/subtitles/${lang}.vtt`,
              ]),
            ),
            posterUrl: video.poster
              ? `/api/tutorials/video/${grant}/poster`
              : null,
            publishedAt: video.publishedAt ?? null,
          }
        : null,
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

  private videoOf(grant: string): {
    guide: TutorialEntry;
    video: TutorialVideoEntry;
  } {
    const guide = this.guideFor(grant);
    const video = this.videoFor(guide.slug);
    if (!video) throw new NotFoundException('This guide has no video.');
    return { guide, video };
  }

  /**
   * Stream a guide's video. A video element asks for byte ranges as the viewer
   * seeks and as the chapters jump, so ranges are honoured (206); without one
   * the whole file goes (200). Either way the link is the same signed grant
   * that opens the PDF.
   */
  async streamVideo(
    grant: string,
    rangeHeader: string | undefined,
    res: Response,
    quality?: string,
  ): Promise<void> {
    const { video } = this.videoOf(grant);
    // `?q=720` asks for a lighter rendition; anything else (or none) is the recorded 1080p.
    const rendition =
      quality && (RENDITIONS as readonly string[]).includes(quality)
        ? video.renditions?.[quality as Rendition]
        : undefined;
    if (quality && quality !== '1080' && !rendition)
      throw new NotFoundException('This video has no such quality.');
    const file = path.join(this.videoDir, rendition ?? video.file);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile())
      throw new NotFoundException('This video is no longer available.');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const range = byteRange(rangeHeader, stat.size);
    if (rangeHeader && !range) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.end();
      return;
    }
    if (range) {
      res.status(206);
      res.setHeader(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${stat.size}`,
      );
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      fs.createReadStream(file, { start: range.start, end: range.end }).pipe(
        res,
      );
      return;
    }
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(file).pipe(res);
  }

  /** A video's subtitles in one language, as WebVTT. */
  async videoSubtitles(
    grant: string,
    lang: string,
    res: Response,
  ): Promise<void> {
    const { video } = this.videoOf(grant);
    const name = video.subtitles[lang.replace(/\.vtt$/, '')];
    if (!name) throw new NotFoundException('No subtitles in that language.');
    const file = path.join(this.videoDir, name);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile())
      throw new NotFoundException('No subtitles in that language.');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(file).pipe(res);
  }

  /** The still shown before the video plays. */
  async videoPoster(grant: string, res: Response): Promise<void> {
    const { video } = this.videoOf(grant);
    if (!video.poster) throw new NotFoundException('No poster.');
    const file = path.join(this.videoDir, video.poster);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new NotFoundException('No poster.');
    const ext = path.extname(video.poster).toLowerCase();
    res.setHeader(
      'Content-Type',
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : 'image/jpeg',
    );
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(file).pipe(res);
  }
}
