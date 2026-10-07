/**
 * Photographs (JPEG / PNG) in a filled DOCX.
 *
 *   const session = new DocxImageSession(pkg);                       // pkg = openDocx(filledBytes)
 *   session.replacePlaceholderCell(cell, { bytes, description });     // an "IMAGE 01 / Insert photograph" box
 *   session.appendToCell(cell, { bytes, description });               // or an inline picture at the end of a cell
 *   const docx = writeDocx(pkg, { mtime: now });
 *
 *   insertDocxImages(bytes, [{ target: { placeholder: 1 }, image }], { now })   // bytes in, bytes out
 *
 * What it does, deterministically (same inputs → same bytes):
 * - sniffs the format from the bytes (never trusts a file name): baseline / progressive JPEG and PNG only;
 * - enforces size limits (bytes per image, bytes per document, pixels, edge length, image count) so the filled
 *   package still opens under the engine's own upload limits (DEFAULT_DOCX_LIMITS.maxCompressedBytes);
 * - respects the EXIF orientation: the tag is neutralised in the stored copy (so no renderer applies it twice) and the
 *   picture is rotated / mirrored with DrawingML (`a:xfrm rot/flipH/flipV`), the layout box taking the displayed shape;
 * - adds `word/media/*` parts (named by content hash, so one photo used twice is stored once), the part relationship
 *   and the `[Content_Types].xml` default for the extension;
 * - sizes the picture to the cell's text width (tcW minus cell margins) and, for a placeholder box, the row height,
 *   keeping the aspect ratio.
 *
 * Pixels are never re-encoded (no image codec dependency): a photo that is too large must be downscaled by the
 * caller before it reaches the document.
 */
import type { Document, Element } from '@xmldom/xmldom';
import { sha256Hex } from '../hash.js';
import { normaliseText, paragraphText } from './text.js';
import { DocxError, type DocxPackage } from './types.js';
import { openDocx, writeDocx } from './zip.js';
import { childElements, closestW, createW, isW, markDirty, NS, parseXml, partDom, removeNode, setPartDom, setWAttr, wAttr, wChild, wChildren, wDescendants } from './xml.js';

// ---------------------------------------------------------------------------
// Limits and types
// ---------------------------------------------------------------------------

export interface DocxImageLimits {
  /** Largest single photo (bytes). */
  maxImageBytes: number;
  /** All photos added to one document (bytes, after de-duplication). */
  maxTotalBytes: number;
  /** Width × height. */
  maxPixels: number;
  /** Longest edge (pixels). */
  maxDimension: number;
  /** Photos added to one document. */
  maxImages: number;
}

/**
 * Defaults keep a filled CarFlex report (template ≈ 1.8 MB) under the engine's 15 MiB package limit: 6 MiB a photo,
 * 12 MiB in all.
 */
export const DEFAULT_IMAGE_LIMITS: DocxImageLimits = Object.freeze({
  maxImageBytes: 6 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  maxPixels: 50_000_000,
  maxDimension: 12_000,
  maxImages: 40
});

export type DocxImageFormat = 'jpeg' | 'png';

/** EXIF orientation 1–8 (1 = as stored). */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface DocxImageInfo {
  format: DocxImageFormat;
  /** Stored pixel size. */
  width: number;
  height: number;
  orientation: ExifOrientation;
  /** Size as displayed once the orientation is applied (width/height swap for 5–8). */
  displayWidth: number;
  displayHeight: number;
}

export interface DocxImage {
  bytes: Uint8Array;
  /** Alt text (wp:docPr descr). */
  description?: string;
  /** Shape name (wp:docPr name); default `Photo <n>`. */
  name?: string;
}

/** Box in EMU (914 400 per inch, 635 per twip). */
export interface ImageBox {
  widthEmu: number;
  heightEmu?: number;
}

export interface PlacedImage {
  mediaPart: string;
  rId: string;
  docPrId: number;
  info: DocxImageInfo;
  /** Displayed size (EMU). */
  cx: number;
  cy: number;
}

export const EMU_PER_TWIP = 635;
export const EMU_PER_INCH = 914_400;

const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const CONTENT_TYPE: Record<DocxImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png' };

// ---------------------------------------------------------------------------
// Sniffing (format, size, EXIF orientation)
// ---------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u16be(b: Uint8Array, o: number): number {
  return ((b[o]! << 8) | b[o + 1]!) >>> 0;
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

