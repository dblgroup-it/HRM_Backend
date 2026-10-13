import { loadRemoteCv, REMOTE_CV_MAX_BYTES } from './remote-cv';

/**
 * The customized CV a Bdjobs applicant attached is a link on somebody else's
 * server. It is fetched for the AI to read beside the profile — so it gets
 * the same care as the photo: public addresses only, at every hop; a size
 * cap; and only what the AI can read.
 */

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');

function reply(
  body: Buffer | null,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body ? new Uint8Array(body) : null, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

describe('loadRemoteCv', () => {
  it('reads a PDF from a public link', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(PDF));
    const cv = await loadRemoteCv('https://bdjobs.example/cv.pdf', fetchFn);
    expect(cv.mimeType).toBe('application/pdf');
    expect(cv.data.equals(PDF)).toBe(true);
  });

  it('never asks the server for its own network', async () => {
    const fetchFn = jest.fn();
    for (const url of [
      'http://localhost:4000/api',
      'http://127.0.0.1/cv.pdf',
      'http://192.168.22.207/cv.pdf',
      'http://intranet/cv.pdf',
      'file:///etc/passwd',
    ])
      await expect(loadRemoteCv(url, fetchFn)).rejects.toThrow('not a public');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('checks every redirect, not just the first address', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        reply(null, {
          status: 302,
          headers: { location: 'http://10.0.0.5/cv.pdf' },
        }),
      );
    await expect(
      loadRemoteCv('https://bdjobs.example/cv.pdf', fetchFn),
    ).rejects.toThrow('redirected to an address that is not public');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses what the AI cannot read, by the bytes rather than the name', async () => {
    const docx = Buffer.from('PK\u0003\u0004 word/document.xml');
    const fetchFn = jest
      .fn()
      .mockResolvedValue(
        reply(docx, { headers: { 'content-type': 'application/pdf' } }),
      );
    await expect(
      loadRemoteCv('https://bdjobs.example/cv.pdf', fetchFn),
    ).rejects.toThrow('not a PDF or an image');
  });

  it('stops at 10 MB whatever the server claims', async () => {
    const big = Buffer.alloc(REMOTE_CV_MAX_BYTES + 1, 0x20);
    big.write('%PDF-');
    const fetchFn = jest.fn().mockResolvedValue(reply(big));
    await expect(
      loadRemoteCv('https://bdjobs.example/cv.pdf', fetchFn),
    ).rejects.toThrow('larger than 10 MB');
  });
});
