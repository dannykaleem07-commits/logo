// owned by intake-web
/**
 * Upload queue for case bundles (docs/SMART-INTAKE.md §11.3). The owner drops files or whole folders; the queue sends
 * them to `POST /intake/bundles/:id/files`:
 *
 *  - small files in batches of at most 10 per multipart request (each file at most the chunk threshold, 64 MiB);
 *  - larger files through the resumable upload (purpose `intake`) and then `{uploadId}`;
 *  - files above the server's limit are refused with a message pointing at the import folder
 *    (`inbox\intake\<bundle name>\`);
 *  - at most 2 requests at a time; a failed request can be retried file by file.
 *
 * The queue outlives the page that started it (the New bundle page hands it to the bundle page), so queues are kept in
 * a module-level registry keyed by bundle id. Transport is injected (tests never touch the network).
 */
import { ApiError, buildUrl, parseOverrideInfo } from '../../../api/client';
import { bundlesApi, type AddFilesResult } from '../../../api/bundlesApi';
import { DEFAULT_LIMITS, getUploadLimits, planUpload, uploadInChunks, type UploadLimits } from '../../../api/uploads';

export const MAX_FILES_PER_REQUEST = 10;
export const MAX_CONCURRENT_REQUESTS = 2;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Files that are never sent: hidden files, macOS resource forks and Windows folder litter. */
export function isSkippableName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  if (!base) return true;
  if (base.startsWith('.')) return true;
  const lower = base.toLowerCase();
  return lower === 'thumbs.db' || lower === 'desktop.ini' || lower === '__macosx';
}

export interface UploadPlanResult<F extends { name: string; size: number }> {
  /** Multipart batches (each ≤ 10 files, each file ≤ the chunk threshold). */
  batches: F[][];
  /** Files that go up in parts first. */
  chunked: F[];
  /** Files over the limit, with the message to show. */
  refused: Array<{ file: F; message: string }>;
}

/** Split files into multipart batches, chunked uploads and refusals (order kept). */
export function planBundleUpload<F extends { name: string; size: number }>(files: F[], limits: UploadLimits, folderHint: string): UploadPlanResult<F> {
  const batches: F[][] = [];
  const chunked: F[] = [];
  const refused: Array<{ file: F; message: string }> = [];
  let current: F[] = [];
  for (const f of files) {
    const plan = planUpload(f.size, limits);
    if (plan.mode === 'too-large') {
      refused.push({ file: f, message: `${f.name} is too large to upload here. Put it in the import folder ${folderHint} and it joins this bundle.` });
    } else if (plan.mode === 'chunked') {
      chunked.push(f);
    } else {
      current.push(f);
      if (current.length === MAX_FILES_PER_REQUEST) {
        batches.push(current);
        current = [];
      }
    }
  }
  if (current.length) batches.push(current);
  return { batches, chunked, refused };
}

/** `inbox\intake\<name>\` — where very large files for this bundle go (Windows path style, as the owner sees it). */
export function importFolderHint(bundleName: string): string {
  const safe = bundleName.replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim() || 'bundle';
  return `inbox\\intake\\${safe}\\`;
}

// ---------------------------------------------------------------------------
// Folder walking (drag and drop of folders)
// ---------------------------------------------------------------------------

/** The parts of the File and Directory Entries API the walker uses (a stand-in is enough in tests). */
export interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, fail?: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: EntryLike[]) => void, fail?: (e: unknown) => void) => void };
}

function readAll(dir: EntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader?.();
  if (!reader) return Promise.resolve([]);
  const out: EntryLike[] = [];
  // readEntries returns at most ~100 entries per call: keep reading until it returns none.
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries(
        (batch) => {
          if (!batch.length) resolve(out);
          else {
            out.push(...batch);
            next();
          }
        },
        (e) => reject(e),
      );
    next();
  });
}

function fileOf(entry: EntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) return resolve(null);
    entry.file(
      (f) => resolve(f),
      () => resolve(null),
    );
  });
}

/** Walk dropped entries (files and folders, recursively), skipping hidden files, Thumbs.db and desktop.ini. */
export async function walkEntries(entries: EntryLike[], depth = 0): Promise<File[]> {
  const out: File[] = [];
  for (const e of entries) {
    if (isSkippableName(e.name)) continue;
    if (e.isFile) {
      const f = await fileOf(e);
      if (f && !isSkippableName(f.name)) out.push(f);
    } else if (e.isDirectory && depth < 16) {
      out.push(...(await walkEntries(await readAll(e).catch(() => []), depth + 1)));
    }
  }
  return out;
}

