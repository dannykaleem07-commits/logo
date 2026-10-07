// owned by intake
/**
 * Magic-byte sniffing (docs/SUPREME-DESIGN.md §G.2 step 1). Our own table, no dependency, and the extension is never
 * trusted: the bytes decide the type and `extensionMatches` only reports whether the name agrees. Exported for reuse
 * by Phase 2 (engineer data, calls, `.msg` import).
 */
import path from 'node:path';

export type SniffedKind =
  | 'pdf'
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'heic'
  | 'docx'
  | 'xlsx'
  | 'zip'
  | 'eml'
  | 'msg'
  | 'ole'
  | 'cab'
  | 'sqlite'
  | 'jet'
  | 'wav'
  | 'mp3'
  | 'm4a'
  | 'mp4'
  | 'ogg'
  | 'webm'
  | 'text'
  | 'unknown';

export interface SniffedType {
  kind: SniffedKind;
  /** The MIME type the bytes say (never the client's claim). */
  mime: string;
  /** Canonical extension for the kind (no dot). */
  ext: string;
  /** Broad family the pipeline routes on. */
  family: 'document' | 'image' | 'email' | 'archive' | 'database' | 'audio' | 'video' | 'text' | 'unknown';
  /** Extension of the supplied filename (lower case, no dot), if any. */
  claimedExtension?: string;
  /** False when a filename was given and its extension disagrees with the bytes (a "lying" extension). */
  extensionMatches: boolean;
}

interface KindInfo {
  mime: string;
  ext: string;
  family: SniffedType['family'];
  /** Extensions that are honest for this kind. */
  aliases: readonly string[];
}

export const SNIFF_TABLE: Readonly<Record<SniffedKind, KindInfo>> = {
  pdf: { mime: 'application/pdf', ext: 'pdf', family: 'document', aliases: ['pdf'] },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', family: 'image', aliases: ['jpg', 'jpeg', 'jpe', 'jfif'] },
  png: { mime: 'image/png', ext: 'png', family: 'image', aliases: ['png'] },
  gif: { mime: 'image/gif', ext: 'gif', family: 'image', aliases: ['gif'] },
  webp: { mime: 'image/webp', ext: 'webp', family: 'image', aliases: ['webp'] },
  heic: { mime: 'image/heic', ext: 'heic', family: 'image', aliases: ['heic', 'heif', 'hif'] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', family: 'document', aliases: ['docx', 'docm', 'dotx'] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', family: 'document', aliases: ['xlsx', 'xlsm'] },
  zip: { mime: 'application/zip', ext: 'zip', family: 'archive', aliases: ['zip'] },
  eml: { mime: 'message/rfc822', ext: 'eml', family: 'email', aliases: ['eml', 'mht', 'txt'] },
  msg: { mime: 'application/vnd.ms-outlook', ext: 'msg', family: 'email', aliases: ['msg'] },
  ole: { mime: 'application/x-ole-storage', ext: 'ole', family: 'document', aliases: ['doc', 'xls', 'ppt', 'msi'] },
  cab: { mime: 'application/vnd.ms-cab-compressed', ext: 'cab', family: 'archive', aliases: ['cab'] },
  sqlite: { mime: 'application/vnd.sqlite3', ext: 'sqlite', family: 'database', aliases: ['sqlite', 'sqlite3', 'db'] },
  jet: { mime: 'application/x-msaccess', ext: 'mdb', family: 'database', aliases: ['mdb', 'accdb', 'mde', 'accde'] },
  wav: { mime: 'audio/wav', ext: 'wav', family: 'audio', aliases: ['wav', 'wave'] },
  mp3: { mime: 'audio/mpeg', ext: 'mp3', family: 'audio', aliases: ['mp3'] },
  m4a: { mime: 'audio/mp4', ext: 'm4a', family: 'audio', aliases: ['m4a', 'm4b', 'mp4', 'aac'] },
  mp4: { mime: 'video/mp4', ext: 'mp4', family: 'video', aliases: ['mp4', 'm4v', 'mov', '3gp'] },
  ogg: { mime: 'audio/ogg', ext: 'ogg', family: 'audio', aliases: ['ogg', 'oga', 'opus'] },
  webm: { mime: 'video/webm', ext: 'webm', family: 'audio', aliases: ['webm', 'weba', 'mkv'] },
  text: { mime: 'text/plain', ext: 'txt', family: 'text', aliases: ['txt', 'text', 'csv', 'log', 'md', 'json', 'xml', 'html', 'htm'] },
  unknown: { mime: 'application/octet-stream', ext: 'bin', family: 'unknown', aliases: [] },
};

const startsWith = (buf: Buffer, sig: readonly number[], offset = 0): boolean => buf.length >= offset + sig.length && sig.every((b, i) => buf[offset + i] === b);
const ascii = (buf: Buffer, start: number, end: number): string => buf.subarray(start, Math.min(end, buf.length)).toString('latin1');

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif']);
const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ']);

/** ISO-BMFF `ftyp` box: major brand + compatible brands. */
function ftypBrands(buf: Buffer): string[] | undefined {
  if (buf.length < 12 || ascii(buf, 4, 8) !== 'ftyp') return undefined;
  const size = buf.readUInt32BE(0);
  const end = Math.min(buf.length, size >= 16 && size <= 4096 ? size : 32);
  const brands = [ascii(buf, 8, 12)];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(buf, o, o + 4));
  return brands;
}

/** Search a ZIP's (first 4 MiB of) bytes for an entry name. */
function zipHasEntry(buf: Buffer, name: string): boolean {
  return buf.subarray(0, 4 * 1024 * 1024).includes(Buffer.from(name, 'latin1'));
}

