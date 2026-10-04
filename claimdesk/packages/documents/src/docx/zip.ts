/**
 * openDocx / writeDocx (fflate) with the zip-level safety limits (§A.2, §A.3).
 *
 * The fflate `filter` sees every entry's declared compressed and uncompressed size before anything is inflated, so
 * zip bombs (huge entries, huge totals, absurd compression ratios, too many entries) are refused without inflating.
 * Untouched entries are written back byte-identical (same uncompressed bytes); only DOM parts marked dirty are
 * re-serialised. Output order is the original entry order and every entry carries the same fixed mtime, so the same
 * inputs always give the same bytes.
 */
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { DEFAULT_DOCX_LIMITS, DocxError, type DocxLimits, type DocxPackage } from './types.js';
import { encodeUtf8, serializeXml } from './xml.js';

const ONE_MIB = 1024 * 1024;

/** Default zip mtime when the caller gives none (deterministic output). */
export const DEFAULT_ZIP_MTIME = new Date(2026, 0, 1, 0, 0, 0);

export function resolveLimits(limits?: Partial<DocxLimits>): DocxLimits {
  return { ...DEFAULT_DOCX_LIMITS, ...(limits ?? {}) };
}

export function isZipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Problem with an entry name, or undefined when it is acceptable. */
export function badEntryName(name: string): string | undefined {
  if (name.length === 0) return 'empty entry name';
  if (name.includes('\0')) return 'NUL in entry name';
  if (name.includes('\\')) return 'backslash in entry name';
  if (name.startsWith('/')) return 'absolute entry name';
  if (/^[A-Za-z]:/.test(name)) return 'drive letter in entry name';
  if (name.split('/').some((seg) => seg === '..')) return 'path traversal in entry name';
  return undefined;
}

export interface ZipEntryInfo {
  name: string;
  size: number;
  originalSize: number;
  compression: number;
}

/**
 * Inflate a zip, enforcing limits inside the fflate filter (before any entry is inflated).
 * Returns the entries in archive order. Throws DocxError on any breach.
 */
export function unzipChecked(bytes: Uint8Array, limits?: Partial<DocxLimits>): { entries: Map<string, Uint8Array>; order: string[]; infos: ZipEntryInfo[] } {
  const lim = resolveLimits(limits);
  if (bytes.length > lim.maxCompressedBytes) {
    throw new DocxError('TOO_LARGE', `The file is larger than ${Math.round(lim.maxCompressedBytes / ONE_MIB)} MiB`);
  }
  if (!isZipMagic(bytes)) throw new DocxError('NOT_A_ZIP', 'Not a Word document (.docx is a zip package)');
  const seen = new Set<string>();
  const order: string[] = [];
  const infos: ZipEntryInfo[] = [];
  let total = 0;
  let count = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, {
      filter: (file) => {
        count += 1;
        if (count > lim.maxEntries) throw new DocxError('TOO_MANY_ENTRIES', `More than ${lim.maxEntries} entries in the package`);
        const bad = badEntryName(file.name);
        if (bad) throw new DocxError('BAD_ENTRY_NAME', `${bad}: ${JSON.stringify(file.name)}`, file.name);
        if (seen.has(file.name)) throw new DocxError('DUPLICATE_ENTRY', `Duplicate entry ${file.name}`, file.name);
        seen.add(file.name);
        if (file.originalSize > lim.maxEntryUncompressed) {
          throw new DocxError('ENTRY_TOO_LARGE', `${file.name} expands to more than ${Math.round(lim.maxEntryUncompressed / ONE_MIB)} MiB`, file.name);
        }
        total += file.originalSize;
        if (total > lim.maxTotalUncompressed) {
          throw new DocxError('TOTAL_TOO_LARGE', `The package expands to more than ${Math.round(lim.maxTotalUncompressed / ONE_MIB)} MiB`, file.name);
        }
        if (file.originalSize > ONE_MIB) {
          const ratio = file.size === 0 ? Number.POSITIVE_INFINITY : file.originalSize / file.size;
          if (ratio > lim.maxRatio) throw new DocxError('COMPRESSION_RATIO', `${file.name} has a compression ratio above ${lim.maxRatio}`, file.name);
        }
        if (file.compression !== 0 && file.compression !== 8) {
          throw new DocxError('UNSUPPORTED_COMPRESSION', `${file.name} uses compression method ${file.compression}`, file.name);
        }
        order.push(file.name);
        infos.push({ name: file.name, size: file.size, originalSize: file.originalSize, compression: file.compression });
        return true;
      }
    });
  } catch (err) {
    if (err instanceof DocxError) throw err;
    throw new DocxError('BAD_ZIP', `The package could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries = new Map<string, Uint8Array>();
  for (const info of infos) {
    const data = unzipped[info.name];
    if (!data) throw new DocxError('BAD_ZIP', `Entry ${info.name} could not be read`, info.name);
    if (data.length !== info.originalSize) throw new DocxError('BAD_ZIP', `Entry ${info.name} size does not match its header`, info.name);
    entries.set(info.name, data);
  }
  return { entries, order, infos };
}

export function openDocx(bytes: Uint8Array, limits?: Partial<DocxLimits>): DocxPackage {
  const { entries, order } = unzipChecked(bytes, limits);
  if (!entries.has('[Content_Types].xml')) throw new DocxError('MISSING_CONTENT_TYPES', 'The package has no [Content_Types].xml', '[Content_Types].xml');
  if (!entries.has('word/document.xml')) throw new DocxError('MISSING_DOCUMENT', 'The package has no word/document.xml', 'word/document.xml');
  return { entries, order, dom: new Map(), dirty: new Set() };
}

/** Serialise dirty DOM parts back into `entries` (idempotent). */
export function flushDom(pkg: DocxPackage): void {
  for (const part of pkg.dirty ?? []) {
    const doc = pkg.dom.get(part);
    if (doc) pkg.entries.set(part, encodeUtf8(serializeXml(doc)));
  }
  pkg.dirty?.clear();
}

export function writeDocx(pkg: DocxPackage, opts?: { mtime?: Date }): Uint8Array {
  flushDom(pkg);
  const mtime = opts?.mtime ?? DEFAULT_ZIP_MTIME;
  const names = [...pkg.order];
  // [Content_Types].xml first (Word does not require it, but some readers do).
  const ctIdx = names.indexOf('[Content_Types].xml');
  if (ctIdx > 0) {
    names.splice(ctIdx, 1);
    names.unshift('[Content_Types].xml');
  }
  const files: Zippable = {};
  for (const name of names) {
    const data = pkg.entries.get(name);
    if (!data) continue;
    files[name] = [data, { level: 6, mtime }];
  }
  return zipSync(files, { level: 6, mtime });
}
