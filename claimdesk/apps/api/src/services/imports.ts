/**
 * The import folder (SUPREME-DESIGN §0.3 point 3, §K.6, §L.11; slice `uploads-desktop`).
 *
 *   <home>\inbox\{evidence,intake,mail,brain-packs,engineer-data}\    where the owner drops files of any size
 *   <DATA_DIR>\imports\<purpose>\<id>\<file> + manifest.json          a staged import (no database table)
 *
 * A dropped file is taken once its size and modification time have not changed for 10 seconds (tracked in memory),
 * moved (rename; copy + delete across volumes) into DATA_DIR\imports, hashed, and recorded as a *staged import*.
 * Other slices consume staged imports (mail ingests `.eml` files, intake reads documents, casework imports brain
 * packs, engineer mode reads data packs) and mark them consumed or failed. Files dropped into
 * `inbox\evidence\<CCG-YYYY-NNNNN>\` attach themselves to that claim as evidence; an unknown reference stays staged.
 *
 * Staged imports are bookkeeping, not evidence: their manifests change status. Evidence itself stays write-once.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { SYSTEM_ACTOR, type Actor } from '@ccguk/db';
import type { EvidenceKind, Id } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { enqueueJob } from '../agent/core.js';
import { hashFile, moveFile, safeFilename, stageExistingFile, storeEvidence, type StoreEvidenceResult } from './evidence.js';

export type ImportPurpose = 'evidence' | 'intake' | 'mail' | 'brain-packs' | 'engineer-data';

export interface StagedImport {
  id: string;
  purpose: ImportPurpose;
  filename: string;
  bytes: number;
  sha256: string;
  mime: string;
  receivedAt: string;
  source: 'folder' | 'upload';
  status: 'staged' | 'consumed' | 'failed';
  claimRef?: string;
  consumedBy?: string;
  consumedAt?: string;
  result?: unknown;
  error?: string;
}

export const IMPORT_PURPOSES: readonly ImportPurpose[] = ['evidence', 'intake', 'mail', 'brain-packs', 'engineer-data'];

/** A file is taken once its size and mtime have been unchanged for this long. */
export const STABLE_MS = 10_000;
/** The watcher's fallback poll. */
export const POLL_MS = 60_000;

const CLAIM_REF = /^CCG-\d{4}-\d{5}$/i;

/** `<home>\inbox`: CLAIMDESK_INBOX_DIR (set by the desktop launcher), else next to DATA_DIR. */
export function inboxDir(ctx: AppContext): string {
  const fromEnv = process.env.CLAIMDESK_INBOX_DIR?.trim();
  return fromEnv ? fromEnv : path.join(path.dirname(ctx.config.dataDir), 'inbox');
}

export function importsRoot(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'imports');
}

/** Create the inbox and its five subfolders (idempotent); returns the subfolder paths. */
export function ensureInbox(ctx: AppContext): Array<{ purpose: ImportPurpose; path: string }> {
  const root = inboxDir(ctx);
  return IMPORT_PURPOSES.map((purpose) => {
    const p = path.join(root, purpose);
    mkdirSync(p, { recursive: true });
    return { purpose, path: p };
  });
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

function importDir(ctx: AppContext, purpose: ImportPurpose, id: string): string {
  return path.join(importsRoot(ctx), purpose, id);
}

function findImportDir(ctx: AppContext, id: string): string | undefined {
  if (!ID_RE.test(id)) return undefined;
  for (const purpose of IMPORT_PURPOSES) {
    const dir = importDir(ctx, purpose, id);
    if (existsSync(path.join(dir, 'manifest.json'))) return dir;
  }
  return undefined;
}

function readManifest(dir: string): StagedImport | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as StagedImport;
  } catch {
    return undefined;
  }
}

