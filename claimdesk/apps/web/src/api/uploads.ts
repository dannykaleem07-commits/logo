/**
 * Big uploads and the import folder (docs/SUPREME-DESIGN.md §0.3, §L.11; slice `uploads-desktop`).
 *
 * - `GET /limits` → how big one upload may be and when to switch to the chunked protocol.
 * - `uploadInChunks(file, …)`: the resumable protocol (`POST /uploads` → `PUT /uploads/:id?offset=N` raw chunks →
 *   `POST /uploads/:id/complete`). After a network error it asks the server how much arrived (`GET /uploads/:id`)
 *   and carries on from there; each chunk is retried 3 times with a growing pause.
 * - Pure helpers (unit-tested): the chunk plan, the resume decision, the plain-English size messages.
 * - The import folder: `GET /imports`, `GET /imports/folder`, `POST /imports/folder/open`, `POST /imports/:id/attach-evidence`.
 */
import type { Evidence, EvidenceKind, Id } from '@ccguk/domain';
import { ApiError, buildUrl, parseOverrideInfo, request } from './client';

export interface UploadLimits {
  maxEvidenceBytes: number;
  chunkThresholdBytes: number;
  chunkBytes: number;
}

const MIB = 1024 * 1024;

/** What the API answers when it cannot be reached (the 0.3 server has no /limits): the 0.4 defaults. */
export const DEFAULT_LIMITS: UploadLimits = { maxEvidenceBytes: 2048 * MIB, chunkThresholdBytes: 64 * MIB, chunkBytes: 8 * MIB };

/** Above this size the browser does not hash the file itself (the server's hash is authoritative and shown after). */
export const DEVICE_HASH_MAX_BYTES = 256 * MIB;

/** Retries per chunk after the first attempt. */
export const CHUNK_RETRIES = 3;

