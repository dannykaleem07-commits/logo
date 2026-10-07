/**
 * Big uploads (SUPREME-DESIGN §0.3 points 1–2, slice `uploads-desktop`).
 *
 *  - `uploadLimits()`: per-route limits read from the environment (MAX_EVIDENCE_UPLOAD_MB default 2048,
 *    CHUNK_THRESHOLD_MB default 64, CHUNK_MB default 8). The global 25 MiB multipart limit in app.ts stays the default
 *    for every other route.
 *  - Resumable chunked upload sessions: `POST /uploads` → `PUT /uploads/:id?offset=N` (raw chunks) →
 *    `POST /uploads/:id/complete`. Each session lives in `<DATA_DIR>/uploads/<id>/{data.part, session.json}`; the
 *    SHA-256 is computed incrementally (one crypto Hash per live session, kept in memory and rebuilt by streaming
 *    data.part once after a restart). A failed chunk never advances `receivedBytes`, so the client simply resends it.
 *  - Completion: purpose `evidence` goes through the existing write-once store (`storeEvidence`); every other purpose
 *    becomes a staged import (services/imports.ts).
 *  - Sessions untouched for 7 days are deleted lazily (on the next uploads call).
 */
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Actor } from '@ccguk/db';
import type { Id, ISODateTime } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict, HttpError, notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { evidenceFields } from '../schemas/services.js';
import type { CreateUploadBody, UploadPurpose } from '../schemas/uploads.js';
import { safeFilename, stageExistingFile, storeEvidence, type StoreEvidenceResult } from './evidence.js';
import { stageImport, type StagedImport } from './imports.js';

const MIB = 1024 * 1024;

export interface UploadLimits {
  /** Largest evidence file accepted by `POST /claims/:id/evidence` and by a chunked evidence upload. */
  maxEvidenceBytes: number;
  /** Files above this size are sent with the chunked protocol by the web app. */
  chunkThresholdBytes: number;
  /** Size of each chunk the web app sends (a chunk may be up to chunkBytes + 1 MiB). */
  chunkBytes: number;
}

function mib(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Math.floor((Number.isFinite(n) && n > 0 ? n : fallback) * MIB);
}

export function uploadLimits(env: NodeJS.ProcessEnv = process.env): UploadLimits {
  return {
    maxEvidenceBytes: mib(env, 'MAX_EVIDENCE_UPLOAD_MB', 2048),
    chunkThresholdBytes: mib(env, 'CHUNK_THRESHOLD_MB', 64),
    chunkBytes: mib(env, 'CHUNK_MB', 8),
  };
}

/** A chunk may exceed chunkBytes by this much (the client's slicing need not be exact). */
export const CHUNK_SLACK_BYTES = MIB;
/** Free disk space needed before a session starts: the declared size × this factor. */
export const FREE_SPACE_FACTOR = 1.1;
/** Sessions with no activity for this long are deleted on the next uploads call. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type UploadStatus = 'receiving' | 'complete';

export interface UploadSession {
  id: Id;
  filename: string;
  bytes: number;
  mime: string;
  purpose: UploadPurpose;
  claimId?: Id;
  fields?: Record<string, string>;
  receivedBytes: number;
  status: UploadStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  createdBy: Id;
  /** Set once complete: what the upload became (so a repeated `complete` returns the same answer). */
  result?: { evidenceId?: Id; deduped?: boolean; alsoOnClaims?: Id[]; importId?: Id; sha256: string };
}

export interface UploadProgress {
  id: Id;
  receivedBytes: number;
  bytes: number;
  status: UploadStatus;
  chunkBytes: number;
}

export function uploadsRoot(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'uploads');
}

function sessionDir(ctx: AppContext, id: Id): string {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) throw notFound('upload', id);
  return path.join(uploadsRoot(ctx), id);
}

const dataPath = (dir: string) => path.join(dir, 'data.part');
const sessionPath = (dir: string) => path.join(dir, 'session.json');

interface LiveHash {
  hash: Hash;
  bytes: number;
}

/** Incremental hash per live session, keyed by the session folder (absolute, so several apps in one process never mix). */
const liveHashes = new Map<string, LiveHash>();
/** Sessions with a chunk being written right now (one writer per session). */
const busy = new Set<string>();