function writeManifest(ctx: AppContext, imp: StagedImport): void {
  const dir = importDir(ctx, imp.purpose, imp.id);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `manifest.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(imp, null, 2));
  renameSync(tmp, path.join(dir, 'manifest.json'));
}

export function listStagedImports(ctx: AppContext, f: { purpose?: ImportPurpose; status?: StagedImport['status'] } = {}): StagedImport[] {
  const out: StagedImport[] = [];
  for (const purpose of f.purpose ? [f.purpose] : IMPORT_PURPOSES) {
    const base = path.join(importsRoot(ctx), purpose);
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const m = readManifest(path.join(base, id));
      if (!m) continue;
      if (f.status && m.status !== f.status) continue;
      out.push(m);
    }
  }
  return out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id));
}

export function getStagedImport(ctx: AppContext, id: string): StagedImport | undefined {
  const dir = findImportDir(ctx, id);
  return dir ? readManifest(dir) : undefined;
}

function requireImport(ctx: AppContext, id: string): StagedImport {
  const imp = getStagedImport(ctx, id);
  if (!imp) throw notFound('import', id);
  return imp;
}

/** Absolute path of the imported file (it may be gone once a consumer has moved it, e.g. into the evidence store). */
export function stagedImportPath(ctx: AppContext, id: string): string {
  const imp = requireImport(ctx, id);
  return path.join(importDir(ctx, imp.purpose, imp.id), imp.filename);
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  webp: 'image/webp',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
  cab: 'application/vnd.ms-cab-compressed',
};

export function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/** Evidence kind guessed from the MIME type (the owner can still attach it as something else). */
export function kindFromMime(mime: string): EvidenceKind {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'photo';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'call_recording';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'message/rfc822' || m === 'application/vnd.ms-outlook') return 'correspondence';
  return 'document';
}

export interface StageImportOptions {
  purpose: ImportPurpose;
  source: 'folder' | 'upload';
  claimRef?: string;
  /** Defaults to the source file's name. */
  filename?: string;
  /** Defaults to a guess from the file extension. */
  mime?: string;
  /** When the caller already hashed the bytes (a chunked upload), skip re-reading them. */
  sha256?: string;
  bytes?: number;
  actor?: Actor;
}

/** Move a file into `<DATA_DIR>/imports/<purpose>/<id>/` and record its manifest (audited `import.staged`). */
export async function stageImport(ctx: AppContext, srcPath: string, opts: StageImportOptions): Promise<StagedImport> {
  const id = randomUUID();
  const filename = safeFilename(opts.filename ?? path.basename(srcPath));
  const dir = importDir(ctx, opts.purpose, id);
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);
  moveFile(srcPath, dest);
  const bytes = statSync(dest).size;
  const sha256 = opts.sha256 && opts.bytes === bytes ? opts.sha256.toLowerCase() : await hashFile(dest);
  const imp: StagedImport = {
    id,
    purpose: opts.purpose,
    filename,
    bytes,
    sha256,
    mime: opts.mime?.trim() && opts.mime !== 'application/octet-stream' ? opts.mime.trim() : mimeFromFilename(filename),
    receivedAt: ctx.now(),
    source: opts.source,
    status: 'staged',
  };
  if (opts.claimRef) imp.claimRef = opts.claimRef.toUpperCase();
  writeManifest(ctx, imp);
  ctx.repos.appendAudit(ctx.db, {
    actor: opts.actor ?? SYSTEM_ACTOR,
    action: 'import.staged',
    entity: 'imports',
    entityId: id,
    after: { purpose: imp.purpose, filename, bytes, sha256, source: imp.source, claimRef: imp.claimRef ?? null },
    at: imp.receivedAt,
  });
  return imp;
}

export function stageImportFromFile(ctx: AppContext, srcPath: string, purpose: ImportPurpose, source: 'folder' | 'upload', claimRef?: string): Promise<StagedImport> {
  return stageImport(ctx, srcPath, { purpose, source, claimRef });
}

/** A consumer finished with the import. Idempotent for the same consumer; a different consumer gets 409. */
export function markImportConsumed(ctx: AppContext, id: string, consumedBy: string, result?: unknown): StagedImport {
  const imp = requireImport(ctx, id);
  if (imp.status === 'consumed') {
    if (imp.consumedBy === consumedBy) return imp;
    throw conflict('IMPORT_CONSUMED', `Import ${id} was already used by ${imp.consumedBy ?? 'another step'}`, { consumedBy: imp.consumedBy });
  }
  const next: StagedImport = { ...imp, status: 'consumed', consumedBy, consumedAt: ctx.now() };
  if (result !== undefined) next.result = result;
  delete next.error;
  writeManifest(ctx, next);
  return next;
}

export function markImportFailed(ctx: AppContext, id: string, error: string): StagedImport {
  const imp = requireImport(ctx, id);
  if (imp.status === 'consumed') throw conflict('IMPORT_CONSUMED', `Import ${id} was already used by ${imp.consumedBy ?? 'another step'}`, { consumedBy: imp.consumedBy });
  const next: StagedImport = { ...imp, status: 'failed', error: error.slice(0, 2000) };
  writeManifest(ctx, next);
  return next;
}

// ---------------------------------------------------------------------------
// Attach as evidence
// ---------------------------------------------------------------------------

export interface AttachResult extends StoreEvidenceResult {
  import: StagedImport;
}

/**
 * Store a staged import as evidence on a claim through the write-once store (deduped by hash) and mark the import
 * consumed by `evidence`. The bytes move into the evidence store; the manifest keeps the evidence id.
 */
export async function attachImportAsEvidence(ctx: AppContext, id: string, input: { claimId: Id; kind?: EvidenceKind; description?: string }, actor: Actor, auditAction = 'evidence.import_attach'): Promise<AttachResult> {
  const imp = requireImport(ctx, id);
  if (imp.status === 'consumed') throw conflict('IMPORT_CONSUMED', `Import ${id} was already used by ${imp.consumedBy ?? 'another step'}`, { consumedBy: imp.consumedBy, result: imp.result });
  const claim = ctx.repos.requireClaim(ctx.db, input.claimId);
  const file = path.join(importDir(ctx, imp.purpose, imp.id), imp.filename);
  if (!existsSync(file)) throw conflict('IMPORT_FILE_MISSING', `The file for import ${id} is no longer in the imports folder`);
  const staged = stageExistingFile(ctx, file, imp.sha256, imp.bytes);
  const kind = input.kind ?? kindFromMime(imp.mime);
  const stored = await storeEvidence(ctx, { claimId: claim.id, staged, filename: imp.filename, mime: imp.mime, fields: { kind, description: input.description }, actor });
  const consumed = markImportConsumed(ctx, id, 'evidence', { evidenceId: stored.evidence.id, claimId: claim.id, claimRef: claim.reference, deduped: stored.deduped });
  ctx.repos.appendAudit(ctx.db, {
    actor,
    action: auditAction,
    entity: 'evidence',
    entityId: stored.evidence.id,
    after: { importId: id, claimId: claim.id, claimRef: claim.reference, filename: imp.filename, sha256: imp.sha256, bytes: imp.bytes, kind, deduped: stored.deduped, source: imp.source },
    at: ctx.now(),
  });
  return { ...stored, import: consumed };
}

// ---------------------------------------------------------------------------
// Folder scan
// ---------------------------------------------------------------------------

interface Seen {
  size: number;
  mtimeMs: number;
  since: number;
}

/** Size/mtime observations per absolute path (the stability window). */
const seen = new Map<string, Seen>();

/** Partial downloads, Office lock files and hidden files are never taken. */
export function ignoredInboxName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~$') || /\.(tmp|part|partial|crdownload|download)$/i.test(name) || /^desktop\.ini$|^thumbs\.db$/i.test(name);
}

interface Candidate {
  abs: string;
  purpose: ImportPurpose;
  claimRef?: string;
}

function candidates(root: string, onUnread?: (abs: string, hint: string) => void): Candidate[] {
  const out: Candidate[] = [];
  for (const purpose of IMPORT_PURPOSES) {
    const dir = path.join(root, purpose);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (ignoredInboxName(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isFile()) out.push({ abs, purpose });
      else if (e.isDirectory() && (purpose === 'evidence' || (purpose === 'intake' && CLAIM_REF.test(e.name)))) {
        // inbox\evidence\<CCG-YYYY-NNNNN>\<file>: attach to that claim; inbox\intake\<CCG-YYYY-NNNNN>\<file>: read for that claim
        const ref = CLAIM_REF.test(e.name) ? e.name.toUpperCase() : undefined;
        let inner: import('node:fs').Dirent[];
        try {
          inner = readdirSync(abs, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const f of inner) if (f.isFile() && !ignoredInboxName(f.name)) out.push({ abs: path.join(abs, f.name), purpose, claimRef: ref });
      } else if (e.isDirectory()) {
        // Any other subfolder is not read: say so once (log + GET /imports/folder) instead of ignoring it silently.
        if (!unreadFolders.has(abs)) {
          unreadFolders.add(abs);
          onUnread?.(abs, `files must be directly in ${dir}${purpose === 'intake' ? ' (or in a folder named after a claim reference, e.g. CCG-2026-00001)' : ''}`);
        }
      }
    }
  }
  return out;
}

/** Subfolders of the inbox that are not read (shown on Settings > Import folder). */
const unreadFolders = new Set<string>();

export function unreadInboxFolders(ctx: AppContext): string[] {
  const root = inboxDir(ctx);
  return [...unreadFolders].filter((p) => p.startsWith(root + path.sep) && existsSync(p)).sort();
}

/**
 * One pass over the inbox: files whose size and mtime have been unchanged for ≥ 10 s are staged (and, for
 * `evidence\<ref>\`, attached to the claim). `nowMs` is injectable for tests. Returns the imports staged in this pass.
 */
export async function scanInboxOnce(ctx: AppContext, nowMs: number = Date.now()): Promise<StagedImport[]> {
  const root = inboxDir(ctx);
  ensureInbox(ctx);
  const found = candidates(root, (abs, hint) => ctx.logger.warn('imports: a folder in the inbox is not read', { folder: abs, hint }));
  const present = new Set(found.map((c) => c.abs));
  for (const k of [...seen.keys()]) if (k.startsWith(root + path.sep) && !present.has(k)) seen.delete(k);
  const staged: StagedImport[] = [];
  for (const c of found) {
    let st;
    try {
      st = statSync(c.abs);
    } catch {
      seen.delete(c.abs);
      continue;
    }
    const prev = seen.get(c.abs);
    if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
      seen.set(c.abs, { size: st.size, mtimeMs: st.mtimeMs, since: nowMs });
      continue;
    }
    if (nowMs - prev.since < STABLE_MS) continue;
    let imp: StagedImport;
    try {
      imp = await stageImport(ctx, c.abs, { purpose: c.purpose, source: 'folder', claimRef: c.claimRef });
    } catch (err) {
      // still locked by the program writing it (Windows) or removed meanwhile: try again on the next pass
      ctx.logger.warn('imports: could not take a file from the inbox yet', { file: c.abs, error: String(err) });
      seen.set(c.abs, { size: st.size, mtimeMs: st.mtimeMs, since: nowMs });
      continue;
    }
    seen.delete(c.abs);
    if (c.purpose === 'mail') {
      // §C.2: an .eml dropped in inbox\mail is ingested straight away (the 5-minute mail.sync sweep is the fallback);
      // the key is the one mail.sync uses, so the file is never queued twice.
      try {
        enqueueJob(ctx, { type: 'mail.ingest_file', payload: { importId: imp.id }, idempotencyKey: `mail.ingest_file:${imp.sha256}`, createdBy: 'agent:mail' });
      } catch (err) {
        ctx.logger.warn('imports: could not queue an inbox email for ingest; mail.sync will pick it up', { importId: imp.id, error: String(err) });
      }
    }
    if (c.purpose === 'evidence' && c.claimRef) {
      const claim = ctx.repos.getClaimByReference(ctx.db, c.claimRef);
      if (claim) {
        try {
          const r = await attachImportAsEvidence(ctx, imp.id, { claimId: claim.id, kind: kindFromMime(imp.mime) }, SYSTEM_ACTOR, 'evidence.import_folder');
          imp = r.import;
        } catch (err) {
          ctx.logger.warn('imports: could not attach an inbox file to its claim', { importId: imp.id, claimRef: c.claimRef, error: String(err) });
          imp = markImportFailed(ctx, imp.id, `Could not attach to ${c.claimRef}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    staged.push(imp);
  }
  return staged;
}

