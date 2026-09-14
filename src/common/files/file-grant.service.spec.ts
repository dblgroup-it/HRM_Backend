import { ForbiddenException } from '@nestjs/common';

import { FileGrantService } from './file-grant.service';
import type { ConfigService } from '@nestjs/config';

const cfg = (secret = 'a-long-development-jwt-secret-value') =>
  ({ get: () => secret }) as unknown as ConfigService;

/**
 * A grant is what replaced Google Drive's "anyone with the link". It has to be
 * unforgeable, bound to one file, and short-lived — these prove all three.
 */
describe('FileGrantService', () => {
  const svc = new FileGrantService(cfg());

  it('round-trips the file it was minted for', () => {
    const g = svc.mint('file-abc', 'cv', { filename: 'CV.pdf' });
    const out = svc.verify(g);
    expect(out.fileId).toBe('file-abc');
    expect(out.purpose).toBe('cv');
    expect(out.filename).toBe('CV.pdf');
  });

  it('rejects a grant whose payload was edited to name another file', () => {
    const g = svc.mint('file-abc', 'cv');
    const [body, sig] = g.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
    decoded.f = 'file-SOMEONE-ELSE';
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${sig}`;
    expect(() => svc.verify(forged)).toThrow(ForbiddenException);
  });

  it('rejects a grant signed with a different secret', () => {
    const other = new FileGrantService(cfg('a-completely-different-secret'));
    expect(() => svc.verify(other.mint('file-abc', 'cv'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects an expired grant', () => {
    const g = svc.mint('file-abc', 'cv', { ttlSeconds: -1 });
    expect(() => svc.verify(g)).toThrow(ForbiddenException);
  });

  it('rejects malformed input without throwing something unhelpful', () => {
    for (const bad of ['', 'nonsense', 'a.b', 'a.b.c.d']) {
      expect(() => svc.verify(bad)).toThrow(ForbiddenException);
    }
  });

  it('mints a relative API path, never a Google Drive URL', () => {
    const url = svc.url('file-abc', 'cv');
    expect(url).toMatch(/^\/api\/files\//);
    expect(url).not.toContain('drive.google.com');
  });

  it('returns null when there is no file, so callers fall back cleanly', () => {
    expect(svc.url(null, 'cv')).toBeNull();
    expect(svc.url(undefined, 'cv')).toBeNull();
  });

  it('does not leak the file id in the clear-ish part of the URL', () => {
    // base64url-encoded, not plaintext — a casual reader of a log or a
    // Referer header does not get a Drive id handed to them.
    const url = svc.url('1AbCdEfGhIjKlMnOpQrSt', 'cv')!;
    expect(url).not.toContain('1AbCdEfGhIjKlMnOpQrSt');
  });
});
