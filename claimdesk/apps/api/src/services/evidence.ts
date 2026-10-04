/**
 * Write-once evidence store (BLUEPRINT §3.8, §6; ARCHITECTURE convention 3).
 *
 *   EVIDENCE_DIR/<claimId>/<sha256[0..2]>/<sha256>.<ext>        the bytes, chmod 0444
 *   EVIDENCE_DIR/<claimId>/<sha256[0..2]>/<sha256>.json         sidecar manifest, written with O_EXCL (never overwritten)
 *
 * The hash is computed while the upload streams to a staging file; the final path is derived from the hash, so the
 * same bytes on the same claim de-duplicate to the existing record. EXIF is read with exifr for images. `verify`
 * re-hashes the stored file and compares it with the row and the manifest (tamper evidence).
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Stream an upload to the staging area, hashing as it goes. */
export async function stageStream(ctx: AppContext, stream: Readable): Promise<StagedUpload> {
  const tempPath = path.join(stagingDir(ctx), randomUUID());
  const hash = createHash('sha256');
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  await pipeline(stream, createWriteStream(tempPath, { flags: 'wx' }));
  return { tempPath, sha256: hash.digest('hex'), bytes };
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

export function absoluteEvidencePath(ctx: AppContext, storagePath: string): string {
  if (path.isAbsolute(storagePath)) return storagePath;
  // Legacy rows (db fixtures) use "evidence/<claim>/<file>"; both resolve under EVIDENCE_DIR.
  const rel = storagePath.startsWith('evidence/') ? storagePath.slice('evidence/'.length) : storagePath;
  return path.join(ctx.config.evidenceDir, rel);
}

export function manifestPath(absolutePath: string): string {
  return absolutePath.replace(/\.[A-Za-z0-9]+$/, '') + '.json';
}

/**
 * Move a staged file to its content-addressed location (write-once) and write the sidecar manifest with O_EXCL.
 * If the path already holds the same bytes the staged copy is discarded and `created` is false; a different file at
 * the same path is impossible by construction (the path is the hash) and is reported as a conflict.
 */
export function finaliseStaged(ctx: AppContext, staged: StagedUpload, claimId: Id | undefined, ext: string, manifest: EvidenceManifest): StoredFile {
  const relativePath = relativeStoragePath(claimId, staged.sha256, ext);
  const absolutePath = absoluteEvidencePath(ctx, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (existsSync(absolutePath)) {
    const existingHash = hashFile(absolutePath);
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

export function hashFile(absolutePath: string): string {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
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

/** EXIF summary for images (exifr); undefined for non-images or when nothing is embedded. PNGs fall back to IHDR dimensions. */
export async function extractExif(buffer: Buffer, mime: string, logger: AppContext['logger']): Promise<ExifSummary | undefined> {
  if (!mime.toLowerCase().startsWith('image/')) return undefined;
  const summary: ExifSummary = {};
  try {
    const raw = (await exifr.parse(buffer, {
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
    const dims = pngDimensions(buffer);
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
  const buffer = readFileSync(staged.tempPath);
  const exif = await extractExif(buffer, input.mime, ctx.logger);
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
  const stored = finaliseStaged(ctx, staged, input.claimId, extensionFor(filename, input.mime), manifest);
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
export function verifyEvidence(ctx: AppContext, evidence: Evidence, actor: Actor): VerifyResult {
  const abs = absoluteEvidencePath(ctx, evidence.storagePath);
  const checkedAt = ctx.now();
  let result: VerifyResult;
  if (!existsSync(abs)) {
    result = { evidenceId: evidence.id, status: 'missing', recordedSha256: evidence.sha256, manifest: existsSync(manifestPath(abs)) ? 'ok' : 'missing', checkedAt };
  } else {
    const computed = hashFile(abs);
    const st = statSync(abs);
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