/** Orientation entry of a TIFF/EXIF block: value and the absolute offset of its SHORT (for neutralising). */
function tiffOrientation(b: Uint8Array, tiffStart: number, end: number): { value: number; offset: number; little: boolean } | undefined {
  if (tiffStart + 8 > end) return undefined;
  const little = b[tiffStart] === 0x49 && b[tiffStart + 1] === 0x49;
  const big = b[tiffStart] === 0x4d && b[tiffStart + 1] === 0x4d;
  if (!little && !big) return undefined;
  const r16 = (o: number): number => (little ? b[o]! | (b[o + 1]! << 8) : u16be(b, o));
  const r32 = (o: number): number => (little ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0 : u32be(b, o));
  if (r16(tiffStart + 2) !== 42) return undefined;
  const ifd = tiffStart + r32(tiffStart + 4);
  if (ifd + 2 > end) return undefined;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return undefined;
    if (r16(e) === 0x0112 && r16(e + 2) === 3) return { value: r16(e + 8), offset: e + 8, little };
  }
  return undefined;
}

interface Sniff {
  info: DocxImageInfo;
  /** Where the orientation lives, so the stored copy can be neutralised. */
  exif?: { kind: 'jpeg'; offset: number; little: boolean } | { kind: 'png-chunk'; start: number; end: number };
}

function orientationOf(v: number | undefined): ExifOrientation {
  return v !== undefined && v >= 1 && v <= 8 ? (v as ExifOrientation) : 1;
}

function withDisplay(format: DocxImageFormat, width: number, height: number, orientation: ExifOrientation): DocxImageInfo {
  const swap = orientation >= 5;
  return { format, width, height, orientation, displayWidth: swap ? height : width, displayHeight: swap ? width : height };
}

function sniffPng(b: Uint8Array): Sniff {
  if (b.length < 33 || u32be(b, 12) !== 0x49484452) throw new DocxError('IMAGE_CORRUPT', 'The PNG has no IHDR header');
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  let orientation: ExifOrientation = 1;
  let exif: Sniff['exif'];
  // walk chunks up to the first IDAT (an eXIf chunk must come before it)
  let o = 8;
  while (o + 12 <= b.length) {
    const len = u32be(b, o);
    const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    const next = o + 12 + len;
    if (next > b.length) break;
    if (type === 'eXIf') {
      const t = tiffOrientation(b, o + 8, o + 8 + len);
      orientation = orientationOf(t?.value);
      exif = { kind: 'png-chunk', start: o, end: next };
    }
    if (type === 'IDAT' || type === 'IEND') break;
    o = next;
  }
  return { info: withDisplay('png', width, height, orientation), ...(exif ? { exif } : {}) };
}

// SOF markers a renderer can draw: baseline, extended sequential, progressive (Huffman).
const SOF_OK = new Set([0xc0, 0xc1, 0xc2]);
const SOF_OTHER = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function sniffJpeg(b: Uint8Array): Sniff {
  let o = 2;
  let orientation: ExifOrientation = 1;
  let exif: Sniff['exif'];
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) throw new DocxError('IMAGE_CORRUPT', 'The JPEG marker stream is damaged');
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS before a frame header
    const len = u16be(b, o + 2);
    const seg = o + 4;
    const segEnd = o + 2 + len;
    if (len < 2 || segEnd > b.length) throw new DocxError('IMAGE_CORRUPT', 'The JPEG segment lengths are damaged');
    if (marker === 0xe1 && !exif && segEnd - seg >= 14 && String.fromCharCode(b[seg]!, b[seg + 1]!, b[seg + 2]!, b[seg + 3]!) === 'Exif' && b[seg + 4] === 0 && b[seg + 5] === 0) {
      const t = tiffOrientation(b, seg + 6, segEnd);
      if (t) {
        orientation = orientationOf(t.value);
        exif = { kind: 'jpeg', offset: t.offset, little: t.little };
      }
    }
    if (SOF_OK.has(marker)) {
      if (segEnd - seg < 5) throw new DocxError('IMAGE_CORRUPT', 'The JPEG frame header is damaged');
      const height = u16be(b, seg + 1);
      const width = u16be(b, seg + 3);
      return { info: withDisplay('jpeg', width, height, orientation), ...(exif ? { exif } : {}) };
    }
    if (SOF_OTHER.has(marker)) throw new DocxError('IMAGE_UNSUPPORTED', 'This JPEG coding (lossless / arithmetic) cannot be shown by Word and PDF converters; save it as a standard JPEG');
    o = segEnd;
  }
  throw new DocxError('IMAGE_CORRUPT', 'The JPEG has no frame header');
}

