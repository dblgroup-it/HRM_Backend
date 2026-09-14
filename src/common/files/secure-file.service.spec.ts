import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Readable, Writable } from 'node:stream';

import { SecureFileService } from './secure-file.service';
import type { DriveService } from '../../modules/integrations/google/drive.service';

/**
 * Regression cover for the secure-file viewing bug.
 *
 * Two defects shipped together and both showed up as "the document will not
 * open". The first was a frontend URL-origin problem (covered on that side);
 * this file covers the second, which was entirely server-side: Node's
 * `setHeader` throws `ERR_INVALID_CHAR` on any character outside Latin-1, and
 * every CV in this system is named `"<Candidate> — CV.pdf"` with an em dash.
 * So the header line threw, the request 500'd, and no document could be served
 * at all.
 */
describe('SecureFileService.stream', () => {
  function build(media: { mimeType: string; name?: string } | Error) {
    const drive = {
      getFileMedia: jest.fn().mockImplementation(() =>
        media instanceof Error
          ? Promise.reject(media)
          : Promise.resolve({
              ...media,
              stream: Readable.from(['pdf-bytes']),
            }),
      ),
    } as unknown as DriveService;

    // A real Writable, so `stream.pipe(res)` behaves as it does in the server
    // rather than against a stub that would hide a piping bug.
    const headers: Record<string, string> = {};
    const res = new Writable({ write: (_c, _e, cb) => cb() }) as Writable &
      Record<string, unknown>;
    res.setHeader = (k: string, v: string) => {
      // Node's own rule for header values. Without reproducing it the test
      // would pass on a plain object while the real server threw
      // ERR_INVALID_CHAR — which is exactly the bug being covered.
      if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(v)) {
        throw new TypeError(`Invalid character in header content ["${k}"]`);
      }
      headers[k.toLowerCase()] = v;
    };
    res.status = jest.fn().mockReturnValue(res);
    res.headersSent = false;

    return { svc: new SecureFileService(drive), res, headers };
  }

  const run = async (
    filename: string | undefined,
    driveName = 'OMOR KYUM Aunto — CV.pdf',
  ) => {
    const { svc, res, headers } = build({
      mimeType: 'application/pdf',
      name: driveName,
    });
    await svc.stream(res as never, 'file-1', { filename });
    return headers;
  };

  it('serves a file whose name contains an em dash (the exact 500)', async () => {
    const h = await run('Mohammad Rahman — CV');
    expect(h['content-disposition']).toContain('inline;');
    // ASCII fallback: em dash folded to a hyphen, still readable.
    expect(h['content-disposition']).toContain(
      'filename="Mohammad Rahman - CV"',
    );
    // The real name survives, percent-encoded, for clients that prefer it.
    expect(h['content-disposition']).toContain(
      "filename*=UTF-8''Mohammad%20Rahman%20%E2%80%94%20CV",
    );
  });

  it('serves a file when the name comes from Drive rather than the grant', async () => {
    // No filename in the grant -> falls back to the Drive name, which is also
    // em-dashed because that is how uploads are named.
    const h = await run(undefined);
    expect(h['content-disposition']).toContain(
      'filename="OMOR KYUM Aunto - CV.pdf"',
    );
  });

  it('serves a file named in a non-Latin script', async () => {
    const h = await run('রহমান — CV');
    // Fallback keeps the shape without throwing...
    expect(h['content-disposition']).toMatch(/filename="_+ - CV"/);
    // ...and the real name is still delivered.
    expect(h['content-disposition']).toContain("filename*=UTF-8''%E0%A6%B0");
  });

  it.each([
    ['curly quotes', 'Nadia ‘Nadi’ Rahman CV'],
    ['ellipsis', 'Long Name… CV'],
    ['en dash', 'A – B CV'],
    ['accents', 'José Álvarez CV'],
    ['emoji', 'CV 🎯'],
  ])('does not throw on %s', async (_label, name) => {
    await expect(run(name)).resolves.toBeDefined();
  });

  it('cannot be used to inject a second header or directive', async () => {
    const h = await run('evil"; attachment; x="a\r\nX-Injected: 1');
    const cd = h['content-disposition'];

    // The characters that would let a name break out are gone. The words
    // themselves may remain as inert text inside the quoted filename — that is
    // harmless, and stripping them would be security theatre.
    expect(cd).not.toMatch(/[\r\n]/); // no header splitting
    // Exactly two quotes — the pair delimiting the filename. A third would
    // mean the name closed the string early and started something new.
    expect(cd.match(/"/g)).toHaveLength(2);
    // And exactly two semicolons: the two real parameter separators.
    expect(cd.match(/;/g)).toHaveLength(2);

    // Still exactly one of each parameter, and still `inline`.
    expect(cd.startsWith('inline; filename="')).toBe(true);
    expect(cd.match(/filename\*?=/g)).toHaveLength(2); // filename= and filename*=
  });

  it('sets the real mime type and forbids caching', async () => {
    const { svc, res, headers } = build({
      mimeType: 'image/png',
      name: 'x.png',
    });
    await svc.stream(res as never, 'f', {});
    expect(headers['content-type']).toBe('image/png');
    expect(headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  describe('Drive failures are not all the same thing', () => {
    const driveError = (code: number, message: string) =>
      Object.assign(new Error(message), { code });

    it('reports a genuinely missing file as 404', async () => {
      const { svc, res } = build(driveError(404, 'File not found: abc'));
      await expect(svc.stream(res as never, 'gone', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([
      [401, 'Invalid Credentials'],
      [403, 'The user does not have sufficient permissions'],
      [500, 'Internal Error'],
      [503, 'Backend Error'],
    ])(
      'reports a Drive %s as unavailable, not as a missing document',
      async (code, message) => {
        // The caller was already authorized; this is the server's own Drive
        // credential or Drive itself failing. Calling that "not found" sends
        // whoever is debugging in the wrong direction — which is how the
        // original regression stayed hidden.
        const { svc, res } = build(driveError(code, message));
        await expect(svc.stream(res as never, 'f', {})).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      },
    );

    it("never forwards Drive's own error text to the caller", async () => {
      const { svc, res } = build(
        driveError(403, 'hr.recruitment@dbl-group.com lacks permission'),
      );
      await expect(svc.stream(res as never, 'f', {})).rejects.not.toThrow(
        /hr\.recruitment/,
      );
    });
  });
});
