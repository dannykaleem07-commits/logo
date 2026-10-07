import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { DEFAULT_LIMITS, isRetryable, planChunks, planUpload, progressText, resumeOffset, retryDelayMs, sizeText, uploadInChunks, type UploadLimits } from './uploads';

const MIB = 1024 * 1024;

describe('size messages', () => {
  it('formats sizes the way Windows shows them', () => {
    expect(sizeText(512)).toBe('512 bytes');
    expect(sizeText(900 * 1024)).toBe('900 KB');
    expect(sizeText(4.2 * MIB)).toBe('4.2 MB');
    expect(sizeText(31 * MIB)).toBe('31 MB');
    expect(sizeText(1.6 * 1024 * MIB)).toBe('1.6 GB');
    expect(sizeText(-1)).toBe('—');
  });

  it('describes progress', () => {
    expect(progressText(12 * MIB, 310 * MIB)).toBe('12 MB of 310 MB (3%)');
    expect(progressText(310 * MIB, 310 * MIB)).toBe('310 MB of 310 MB (100%)');
    expect(progressText(0, 0)).toBe('0 bytes of 0 bytes (100%)');
  });

  it('plans one upload, an upload in parts, or the import folder', () => {
    const limits: UploadLimits = { maxEvidenceBytes: 2048 * MIB, chunkThresholdBytes: 25 * MIB, chunkBytes: 8 * MIB };
    expect(planUpload(3 * MIB, limits)).toEqual({ mode: 'single', message: 'This file is 3 MB.', deviceHash: true });
    expect(planUpload(31 * MIB, limits)).toEqual({ mode: 'chunked', message: 'This file is 31 MB — it will upload in parts.', deviceHash: true });
    const big = planUpload(700 * MIB, limits);
    expect(big.mode).toBe('chunked');
    expect(big.deviceHash).toBe(false); // above 256 MiB the server's hash is shown after upload
    expect(big.message).toMatch(/^This file is 700 MB — it will upload in parts\. /);
    const huge = planUpload(3 * 1024 * MIB, limits);
    expect(huge.mode).toBe('too-large');
    expect(huge.message).toBe('This file is 3 GB — larger than the 2 GB limit for one upload. Put it in the ClaimDesk import folder instead (Settings → Import folder).');
    expect(planUpload(64 * MIB, DEFAULT_LIMITS).mode).toBe('single');
    expect(planUpload(64 * MIB + 1, DEFAULT_LIMITS).mode).toBe('chunked');
  });
});

describe('chunk plan', () => {
  it('cuts the file into chunkBytes pieces, the last one shorter', () => {
    expect(planChunks(20, 8)).toEqual([
      { index: 0, start: 0, end: 8 },
      { index: 1, start: 8, end: 16 },
      { index: 2, start: 16, end: 20 },
    ]);
    expect(planChunks(16, 8)).toHaveLength(2);
    expect(planChunks(0, 8)).toEqual([]);
  });
  it('resumes from the server offset, even mid-chunk', () => {
    expect(planChunks(20, 8, 8)).toEqual([
      { index: 1, start: 8, end: 16 },
      { index: 2, start: 16, end: 20 },
    ]);
    expect(planChunks(20, 8, 10)[0]).toEqual({ index: 1, start: 10, end: 18 });
    expect(planChunks(20, 8, 99)).toEqual([]);
    expect(() => planChunks(10, 0)).toThrow();
  });
});

describe('resume decisions', () => {
  it('trusts a sensible server offset, otherwise keeps ours', () => {
    expect(resumeOffset(8, 20, 16)).toBe(16);
    expect(resumeOffset(8, 20, 0)).toBe(0);
    expect(resumeOffset(8, 20, undefined)).toBe(8);
    expect(resumeOffset(8, 20, 25)).toBe(8);
    expect(resumeOffset(8, 20, 1.5)).toBe(8);
  });
  it('retries network errors and server hiccups, never refusals', () => {
    expect(isRetryable(new ApiError(0, 'NETWORK', 'down', '/api/x'))).toBe(true);
    expect(isRetryable(new ApiError(503, 'HTTP_503', 'busy', '/api/x'))).toBe(true);
    expect(isRetryable(new ApiError(413, 'FILE_TOO_LARGE', 'big', '/api/x'))).toBe(false);
    expect(isRetryable(new ApiError(507, 'INSUFFICIENT_STORAGE', 'full', '/api/x'))).toBe(true);
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryable(new Error('other'))).toBe(false);
  });
  it('backs off 1 s, 2 s, 4 s', () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000]);
    expect(retryDelayMs(10)).toBe(15000);
  });
});