function sniff(bytes: Uint8Array): Sniff {
  if (bytes.length >= 8 && PNG_SIG.every((v, i) => bytes[i] === v)) return sniffPng(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return sniffJpeg(bytes);
  const head = String.fromCharCode(...bytes.slice(0, 12));
  if (/^GIF8/.test(head) || /^RIFF....WEBP/.test(head) || /ftyp(heic|heix|mif1|avif)/.test(head)) {
    throw new DocxError('IMAGE_UNSUPPORTED', 'Only JPEG and PNG photographs can go into the report; convert this image first');
  }
  throw new DocxError('IMAGE_UNSUPPORTED', 'Not a JPEG or PNG image');
}

/** Format, stored size and EXIF orientation of a JPEG / PNG (throws DocxError IMAGE_UNSUPPORTED / IMAGE_CORRUPT). */
export function readImageInfo(bytes: Uint8Array): DocxImageInfo {
  return sniff(bytes).info;
}

function checkLimits(bytes: Uint8Array, info: DocxImageInfo, lim: DocxImageLimits): void {
  if (bytes.length > lim.maxImageBytes) {
    throw new DocxError('IMAGE_TOO_LARGE', `A photograph is larger than ${(lim.maxImageBytes / 1048576).toFixed(0)} MB; reduce it before adding it to the report`);
  }
  if (info.width < 1 || info.height < 1) throw new DocxError('IMAGE_CORRUPT', 'The image has no pixels');
  if (info.width > lim.maxDimension || info.height > lim.maxDimension || info.width * info.height > lim.maxPixels) {
    throw new DocxError('IMAGE_TOO_LARGE', `The photograph is ${info.width} × ${info.height} pixels; the limit is ${lim.maxDimension} pixels a side and ${Math.round(lim.maxPixels / 1e6)} megapixels`);
  }
}

/**
 * The bytes stored in the document: the EXIF orientation neutralised (JPEG: the tag set to 1 in place; PNG: the eXIf
 * chunk dropped) so every renderer shows the stored pixels and the DrawingML transform alone rotates them. The input
 * array is never modified.
 */
export function neutraliseOrientation(bytes: Uint8Array): Uint8Array {
  const s = sniff(bytes);
  if (!s.exif || s.info.orientation === 1) return bytes;
  if (s.exif.kind === 'jpeg') {
    const out = bytes.slice();
    const o = s.exif.offset;
    if (s.exif.little) {
      out[o] = 1;
      out[o + 1] = 0;
    } else {
      out[o] = 0;
      out[o + 1] = 1;
    }
    return out;
  }
  const out = new Uint8Array(bytes.length - (s.exif.end - s.exif.start));
  out.set(bytes.subarray(0, s.exif.start), 0);
  out.set(bytes.subarray(s.exif.end), s.exif.start);
  return out;
}

/** DrawingML transform that shows the stored pixels in their EXIF orientation (flips are applied before rotation). */
export function orientationTransform(o: ExifOrientation): { rot: number; flipH: boolean; flipV: boolean } {
  switch (o) {
    case 2:
      return { rot: 0, flipH: true, flipV: false };
    case 3:
      return { rot: 10_800_000, flipH: false, flipV: false };
    case 4:
      return { rot: 0, flipH: false, flipV: true };
    case 5:
      return { rot: 16_200_000, flipH: true, flipV: false };
    case 6:
      return { rot: 5_400_000, flipH: false, flipV: false };
    case 7:
      return { rot: 5_400_000, flipH: true, flipV: false };
    case 8:
      return { rot: 16_200_000, flipH: false, flipV: false };
    default:
      return { rot: 0, flipH: false, flipV: false };
  }
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/** Displayed size (EMU) that fits `box`, keeping the aspect ratio. Integer EMU; never 0. */
export function fitImage(info: Pick<DocxImageInfo, 'displayWidth' | 'displayHeight'>, box: ImageBox): { cx: number; cy: number } {
  const w = Math.max(1, info.displayWidth);
  const h = Math.max(1, info.displayHeight);
  let scale = box.widthEmu / w;
  if (box.heightEmu !== undefined && box.heightEmu > 0) scale = Math.min(scale, box.heightEmu / h);
  return { cx: Math.max(1, Math.floor(w * scale)), cy: Math.max(1, Math.floor(h * scale)) };
}

function twips(el: Element | undefined, attr = 'w'): number | undefined {
  const v = wAttr(el, attr);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Cell margin (twips) on one side: the cell's tcMar, else the table's tblCellMar, else Word's default. */
function cellMargin(tc: Element, side: 'left' | 'right' | 'top' | 'bottom'): number {
  const alt = side === 'left' ? 'start' : side === 'right' ? 'end' : side;
  const own = wChild(wChild(tc, 'tcPr'), 'tcMar');
  const ownV = twips(wChild(own, side) ?? wChild(own, alt));
  if (ownV !== undefined) return ownV;
  const tbl = closestW(tc, 'tbl');
  const tblMar = wChild(wChild(tbl, 'tblPr'), 'tblCellMar');
  const tblV = twips(wChild(tblMar, side) ?? wChild(tblMar, alt));
  if (tblV !== undefined) return tblV;
  return side === 'left' || side === 'right' ? 108 : 0;
}

/**
 * The text box of a table cell in EMU: width = tcW − left/right margins; height (when `useRowHeight`) = the row's
 * trHeight − top/bottom margins, so a picture never pushes a fixed photo grid onto another page.
 */
export function cellContentBox(tc: Element, opts: { useRowHeight?: boolean; insetTwips?: number } = {}): ImageBox {
  const inset = opts.insetTwips ?? 20;
  let width = twips(wChild(wChild(tc, 'tcPr'), 'tcW'));
  if (width === undefined || width <= 0) {
    // gridSpan / grid fallback: the table width split evenly
    const tbl = closestW(tc, 'tbl');
    const cols = wChildren(wChild(tbl, 'tblGrid') ?? (tbl as Element), 'gridCol').map((g) => twips(g) ?? 0);
    width = cols.length ? Math.max(...cols) : 4000;
  }
  const inner = Math.max(200, width - cellMargin(tc, 'left') - cellMargin(tc, 'right') - inset);
  const box: ImageBox = { widthEmu: inner * EMU_PER_TWIP };
  if (opts.useRowHeight) {
    const tr = closestW(tc, 'tr');
    const trH = twips(wChild(wChild(tr, 'trPr'), 'trHeight'), 'val');
    if (trH !== undefined && trH > 0) {
      box.heightEmu = Math.max(200, trH - cellMargin(tc, 'top') - cellMargin(tc, 'bottom') - inset) * EMU_PER_TWIP;
    }
  }
  return box;
}

// ---------------------------------------------------------------------------
// Package plumbing (media part, relationship, content type, docPr ids)
// ---------------------------------------------------------------------------

function relsPartOf(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

function relsDom(pkg: DocxPackage, part: string): Document {
  const relsPart = relsPartOf(part);
  if (!pkg.entries.has(relsPart)) {
    setPartDom(pkg, relsPart, parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rels}"/>`, relsPart));
  }
  return partDom(pkg, relsPart);
}

function ensureContentTypeDefault(pkg: DocxPackage, ext: string, type: string): void {
  const ct = partDom(pkg, '[Content_Types].xml');
  const root = ct.documentElement!;
  const defaults = root.getElementsByTagNameNS(NS.ct, 'Default');
  for (let i = 0; i < defaults.length; i++) {
    if ((defaults[i]!.getAttribute('Extension') ?? '').toLowerCase() === ext) return;
  }
  const d = ct.createElementNS(NS.ct, 'Default');
  d.setAttribute('Extension', ext);
  d.setAttribute('ContentType', type);
  root.insertBefore(d, root.firstChild);
  markDirty(pkg, '[Content_Types].xml');
}

function maxDocPrId(pkg: DocxPackage): number {
  let max = 0;
  for (const name of pkg.order) {
    if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)) continue;
    const doc = partDom(pkg, name);
    for (const ns of [NS_WP]) {
      const list = doc.getElementsByTagNameNS(ns, 'docPr');
      for (let i = 0; i < list.length; i++) {
        const n = Number(list[i]!.getAttribute('id'));
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
  }
  return max;
}

function el(doc: Document, ns: string, qname: string, attrs: Record<string, string> = {}, kids: Element[] = []): Element {
  const e = doc.createElementNS(ns, qname);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.appendChild(k);
  return e;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface Embedded {
  mediaPart: string;
  info: DocxImageInfo;
  /** part → rId */
  rIds: Map<string, string>;
}

/**
 * Adds photographs to one open package. Keeps the docPr id counter, the media de-duplication map and the byte
 * budget across calls; call `writeDocx(pkg, …)` afterwards.
 */
export class DocxImageSession {
  readonly placed: PlacedImage[] = [];
  private readonly limits: DocxImageLimits;
  private nextDocPr: number;
  private totalBytes = 0;
  private readonly media = new Map<string, Embedded>();

  constructor(
    private readonly pkg: DocxPackage,
    opts: { limits?: Partial<DocxImageLimits> } = {}
  ) {
    this.limits = { ...DEFAULT_IMAGE_LIMITS, ...(opts.limits ?? {}) };
    this.nextDocPr = maxDocPrId(pkg) + 1;
  }

  /** Validate and store the photo (once per content hash) and relate it to `part`. */
  embed(part: string, image: DocxImage): { rId: string; mediaPart: string; info: DocxImageInfo } {
    if (this.placed.length >= this.limits.maxImages) throw new DocxError('TOO_MANY_IMAGES', `No more than ${this.limits.maxImages} photographs can go into one document`);
    const s = sniff(image.bytes);
    checkLimits(image.bytes, s.info, this.limits);
    const hash = sha256Hex(image.bytes);
    let e = this.media.get(hash);
    if (!e) {
      const stored = neutraliseOrientation(image.bytes);
      if (this.totalBytes + stored.length > this.limits.maxTotalBytes) {
        throw new DocxError('IMAGES_TOO_LARGE', `The photographs come to more than ${(this.limits.maxTotalBytes / 1048576).toFixed(0)} MB; reduce them before adding them to the report`);
      }
      this.totalBytes += stored.length;
      const ext = s.info.format;
      let mediaPart = `word/media/cd-photo-${hash.slice(0, 16)}.${ext}`;
      for (let n = 2; this.pkg.entries.has(mediaPart); n++) mediaPart = `word/media/cd-photo-${hash.slice(0, 16)}-${n}.${ext}`;
      this.pkg.entries.set(mediaPart, stored);
      this.pkg.order.push(mediaPart);
      ensureContentTypeDefault(this.pkg, ext, CONTENT_TYPE[ext]);
      e = { mediaPart, info: s.info, rIds: new Map() };
      this.media.set(hash, e);
    }
    let rId = e.rIds.get(part);
    if (!rId) {
      const rels = relsDom(this.pkg, part);
      const root = rels.documentElement!;
      const existing = new Set<string>();
      const list = root.getElementsByTagNameNS(NS.rels, 'Relationship');
      for (let i = 0; i < list.length; i++) existing.add(list[i]!.getAttribute('Id') ?? '');
      let n = 1;
      while (existing.has(`rIdCdPhoto${n}`)) n++;
      rId = `rIdCdPhoto${n}`;
      const partDir = part.slice(0, part.lastIndexOf('/') + 1);
      const r = rels.createElementNS(NS.rels, 'Relationship');
      r.setAttribute('Id', rId);
      r.setAttribute('Type', REL_IMAGE);
      r.setAttribute('Target', e.mediaPart.startsWith(partDir) ? e.mediaPart.slice(partDir.length) : `/${e.mediaPart}`);
      root.appendChild(r);
      markDirty(this.pkg, relsPartOf(part));
      e.rIds.set(part, rId);
    }
    return { rId, mediaPart: e.mediaPart, info: e.info };
  }

  /** A `w:r` holding an inline picture of `image` that fits `box`. */
  inlineRun(part: string, image: DocxImage, box: ImageBox): { run: Element; placed: PlacedImage } {
    const doc = partDom(this.pkg, part);
    const { rId, mediaPart, info } = this.embed(part, image);
    const { cx, cy } = fitImage(info, box);
    const id = this.nextDocPr++;
    const t = orientationTransform(info.orientation);
    const quarter = t.rot === 5_400_000 || t.rot === 16_200_000;
    // the shape keeps the stored aspect; for a quarter turn its unrotated extent is the displayed one swapped and the
    // effect extent widens / narrows the layout box to the rotated (displayed) bounds (as Word writes it)
    const sx = quarter ? cy : cx;
    const sy = quarter ? cx : cy;
    // split exactly so extent + effect extent is the displayed size to the EMU
    const dl = quarter ? Math.floor((cx - sx) / 2) : 0;
    const dr = quarter ? cx - sx - dl : 0;
    const dt = quarter ? Math.floor((cy - sy) / 2) : 0;
    const db = quarter ? cy - sy - dt : 0;
    const name = (image.name ?? `Photo ${id}`).slice(0, 200);
    const descr = (image.description ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 1000);
    const xfrmAttrs: Record<string, string> = {};
    if (t.rot) xfrmAttrs.rot = String(t.rot);
    if (t.flipH) xfrmAttrs.flipH = '1';
    if (t.flipV) xfrmAttrs.flipV = '1';
    const inline = el(doc, NS_WP, 'wp:inline', { distT: '0', distB: '0', distL: '0', distR: '0' }, [
      el(doc, NS_WP, 'wp:extent', { cx: String(sx), cy: String(sy) }),
      el(doc, NS_WP, 'wp:effectExtent', { l: String(dl), t: String(dt), r: String(dr), b: String(db) }),
      el(doc, NS_WP, 'wp:docPr', { id: String(id), name, descr }),
      el(doc, NS_WP, 'wp:cNvGraphicFramePr', {}, [el(doc, NS_A, 'a:graphicFrameLocks', { noChangeAspect: '1' })]),
      el(doc, NS_A, 'a:graphic', {}, [
        el(doc, NS_A, 'a:graphicData', { uri: NS_PIC }, [
          el(doc, NS_PIC, 'pic:pic', {}, [
            el(doc, NS_PIC, 'pic:nvPicPr', {}, [el(doc, NS_PIC, 'pic:cNvPr', { id: String(id), name, descr }), el(doc, NS_PIC, 'pic:cNvPicPr')]),
            el(doc, NS_PIC, 'pic:blipFill', {}, [
              (() => {
                const blip = el(doc, NS_A, 'a:blip');
                blip.setAttributeNS(NS.r, 'r:embed', rId);
                return blip;
              })(),
              el(doc, NS_A, 'a:stretch', {}, [el(doc, NS_A, 'a:fillRect')])
            ]),
            el(doc, NS_PIC, 'pic:spPr', {}, [
              el(doc, NS_A, 'a:xfrm', xfrmAttrs, [el(doc, NS_A, 'a:off', { x: '0', y: '0' }), el(doc, NS_A, 'a:ext', { cx: String(sx), cy: String(sy) })]),
              el(doc, NS_A, 'a:prstGeom', { prst: 'rect' }, [el(doc, NS_A, 'a:avLst')])
            ])
          ])
        ])
      ])
    ]);
    const run = createW(doc, 'r');
    const rPr = createW(doc, 'rPr');
    rPr.appendChild(createW(doc, 'noProof'));
    run.appendChild(rPr);
    const drawing = createW(doc, 'drawing');
    drawing.appendChild(inline);
    run.appendChild(drawing);
    markDirty(this.pkg, part);
    const placed: PlacedImage = { mediaPart, rId, docPrId: id, info, cx, cy };
    this.placed.push(placed);
    return { run, placed };
  }

  /** A centred paragraph that holds only the picture (single line spacing, no space before/after). */
  pictureParagraph(part: string, image: DocxImage, box: ImageBox, opts: { spacingAfterTwips?: number } = {}): { para: Element; placed: PlacedImage } {
    const doc = partDom(this.pkg, part);
    const { run, placed } = this.inlineRun(part, image, box);
    const p = createW(doc, 'p');
    const pPr = createW(doc, 'pPr');
    const keep = createW(doc, 'keepNext');
    pPr.appendChild(keep);
    const spacing = createW(doc, 'spacing');
    setWAttr(spacing, 'before', '0');
    setWAttr(spacing, 'after', String(opts.spacingAfterTwips ?? 0));
    setWAttr(spacing, 'line', '240');
    setWAttr(spacing, 'lineRule', 'auto');
    pPr.appendChild(spacing);
    const jc = createW(doc, 'jc');
    setWAttr(jc, 'val', 'center');
    pPr.appendChild(jc);
    p.appendChild(pPr);
    p.appendChild(run);
    return { para: p, placed };
  }

  /**
   * Replace an image placeholder box ("IMAGE 01 / Insert photograph") with the photo: the cell's paragraphs give way
   * to one centred picture paragraph sized to the cell (width and row height). Cell borders and shading stay.
   */
  replacePlaceholderCell(tc: Element, image: DocxImage, opts: { part?: string; box?: ImageBox } = {}): PlacedImage {
    const part = opts.part ?? 'word/document.xml';
    const box = opts.box ?? cellContentBox(tc, { useRowHeight: true });
    const { para, placed } = this.pictureParagraph(part, image, box);
    const paras = wChildren(tc, 'p');
    const first = paras[0];
    if (first) tc.insertBefore(para, first);
    else tc.appendChild(para);
    for (const p of paras) removeNode(p);
    for (const t of wChildren(tc, 'tbl')) removeNode(t);
    markDirty(this.pkg, part);
    return placed;
  }

  /** Append the photo at the end of a cell in its own paragraph (width-fitted; `box` overrides). */
  appendToCell(tc: Element, image: DocxImage, opts: { part?: string; box?: ImageBox } = {}): PlacedImage {
    const part = opts.part ?? 'word/document.xml';
    const box = opts.box ?? cellContentBox(tc);
    const { para, placed } = this.pictureParagraph(part, image, box);
    // a cell's only paragraph that is empty is reused rather than leaving a blank line above the picture
    const paras = wChildren(tc, 'p');
    const last = paras[paras.length - 1];
    if (paras.length === 1 && last && normaliseText(paragraphText(last).text) === '' && !wDescendants(last, 'drawing').length && !wDescendants(last, 'sdt').length) {
      tc.replaceChild(para, last);
    } else {
      tc.appendChild(para);
    }
    markDirty(this.pkg, part);
    return placed;
  }

  /** Insert the photo in a new paragraph right after `p` (body width unless `box`). */
  appendAfterParagraph(p: Element, image: DocxImage, opts: { part?: string; box?: ImageBox } = {}): PlacedImage {
    const part = opts.part ?? 'word/document.xml';
    const tc = closestW(p, 'tc');
    const box = opts.box ?? (tc ? cellContentBox(tc) : { widthEmu: bodyTextWidthTwips(partDom(this.pkg, part)) * EMU_PER_TWIP });
    const { para, placed } = this.pictureParagraph(part, image, box, { spacingAfterTwips: 120 });
    p.parentNode!.insertBefore(para, p.nextSibling);
    markDirty(this.pkg, part);
    return placed;
  }
}

/** Text width of the last section (twips). */
export function bodyTextWidthTwips(doc: Document): number {
  const body = wDescendants(doc, 'body')[0];
  const sect = body ? wChildren(body, 'sectPr')[0] : undefined;
  const w = Number(wAttr(wChild(sect, 'pgSz'), 'w') ?? 11906);
  const mar = wChild(sect, 'pgMar');
  const width = w - Number(wAttr(mar, 'left') ?? 1134) - Number(wAttr(mar, 'right') ?? 1134);
  return Number.isFinite(width) && width > 2000 ? width : 9638;
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

export interface ImagePlaceholder {
  /** 1, 2, … from "IMAGE 01". */
  number: number;
  label: string;
  cell: Element;
}

const PLACEHOLDER_RE = /^(?:image|photo(?:graph)?)\s*0*(\d{1,3})\b/i;

/**
 * Image placeholder boxes in document order: table cells whose first text is "IMAGE 01" (or "Photo 1") and that hold
 * nothing else but a short prompt such as "Insert photograph" and no picture yet.
 */
export function findImagePlaceholders(pkg: DocxPackage, part = 'word/document.xml'): ImagePlaceholder[] {
  const doc = partDom(pkg, part);
  const out: ImagePlaceholder[] = [];
  for (const tc of wDescendants(doc, 'tc')) {
    if (wDescendants(tc, 'drawing').length || wDescendants(tc, 'tbl').length) continue;
    const texts = wChildren(tc, 'p')
      .map((p) => normaliseText(paragraphText(p).text))
      .filter((t) => t.length > 0);
    const first = texts[0];
    if (!first) continue;
    const m = PLACEHOLDER_RE.exec(first);
    if (!m) continue;
    const rest = texts.slice(1).join(' ');
    const label = first.slice(0, m[0].length);
    if (first.length > m[0].length + 2 && rest === '') {
      // "IMAGE 01 Insert photograph" in one paragraph
      if (!/insert|photo|picture|image/i.test(first.slice(m[0].length))) continue;
    } else if (rest && !/insert|photo|picture|image|place/i.test(rest)) continue;
    out.push({ number: Number(m[1]), label, cell: tc });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bytes in, bytes out
// ---------------------------------------------------------------------------

export type ImageTarget =
  /** The "IMAGE 0n" placeholder box with this number. */
  | { placeholder: number }
  /** Append to the table cell whose text contains this (normalised, case-insensitive) — `occurrence` 1-based. */
  | { cellText: string; occurrence?: number }
  /** A new paragraph after the body paragraph whose text contains this. */
  | { afterParagraphText: string; occurrence?: number };

export interface ImagePlacement {
  target: ImageTarget;
  image: DocxImage;
}

export interface InsertImagesReport {
  placed: Array<{ index: number; mediaPart: string; cx: number; cy: number; orientation: ExifOrientation }>;
  skipped: Array<{ index: number; reason: 'TARGET_NOT_FOUND' }>;
}

function nth<T>(list: T[], occurrence = 1): T | undefined {
  return list[Math.max(1, occurrence) - 1];
}

/** Locate the targets in `pkg` and add the photos (document part only). */
export function placeImages(pkg: DocxPackage, placements: ImagePlacement[], opts: { limits?: Partial<DocxImageLimits> } = {}): InsertImagesReport {
  const session = new DocxImageSession(pkg, opts);
  const part = 'word/document.xml';
  const doc = partDom(pkg, part);
  const placeholders = findImagePlaceholders(pkg, part);
  const report: InsertImagesReport = { placed: [], skipped: [] };
  // resolve every target first (a placed photo changes the text the later targets are found by)
  const resolved = placements.map((pl) => {
    const t = pl.target;
    if ('placeholder' in t) {
      const ph = placeholders.find((x) => x.number === t.placeholder);
      return ph ? ({ kind: 'replace', node: ph.cell } as const) : undefined;
    }
    if ('cellText' in t) {
      const needle = normaliseText(t.cellText).toLowerCase();
      const cells = wDescendants(doc, 'tc').filter((tc) => !wDescendants(tc, 'tc').length && normaliseText(childElements(tc).map((c) => (isW(c, 'p') ? paragraphText(c).text : '')).join(' ')).toLowerCase().includes(needle));
      const tc = nth(cells, t.occurrence);
      return tc ? ({ kind: 'cell', node: tc } as const) : undefined;
    }
    const needle = normaliseText(t.afterParagraphText).toLowerCase();
    const paras = wDescendants(doc, 'p').filter((p) => normaliseText(paragraphText(p).text).toLowerCase().includes(needle));
    const p = nth(paras, t.occurrence);
    return p ? ({ kind: 'after', node: p } as const) : undefined;
  });
  placements.forEach((pl, index) => {
    const r = resolved[index];
    if (!r) {
      report.skipped.push({ index, reason: 'TARGET_NOT_FOUND' });
      return;
    }
    const placed = r.kind === 'replace' ? session.replacePlaceholderCell(r.node, pl.image, { part }) : r.kind === 'cell' ? session.appendToCell(r.node, pl.image, { part }) : session.appendAfterParagraph(r.node, pl.image, { part });
    report.placed.push({ index, mediaPart: placed.mediaPart, cx: placed.cx, cy: placed.cy, orientation: placed.info.orientation });
  });
  return report;
}

/** openDocx → placeImages → writeDocx (deterministic: fixed zip mtime from `now`). */
export function insertDocxImages(bytes: Uint8Array, placements: ImagePlacement[], opts: { now: Date; limits?: Partial<DocxImageLimits> }): { docx: Uint8Array; sha256: string; report: InsertImagesReport } {
  const pkg = openDocx(bytes);
  const report = placeImages(pkg, placements, opts.limits ? { limits: opts.limits } : {});
  const docx = writeDocx(pkg, { mtime: opts.now });
  return { docx, sha256: sha256Hex(docx), report };
}

/** Test / preview support: every inline picture in the document part with its media part and displayed size. */
export function listDocxPictures(pkg: DocxPackage, part = 'word/document.xml'): Array<{ mediaPart: string; cx: number; cy: number; descr: string; rot: number; cell?: Element }> {
  const doc = partDom(pkg, part);
  const rels = pkg.entries.has(relsPartOf(part)) ? relsDom(pkg, part) : undefined;
  const targets = new Map<string, string>();
  if (rels) {
    const list = rels.documentElement!.getElementsByTagNameNS(NS.rels, 'Relationship');
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      const target = r.getAttribute('Target') ?? '';
      targets.set(r.getAttribute('Id') ?? '', target.startsWith('/') ? target.slice(1) : `${part.slice(0, part.lastIndexOf('/') + 1)}${target}`);
    }
  }
  const out: Array<{ mediaPart: string; cx: number; cy: number; descr: string; rot: number; cell?: Element }> = [];
  const inlines = doc.getElementsByTagNameNS(NS_WP, 'inline');
  for (let i = 0; i < inlines.length; i++) {
    const inl = inlines[i]!;
    const blip = inl.getElementsByTagNameNS(NS_A, 'blip')[0];
    const rId = blip?.getAttributeNS(NS.r, 'embed') ?? '';
    const ext = inl.getElementsByTagNameNS(NS_WP, 'extent')[0];
    const eff = inl.getElementsByTagNameNS(NS_WP, 'effectExtent')[0];
    const xfrm = inl.getElementsByTagNameNS(NS_A, 'xfrm')[0];
    const docPr = inl.getElementsByTagNameNS(NS_WP, 'docPr')[0];
    const effL = Number(eff?.getAttribute('l') ?? 0) + Number(eff?.getAttribute('r') ?? 0);
    const effT = Number(eff?.getAttribute('t') ?? 0) + Number(eff?.getAttribute('b') ?? 0);
    const cell = closestW(inl, 'tc');
    out.push({
      mediaPart: targets.get(rId) ?? '',
      cx: Number(ext?.getAttribute('cx') ?? 0) + effL,
      cy: Number(ext?.getAttribute('cy') ?? 0) + effT,
      descr: docPr?.getAttribute('descr') ?? '',
      rot: Number(xfrm?.getAttribute('rot') ?? 0),
      ...(cell ? { cell } : {})
    });
  }
  return out;
}
