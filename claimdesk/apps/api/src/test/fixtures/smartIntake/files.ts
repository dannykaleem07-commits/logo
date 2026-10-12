// owned by intake-server
/**
 * Synthetic documents for the smart-intake tests (docs/SMART-INTAKE.md §16.3), generated at test time — no binary
 * fixtures, invented people ("Jane Doe", "Ali Example"), invented references and example.test addresses only.
 *
 *  - text PDFs (pdf-lib), a blank "scanned" pack, an "edited" estimate (iLovePDF producer, ModDate 30 days after
 *    CreationDate, an incremental update section);
 *  - photos with EXIF (DateTimeOriginal + GPS) as PNG (pngjs + an `eXIf` chunk) or JPEG (jpeg-js + APP1), drawn as
 *    simple shapes so the perceptual hash differs between scenes; a resized copy for the near-duplicate check;
 *  - a ZIP (fflate) and an EML (multipart, base64 attachments).
 */
import { crc32 } from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { makeEml } from '../intake/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromApi = createRequire(path.resolve(here, '../../../../package.json'));

interface PdfLibDoc {
  addPage(size: [number, number]): { drawText(t: string, o: Record<string, unknown>): void };
  embedFont(f: string): Promise<unknown>;
  save(opts?: { useObjectStreams?: boolean }): Promise<Uint8Array>;
  setProducer(s: string): void;
  setCreator(s: string): void;
  setCreationDate(d: Date): void;
  setModificationDate(d: Date): void;
  getPage(i: number): { drawText(t: string, o: Record<string, unknown>): void };
}
interface PdfLib {
  PDFDocument: { create(): Promise<PdfLibDoc>; load(b: Uint8Array, o?: Record<string, unknown>): Promise<PdfLibDoc> };
  StandardFonts: { Helvetica: string };
}
const pdfLib = (): PdfLib => requireFromApi('pdf-lib') as PdfLib;

/** A text PDF: one array of lines per page (optional metadata). */
export async function textPdf(pages: string[][], meta: { producer?: string; creator?: string; created?: Date; modified?: Date } = {}): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = pdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 800 - i * 16, size: 10, font }));
  }
  if (meta.producer) doc.setProducer(meta.producer);
  if (meta.creator) doc.setCreator(meta.creator);
  if (meta.created) doc.setCreationDate(meta.created);
  if (meta.modified) doc.setModificationDate(meta.modified);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** A PDF with pages but no text layer (a scan without OCR). */
