import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { byteRange, readVideoCatalogue } from './tutorial-video-catalogue';

describe('tutorial video catalogue', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-videos-'));
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
    fs.writeFileSync(path.join(dir, 'a.bn.vtt'), 'WEBVTT');
    fs.writeFileSync(path.join(dir, 'a.720p.mp4'), 'x');
    fs.writeFileSync(
      path.join(dir, 'videos.json'),
      JSON.stringify({
        version: 1,
        videos: [
          {
            slug: 'raiser',
            file: 'a.mp4',
            title: 'A',
            durationMs: 1000.4,
            bytes: 1,
            chapters: [
              { n: 2, title: 'Two', startMs: 500 },
              { n: 1, title: 'One', startMs: 0 },
              { title: 'bad' },
            ],
            subtitles: {
              bn: 'a.bn.vtt',
              en: 'missing.en.vtt',
              xx1: 'a.bn.vtt',
            },
            poster: 'nope.jpg',
            publishedAt: '2026-10-21',
            renditions: { '720': 'a.720p.mp4', '480': 'a.480p.mp4' },
          },
          { slug: 'gone', file: 'gone.mp4', chapters: [] },
          { slug: 'odd', file: '../x.mp4', chapters: [] },
        ],
      }),
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps only videos whose file exists, with chapters in order and subtitles that exist', () => {
    const c = readVideoCatalogue(dir);
    expect(c?.videos.map((v) => v.slug)).toEqual(['raiser']);
    const v = c!.videos[0];
    expect(v.chapters.map((ch) => ch.title)).toEqual(['One', 'Two']);
    expect(v.durationMs).toBe(1000);
    expect(v.subtitles).toEqual({ bn: 'a.bn.vtt' });
    expect(v.poster).toBeUndefined();
  });

  it('offers a lighter rendition only when its file is there', () => {
    const v = readVideoCatalogue(dir)!.videos[0];
    expect(v.renditions).toEqual({ '720': 'a.720p.mp4' });
    expect(v.publishedAt).toBe('2026-10-21');
  });

  it('is null without a catalogue', () => {
    expect(readVideoCatalogue(path.join(dir, 'nowhere'))).toBeNull();
  });

  it('reads a byte range the way a video element asks for it', () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(byteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=100-', 100)).toBeNull();
    expect(byteRange('items=1-2', 100)).toBeNull();
  });
});
