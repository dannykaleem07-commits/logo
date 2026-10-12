// owned by intake-server
/**
 * Photo pixels for the perceptual hash (docs/SMART-INTAKE.md §5.2, improvement 5). JPEG: the embedded EXIF thumbnail
 * when there is one (fast), else a bounded jpeg-js decode (≤ 50 megapixels, ≤ 512 MB); PNG: pngjs. GIF / WebP / HEIC
 * are not hashed; files over 40 MB are not decoded. EXIF itself comes from the evidence row (`storeEvidence` read it).
 */
import exifr from 'exifr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { dHash64, toGray } from '@ccguk/domain';

export const MAX_HASH_DECODE_BYTES = 40 * 1024 * 1024;

export interface DecodedForHash {
  phash: string;
  /** Pixels of the full image (from the header / decode). */
  pixels: number;
  width: number;
  height: number;
  /** The pixels hashed came from the EXIF thumbnail. */
  fromThumbnail: boolean;
}

function jpegDims(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function decodeJpeg(buf: Buffer): { data: Uint8Array; width: number; height: number } {
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 50, maxMemoryUsageInMB: 512, tolerantDecoding: true });
  return { data: img.data, width: img.width, height: img.height };
}

/** dHash + pixel count of a JPEG or PNG; null for other kinds, oversized files or undecodable data. */
export async function decodeForHash(buffer: Buffer, sniffedKind: string): Promise<DecodedForHash | null> {
  if (buffer.length > MAX_HASH_DECODE_BYTES) return null;
  try {
    if (sniffedKind === 'jpeg') {
      const dims = jpegDims(buffer);
      let thumb: Uint8Array | undefined;
      try {
        thumb = (await exifr.thumbnail(buffer)) as Uint8Array | undefined;
      } catch {
        thumb = undefined;
      }
      if (thumb && thumb.length > 100) {
        try {
          const t = decodeJpeg(Buffer.from(thumb));
          const full = dims ?? { width: t.width, height: t.height };
          return { phash: dHash64(toGray(t.data, t.width, t.height), t.width, t.height), pixels: full.width * full.height, width: full.width, height: full.height, fromThumbnail: true };
        } catch {
          /* fall through to the full decode */
        }
      }
      const img = decodeJpeg(buffer);
      return { phash: dHash64(toGray(img.data, img.width, img.height), img.width, img.height), pixels: img.width * img.height, width: img.width, height: img.height, fromThumbnail: false };
    }
    if (sniffedKind === 'png') {
      const png = PNG.sync.read(buffer);
      const data = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
      return { phash: dHash64(toGray(data, png.width, png.height), png.width, png.height), pixels: png.width * png.height, width: png.width, height: png.height, fromThumbnail: false };
    }
  } catch {
    return null;
  }
  return null;
}

/** GPS position from a photo's EXIF (bounded; null when absent or unreadable). */
export async function photoGps(buffer: Buffer): Promise<{ lat: number; lon: number } | null> {
  if (buffer.length > MAX_HASH_DECODE_BYTES) return null;
  try {
    const g = (await exifr.gps(buffer)) as { latitude?: number; longitude?: number } | undefined;
    return g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude) ? { lat: g.latitude!, lon: g.longitude! } : null;
  } catch {
    return null;
  }
}