export type UploadPurpose = 'evidence' | 'intake' | 'brain-packs' | 'engineer-data';
export type ImportPurpose = UploadPurpose | 'mail';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** "31 MB", "4.2 MB", "1.6 GB", "900 KB" — binary units, as Windows Explorer shows them. */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / MIB;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, '') : Math.round(gb)} GB`;
}

export type UploadMode = 'single' | 'chunked' | 'too-large';

export interface UploadPlan {
  mode: UploadMode;
  /** Plain-English line for the dialog. */
  message: string;
  /** Hash the file in the browser before sending (only ≤ 256 MiB). */
  deviceHash: boolean;
}

/** How a file of `bytes` will be sent, and what to tell the owner. */
export function planUpload(bytes: number, limits: UploadLimits): UploadPlan {
  const size = sizeText(bytes);
  if (bytes > limits.maxEvidenceBytes) {
    return {
      mode: 'too-large',
      message: `This file is ${size} — larger than the ${sizeText(limits.maxEvidenceBytes)} limit for one upload. Put it in the ClaimDesk import folder instead (Settings → Import folder).`,
      deviceHash: false,
    };
  }
  const deviceHash = bytes <= DEVICE_HASH_MAX_BYTES;
  if (bytes > limits.chunkThresholdBytes) {
    return { mode: 'chunked', message: `This file is ${size} — it will upload in parts.${deviceHash ? '' : ' Its fingerprint (SHA-256) is worked out by ClaimDesk and shown when it has arrived.'}`, deviceHash };
  }
  return { mode: 'single', message: `This file is ${size}.`, deviceHash };
}

/** "12 MB of 310 MB (4%)" for the progress bar. */
export function progressText(sent: number, total: number): string {
  const pct = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 100;
  return `${sizeText(Math.min(sent, total))} of ${sizeText(total)} (${pct}%)`;
}

export interface ChunkRange {
  index: number;
  start: number;
  /** Exclusive. */
  end: number;
}

/** The chunks still to send from `fromOffset` (0 for a fresh upload, the server's receivedBytes when resuming). */
export function planChunks(totalBytes: number, chunkBytes: number, fromOffset = 0): ChunkRange[] {
  if (!(chunkBytes > 0)) throw new Error('chunkBytes must be positive');
  const out: ChunkRange[] = [];
  let start = Math.max(0, Math.min(fromOffset, totalBytes));
  let index = Math.floor(start / chunkBytes);
  while (start < totalBytes) {
    const end = Math.min(totalBytes, start + chunkBytes);
    out.push({ index, start, end });
    start = end;
    index += 1;
  }
  return out;
}

/** Pause before retry `attempt` (1-based): 1 s, 2 s, 4 s … capped at 15 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** Network failures and server hiccups are worth retrying; refusals (4xx other than 408/409/429) are not. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
  return err instanceof TypeError; // fetch's network error
}

/**
 * Where to carry on after a chunk failed: the server's `receivedBytes` (from `GET /uploads/:id` or an
 * OFFSET_MISMATCH refusal) when it is a sensible position, otherwise the offset we tried.
 */
export function resumeOffset(tried: number, totalBytes: number, serverReceived: number | undefined): number {
  if (typeof serverReceived === 'number' && Number.isInteger(serverReceived) && serverReceived >= 0 && serverReceived <= totalBytes) return serverReceived;
  return tried;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface UploadDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function errorFrom(res: Response, url: string): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  const e = (body as { error?: { code?: string; message?: string; details?: unknown; override?: unknown } } | undefined)?.error;
  if (e && typeof e.message === 'string') return new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message, url, e.details, parseOverrideInfo(e.override));
  return new ApiError(res.status, `HTTP_${res.status}`, typeof body === 'string' && body ? body.slice(0, 300) : `${res.status} request failed`, url, body);
}

async function call<T>(deps: UploadDeps, path: string, init: RequestInit): Promise<T> {
  const url = buildUrl(path);
  const f = deps.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await f(url, { credentials: 'same-origin', ...init, headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', `Cannot reach the ClaimDesk API (${(e as Error).message})`, url);
  }
  if (!res.ok) throw await errorFrom(res, url);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface ChunkedUploadOptions {
  purpose: UploadPurpose;
  claimId?: Id;
  /** Evidence text fields (kind, description, capturedAt, captureShot, sourceUrl, sha256). */
  fields?: Record<string, string | undefined>;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Override the server's chunk size (tests). */
  chunkBytes?: number;
}

export interface ChunkedUploadResult {
  /** The stored evidence (purpose `evidence`). */
  evidence?: unknown;
  /** The staged import (other purposes). */
  importId?: string;
  uploadId: string;
}

/** The body PUT for one chunk (a Blob slice; the browser streams it from disk). */
function slice(file: Blob, start: number, end: number): Blob {
  return file.slice(start, end);
}

/**
 * Send `file` with the resumable protocol. Resolves with the evidence (purpose `evidence`) or the staged import id.
 * A network error or a server hiccup on a chunk: wait (1 s, 2 s, 4 s), ask the server how much it has, carry on.
 */
export async function uploadInChunks(file: Blob & { name?: string }, opts: ChunkedUploadOptions, deps: UploadDeps = {}): Promise<ChunkedUploadResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const total = file.size;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.fields ?? {})) if (v !== undefined && v !== null && v !== '') fields[k] = String(v);
  const created = await call<{ uploadId: string; chunkBytes: number; receivedBytes: number }>(deps, '/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name || 'upload', bytes: total, mime: file.type || 'application/octet-stream', purpose: opts.purpose, claimId: opts.claimId, fields: Object.keys(fields).length ? fields : undefined }),
    signal: opts.signal,
  });
  const id = created.uploadId;
  const chunkBytes = opts.chunkBytes ?? created.chunkBytes;
  let offset = created.receivedBytes ?? 0;
  opts.onProgress?.(offset, total);
  try {
    while (offset < total) {
      const end = Math.min(total, offset + chunkBytes);
      let attempt = 0;
      for (;;) {
        if (opts.signal?.aborted) throw new DOMException('The upload was cancelled', 'AbortError');
        try {
          const r = await call<{ receivedBytes: number }>(deps, `/uploads/${encodeURIComponent(id)}?offset=${offset}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: slice(file, offset, end),
            signal: opts.signal,
          });
          offset = resumeOffset(end, total, r.receivedBytes);
          break;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          if (err instanceof ApiError && err.code === 'OFFSET_MISMATCH') {
            // the server already has a different amount (a retry after a lost answer): go from there
            attempt += 1;
            if (attempt > CHUNK_RETRIES) throw err;
            offset = resumeOffset(offset, total, (err.details as { receivedBytes?: number } | undefined)?.receivedBytes);
            break;
          }
          if (!isRetryable(err) || attempt >= CHUNK_RETRIES) throw err;
          attempt += 1;
          await sleep(retryDelayMs(attempt));
          try {
            const state = await call<{ receivedBytes: number }>(deps, `/uploads/${encodeURIComponent(id)}`, { method: 'GET', signal: opts.signal });
            const next = resumeOffset(offset, total, state.receivedBytes);
            if (next !== offset) {
              offset = next;
              break;
            }
          } catch (probe) {
            if (probe instanceof DOMException && probe.name === 'AbortError') throw probe;
            /* the server is still unreachable: the retry below will say so */
          }
        }
      }
      opts.onProgress?.(offset, total);
    }
    const body: { sha256?: string } = {};
    if (fields.sha256) body.sha256 = fields.sha256;
    const done = await call<Record<string, unknown>>(deps, `/uploads/${encodeURIComponent(id)}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: opts.signal });
    opts.onProgress?.(total, total);
    if (opts.purpose === 'evidence') return { evidence: done, uploadId: id };
    return { importId: typeof done.importId === 'string' ? done.importId : undefined, uploadId: id };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // cancelled by the owner: forget the partial upload (best effort)
      void call(deps, `/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Limits and the import folder
// ---------------------------------------------------------------------------

export async function getUploadLimits(signal?: AbortSignal): Promise<UploadLimits> {
  try {
    const r = await request<Partial<UploadLimits>>('/limits', { method: 'GET', signal });
    return {
      maxEvidenceBytes: typeof r?.maxEvidenceBytes === 'number' ? r.maxEvidenceBytes : DEFAULT_LIMITS.maxEvidenceBytes,
      chunkThresholdBytes: typeof r?.chunkThresholdBytes === 'number' ? r.chunkThresholdBytes : DEFAULT_LIMITS.chunkThresholdBytes,
      chunkBytes: typeof r?.chunkBytes === 'number' ? r.chunkBytes : DEFAULT_LIMITS.chunkBytes,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return DEFAULT_LIMITS;
  }
}

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

export interface ImportFolderInfo {
  path: string;
  subfolders: Array<{ purpose: ImportPurpose; path: string }>;
  watching?: boolean;
}

export const IMPORT_PURPOSE_LABEL: Record<ImportPurpose, string> = {
  evidence: 'Evidence',
  intake: 'Read into a claim',
  mail: 'Email',
  'brain-packs': 'Brain pack',
  'engineer-data': 'Engineer data',
};

export const IMPORT_STATUS_LABEL: Record<StagedImport['status'], string> = { staged: 'Waiting', consumed: 'Done', failed: 'Problem' };

export const uploadsApi = {
  limits: getUploadLimits,
  listImports: async (q: { purpose?: ImportPurpose; status?: StagedImport['status']; limit?: number } = {}, signal?: AbortSignal) =>
    (await request<{ items: StagedImport[]; total: number }>('/imports', { method: 'GET', query: q, signal })).items ?? [],
  importFolder: (signal?: AbortSignal) => request<ImportFolderInfo>('/imports/folder', { method: 'GET', signal }),
  openImportFolder: () => request<{ opened: boolean; path: string }>('/imports/folder/open', { method: 'POST', body: {} }),
  attachImport: (id: string, body: { claimId: Id; kind?: EvidenceKind; description?: string }) =>
    request<Evidence & { deduped: boolean; importId: string }>(`/imports/${encodeURIComponent(id)}/attach-evidence`, { method: 'POST', body }),
};