export async function blankPdf(pageCount: number): Promise<Buffer> {
  const { PDFDocument } = pdfLib();
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

/**
 * An "edited" PDF: produced by an online editor, modified 30 days after creation, with an incremental update section
 * appended (a second `%%EOF`).
 */
export async function editedPdf(pages: string[][], created: Date): Promise<Buffer> {
  const modified = new Date(created.getTime() + 30 * 86_400_000);
  const first = await textPdf(pages, { producer: 'iLovePDF', creator: 'iLovePDF', created, modified });
  // incremental update: an extra object and a new trailer pointing at the previous xref
  const text = first.toString('latin1');
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)?.[1] ?? '0');
  const size = Number(/\/Size\s+(\d+)/.exec(text)?.[1] ?? '10');
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(text)?.[1] ?? '1 0 R';
  const info = /\/Info\s+(\d+\s+\d+\s+R)/.exec(text)?.[1];
  const objOffset = first.length + 1;
  const obj = `\n${size} 0 obj\n<< /Note (edited) >>\nendobj\n`;
  const xrefOffset = first.length + Buffer.byteLength(obj, 'latin1');
  const xref = `xref\n${size} 1\n${String(objOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size + 1} /Root ${root}${info ? ` /Info ${info}` : ''} /Prev ${startxref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([first, Buffer.from(obj + xref, 'latin1')]);
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export interface PhotoExif {
  /** "YYYY:MM:DD HH:MM:SS" (camera wall time). */
  taken?: string;
  gps?: { lat: number; lon: number };
  software?: string;
}

type Entry = { tag: number; type: 2 | 4 | 5; count: number; data: Buffer };

function asciiEntry(tag: number, s: string): Entry {
  const data = Buffer.from(`${s}\0`, 'latin1');
  return { tag, type: 2, count: data.length, data };
}
function longEntry(tag: number, v: number): Entry {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(v);
  return { tag, type: 4, count: 1, data };
}
function rationalEntry(tag: number, values: Array<[number, number]>): Entry {
  const data = Buffer.alloc(values.length * 8);
  values.forEach(([n, d], i) => {
    data.writeUInt32BE(n, i * 8);
    data.writeUInt32BE(d, i * 8 + 4);
  });
  return { tag, type: 5, count: values.length, data };
}
function dms(v: number): Array<[number, number]> {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = Math.round(((a - d) * 60 - m) * 60 * 100);
  return [[d, 1], [m, 1], [s, 100]];
}

/** A big-endian TIFF block with IFD0 (+ Exif and GPS sub-IFDs). */
export function exifTiff(exif: PhotoExif): Buffer {
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const exifEntries: Entry[] = exif.taken ? [asciiEntry(0x9003, exif.taken)] : [];
  const gpsEntries: Entry[] = exif.gps
    ? [asciiEntry(0x0001, exif.gps.lat >= 0 ? 'N' : 'S'), rationalEntry(0x0002, dms(exif.gps.lat)), asciiEntry(0x0003, exif.gps.lon >= 0 ? 'E' : 'W'), rationalEntry(0x0004, dms(exif.gps.lon))]
    : [];
  const ifd0: Entry[] = [];
  if (exif.software) ifd0.push(asciiEntry(0x0131, exif.software));
  if (exifEntries.length) ifd0.push(longEntry(0x8769, 0));
  if (gpsEntries.length) ifd0.push(longEntry(0x8825, 0));
  ifd0.sort((a, b) => a.tag - b.tag);
  // layout: header(8) | IFD0 | IFD0 data | ExifIFD | data | GPSIFD | data
  const blocks: Array<{ entries: Entry[]; offset: number; dataOffset: number }> = [];
  let off = 8;
  const dataLen = (es: Entry[]) => es.reduce((n, e) => n + (e.data.length > 4 ? e.data.length + (e.data.length % 2) : 0), 0);
  for (const es of [ifd0, exifEntries, gpsEntries]) {
    blocks.push({ entries: es, offset: es.length ? off : 0, dataOffset: off + ifdSize(es.length) });
    if (es.length) off += ifdSize(es.length) + dataLen(es);
  }
  // pointers
  for (const e of ifd0) {
    if (e.tag === 0x8769) e.data.writeUInt32BE(blocks[1]!.offset);
    if (e.tag === 0x8825) e.data.writeUInt32BE(blocks[2]!.offset);
  }
  const buf = Buffer.alloc(off);
  buf.write('MM', 0, 'latin1');
  buf.writeUInt16BE(42, 2);
  buf.writeUInt32BE(8, 4);
  for (const b of blocks) {
    if (!b.entries.length) continue;
    buf.writeUInt16BE(b.entries.length, b.offset);
    let data = b.dataOffset;
    b.entries.forEach((e, i) => {
      const at = b.offset + 2 + i * 12;
      buf.writeUInt16BE(e.tag, at);
      buf.writeUInt16BE(e.type, at + 2);
      buf.writeUInt32BE(e.count, at + 4);
      if (e.data.length <= 4) e.data.copy(buf, at + 8);
      else {
        buf.writeUInt32BE(data, at + 8);
        e.data.copy(buf, data);
        data += e.data.length + (e.data.length % 2);
      }
    });
    buf.writeUInt32BE(0, b.offset + 2 + b.entries.length * 12);
  }
  return buf;
}

/** RGBA pixels of a synthetic scene: a seeded grid of blocks (so each seed hashes differently) with a "car" and a "plate". */
export function scenePixels(width: number, height: number, seed: number): Buffer {
  let a = (seed * 2654435761) >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const cols = 12;
  const rows = 9;
  const grid = Array.from({ length: cols * rows }, () => Math.round(rnd() * 255));
  const tint = [rnd(), rnd(), rnd()];
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const g = grid[Math.min(rows - 1, Math.floor((y / height) * rows)) * cols + Math.min(cols - 1, Math.floor((x / width) * cols))]!;
      let r = Math.round(g * (0.6 + 0.4 * tint[0]!));
      let gg = Math.round(g * (0.6 + 0.4 * tint[1]!));
      let b = Math.round(g * (0.6 + 0.4 * tint[2]!));
      if (x > width * 0.3 && x < width * 0.7 && y > height * 0.55 && y < height * 0.85) [r, gg, b] = [200, 30, 30];
      if (x > width * 0.42 && x < width * 0.58 && y > height * 0.74 && y < height * 0.8) [r, gg, b] = [240, 220, 30];
      data[i] = r;
      data[i + 1] = gg;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A PNG of the scene with an `eXIf` chunk before IEND. */
export function pngPhoto(width: number, height: number, seed: number, exif: PhotoExif): Buffer {
  const png = new PNG({ width, height });
  scenePixels(width, height, seed).copy(png.data);
  const encoded = PNG.sync.write(png);
  if (!exif.taken && !exif.gps && !exif.software) return encoded;
  const iend = encoded.length - 12;
  return Buffer.concat([encoded.subarray(0, iend), pngChunk('eXIf', exifTiff(exif)), encoded.subarray(iend)]);
}

/** A JPEG of the scene with an APP1 Exif segment. */
export function jpegPhoto(width: number, height: number, seed: number, exif: PhotoExif, quality = 85): Buffer {
  const raw = jpeg.encode({ data: scenePixels(width, height, seed), width, height }, quality).data as Buffer;
  if (!exif.taken && !exif.gps && !exif.software) return Buffer.from(raw);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff(exif)]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([raw.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, raw.subarray(2)]);
}

export function zipOf(entries: Record<string, Buffer>): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, new Uint8Array(v)])), { level: 6 }));
}

export { makeEml };
