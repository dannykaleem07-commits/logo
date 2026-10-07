import { readFileSync } from 'node:fs';
import { unzipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  cellContentBox,
  DocxImageSession,
  EMU_PER_TWIP,
  findImagePlaceholders,
  fitImage,
  insertDocxImages,
  listDocxPictures,
  neutraliseOrientation,
  orientationTransform,
  readImageInfo
} from './images.js';
import { DocxError } from './types.js';
import { openDocx, writeDocx } from './zip.js';
import { docx, p, pt, r, tbl, tc, tr } from './__fixtures__/build.js';

const now = new Date('2026-10-07T09:00:00Z');
const xmlOf = (bytes: Uint8Array, part = 'word/document.xml'): string => new TextDecoder().decode(unzipSync(bytes)[part]);
const fixture = (f: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../engineer/__fixtures__/${f}`, import.meta.url)));
const JPEG_LANDSCAPE = fixture('photo-1-front-offside.jpg'); // 1600 × 1200, no orientation
const JPEG_EXIF6 = fixture('photo-2-rear-nearside-exif6.jpg'); // stored 1200 × 900, orientation 6 → 900 × 1200

// --- a tiny deterministic PNG encoder (RGB, 8-bit) with an optional eXIf chunk -------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function png(width: number, height: number, orientation?: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([x * 7, y * 5, 128], y * (1 + width * 3) + 1 + x * 3);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (orientation) {
    // big-endian TIFF, IFD0 with one entry: 0x0112 SHORT 1 = orientation
    const tiff = new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
    parts.push(chunk('eXIf', tiff));
  }
  parts.push(chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

const PHOTO_GRID = docx(
  [
    pt('Photographs'),
    tbl(
      [
        tr([tc([p(r('IMAGE 01', { b: true })), p(r('Insert photograph'))], { w: 4500 }), tc([p(r('IMAGE 02', { b: true })), p(r('Insert photograph'))], { w: 4500 })], { height: 3000 }),
        tr([tc(p(r('Damage sketch')), { w: 4500 }), tc(p(''), { w: 4500 })])
      ],
      [4500, 4500]
    ),
    pt('Photographs follow.')
  ].join('')
);

describe('readImageInfo', () => {
  it('reads JPEG size and EXIF orientation', () => {
    expect(readImageInfo(JPEG_LANDSCAPE)).toEqual({ format: 'jpeg', width: 1600, height: 1200, orientation: 1, displayWidth: 1600, displayHeight: 1200 });
    expect(readImageInfo(JPEG_EXIF6)).toEqual({ format: 'jpeg', width: 1200, height: 900, orientation: 6, displayWidth: 900, displayHeight: 1200 });
  });

  it('reads PNG size and an eXIf orientation', () => {
    expect(readImageInfo(png(40, 20))).toMatchObject({ format: 'png', width: 40, height: 20, orientation: 1 });
    expect(readImageInfo(png(40, 20, 8))).toMatchObject({ orientation: 8, displayWidth: 20, displayHeight: 40 });
  });

  it('refuses other formats and damaged files', () => {
    const code = (b: Uint8Array): string | undefined => {
      try {
        readImageInfo(b);
        return undefined;
      } catch (e) {
        return e instanceof DocxError ? e.code : 'OTHER';
      }
    };
    expect(code(new TextEncoder().encode('GIF89a......'))).toBe('IMAGE_UNSUPPORTED');
    expect(code(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('IMAGE_UNSUPPORTED');
    expect(code(new TextEncoder().encode('hello world, not an image'))).toBe('IMAGE_UNSUPPORTED');
    expect(code(JPEG_LANDSCAPE.slice(0, 30))).toBe('IMAGE_CORRUPT');
  });
});

describe('orientation', () => {
  it('neutralises the stored orientation without touching the input', () => {
    const before = JPEG_EXIF6.slice();
    const out = neutraliseOrientation(JPEG_EXIF6);
    expect(out.length).toBe(JPEG_EXIF6.length);
    expect(readImageInfo(out).orientation).toBe(1);
    expect(JPEG_EXIF6).toEqual(before);
    expect(neutraliseOrientation(JPEG_LANDSCAPE)).toBe(JPEG_LANDSCAPE);
    const p8 = png(10, 6, 8);
    const n8 = neutraliseOrientation(p8);
    expect(readImageInfo(n8)).toMatchObject({ orientation: 1, width: 10, height: 6 });
    expect(n8.length).toBeLessThan(p8.length);
  });

  it('maps EXIF orientations to DrawingML rotation / flips', () => {
    expect(orientationTransform(1)).toEqual({ rot: 0, flipH: false, flipV: false });
    expect(orientationTransform(3)).toEqual({ rot: 10_800_000, flipH: false, flipV: false });
    expect(orientationTransform(6)).toEqual({ rot: 5_400_000, flipH: false, flipV: false });
    expect(orientationTransform(8)).toEqual({ rot: 16_200_000, flipH: false, flipV: false });
    expect(orientationTransform(2).flipH).toBe(true);
    expect(orientationTransform(4).flipV).toBe(true);
    expect(orientationTransform(5)).toEqual({ rot: 16_200_000, flipH: true, flipV: false });
    expect(orientationTransform(7)).toEqual({ rot: 5_400_000, flipH: true, flipV: false });
  });
});

describe('fitImage / cellContentBox', () => {
  it('fits the width, keeps the aspect ratio and respects a height cap', () => {
    expect(fitImage({ displayWidth: 1600, displayHeight: 1200 }, { widthEmu: 1_600_000 })).toEqual({ cx: 1_600_000, cy: 1_200_000 });
    const capped = fitImage({ displayWidth: 900, displayHeight: 1200 }, { widthEmu: 2_000_000, heightEmu: 1_200_000 });
    expect(capped.cy).toBe(1_200_000);
    expect(capped.cx).toBe(900_000);
  });

  it('measures a cell from tcW minus its margins and the row height', () => {
    const pkg = openDocx(PHOTO_GRID);
    const ph = findImagePlaceholders(pkg);
    expect(ph.map((x) => [x.number, x.label])).toEqual([
      [1, 'IMAGE 01'],
      [2, 'IMAGE 02']
    ]);
    const box = cellContentBox(ph[0]!.cell, { useRowHeight: true });
    expect(box.widthEmu).toBe((4500 - 108 - 108 - 20) * EMU_PER_TWIP);
    expect(box.heightEmu).toBe((3000 - 20) * EMU_PER_TWIP);
  });
});

describe('insertDocxImages', () => {
  it('replaces placeholder boxes, appends to a cell and after a paragraph; adds media, rels and content types', () => {
    const { docx: out, report } = insertDocxImages(
      PHOTO_GRID,
      [
        { target: { placeholder: 1 }, image: { bytes: JPEG_LANDSCAPE, description: 'Front offside' } },
        { target: { placeholder: 2 }, image: { bytes: JPEG_EXIF6, description: 'Rear nearside' } },
        { target: { cellText: 'Damage sketch' }, image: { bytes: png(64, 32), description: 'Sketch' } },
        { target: { afterParagraphText: 'Photographs follow' }, image: { bytes: JPEG_LANDSCAPE } },
        { target: { placeholder: 9 }, image: { bytes: JPEG_LANDSCAPE } }
      ],
      { now }
    );
    expect(report.placed.map((x) => x.index)).toEqual([0, 1, 2, 3]);
    expect(report.skipped).toEqual([{ index: 4, reason: 'TARGET_NOT_FOUND' }]);
    const files = unzipSync(out);
    const media = Object.keys(files).filter((n) => n.startsWith('word/media/'));
    expect(media).toHaveLength(3); // the same JPEG used twice is stored once
    const ct = xmlOf(out, '[Content_Types].xml');
    expect(ct).toContain('Extension="jpeg" ContentType="image/jpeg"');
    expect(ct).toContain('Extension="png" ContentType="image/png"');
    const rels = xmlOf(out, 'word/_rels/document.xml.rels');
    for (const m of media) expect(rels).toContain(`Target="${m.slice('word/'.length)}"`);
    // the stored EXIF-6 photo is neutralised; the drawing rotates it a quarter turn
    const exifMedia = media.find((m) => files[m]!.length === JPEG_EXIF6.length)!;
    expect(readImageInfo(files[exifMedia]!).orientation).toBe(1);
    const xml = xmlOf(out);
    expect(xml).not.toContain('Insert photograph');
    expect(xml).not.toContain('IMAGE 01');
    expect(xml).toContain('rot="5400000"');
    expect(xml).toContain('descr="Front offside"');
    const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(4);
    // displayed boxes: inside the cell, aspect ratio kept (the rotated photo is portrait)
    const pics = listDocxPictures(openDocx(out));
    expect(pics).toHaveLength(4);
    const [front, rear] = pics;
    expect(front!.cx / front!.cy).toBeCloseTo(4 / 3, 3);
    expect(rear!.cy / rear!.cx).toBeCloseTo(4 / 3, 2);
    expect(rear!.cy).toBeLessThanOrEqual((3000 - 20) * EMU_PER_TWIP);
    expect(front!.cx).toBeLessThanOrEqual((4500 - 236) * EMU_PER_TWIP);
  });

  it('is deterministic', () => {
    const run = () => insertDocxImages(PHOTO_GRID, [{ target: { placeholder: 1 }, image: { bytes: JPEG_EXIF6 } }], { now }).sha256;
    expect(run()).toBe(run());
  });

  it('enforces the size limits', () => {
    const pkg = openDocx(PHOTO_GRID);
    const cell = findImagePlaceholders(pkg)[0]!.cell;
    expect(() => new DocxImageSession(pkg, { limits: { maxImageBytes: 1000 } }).replacePlaceholderCell(cell, { bytes: JPEG_LANDSCAPE })).toThrow(/larger than/);
    expect(() => new DocxImageSession(pkg, { limits: { maxDimension: 1000 } }).replacePlaceholderCell(cell, { bytes: JPEG_LANDSCAPE })).toThrow(/pixels/);
    const s = new DocxImageSession(pkg, { limits: { maxTotalBytes: JPEG_LANDSCAPE.length + 10 } });
    s.appendToCell(cell, { bytes: JPEG_LANDSCAPE });
    expect(() => s.appendToCell(cell, { bytes: JPEG_EXIF6 })).toThrow(/come to more than/);
    const one = new DocxImageSession(openDocx(PHOTO_GRID), { limits: { maxImages: 1 } });
    const c2 = findImagePlaceholders(openDocx(PHOTO_GRID))[0]!.cell;
    one.appendToCell(c2, { bytes: JPEG_LANDSCAPE });
    expect(() => one.appendToCell(c2, { bytes: JPEG_LANDSCAPE })).toThrow(/No more than 1/);
    // a refused photo leaves the package writable
    expect(writeDocx(pkg, { mtime: now }).length).toBeGreaterThan(0);
  });
});
