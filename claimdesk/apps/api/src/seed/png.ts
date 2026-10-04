/**
 * Tiny programmatic PNG encoder for seed evidence (no binary fixtures in the repo). Produces a valid 8-bit RGB PNG of
 * a flat colour with a simple diagonal, large enough to look like a photo thumbnail and small enough to embed.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export interface PngOptions {
  width?: number;
  height?: number;
  rgb?: [number, number, number];
  /** Adds a diagonal band in a contrasting colour so images differ by content (and by hash). */
  seed?: number;
}

export function makePng(opts: PngOptions = {}): Buffer {
  const width = opts.width ?? 64;
  const height = opts.height ?? 48;
  const [r, g, b] = opts.rgb ?? [7, 38, 71];
  const seed = opts.seed ?? 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const band = Math.abs(x - y - (seed % width)) < 4;
      raw[o++] = band ? 255 - r : r;
      raw[o++] = band ? 255 - g : g;
      raw[o++] = band ? 255 - b : b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
