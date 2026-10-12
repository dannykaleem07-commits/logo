/**
 * Perceptual hash (docs/SMART-INTAKE.md §4.12, improvement 5): a 64-bit difference hash. The image is reduced to 9×8
 * grey (box averaging), and each bit says whether a pixel is brighter than its right-hand neighbour. Resizing and
 * re-compressing a photo changes only a few bits; different photos differ in about half of them.
 */

/** RGBA (or RGB when `channels` is 3) → 8-bit luma (Rec. 601). */
export function toGray(rgba: Uint8Array, w: number, h: number, channels = 4): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i += 1, p += channels) out[i] = Math.round(0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!);
  return out;
}

/** Box-average resize of a grey image to tw × th. */
export function areaResize(gray: Uint8Array, w: number, h: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty += 1) {
    const y0 = (ty * h) / th;
    const y1 = ((ty + 1) * h) / th;
    for (let tx = 0; tx < tw; tx += 1) {
      const x0 = (tx * w) / tw;
      const x1 = ((tx + 1) * w) / tw;
      let sum = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1) && y < h; y += 1) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.ceil(x1) && x < w; x += 1) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          sum += gray[y * w + x]! * wx * wy;
          area += wx * wy;
        }
      }
      out[ty * tw + tx] = area > 0 ? Math.round(sum / area) : 0;
    }
  }
  return out;
}

/** 64-bit difference hash as 16 hex characters. */
export function dHash64(gray: Uint8Array, w: number, h: number): string {
  const small = areaResize(gray, w, h, 9, 8);
  let hex = '';
  for (let y = 0; y < 8; y += 1) {
    let byte = 0;
    for (let x = 0; x < 8; x += 1) byte = (byte << 1) | (small[y * 9 + x]! > small[y * 9 + x + 1]! ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));

/** Number of differing bits between two hex hashes of equal length (Infinity when they cannot be compared). */
export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    if (Number.isNaN(x)) return Infinity;
    d += POP[x]!;
  }
  return d;
}