/** A tiny in-memory chunked-upload server for the protocol tests. */
function fakeServer(opts: { failPutOnce?: number[]; loseAnswerOnce?: number[]; chunkBytes?: number } = {}) {
  const store = { received: new Uint8Array(0), bytes: 0, completed: false, deleted: false, puts: [] as number[], gets: 0, sha256: undefined as string | undefined, fields: undefined as unknown };
  const failOnce = new Set(opts.failPutOnce ?? []);
  const loseOnce = new Set(opts.loseAnswerOnce ?? []);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.pathname === '/api/uploads') {
      const b = JSON.parse(String(init?.body));
      store.bytes = b.bytes;
      store.fields = b.fields;
      return json(201, { uploadId: 'u1', chunkBytes: opts.chunkBytes ?? 4, receivedBytes: 0 });
    }
    if (method === 'PUT') {
      const offset = Number(url.searchParams.get('offset'));
      store.puts.push(offset);
      if (failOnce.has(offset)) {
        failOnce.delete(offset);
        throw new TypeError('Failed to fetch');
      }
      if (offset !== store.received.length) return json(409, { error: { code: 'OFFSET_MISMATCH', message: 'mismatch', details: { receivedBytes: store.received.length } } });
      const chunk = new Uint8Array(await (init?.body as Blob).arrayBuffer());
      const next = new Uint8Array(store.received.length + chunk.length);
      next.set(store.received);
      next.set(chunk, store.received.length);
      store.received = next;
      if (loseOnce.has(offset)) {
        loseOnce.delete(offset);
        throw new TypeError('connection reset'); // the chunk arrived, the answer did not
      }
      return json(200, { receivedBytes: store.received.length });
    }
    if (method === 'GET' && url.pathname === '/api/uploads/u1') {
      store.gets += 1;
      return json(200, { receivedBytes: store.received.length, bytes: store.bytes, status: 'receiving' });
    }
    if (method === 'POST' && url.pathname === '/api/uploads/u1/complete') {
      store.completed = true;
      store.sha256 = JSON.parse(String(init?.body)).sha256;
      return json(201, { id: 'ev1', sha256: 'f'.repeat(64), bytes: store.received.length });
    }
    if (method === 'DELETE') {
      store.deleted = true;
      return new Response(null, { status: 204 });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'no' } });
  }) as typeof fetch;
  return { store, fetchImpl };
}

const noSleep = async () => undefined;
const fileOf = (n: number, name = 'AUDATEX.cab') => new File([new Uint8Array(Array.from({ length: n }, (_, i) => i % 251))], name, { type: 'application/vnd.ms-cab-compressed' });

describe('uploadInChunks', () => {
  it('sends every chunk in order and completes (evidence)', async () => {
    const { store, fetchImpl } = fakeServer();
    const progress: number[] = [];
    const r = await uploadInChunks(fileOf(10), { purpose: 'evidence', claimId: 'c1', fields: { kind: 'document', sha256: 'a'.repeat(64), description: '' }, onProgress: (s) => progress.push(s) }, { fetch: fetchImpl, sleep: noSleep });
    expect(store.puts).toEqual([0, 4, 8]);
    expect(store.received).toEqual(new Uint8Array(Array.from({ length: 10 }, (_, i) => i % 251)));
    expect(store.completed).toBe(true);
    expect(store.sha256).toBe('a'.repeat(64));
    expect(store.fields).toEqual({ kind: 'document', sha256: 'a'.repeat(64) });
    expect((r.evidence as { id: string }).id).toBe('ev1');
    expect(progress).toEqual([0, 4, 8, 10, 10]);
  });

  it('after a network error asks the server how much arrived and carries on', async () => {
    const { store, fetchImpl } = fakeServer({ failPutOnce: [4] });
    await uploadInChunks(fileOf(10), { purpose: 'intake' }, { fetch: fetchImpl, sleep: noSleep });
    expect(store.puts).toEqual([0, 4, 4, 8]);
    expect(store.gets).toBe(1);
    expect(store.received.length).toBe(10);
  });

  it('does not resend a chunk whose answer was lost (the server already has it)', async () => {
    const { store, fetchImpl } = fakeServer({ loseAnswerOnce: [4] });
    const r = await uploadInChunks(fileOf(10), { purpose: 'engineer-data' }, { fetch: fetchImpl, sleep: noSleep });
    expect(store.puts).toEqual([0, 4, 8]);
    expect(store.received.length).toBe(10);
    expect(r.evidence).toBeUndefined();
  });

  it('gives up after three retries of the same chunk', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && String(input).endsWith('/api/uploads')) return new Response(JSON.stringify({ uploadId: 'u1', chunkBytes: 4, receivedBytes: 0 }), { status: 201, headers: { 'content-type': 'application/json' } });
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const delays: number[] = [];
    await expect(uploadInChunks(fileOf(10), { purpose: 'intake' }, { fetch: fetchImpl, sleep: async (ms) => void delays.push(ms) })).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('cancelling stops the upload and forgets the partial session', async () => {
    const { store, fetchImpl } = fakeServer();
    const ctrl = new AbortController();
    const p = uploadInChunks(fileOf(10), { purpose: 'intake', signal: ctrl.signal, onProgress: (s) => s >= 4 && ctrl.abort() }, { fetch: fetchImpl, sleep: noSleep });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(store.deleted).toBe(true);
    expect(store.completed).toBe(false);
  });
});