function readSession(ctx: AppContext, id: Id): UploadSession {
  const dir = sessionDir(ctx, id);
  const file = sessionPath(dir);
  if (!existsSync(file)) throw notFound('upload', id);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as UploadSession;
  } catch {
    throw conflict('UPLOAD_CORRUPT', `Upload ${id} cannot be read; start it again`);
  }
}

function writeSession(ctx: AppContext, s: UploadSession): void {
  const dir = sessionDir(ctx, s.id);
  const tmp = path.join(dir, `session.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, sessionPath(dir));
}

function progressOf(ctx: AppContext, s: UploadSession): UploadProgress {
  return { id: s.id, receivedBytes: s.receivedBytes, bytes: s.bytes, status: s.status, chunkBytes: uploadLimits().chunkBytes };
}

/** Free bytes on the volume holding `dir` (undefined when the platform cannot tell). */
export function freeBytes(dir: string): number | undefined {
  try {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return undefined;
  }
}

/** Delete sessions whose last activity is older than 7 days (lazy; called by every uploads route). */
export function sweepExpiredUploads(ctx: AppContext, nowMs: number = Date.parse(ctx.now())): number {
  const root = uploadsRoot(ctx);
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const id of readdirSync(root)) {
    const dir = path.join(root, id);
    if (busy.has(dir)) continue;
    let updated = NaN;
    try {
      const s = JSON.parse(readFileSync(sessionPath(dir), 'utf8')) as UploadSession;
      updated = Date.parse(s.updatedAt);
    } catch {
      updated = NaN;
    }
    // no readable session.json (a session being created right now has none yet): left alone
    if (!Number.isFinite(updated) || nowMs - updated <= SESSION_TTL_MS) continue;
    rmSync(dir, { recursive: true, force: true });
    liveHashes.delete(dir);
    removed += 1;
  }
  return removed;
}

/** `POST /uploads`: validate, check free disk space, create the session folder. */
export function createUpload(ctx: AppContext, body: CreateUploadBody, actor: Actor): UploadProgress {
  sweepExpiredUploads(ctx);
  const limits = uploadLimits();
  if (body.purpose === 'evidence') {
    if (!body.claimId) throw new HttpError(400, 'VALIDATION', 'An evidence upload needs the claim it belongs to (claimId)');
    ctx.repos.requireClaim(ctx.db, body.claimId);
    parse(evidenceFields, body.fields ?? {});
    if (body.bytes > limits.maxEvidenceBytes) {
      throw new HttpError(413, 'FILE_TOO_LARGE', `This file is larger than the evidence limit of ${Math.round(limits.maxEvidenceBytes / MIB)} MB`, { limitBytes: limits.maxEvidenceBytes, bytes: body.bytes, useImportFolder: true });
    }
  } else if (body.claimId) {
    ctx.repos.requireClaim(ctx.db, body.claimId);
  }
  const root = uploadsRoot(ctx);
  mkdirSync(root, { recursive: true });
  const free = freeBytes(root);
  const needBytes = Math.ceil(body.bytes * FREE_SPACE_FACTOR);
  if (free !== undefined && free < needBytes) {
    throw new HttpError(507, 'INSUFFICIENT_STORAGE', 'There is not enough free disk space on this computer for this file', { needBytes, freeBytes: free });
  }
  const id = randomUUID();
  const dir = sessionDir(ctx, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(dataPath(dir), Buffer.alloc(0));
  const now = ctx.now();
  const session: UploadSession = {
    id,
    filename: safeFilename(body.filename),
    bytes: body.bytes,
    mime: body.mime?.trim() || 'application/octet-stream',
    purpose: body.purpose,
    claimId: body.claimId,
    fields: body.fields,
    receivedBytes: 0,
    status: 'receiving',
    createdAt: now,
    updatedAt: now,
    createdBy: actor.userId,
  };
  writeSession(ctx, session);
  liveHashes.set(dir, { hash: createHash('sha256'), bytes: 0 });
  return progressOf(ctx, session);
}

export function getUpload(ctx: AppContext, id: Id): UploadProgress {
  sweepExpiredUploads(ctx);
  return progressOf(ctx, readSession(ctx, id));
}

/** The live hash for a session, rebuilt by streaming data.part once when the process has restarted. */
async function liveHashFor(dir: string, receivedBytes: number): Promise<LiveHash> {
  const existing = liveHashes.get(dir);
  if (existing && existing.bytes === receivedBytes) return existing;
  const hash = createHash('sha256');
  if (receivedBytes > 0) {
    for await (const chunk of createReadStream(dataPath(dir), { start: 0, end: receivedBytes - 1, highWaterMark: MIB })) hash.update(chunk as Buffer);
  }
  const live = { hash, bytes: receivedBytes };
  liveHashes.set(dir, live);
  return live;
}

/**
 * `PUT /uploads/:id?offset=N`: append one raw chunk. `offset` must equal the bytes already received (else 409
 * OFFSET_MISMATCH with `receivedBytes`); a chunk larger than chunkBytes + 1 MiB is refused (413). The chunk is written
 * at `offset` and hashed into a copy of the live hash; only a complete chunk advances `receivedBytes`.
 */
export async function appendChunk(ctx: AppContext, id: Id, offset: number, stream: Readable, contentLength?: number): Promise<UploadProgress> {
  const dir = sessionDir(ctx, id);
  const drain = () => {
    stream.resume();
  };
  let session: UploadSession;
  try {
    session = readSession(ctx, id);
  } catch (err) {
    drain();
    throw err;
  }
  const limits = uploadLimits();
  const maxChunk = limits.chunkBytes + CHUNK_SLACK_BYTES;
  if (session.status === 'complete') {
    drain();
    throw conflict('UPLOAD_COMPLETE', `Upload ${id} is already complete`, { receivedBytes: session.receivedBytes });
  }
  if (offset !== session.receivedBytes) {
    drain();
    throw conflict('OFFSET_MISMATCH', `The server has ${session.receivedBytes} bytes of this upload; send from there`, { receivedBytes: session.receivedBytes });
  }
  if (contentLength !== undefined && contentLength > maxChunk) {
    drain();
    throw new HttpError(413, 'FILE_TOO_LARGE', `A chunk can be at most ${maxChunk} bytes`, { limitBytes: maxChunk, chunk: true });
  }
  if (contentLength !== undefined && session.receivedBytes + contentLength > session.bytes) {
    drain();
    throw new HttpError(400, 'UPLOAD_TOO_LONG', `This chunk would take the upload past its declared size of ${session.bytes} bytes`, { receivedBytes: session.receivedBytes, bytes: session.bytes });
  }
  if (busy.has(dir)) {
    drain();
    throw conflict('UPLOAD_BUSY', 'Another part of this upload is still being received', { receivedBytes: session.receivedBytes });
  }
  busy.add(dir);
  try {
    const live = await liveHashFor(dir, session.receivedBytes);
    const hash = live.hash.copy();
    let n = 0;
    let tooBig: HttpError | undefined;
    const out = createWriteStream(dataPath(dir), { flags: 'r+', start: offset });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        stream.unpipe(out);
        out.destroy();
        stream.resume();
        reject(err);
      };
      stream.on('data', (chunk: Buffer) => {
        n += chunk.length;
        if (n > maxChunk) {
          tooBig = new HttpError(413, 'FILE_TOO_LARGE', `A chunk can be at most ${maxChunk} bytes`, { limitBytes: maxChunk, chunk: true });
          fail(tooBig);
          return;
        }
        if (session.receivedBytes + n > session.bytes) {
          fail(new HttpError(400, 'UPLOAD_TOO_LONG', `This chunk would take the upload past its declared size of ${session.bytes} bytes`, { receivedBytes: session.receivedBytes, bytes: session.bytes }));
          return;
        }
        hash.update(chunk);
      });
      stream.on('error', fail);
      stream.on('aborted', () => fail(new HttpError(400, 'UPLOAD_ABORTED', 'The connection dropped part-way through this chunk; send it again')));
      out.on('error', fail);
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      stream.pipe(out);
    });
    // Request bodies that end early without an error still get here; the declared Content-Length is the arbiter.
    if (contentLength !== undefined && n !== contentLength) throw new HttpError(400, 'UPLOAD_ABORTED', 'The chunk arrived incomplete; send it again', { receivedBytes: session.receivedBytes });
    const fresh = readSession(ctx, id);
    fresh.receivedBytes = offset + n;
    fresh.updatedAt = ctx.now();
    writeSession(ctx, fresh);
    liveHashes.set(dir, { hash, bytes: fresh.receivedBytes });
    return progressOf(ctx, fresh);
  } finally {
    busy.delete(dir);
  }
}

export interface CompleteUploadResult {
  status: 200 | 201;
  body: Record<string, unknown>;
}

/**
 * `POST /uploads/:id/complete`: all bytes received → hash check → evidence (write-once store, deduped) or a staged
 * import. A repeated `complete` returns the same answer (the session keeps its result until it expires).
 */
export async function completeUpload(ctx: AppContext, id: Id, expectedSha256: string | undefined, actor: Actor): Promise<CompleteUploadResult> {
  const dir = sessionDir(ctx, id);
  const session = readSession(ctx, id);
  if (session.status === 'complete' && session.result) return repeatResult(ctx, session);
  if (busy.has(dir)) throw conflict('UPLOAD_BUSY', 'A part of this upload is still being received', { receivedBytes: session.receivedBytes });
  if (session.receivedBytes !== session.bytes) {
    throw conflict('UPLOAD_INCOMPLETE', `Only ${session.receivedBytes} of ${session.bytes} bytes have arrived`, { receivedBytes: session.receivedBytes, bytes: session.bytes });
  }
  busy.add(dir);
  try {
    const live = await liveHashFor(dir, session.receivedBytes);
    const sha256 = live.hash.copy().digest('hex');
    if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) {
      throw conflict('HASH_MISMATCH', `Device hash ${expectedSha256.toLowerCase()} does not match the uploaded bytes (${sha256})`, { expected: expectedSha256.toLowerCase(), actual: sha256 });
    }
    // a failed chunk may have left bytes past the end: cut the file to the declared size
    truncateSync(dataPath(dir), session.bytes);

    let result: UploadSession['result'];
    let response: CompleteUploadResult;
    if (session.purpose === 'evidence') {
      const claimId = session.claimId;
      if (!claimId) throw new HttpError(400, 'VALIDATION', 'An evidence upload needs a claimId');
      ctx.repos.requireClaim(ctx.db, claimId);
      const fields = parse(evidenceFields, session.fields ?? {});
      const staged = stageExistingFile(ctx, dataPath(dir), sha256, session.bytes);
      const stored: StoreEvidenceResult = await storeEvidence(ctx, { claimId, staged, filename: session.filename, mime: session.mime, fields, actor });
      result = { evidenceId: stored.evidence.id, deduped: stored.deduped, alsoOnClaims: stored.alsoOnClaims, sha256 };
      response = { status: stored.deduped ? 200 : 201, body: { ...stored.evidence, deduped: stored.deduped, alsoOnClaims: stored.alsoOnClaims } };
    } else {
      const claimRef = session.claimId ? ctx.repos.getClaim(ctx.db, session.claimId)?.reference : undefined;
      const named = path.join(dir, session.filename);
      renameSync(dataPath(dir), named);
      const imp: StagedImport = await stageImport(ctx, named, { purpose: session.purpose, source: 'upload', claimRef, filename: session.filename, mime: session.mime, sha256, bytes: session.bytes, actor });
      result = { importId: imp.id, sha256 };
      response = { status: 201, body: { importId: imp.id, import: imp, sha256 } };
    }
    const done = readSession(ctx, id);
    done.status = 'complete';
    done.result = result;
    done.updatedAt = ctx.now();
    writeSession(ctx, done);
    liveHashes.delete(dir);
    rmSync(dataPath(dir), { force: true });
    return response;
  } finally {
    busy.delete(dir);
  }
}

function repeatResult(ctx: AppContext, s: UploadSession): CompleteUploadResult {
  const r = s.result!;
  if (r.evidenceId) {
    const e = ctx.repos.requireEvidence(ctx.db, r.evidenceId);
    return { status: 200, body: { ...e, deduped: true, alsoOnClaims: r.alsoOnClaims ?? [] } };
  }
  return { status: 200, body: { importId: r.importId, sha256: r.sha256 } };
}

/** `DELETE /uploads/:id`: forget the session and its bytes. */
export function deleteUpload(ctx: AppContext, id: Id): void {
  const dir = sessionDir(ctx, id);
  if (!existsSync(dir)) throw notFound('upload', id);
  if (busy.has(dir)) throw conflict('UPLOAD_BUSY', 'A part of this upload is still being received');
  rmSync(dir, { recursive: true, force: true });
  liveHashes.delete(dir);
}

/** Test hook: drop every in-memory hash, as a restart would (they are rebuilt from data.part on the next chunk). */
export function forgetLiveUploadHashes(): void {
  liveHashes.clear();
}
