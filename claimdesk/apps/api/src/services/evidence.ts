/**
 * Write-once evidence store (BLUEPRINT §3.8, §6; ARCHITECTURE convention 3; SUPREME-DESIGN §0.3 point 4).
 *
 *   EVIDENCE_DIR/<claimId>/<sha256[0..2]>/<sha256>.<ext>        the bytes, chmod 0444
 *   EVIDENCE_DIR/<claimId>/<sha256[0..2]>/<sha256>.json         sidecar manifest, written with O_EXCL (never overwritten)
 *
 * The hash is computed while the upload streams to a staging file; the final path is derived from the hash, so the
 * same bytes on the same claim de-duplicate to the existing record. EXIF is read with exifr for images up to 64 MiB.
 * `verify` re-hashes the stored file and compares it with the row and the manifest (tamper evidence). Every read of a
 * stored file streams (no whole-file buffers), so multi-gigabyte evidence never sits in memory.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import exifr from 'exifr';
import type { Actor } from '@ccguk/db';
import type { Evidence, ExifSummary, Id, ISODateTime } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';
import type { EvidenceFields } from '../schemas/services.js';

export interface StagedUpload {
  tempPath: string;
  sha256: string;
  bytes: number;
}

export interface StoredFile {
  relativePath: string;
  absolutePath: string;
  /** False when the bytes were already in the store at that path (same hash). */
  created: boolean;
}

export interface EvidenceManifest {
  sha256: string;
  bytes: number;
  filename: string;
  mime: string;
  claimId?: Id;
  kind: string;
  uploadedAt: ISODateTime;
  uploadedBy: Id;
  capturedAt?: ISODateTime;
  exif?: ExifSummary;
  writeOnce: true;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'message/rfc822': 'eml',
};

export function extensionFor(filename: string, mime: string): string {
  const fromName = path.extname(filename).replace('.', '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (fromName && fromName.length <= 8) return fromName;
  return MIME_EXT[mime.toLowerCase()] ?? 'bin';
}

export function safeFilename(name: string): string {
  const base = path.basename(name || 'upload').replace(/[^\w.\- ()]/g, '_').trim();
  return base.length ? base.slice(0, 180) : 'upload';
}

function stagingDir(ctx: AppContext): string {
  const dir = path.join(ctx.config.evidenceDir, '.incoming');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stream an upload to the staging area, hashing as it goes. A stream that fails part-way deletes its temp file. */
export async function stageStream(ctx: AppContext, stream: Readable): Promise<StagedUpload> {
  const tempPath = path.join(stagingDir(ctx), randomUUID());
  const hash = createHash('sha256');
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  try {
    await pipeline(stream, createWriteStream(tempPath, { flags: 'wx' }));
  } catch (err) {
    removeQuietly(tempPath);
    throw err;
  }
  return { tempPath, sha256: hash.digest('hex'), bytes };
}

/**
 * Move a file that is already on disk (a finished chunked upload) into the staging area without re-reading it: rename
 * when on the same volume, copy + unlink across volumes. The caller supplies the hash it computed while receiving.
 */
export function stageExistingFile(ctx: AppContext, sourcePath: string, sha256: string, bytes: number): StagedUpload {
  const tempPath = path.join(stagingDir(ctx), randomUUID());
  moveFile(sourcePath, tempPath);
  return { tempPath, sha256, bytes };
}

/** rename, or copy + unlink when the rename crosses volumes (EXDEV). */
export function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    removeQuietly(from);
  }
}

function removeQuietly(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
}

export function stageBuffer(ctx: AppContext, buffer: Buffer): StagedUpload {
  const tempPath = path.join(stagingDir(ctx), randomUUID());
  writeFileSync(tempPath, buffer, { flag: 'wx' });
  return { tempPath, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length };
}

export function discardStaged(staged: StagedUpload): void {
  try {
    unlinkSync(staged.tempPath);
  } catch {
    /* already gone */
  }
}

export function relativeStoragePath(claimId: Id | undefined, sha256: string, ext: string): string {
  return path.posix.join(claimId ?? '_unassigned', sha256.slice(0, 2), `${sha256}.${ext}`);
}

/** Resolve `candidate` and refuse anything that escapes `root` (defence in depth: store paths come from our own rows, never from a request). */
export function assertInsideStore(root: string, candidate: string, what: string): string {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  if (c !== r && !c.startsWith(r + path.sep)) throw conflict('STORE_PATH_INVALID', `${what} resolves outside its store and is refused`, { path: candidate });
  return c;
}

