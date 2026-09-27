import {
  decodeDataUri,
  detectImageMime,
  isFetchableUrl,
  loadPhoto,
  PhotoError,
} from './candidate-photo';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function res(status: number, body?: Buffer, headers: Record<string, string> = {}) {
  return new Response(body ? new Uint8Array(body) : null, { status, headers });
}

describe('candidate photo', () => {
  it('identifies an image by its bytes, not its label', () => {
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(Buffer.from('<svg></svg>'))).toBeNull();
  });

  it('decodes an inline data: URI and rejects one that is not an image', () => {
    const ok = decodeDataUri(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(ok?.mimeType).toBe('image/png');
    expect(() =>
      decodeDataUri(`data:image/png;base64,${Buffer.from('hello').toString('base64')}`),
    ).toThrow(PhotoError);
    expect(decodeDataUri('https://x.example/a.png')).toBeNull();
  });

  it.each([
    'http://localhost/a.png',
    'http://127.0.0.1/a.png',
    'http://10.0.0.5/a.png',
    'http://172.20.1.1/a.png',
    'http://192.168.22.207/a.png',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/a.png',
    'http://intranet/a.png',
    'ftp://images.example.com/a.png',
    'file:///etc/passwd',
  ])('refuses to fetch %s', (url) => {
    expect(isFetchableUrl(url)).toBe(false);
  });

  it('fetches a public link', async () => {
    expect(isFetchableUrl('https://images.bdjobs.com/p/1.jpg')).toBe(true);
    const photo = await loadPhoto('https://images.bdjobs.com/p/1.jpg', (async () =>
      res(200, JPEG)) as typeof fetch);
    expect(photo.mimeType).toBe('image/jpeg');
    expect(photo.sourceUrl).toBe('https://images.bdjobs.com/p/1.jpg');
  });

  it('refuses a public link that redirects inside the network', async () => {
    const fake = (async () =>
      res(302, undefined, { location: 'http://127.0.0.1/secret' })) as typeof fetch;
    await expect(loadPhoto('https://images.bdjobs.com/p/1.jpg', fake)).rejects.toThrow(
      /redirected to an address that is not public/,
    );
  });

  it('refuses anything over 2 MB, whatever Content-Length said', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]);
    const fake = (async () => res(200, big, { 'content-length': '10' })) as typeof fetch;
    await expect(loadPhoto('https://images.bdjobs.com/p/1.jpg', fake)).rejects.toThrow(/2 MB/);
  });
});
