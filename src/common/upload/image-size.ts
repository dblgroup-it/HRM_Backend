/**
 * Image dimensions read from the file header.
 *
 * Needed to enforce the 3:1 aspect ratio on e-signatures. Done by hand rather
 * than by adding sharp or image-size: this reads a few bytes of a header, it
 * is the only place in the codebase that needs it, and sharp in particular
 * drags a native binary into every deploy on a Windows server that has already
 * cost this project two outages over native build steps.
 *
 * Returns null for anything it does not recognise, and the caller decides what
 * that means — refusing an image because the format is unfamiliar is a worse
 * outcome than not checking its ratio.
 */

export interface ImageDimensions {
  width: number;
  height: number;
  type: 'png' | 'jpeg' | 'gif' | 'webp';
}

function png(b: Buffer): ImageDimensions | null {
  // 89 50 4E 47 0D 0A 1A 0A, then an IHDR chunk whose data starts at byte 16.
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) {
    return null;
  }
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), type: 'png' };
}

function jpeg(b: Buffer): ImageDimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1; // Resynchronise rather than give up — padding bytes are legal.
      continue;
    }
    const marker = b[i + 1];
    // Standalone markers carry no length.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    // SOF0-SOF15 hold the frame size; DHT (c4), JPG (c8) and DAC (cc) do not.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      return {
        height: b.readUInt16BE(i + 5),
        width: b.readUInt16BE(i + 7),
        type: 'jpeg',
      };
    }
    if (length < 2) return null; // Malformed; stop rather than loop forever.
    i += 2 + length;
  }
  return null;
}

function gif(b: Buffer): ImageDimensions | null {
  if (b.length < 10) return null;
  const magic = b.toString('ascii', 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), type: 'gif' };
}

function webp(b: Buffer): ImageDimensions | null {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const format = b.toString('ascii', 12, 16);

  if (format === 'VP8 ') {
    // Lossy: a 3-byte start code, then 14-bit width and height.
    return {
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
      type: 'webp',
    };
  }
  if (format === 'VP8L') {
    // Lossless: 14 bits each, packed across four bytes after the signature.
    const bits = b.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      type: 'webp',
    };
  }
  if (format === 'VP8X') {
    // Extended: 24-bit values, stored minus one.
    const w = b[24] | (b[25] << 8) | (b[26] << 16);
    const h = b[27] | (b[28] << 8) | (b[29] << 16);
    return { width: w + 1, height: h + 1, type: 'webp' };
  }
  return null;
}

/** Dimensions of a PNG, JPEG, GIF or WebP; null for anything else. */
export function imageSize(buffer: Buffer): ImageDimensions | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
  for (const read of [png, jpeg, gif, webp]) {
    try {
      const size = read(buffer);
      // A zero dimension is a corrupt header, not a valid image.
      if (size && size.width > 0 && size.height > 0) return size;
    } catch {
      // A truncated or malformed file must not take the request down; the next
      // reader gets a turn and an unrecognised image ends up as null.
    }
  }
  return null;
}
