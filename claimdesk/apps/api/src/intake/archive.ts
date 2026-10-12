// owned by intake-server
/**
 * ZIP unpacking for intake (docs/SMART-INTAKE.md §5.2). The archive is read from the evidence store with random
 * access in 1 MiB chunks — the central directory first (names, sizes, flags), then each entry's data streamed through
 * fflate's `Inflate` (or passed through when stored) into a staged temp file, hashed as it is written — so a 2 GB ZIP
 * never sits in memory. Each entry becomes a child intake item (`createItemFromStaged`) and, for bundle items, a
 * bundle file.
 *
 * Limits (Settings > Intake): at most `maxEntries` entries and `maxTotalBytes` uncompressed, nested ZIPs to
 * `maxDepth`, a per-entry compression ratio ≤ `maxRatio` (zip bombs); encrypted entries (general-purpose flag bit 0),
 * directories, `__MACOSX/`, dot-files, `Thumbs.db` and `desktop.ini` are skipped and listed. Entry names are reduced
 * to a safe base name — no path from an archive ever reaches the file system.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { Inflate } from 'fflate';
import type { IntakeSettings } from '@ccguk/domain';
import type { StagedUpload } from '../services/evidence.js';
import { safeFilename } from '../services/evidence.js';

export interface ArchiveEntryOutcome {
  name: string;
  bytes: number;
  outcome: 'item' | 'skipped';
  reason?: string;
}

interface CdEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  isDir: boolean;
}

const CHUNK = 1024 * 1024;

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, pos + off);
    if (n <= 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

/** The central directory of a ZIP (throws on a file that is not a readable ZIP). */
export function readCentralDirectory(fd: number, fileSize: number): CdEntry[] {
  const tailLen = Math.min(fileSize, 65_557);
  const tail = readAt(fd, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end of central directory)');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  // ZIP64 end of central directory locator
  const locPos = eocd - 20;
  if ((count === 0xffff || cdOffset === 0xffffffff) && locPos >= 0 && tail.readUInt32LE(locPos) === 0x07064b50) {
    const z64Off = Number(tail.readBigUInt64LE(locPos + 8));
    const z64 = readAt(fd, z64Off, 56);
    if (z64.readUInt32LE(0) === 0x06064b50) {
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
  }
  if (cdSize > 64 * 1024 * 1024) throw new Error('the ZIP directory is too large');
  const cd = readAt(fd, cdOffset, cdSize);
  const out: CdEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n += 1) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
    // ZIP64 extended information
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff && q + 8 <= e + 4 + len) {
          size = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) {
          compressedSize = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff && q + 8 <= e + 4 + len) localHeaderOffset = Number(cd.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    out.push({ name, flags, method, compressedSize, size, localHeaderOffset, isDir: name.endsWith('/') || name.endsWith('\\') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Entry names never unpacked: macOS resource forks, dot-files, Windows thumbnails. */
export function ignoredEntry(name: string): string | null {
  const parts = name.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return 'empty name';
  if (parts.some((p) => p === '__MACOSX')) return 'macOS resource file';
  const base = parts[parts.length - 1]!;
  if (base.startsWith('.')) return 'hidden file';
  if (/^thumbs\.db$|^desktop\.ini$/i.test(base)) return 'Windows system file';
  return null;
}

export interface UnpackLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxRatio: number;
}

export interface UnpackedEntry {
  name: string;
  staged: StagedUpload;
}

/**
 * Unpack the entries of the ZIP at `absolutePath` into staged temp files under `stagingDir`, calling `onEntry` for each
 * (the caller turns it into an item; the temp file belongs to the caller once handed over). Returns every entry's
 * outcome (items and skipped entries with the reason).
 */
export async function unpackZip(absolutePath: string, stagingDir: string, limits: UnpackLimits, onEntry: (e: UnpackedEntry) => Promise<void>): Promise<ArchiveEntryOutcome[]> {
  mkdirSync(stagingDir, { recursive: true });
  const fd = openSync(absolutePath, 'r');
  const outcomes: ArchiveEntryOutcome[] = [];
  try {
    const fileSize = fstatSync(fd).size;
    const entries = readCentralDirectory(fd, fileSize);
    let total = 0;
    let taken = 0;
    for (const entry of entries) {
      if (entry.isDir) continue;
      const display = safeFilename(path.basename(entry.name.replace(/\\/g, '/')));
      const skip = (reason: string) => outcomes.push({ name: display, bytes: entry.size, outcome: 'skipped', reason });
      const ignored = ignoredEntry(entry.name);
      if (ignored) {
        skip(ignored);
        continue;
      }
      if (entry.flags & 0x1) {
        skip('encrypted (password-protected) — extract it yourself and add the file');
        continue;
      }
      if (entry.method !== 0 && entry.method !== 8) {
        skip(`unsupported compression method ${entry.method}`);
        continue;
      }
      if (taken >= limits.maxEntries) {
        skip(`more than ${limits.maxEntries} files in the archive`);
        continue;
      }
      if (entry.compressedSize > 0 && entry.size / entry.compressedSize > limits.maxRatio) {
        skip(`compression ratio ${Math.round(entry.size / entry.compressedSize)}:1 is above ${limits.maxRatio}:1`);
        continue;
      }
      if (total + entry.size > limits.maxTotalBytes) {
        skip('the archive is larger than the unpack limit');
        continue;
      }
      const staged = extractEntry(fd, entry, stagingDir, Math.min(limits.maxTotalBytes - total, entry.size));
      if (!staged.ok) {
        skip(staged.reason);
        continue;
      }
      total += staged.staged.bytes;
      taken += 1;
      if (staged.staged.bytes === 0) {
        try {
          unlinkSync(staged.staged.tempPath);
        } catch {
          /* gone */
        }
        skip('empty file');
        continue;
      }
      outcomes.push({ name: display, bytes: staged.staged.bytes, outcome: 'item' });
      await onEntry({ name: display, staged: staged.staged });
    }
  } finally {
    closeSync(fd);
  }
  return outcomes;
}

function extractEntry(fd: number, entry: CdEntry, stagingDir: string, maxOut: number): { ok: true; staged: StagedUpload } | { ok: false; reason: string } {
  const lh = readAt(fd, entry.localHeaderOffset, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) return { ok: false, reason: 'damaged entry header' };
  const dataStart = entry.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const tempPath = path.join(stagingDir, randomUUID());
  const out = openSync(tempPath, 'wx');
  const hash = createHash('sha256');
  let written = 0;
  let failed: string | null = null;
  const sink = (chunk: Uint8Array) => {
    if (failed) return;
    if (written + chunk.length > maxOut || written + chunk.length > entry.size) {
      failed = 'the file is larger than its archive entry says';
      return;
    }
    hash.update(chunk);
    writeSync(out, chunk);
    written += chunk.length;
  };
  try {
    if (entry.method === 0) {
      for (let pos = 0; pos < entry.compressedSize && !failed; pos += CHUNK) sink(readAt(fd, dataStart + pos, Math.min(CHUNK, entry.compressedSize - pos)));
    } else {
      const inflater = new Inflate((chunk) => sink(chunk));
      for (let pos = 0; pos < entry.compressedSize && !failed; pos += CHUNK) {
        const len = Math.min(CHUNK, entry.compressedSize - pos);
        inflater.push(readAt(fd, dataStart + pos, len), pos + len >= entry.compressedSize);
      }
    }
  } catch (err) {
    failed = `could not be unpacked: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    closeSync(out);
  }
  if (!failed && written !== entry.size) failed = 'the unpacked size does not match the archive';
  if (failed) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* gone */
    }
    return { ok: false, reason: failed };
  }
  return { ok: true, staged: { tempPath, sha256: hash.digest('hex'), bytes: written } };
}

/** The archive limits of the settings. */
export function unpackLimits(s: IntakeSettings): UnpackLimits {
  return { maxEntries: s.archives.maxEntries, maxTotalBytes: s.archives.maxTotalBytes, maxRatio: s.archives.maxRatio };
}