const UTF16_SUBSTG = Buffer.from('__substg1.0_', 'utf16le');

/** RFC 822 header names that start real messages. */
const MAIL_HEADERS = ['received', 'from', 'to', 'cc', 'subject', 'date', 'message-id', 'mime-version', 'return-path', 'delivered-to', 'content-type', 'reply-to', 'sender', 'x-mailer', 'dkim-signature', 'authentication-results', 'in-reply-to', 'references'];

/** True when the text opens with an RFC 822 header block (at least two known headers, From/Date/Subject among them). */
export function looksLikeEmail(text: string): boolean {
  const head = text.replace(/^﻿/, '').slice(0, 16 * 1024);
  const block = head.split(/\r?\n\r?\n/)[0] ?? '';
  const lines = block.split(/\r?\n/);
  if (!lines.length || !/^[A-Za-z][A-Za-z0-9-]*:\s?/.test(lines[0] ?? '')) return false;
  const names = new Set<string>();
  for (const line of lines) {
    if (/^[ \t]/.test(line)) continue; // folded continuation
    const m = /^([A-Za-z][A-Za-z0-9-]*):/.exec(line);
    if (!m) return false; // not a header block
    names.add(m[1]!.toLowerCase());
  }
  const known = [...names].filter((n) => MAIL_HEADERS.includes(n) || n.startsWith('x-'));
  return known.length >= 2 && (names.has('from') || names.has('date') || names.has('subject') || names.has('received'));
}

/** Text if valid UTF-8 (or UTF-16 with a BOM) with no NULs and mostly printable characters. */
function decodeText(buf: Buffer): string | undefined {
  const sample = buf.subarray(0, 64 * 1024);
  if (!sample.length) return undefined;
  if (startsWith(sample, [0xff, 0xfe]) || startsWith(sample, [0xfe, 0xff])) {
    const le = sample[0] === 0xff;
    const body = sample.subarray(2);
    const text = le ? body.toString('utf16le') : Buffer.from(body).swap16().toString('utf16le');
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? undefined : text;
  }
  if (sample.includes(0)) return undefined;
  const text = sample.toString('utf8');
  // Invalid UTF-8 decodes to U+FFFD; allow a cut multi-byte sequence at the very end of the sample.
  const bad = (text.slice(0, -4).match(/�/g) ?? []).length;
  if (bad > 0) return undefined;
  const control = (text.match(/[\u0000-\u0008\u000e-\u001f\u007f]/g) ?? []).length;
  return control / Math.max(text.length, 1) < 0.01 ? text : undefined;
}

function kindOf(buf: Buffer): SniffedKind {
  if (buf.length === 0) return 'unknown';
  // PDF: "%PDF-" at the start, or within the first KiB (some producers prepend junk).
  if (ascii(buf, 0, 5) === '%PDF-' || buf.subarray(0, 1024).includes(Buffer.from('%PDF-', 'latin1'))) return 'pdf';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WAVE') return 'wav';
  const brands = ftypBrands(buf);
  if (brands) {
    if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic';
    if (brands.some((b) => M4A_BRANDS.has(b))) return 'm4a';
    return 'mp4';
  }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) {
    if (zipHasEntry(buf, '[Content_Types].xml')) {
      if (zipHasEntry(buf, 'word/')) return 'docx';
      if (zipHasEntry(buf, 'xl/')) return 'xlsx';
    }
    return 'zip';
  }
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return buf.includes(UTF16_SUBSTG) ? 'msg' : 'ole';
  if (ascii(buf, 0, 4) === 'MSCF') return 'cab';
  if (ascii(buf, 0, 16) === 'SQLite format 3\u0000') return 'sqlite';
  if (ascii(buf, 4, 19) === 'Standard Jet DB' || ascii(buf, 4, 19) === 'Standard ACE DB') return 'jet';
  if (ascii(buf, 0, 3) === 'ID3') return 'mp3';
  if (ascii(buf, 0, 4) === 'OggS') return 'ogg';
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  // MPEG audio frame sync (no ID3 tag): 0xFFE? with a valid layer.
  if (buf.length >= 4 && buf[0] === 0xff && ((buf[1]! & 0xe0) === 0xe0) && ((buf[1]! & 0x06) !== 0) && ((buf[2]! & 0xf0) !== 0xf0)) return 'mp3';
  const text = decodeText(buf);
  if (text !== undefined) return looksLikeEmail(text) ? 'eml' : 'text';
  return 'unknown';
}

/** Sniff the bytes (the first few KiB decide; ZIP entry names are searched in the first 4 MiB). */
export function sniff(buf: Buffer, filename?: string): SniffedType {
  const kind = kindOf(buf);
  const info = SNIFF_TABLE[kind];
  const claimed = filename ? path.extname(filename).slice(1).toLowerCase() || undefined : undefined;
  const extensionMatches = claimed === undefined ? true : info.aliases.includes(claimed);
  return { kind, mime: info.mime, ext: info.ext, family: info.family, ...(claimed ? { claimedExtension: claimed } : {}), extensionMatches };
}

/** Kinds the Phase 1 pipeline reads (others are skipped with a reason). */
export const READABLE_KINDS: ReadonlySet<SniffedKind> = new Set(['pdf', 'jpeg', 'png', 'gif', 'webp', 'docx', 'eml', 'text']);
/** Images the models take as they are. */
export const MODEL_IMAGE_KINDS: ReadonlySet<SniffedKind> = new Set(['jpeg', 'png', 'gif', 'webp']);