/** Files from a drop: folders are walked when the browser offers entries, else the plain file list is used. */
export async function filesFromDataTransfer(dt: Pick<DataTransfer, 'items' | 'files'> | null): Promise<File[]> {
  if (!dt) return [];
  const items = dt.items ? Array.from(dt.items) : [];
  const entries: EntryLike[] = [];
  for (const it of items) {
    const getter = (it as DataTransferItem & { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry;
    const entry = it.kind === 'file' && typeof getter === 'function' ? (getter.call(it) as EntryLike | null) : null;
    if (entry) entries.push(entry);
  }
  if (entries.length) return walkEntries(entries);
  return Array.from(dt.files ?? []).filter((f) => !isSkippableName(f.name));
}

/** Files from an `<input type=file>` (with or without `webkitdirectory`). */
export function filesFromInput(list: FileList | null): File[] {
  return Array.from(list ?? []).filter((f) => !isSkippableName((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name));
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export type UploadRowStatus = 'queued' | 'uploading' | 'sent' | 'failed' | 'refused';

export interface UploadRow {
  key: string;
  name: string;
  size: number;
  status: UploadRowStatus;
  sent: number;
  /** The bundle file id once the server has it. */
  fileId: string | null;
  outcome: 'added' | 'already_in_bundle' | null;
  error: string | null;
}

export interface UploadTransport {
  limits: () => Promise<UploadLimits>;
  /** One multipart request with ≤ 10 files; `onProgress(sentBytes)` covers the whole request body. */
  sendBatch: (bundleId: string, files: File[], onProgress: (sent: number, total: number) => void) => Promise<AddFilesResult>;
  /** Resumable upload, then `{uploadId}`. */
  sendChunked: (bundleId: string, file: File, onProgress: (sent: number, total: number) => void) => Promise<AddFilesResult>;
}

/** Multipart POST with upload progress (XMLHttpRequest); falls back to fetch where XHR is missing. */
function xhrSendBatch(bundleId: string, files: File[], onProgress: (sent: number, total: number) => void): Promise<AddFilesResult> {
  if (typeof XMLHttpRequest === 'undefined') return bundlesApi.addFiles(bundleId, files);
  const url = buildUrl(`/intake/bundles/${encodeURIComponent(bundleId)}/files`);
  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Cannot reach the ClaimDesk API', url));
    xhr.onload = () => {
      let body: unknown;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as AddFilesResult);
      const err = (body as { error?: { code?: string; message?: string; details?: unknown; override?: unknown } } | undefined)?.error;
      reject(new ApiError(xhr.status, err?.code ?? `HTTP_${xhr.status}`, err?.message ?? `${xhr.status} upload refused`, url, err?.details, parseOverrideInfo(err?.override)));
    };
    xhr.send(fd);
  });
}

export const defaultTransport: UploadTransport = {
  limits: () => getUploadLimits().catch(() => DEFAULT_LIMITS),
  sendBatch: xhrSendBatch,
  sendChunked: async (bundleId, file, onProgress) => {
    const r = await uploadInChunks(file, { purpose: 'intake', onProgress });
    return bundlesApi.addFromUpload(bundleId, r.uploadId);
  },
};

type Job = { kind: 'batch'; keys: string[] } | { kind: 'chunked'; key: string };

let seq = 0;

export class UploadQueue {
  readonly bundleId: string;
  private bundleName: string;
  private transport: UploadTransport;
  private rows: UploadRow[] = [];
  private files = new Map<string, File>();
  private jobs: Job[] = [];
  private running = 0;
  private listeners = new Set<() => void>();
  private snapshot: readonly UploadRow[] = [];
  private onServerChange: (() => void) | null = null;

  constructor(bundleId: string, bundleName: string, transport: UploadTransport = defaultTransport) {
    this.bundleId = bundleId;
    this.bundleName = bundleName;
    this.transport = transport;
  }

  /** Called after every request that added files (the page refreshes the bundle). */
  setOnServerChange(fn: (() => void) | null): void {
    this.onServerChange = fn;
  }

  setBundleName(name: string): void {
    this.bundleName = name;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): readonly UploadRow[] => this.snapshot;

  /** Requests in flight (for tests and the "uploading" header). */
  get active(): number {
    return this.running;
  }

  get busy(): boolean {
    return this.running > 0 || this.jobs.length > 0;
  }

  private emit(): void {
    this.snapshot = this.rows.map((r) => ({ ...r }));
    for (const l of this.listeners) l();
  }

  private patch(key: string, p: Partial<UploadRow>): void {
    const r = this.rows.find((x) => x.key === key);
    if (r) Object.assign(r, p);
  }

  /** Queue files. Resolves once the plan is made (sending continues in the background). */
  async add(files: File[]): Promise<void> {
    const usable = files.filter((f) => !isSkippableName(f.name));
    if (!usable.length) return;
    const limits = await this.transport.limits();
    const plan = planBundleUpload(usable, limits, importFolderHint(this.bundleName));
    const keyOf = new Map<File, string>();
    for (const f of usable) {
      const key = `u${++seq}`;
      keyOf.set(f, key);
      this.files.set(key, f);
      this.rows.push({ key, name: f.name, size: f.size, status: 'queued', sent: 0, fileId: null, outcome: null, error: null });
    }
    for (const r of plan.refused) this.patch(keyOf.get(r.file)!, { status: 'refused', error: r.message });
    for (const batch of plan.batches) this.jobs.push({ kind: 'batch', keys: batch.map((f) => keyOf.get(f)!) });
    for (const f of plan.chunked) this.jobs.push({ kind: 'chunked', key: keyOf.get(f)! });
    this.emit();
    this.pump();
  }

  /** Send a failed file again (on its own). */
  retry(key: string): void {
    const row = this.rows.find((r) => r.key === key);
    const file = this.files.get(key);
    if (!row || !file || row.status !== 'failed') return;
    row.status = 'queued';
    row.error = null;
    row.sent = 0;
    void this.transport.limits().then((limits) => {
      const plan = planUpload(file.size, limits);
      this.jobs.push(plan.mode === 'chunked' ? { kind: 'chunked', key } : { kind: 'batch', keys: [key] });
      this.emit();
      this.pump();
    });
    this.emit();
  }

  /** Remove finished rows from the list. */
  clearFinished(): void {
    this.rows = this.rows.filter((r) => r.status === 'queued' || r.status === 'uploading' || r.status === 'failed');
    this.emit();
  }

  /** Resolves when nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 5));
  }

  private pump(): void {
    while (this.running < MAX_CONCURRENT_REQUESTS && this.jobs.length) {
      const job = this.jobs.shift()!;
      this.running += 1;
      void this.run(job).finally(() => {
        this.running -= 1;
        this.emit();
        this.pump();
      });
    }
  }

  private applyResult(keys: string[], result: AddFilesResult): void {
    // Match results to rows by filename (in order); anything unmatched is still marked sent.
    const pool = [...result.files];
    for (const key of keys) {
      const row = this.rows.find((r) => r.key === key)!;
      const i = pool.findIndex((f) => f.filename === row.name);
      const hit = i >= 0 ? pool.splice(i, 1)[0] : pool.shift();
      Object.assign(row, { status: 'sent', sent: row.size, fileId: hit?.fileId ?? null, outcome: hit?.outcome ?? 'added', error: null });
    }
  }

  private async run(job: Job): Promise<void> {
    const keys = job.kind === 'batch' ? job.keys : [job.key];
    for (const k of keys) this.patch(k, { status: 'uploading', sent: 0 });
    this.emit();
    try {
      if (job.kind === 'batch') {
        const files = keys.map((k) => this.files.get(k)!);
        const sizes = files.map((f) => f.size);
        const total = sizes.reduce((a, b2) => a + b2, 0) || 1;
        const result = await this.transport.sendBatch(this.bundleId, files, (sent, all) => {
          // spread the request's progress over its files in order
          let left = (sent / (all || total)) * total;
          keys.forEach((k, i) => {
            const part = Math.max(0, Math.min(sizes[i]!, left));
            left -= part;
            this.patch(k, { sent: part });
          });
          this.emit();
        });
        this.applyResult(keys, result);
      } else {
        const file = this.files.get(job.key)!;
        const result = await this.transport.sendChunked(this.bundleId, file, (sent) => {
          this.patch(job.key, { sent });
          this.emit();
        });
        this.applyResult(keys, result);
      }
      this.onServerChange?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const k of keys) this.patch(k, { status: 'failed', error: message });
    }
  }
}

const registry = new Map<string, UploadQueue>();

/** The queue for a bundle (created on first use; kept while the app is open). */
export function uploadQueueFor(bundleId: string, bundleName = '', transport?: UploadTransport): UploadQueue {
  let q = registry.get(bundleId);
  if (!q) {
    q = new UploadQueue(bundleId, bundleName, transport);
    registry.set(bundleId, q);
  } else if (bundleName) q.setBundleName(bundleName);
  return q;
}

/** The queue if one exists (the bundle page shows upload rows only when files were sent from this window). */
export function existingUploadQueue(bundleId: string): UploadQueue | undefined {
  return registry.get(bundleId);
}

/** Tests: drop every queue. */
export function resetUploadQueues(): void {
  registry.clear();
}

/** Upload percentage of a row (0–100). */
export function rowPercent(r: Pick<UploadRow, 'sent' | 'size' | 'status'>): number {
  if (r.status === 'sent') return 100;
  if (!r.size) return 0;
  return Math.max(0, Math.min(100, Math.floor((r.sent / r.size) * 100)));
}