// ---------------------------------------------------------------------------
// Watcher (fs.watch + 60 s poll), started by the evidence route module when JOBS_ENABLED=true
// ---------------------------------------------------------------------------

export interface ImportWatcher {
  stop(): void;
}

export function startImportWatcher(ctx: AppContext, opts: { pollMs?: number } = {}): ImportWatcher {
  ensureInbox(ctx);
  const root = inboxDir(ctx);
  let running = false;
  let again = false;
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const run = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    scanInboxOnce(ctx)
      .then((items) => {
        if (items.length) ctx.logger.info('imports: files taken from the inbox', { count: items.length, ids: items.map((i) => i.id) });
        // something is still settling: look again once the stability window has passed
        if ([...seen.keys()].some((k) => k.startsWith(root + path.sep))) later(STABLE_MS + 500);
      })
      .catch((err) => ctx.logger.error('imports: inbox scan failed', { error: String(err) }))
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          run();
        }
      });
  };
  const later = (ms: number) => {
    if (stopped) return;
    const t = setTimeout(() => {
      timers.delete(t);
      run();
    }, ms);
    t.unref();
    timers.add(t);
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, () => later(1000));
    watcher.on('error', (err) => ctx.logger.warn('imports: folder watch stopped; polling continues', { error: String(err) }));
  } catch (err) {
    ctx.logger.warn('imports: folder watch unavailable; polling every minute', { error: String(err) });
  }
  const poll = setInterval(run, opts.pollMs ?? POLL_MS);
  poll.unref();
  run();
  ctx.logger.info('imports: watching the inbox', { inbox: root });
  return {
    stop: () => {
      stopped = true;
      clearInterval(poll);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      watcher?.close();
    },
  };
}

/** Test hook: forget the stability observations. */
export function resetInboxTracking(): void {
  seen.clear();
}