export function absoluteEvidencePath(ctx: AppContext, storagePath: string): string {
  // Legacy rows (db fixtures) use "evidence/<claim>/<file>"; both resolve under EVIDENCE_DIR.
  const rel = storagePath.startsWith('evidence/') ? storagePath.slice('evidence/'.length) : storagePath;
  const abs = path.isAbsolute(rel) ? rel : path.join(ctx.config.evidenceDir, rel);
  return assertInsideStore(ctx.config.evidenceDir, abs, 'evidence storagePath');
}

export function manifestPath(absolutePath: string): string {
  return absolutePath.replace(/\.[A-Za-z0-9]+$/, '') + '.json';
}

/**
 * Move a staged file to its content-addressed location (write-once) and write the sidecar manifest with O_EXCL.
 * If the path already holds the same bytes the staged copy is discarded and `created` is false; a different file at
 * the same path is impossible by construction (the path is the hash) and is reported as a conflict.
 */
export async function finaliseStaged(ctx: AppContext, staged: StagedUpload, claimId: Id | undefined, ext: string, manifest: EvidenceManifest): Promise<StoredFile> {
  const relativePath = relativeStoragePath(claimId, staged.sha256, ext);
  const absolutePath = absoluteEvidencePath(ctx, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (existsSync(absolutePath)) {
    const existingHash = await hashFile(absolutePath);
    discardStaged(staged);
    if (existingHash !== staged.sha256) throw conflict('EVIDENCE_WRITE_ONCE', `Refusing to overwrite ${relativePath}: the stored file does not match the upload hash`);
    return { relativePath, absolutePath, created: false };
  }
  renameSync(staged.tempPath, absolutePath);
  chmodSync(absolutePath, 0o444);
  const mp = manifestPath(absolutePath);
  if (existsSync(mp)) throw conflict('EVIDENCE_WRITE_ONCE', `Refusing to overwrite manifest ${path.basename(mp)}`);
  writeFileSync(mp, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  chmodSync(mp, 0o444);
  return { relativePath, absolutePath, created: true };
}

/** Streaming SHA-256 of a file (never the whole file in memory). */
export async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// EXIF / image metadata
// ---------------------------------------------------------------------------

function toIso(value: unknown): ISODateTime | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return undefined;
}

function pngDimensions(buffer: Buffer): { widthPx: number; heightPx: number } | undefined {
  if (buffer.length < 24) return undefined;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { widthPx: buffer.readUInt32BE(16), heightPx: buffer.readUInt32BE(20) };
}

/** EXIF is read only for images up to this size (a bigger "image" is not a phone photo; reading it is not worth it). */
export const EXIF_MAX_BYTES = 64 * 1024 * 1024;

/** True when EXIF is worth reading: image/* and at most EXIF_MAX_BYTES. */
export function wantsExif(mime: string, bytes: number): boolean {
  return mime.toLowerCase().startsWith('image/') && bytes <= EXIF_MAX_BYTES;
}

/** The first bytes of a file (enough for a PNG IHDR), without reading the rest. */
function readHead(absolutePath: string, n: number): Buffer {
  const fd = openSync(absolutePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * EXIF summary for images (exifr); undefined for non-images or when nothing is embedded. PNGs fall back to IHDR
 * dimensions. `source` is a buffer or a file path — exifr reads only the chunks it needs from a path.
 */
export async function extractExif(source: Buffer | string, mime: string, logger: AppContext['logger']): Promise<ExifSummary | undefined> {
  if (!mime.toLowerCase().startsWith('image/')) return undefined;
  const summary: ExifSummary = {};
  try {
    const raw = (await exifr.parse(source, {
      pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'Software', 'Orientation', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight', 'GPSAltitude'],
      gps: true,
      translateValues: true,
      reviveValues: true,
    } as Record<string, unknown>)) as Record<string, unknown> | undefined;
    if (raw) {
      const dt = toIso(raw.DateTimeOriginal) ?? toIso(raw.CreateDate);
      if (dt) summary.dateTimeOriginal = dt;
      if (typeof raw.Make === 'string') summary.make = raw.Make.trim();
      if (typeof raw.Model === 'string') summary.model = raw.Model.trim();
      if (typeof raw.Software === 'string') summary.software = raw.Software.trim();
      if (typeof raw.Orientation === 'number') summary.orientation = raw.Orientation;
      const w = raw.ExifImageWidth ?? raw.ImageWidth;
      const h = raw.ExifImageHeight ?? raw.ImageHeight;
      if (typeof w === 'number' && typeof h === 'number') {
        summary.widthPx = w;
        summary.heightPx = h;
      }
      if (typeof raw.latitude === 'number' && typeof raw.longitude === 'number') {
        summary.gps = { lat: raw.latitude, lon: raw.longitude, ...(typeof raw.GPSAltitude === 'number' ? { altitude: raw.GPSAltitude } : {}) };
      }
    }
  } catch (err) {
    logger.warn('evidence: exif parse failed', { error: String(err) });
  }
  if (summary.widthPx === undefined) {
    let head: Buffer | undefined;
    try {
      head = typeof source === 'string' ? readHead(source, 32) : source;
    } catch {
      head = undefined;
    }
    const dims = head ? pngDimensions(head) : undefined;
    if (dims) Object.assign(summary, dims);
  }
  return Object.keys(summary).length ? summary : undefined;
}

// ---------------------------------------------------------------------------
// Record + verify
// ---------------------------------------------------------------------------

export interface StoreEvidenceInput {
  claimId?: Id;
  staged: StagedUpload;
  filename: string;
  mime: string;
  fields: EvidenceFields;
  actor: Actor;
}

export interface StoreEvidenceResult {
  evidence: Evidence;
  /** True when the same bytes were already on this claim and the existing record was returned. */
  deduped: boolean;
  /** Other claims holding the same bytes (cross-file reuse of a photo is a fraud indicator worth a look). */
  alsoOnClaims: Id[];
}

/** Finalise a staged upload: dedupe by hash, read EXIF, store bytes + manifest, insert the immutable row, audit. */
export async function storeEvidence(ctx: AppContext, input: StoreEvidenceInput): Promise<StoreEvidenceResult> {
  const { staged, fields } = input;
  if (fields.sha256 && fields.sha256.toLowerCase() !== staged.sha256) {
    discardStaged(staged);
    throw conflict('HASH_MISMATCH', `Device hash ${fields.sha256.toLowerCase()} does not match the uploaded bytes (${staged.sha256})`, { expected: fields.sha256.toLowerCase(), actual: staged.sha256 });
  }
  const same = ctx.repos.findEvidenceBySha256(ctx.db, staged.sha256);
  const onThisClaim = same.find((e) => e.claimId === input.claimId);
  const alsoOnClaims = [...new Set(same.map((e) => e.claimId).filter((c): c is string => Boolean(c) && c !== input.claimId))];
  if (onThisClaim) {
    discardStaged(staged);
    return { evidence: onThisClaim, deduped: true, alsoOnClaims };
  }
  // EXIF straight from the staged file (exifr reads only the segments it needs), and only for images ≤ 64 MiB.
  const exif = wantsExif(input.mime, staged.bytes) ? await extractExif(staged.tempPath, input.mime, ctx.logger) : undefined;
  const now = ctx.now();
  const filename = safeFilename(input.filename);
  const capturedAt = fields.capturedAt ?? exif?.dateTimeOriginal;
  const manifest: EvidenceManifest = {
    sha256: staged.sha256,
    bytes: staged.bytes,
    filename,
    mime: input.mime,
    claimId: input.claimId,
    kind: fields.kind,
    uploadedAt: now,
    uploadedBy: input.actor.userId,
    capturedAt,
    exif,
    writeOnce: true,
  };
  const stored = await finaliseStaged(ctx, staged, input.claimId, extensionFor(filename, input.mime), manifest);
  const evidence = ctx.db.transaction((tx) => {
    const e = ctx.repos.insertEvidence(tx, {
      claimId: input.claimId,
      kind: fields.kind,
      filename,
      mime: input.mime,
      bytes: staged.bytes,
      sha256: staged.sha256,
      storagePath: stored.relativePath,
      capturedAt,
      uploadedAt: now,
      uploadedBy: input.actor.userId,
      exif,
      captureShot: fields.captureShot,
      sourceUrl: fields.sourceUrl,
      description: fields.description,
    });
    ctx.repos.appendAudit(tx, {
      actor: input.actor,
      action: 'evidence.upload',
      entity: 'evidence',
      entityId: e.id,
      after: { claimId: input.claimId, sha256: e.sha256, bytes: e.bytes, kind: e.kind, storagePath: e.storagePath, alsoOnClaims },
      at: now,
    });
    return e;
  });
  return { evidence, deduped: false, alsoOnClaims };
}

/** Convenience for the seed and tests: store an in-memory buffer as evidence. */
export async function storeEvidenceBuffer(ctx: AppContext, buffer: Buffer, input: Omit<StoreEvidenceInput, 'staged'>): Promise<StoreEvidenceResult> {
  return storeEvidence(ctx, { ...input, staged: stageBuffer(ctx, buffer) });
}

export interface VerifyResult {
  evidenceId: Id;
  status: 'intact' | 'tampered' | 'missing';
  recordedSha256: string;
  computedSha256?: string;
  bytesOnDisk?: number;
  manifest: 'ok' | 'mismatch' | 'missing';
  readOnly?: boolean;
  checkedAt: ISODateTime;
}

/** Re-hash the stored bytes and compare them with the row and the sidecar manifest. Audited as `evidence.verify`. */
export async function verifyEvidence(ctx: AppContext, evidence: Evidence, actor: Actor): Promise<VerifyResult> {
  const abs = absoluteEvidencePath(ctx, evidence.storagePath);
  const checkedAt = ctx.now();
  let result: VerifyResult;
  if (!existsSync(abs)) {
    result = { evidenceId: evidence.id, status: 'missing', recordedSha256: evidence.sha256, manifest: existsSync(manifestPath(abs)) ? 'ok' : 'missing', checkedAt };
  } else {
    const st = statSync(abs);
    const computed = await hashFile(abs);
    let manifest: VerifyResult['manifest'] = 'missing';
    const mp = manifestPath(abs);
    if (existsSync(mp)) {
      try {
        const m = JSON.parse(readFileSync(mp, 'utf8')) as Partial<EvidenceManifest>;
        manifest = m.sha256?.toLowerCase() === evidence.sha256.toLowerCase() && m.bytes === evidence.bytes ? 'ok' : 'mismatch';
      } catch {
        manifest = 'mismatch';
      }
    }
    const intact = computed === evidence.sha256.toLowerCase() && st.size === evidence.bytes;
    result = {
      evidenceId: evidence.id,
      status: intact ? 'intact' : 'tampered',
      recordedSha256: evidence.sha256,
      computedSha256: computed,
      bytesOnDisk: st.size,
      manifest,
      readOnly: (st.mode & 0o222) === 0,
      checkedAt,
    };
  }
  ctx.repos.appendAudit(ctx.db, { actor, action: 'evidence.verify', entity: 'evidence', entityId: evidence.id, after: { status: result.status, manifest: result.manifest, computedSha256: result.computedSha256 }, at: checkedAt });
  return result;
}

export function openEvidenceStream(ctx: AppContext, evidence: Evidence) {
  const abs = absoluteEvidencePath(ctx, evidence.storagePath);
  if (!existsSync(abs)) return undefined;
  return createReadStream(abs);
}

export interface VerifiedEvidenceRead {
  absolutePath: string;
  /** Bytes on disk when the file was verified. */
  size: number;
  computedSha256: string;
  /** True when the bytes on disk hash to the recorded sha256 and have the recorded length. */
  intact: boolean;
}

/** Files above this size keep their verified result in memory while their path, size and mtime are unchanged. */
export const VERIFY_CACHE_MIN_BYTES = 256 * 1024 * 1024;
const verifyCache = new Map<string, { mtimeMs: number; size: number; computedSha256: string }>();

/**
 * Re-hash the stored bytes against the row (streaming) — the file route never serves bytes that no longer match the
 * record. Files over 256 MiB reuse a previous result while {path, mtime, size} are unchanged (stored files are 0444
 * and write-once, so a changed file always shows a new mtime or size).
 */
export async function readEvidenceVerified(ctx: AppContext, evidence: Evidence): Promise<VerifiedEvidenceRead | undefined> {
  const abs = absoluteEvidencePath(ctx, evidence.storagePath);
  if (!existsSync(abs)) return undefined;
  const st = statSync(abs);
  const cacheable = st.size > VERIFY_CACHE_MIN_BYTES;
  const cached = cacheable ? verifyCache.get(abs) : undefined;
  let computedSha256: string;
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) computedSha256 = cached.computedSha256;
  else {
    computedSha256 = await hashFile(abs);
    if (cacheable) verifyCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, computedSha256 });
  }
  return { absolutePath: abs, size: st.size, computedSha256, intact: computedSha256 === evidence.sha256.toLowerCase() && st.size === evidence.bytes };
}

/** Test hook: forget cached verification results. */
export function clearVerifyCache(): void {
  verifyCache.clear();
}
