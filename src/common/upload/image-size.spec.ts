import { deflateSync } from 'node:zlib';

import { imageSize } from './image-size';
import { signatureRatioError } from '../signature.util';

/** A real PNG of the given size — header parsing must be tested on real bytes. */
function png(width: number, height: number): Buffer {
  const raw = Buffer.concat(
    Array.from({ length: height }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xff)]),
    ),
  );
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    // The reader never checks the CRC, so a placeholder keeps the test honest
    // about what is actually being exercised: the IHDR dimensions.
    crc.writeUInt32BE(0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A minimal but structurally real GIF87a header. */
function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF87a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

describe('imageSize', () => {
  it('reads PNG dimensions', () => {
    expect(imageSize(png(600, 200))).toEqual({
      width: 600,
      height: 200,
      type: 'png',
    });
  });

  it('reads GIF dimensions', () => {
    expect(imageSize(gif(900, 300))).toEqual({
      width: 900,
      height: 300,
      type: 'gif',
    });
  });

  it('returns null for something that is not an image', () => {
    expect(
      imageSize(Buffer.from('this is a text file, not a picture')),
    ).toBeNull();
  });

  it('returns null rather than throwing on a truncated header', () => {
    // An upload can arrive cut short; it must not take the request down.
    const cut = png(600, 200).subarray(0, 12);
    expect(() => imageSize(cut)).not.toThrow();
    expect(imageSize(cut)).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(imageSize(Buffer.alloc(0))).toBeNull();
  });
});

describe('signatureRatioError', () => {
  it('accepts an exact 3:1 crop', () => {
    expect(signatureRatioError(900, 300)).toBeNull();
  });

  it('accepts a hand-trimmed crop near 3:1', () => {
    // Nobody crops a scan to three decimal places.
    expect(signatureRatioError(880, 300)).toBeNull(); // 2.93:1
    expect(signatureRatioError(950, 300)).toBeNull(); // 3.17:1
  });

  it('refuses a square', () => {
    const msg = signatureRatioError(300, 300);
    expect(msg).toContain('3 times as wide');
    expect(msg).toContain('300×300');
  });

  it('refuses a full-page scan', () => {
    expect(signatureRatioError(1240, 1754)).not.toBeNull();
  });

  it('tells the uploader what size would work', () => {
    // An error that only says "wrong" makes the person guess.
    expect(signatureRatioError(300, 300)).toContain('900×300');
  });

  it('refuses an image with no usable dimensions', () => {
    expect(signatureRatioError(0, 0)).not.toBeNull();
  });
});
