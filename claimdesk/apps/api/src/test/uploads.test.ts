/**
 * Big uploads (SUPREME-DESIGN §0.3, §R.2 point 1; slice `uploads-desktop`): the evidence route's own limit, the
 * content-length pre-check, streaming storage, truncated streams leaving nothing behind, resumable chunked uploads
 * (abort at 40 % → resume → evidence), offset mismatch, staged imports from an upload, GET /limits.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { forgetLiveUploadHashes, uploadLimits, uploadsRoot } from '../services/uploads.js';
import { absoluteEvidencePath, clearVerifyCache, isoBmffSafeForExif } from '../services/evidence.js';
import { makePng } from '../seed/png.js';

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };
const MIB = 1024 * 1024;

let t: TestApp;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z');
});
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  await t.close();
});

function seedClaim(): string {
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  return ids.claimId;
}

/** Deterministic pseudo-random bytes (fast, no allocation of the whole file). */
function block(seed: number, size: number): Buffer {
  const b = Buffer.allocUnsafe(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 4) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b.writeUInt32LE(x >>> 0, i);
  }
  return b;
}

/** A multipart body streamed from a generator: fields, then `fileBytes` of generated data. `cutAt` ends the stream early (no closing boundary). */
function multipartStream(opts: { fields?: Record<string, string>; filename: string; mime: string; fileBytes: number; cutAt?: number }): { stream: Readable; boundary: string; sha256: Promise<string> } {
  const boundary = `----claimdeskbig${Date.now()}`;
  const hash = createHash('sha256');
  let resolveSha!: (s: string) => void;
  const sha256 = new Promise<string>((r) => (resolveSha = r));
  const pre: Buffer[] = [];
  for (const [k, v] of Object.entries(opts.fields ?? {})) pre.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  pre.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename}"\r\nContent-Type: ${opts.mime}\r\n\r\n`));
  const blockSize = 4 * MIB;
  const base = block(7, blockSize);
  async function* gen() {
    yield Buffer.concat(pre);
    let sent = 0;
    let i = 0;
    const limit = opts.cutAt ?? opts.fileBytes;
    while (sent < limit) {
      const n = Math.min(blockSize, limit - sent);
      // vary each block so the hash covers position too
      const chunk = Buffer.from(base.subarray(0, n));
      chunk.writeUInt32LE(i++, 0);
      hash.update(chunk);
      sent += n;
      yield chunk;
    }
    resolveSha(hash.digest('hex'));
    if (opts.cutAt === undefined) yield Buffer.from(`\r\n--${boundary}--\r\n`);
  }
  return { stream: Readable.from(gen()), boundary, sha256 };
}

function incomingFiles(): string[] {
  const dir = path.join(t.ctx.config.evidenceDir, '.incoming');
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('GET /limits', () => {
  it('reports the defaults and follows the environment', async () => {
    setEnv('MAX_EVIDENCE_UPLOAD_MB', undefined);
    setEnv('CHUNK_THRESHOLD_MB', undefined);
    setEnv('CHUNK_MB', undefined);
    const res = await t.api<{ maxEvidenceBytes: number; chunkThresholdBytes: number; chunkBytes: number }>('GET', '/limits');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ maxEvidenceBytes: 2048 * MIB, chunkThresholdBytes: 64 * MIB, chunkBytes: 8 * MIB });
    setEnv('MAX_EVIDENCE_UPLOAD_MB', '100');
    setEnv('CHUNK_MB', '4');
    setEnv('CHUNK_THRESHOLD_MB', 'nonsense');
    expect(uploadLimits()).toEqual({ maxEvidenceBytes: 100 * MIB, chunkThresholdBytes: 64 * MIB, chunkBytes: 4 * MIB });
  });
});

describe('multipart evidence upload (per-route limit)', () => {
  it('stores a 100 MiB file streamed through multipart (past the global 25 MiB limit) and the sha256 matches', async () => {
    const claimId = seedClaim();
    const body = multipartStream({ fields: { kind: 'document', description: 'Audatex data' }, filename: 'AUDATEX.cab', mime: 'application/vnd.ms-cab-compressed', fileBytes: 100 * MIB });
    const res = await t.app.inject({ method: 'POST', url: `/api/claims/${claimId}/evidence`, payload: body.stream, headers: { 'content-type': `multipart/form-data; boundary=${body.boundary}` } });
    expect(res.statusCode, res.body).toBe(201);
    const ev = res.json() as { id: string; sha256: string; bytes: number; exif?: unknown };
    expect(ev.bytes).toBe(100 * MIB);
    expect(ev.sha256).toBe(await body.sha256);
    expect(ev.exif).toBeUndefined();
    expect(incomingFiles()).toEqual([]);
    // the file route streams the verified bytes back
    const file = await t.app.inject({ method: 'GET', url: `/api/evidence/${ev.id}/file` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-length']).toBe(String(100 * MIB));
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(ev.sha256);
    const verify = await t.api<{ status: string }>('POST', `/evidence/${ev.id}/verify`);
    expect(verify.body.status).toBe('intact');
  }, 120_000);

  it('still reads EXIF / PNG dimensions for small images (from the staged file)', async () => {
    const claimId = seedClaim();
    const png = makePng({ seed: 5 });
    const boundary = '----claimdeskpng';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nphoto\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await t.app.inject({ method: 'POST', url: `/api/claims/${claimId}/evidence`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { exif?: { widthPx?: number } }).exif?.widthPx).toBe(64);
  });

  it('refuses a body over the evidence limit at once from Content-Length (413 FILE_TOO_LARGE, useImportFolder — chunked has the same limit)', async () => {
    const claimId = seedClaim();
    setEnv('MAX_EVIDENCE_UPLOAD_MB', '1');
    const before = t.ctx.repos.listEvidenceForClaim(t.ctx.db, claimId, {}).length;
    const boundary = '----claimdeskcl';
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), randomBytes(3 * MIB), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await t.app.inject({ method: 'POST', url: `/api/claims/${claimId}/evidence`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(res.statusCode).toBe(413);
    const err = (res.json() as ErrorBody).error;
    expect(err.code).toBe('FILE_TOO_LARGE');
    expect(err.details).toMatchObject({ limitBytes: MIB, useImportFolder: true });
    expect(err.details).not.toHaveProperty('useChunked');
    expect(t.ctx.repos.listEvidenceForClaim(t.ctx.db, claimId, {}).length).toBe(before);
  });

  it('refuses a streamed body (no Content-Length) that passes the limit: 413, no row, no temp file', async () => {
    const claimId = seedClaim();
    setEnv('MAX_EVIDENCE_UPLOAD_MB', '1');
    const before = t.ctx.repos.listEvidenceForClaim(t.ctx.db, claimId, {}).length;
    const body = multipartStream({ filename: 'big.bin', mime: 'application/octet-stream', fileBytes: 3 * MIB });
    const res = await t.app.inject({ method: 'POST', url: `/api/claims/${claimId}/evidence`, payload: body.stream, headers: { 'content-type': `multipart/form-data; boundary=${body.boundary}` } });
    expect(res.statusCode).toBe(413);
    expect((res.json() as ErrorBody).error.code).toBe('FILE_TOO_LARGE');
    expect((res.json() as ErrorBody).error.details).toMatchObject({ limitBytes: MIB, useImportFolder: true });
    expect(t.ctx.repos.listEvidenceForClaim(t.ctx.db, claimId, {}).length).toBe(before);
    expect(incomingFiles()).toEqual([]);
  });

  it('a stream that ends part-way leaves no evidence row and no temp file in .incoming', async () => {
    const claimId = seedClaim();
    const before = t.ctx.repos.listEvidenceForClaim(t.ctx.db, claimId, {}).length;
    const body = multipartStream({ fields: { kind: 'document' }, filename: 'cut.bin', mime: 'application/octet-stream', fileBytes: 6 * MIB, cutAt: 5 * MIB });
    const res = await t.app.inject({ method: 'POST', url: `/api/claims/${claimId}/evidence`, payload: body.stream, headers: { 'content-type': `multipart/form-data; boundary=${body.boundary}` } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(t.ctx.repos.listEvidenceForClaim(t.ctx.db, claimId, {}).length).toBe(before);
    expect(incomingFiles()).toEqual([]);
  });

  it('other multipart routes keep their own limits: a 26 MiB Word template is still 413', async () => {
    const boundary = '----claimdeskdocx';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nBig\r\n--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nform\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.docx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`),
      Buffer.alloc(26 * MIB, 1),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await t.app.inject({ method: 'POST', url: '/api/docx-templates', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(res.statusCode).toBe(413);
  }, 60_000);
});

describe('estimate import from a stored text evidence (16 MiB, verified, async)', () => {
  async function textEvidence(claimId: string, bytes: number, content?: string): Promise<{ id: string; storagePath: string }> {
    const body = content !== undefined
      ? (() => {
          const boundary = '----est-boundary';
          const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nestimate\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="est.txt"\r\nContent-Type: text/plain\r\n\r\n`), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]);
          return { payload, boundary };
        })()
      : (() => {
          const m = multipartStream({ fields: { kind: 'estimate' }, filename: 'est.txt', mime: 'text/plain', fileBytes: bytes });
          return { payload: m.stream, boundary: m.boundary };
        })();
    const res = await t.app.inject({ method: 'POST', url: `/api/claims/${claimId}/evidence`, payload: body.payload, headers: { 'content-type': `multipart/form-data; boundary=${body.boundary}` } });
    expect(res.statusCode, res.body).toBe(201);
    const ev = res.json() as { id: string };
    return { id: ev.id, storagePath: t.ctx.repos.requireEvidence(t.ctx.db, ev.id).storagePath };
  }

  it('a 17 MiB text evidence is refused with 413 before it is read', async () => {
    const claimId = seedClaim();
    const ev = await textEvidence(claimId, 17 * MIB);
    const res = await t.api<{ error: { code: string } }>('POST', `/claims/${claimId}/estimate/import`, { evidenceId: ev.id });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  }, 60_000);

  it('a tampered text evidence is refused with 409; an intact one imports', async () => {
    const claimId = seedClaim();
    const ok = await textEvidence(claimId, 0, 'PANEL REPAIR 1.0 hrs @ 45.00\nBUMPER 1 x 120.00\n');
    const good = await t.api('POST', `/claims/${claimId}/estimate/import`, { evidenceId: ok.id });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    const bad = await textEvidence(claimId, 0, 'PANEL REPAIR 2.0 hrs @ 45.00\n');
    const abs = absoluteEvidencePath(t.ctx, bad.storagePath);
    chmodSync(abs, 0o644);
    writeFileSync(abs, 'PANEL REPAIR 9.0 hrs @ 45.00\n');
    clearVerifyCache();
    const res = await t.api<{ error: { code: string } }>('POST', `/claims/${claimId}/estimate/import`, { evidenceId: bad.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVIDENCE_TAMPERED');
  });
});

describe('malformed HEIC (EXIF reader guard)', () => {
  /** ftyp(heic) then one more top-level box of the given size; `meta` optional. */
  function heic(next: { size: number; kind: string } | null, total = 32): Buffer {
    const b = Buffer.alloc(total);
    b.writeUInt32BE(24, 0);
    b.write('ftyp', 4, 'latin1');
    b.write('heic', 8, 'latin1');
    b.write('mif1', 16, 'latin1');
    b.write('heic', 20, 'latin1');
    if (next) {
      b.writeUInt32BE(next.size, 24);
      b.write(next.kind, 28, 'latin1');
    }
    return b;
  }

  it('isoBmffSafeForExif refuses box chains the EXIF reader would loop on, and accepts a reachable meta box', () => {
    expect(isoBmffSafeForExif(heic({ size: 0, kind: 'free' }))).toBe(false); // size 0
    expect(isoBmffSafeForExif(heic({ size: 4, kind: 'free' }))).toBe(false); // size < 8
    expect(isoBmffSafeForExif(heic({ size: 8, kind: 'free' }))).toBe(false); // no meta before the end
    expect(isoBmffSafeForExif(heic({ size: 99, kind: 'meta' }))).toBe(false); // meta runs past the end
    expect(isoBmffSafeForExif(heic({ size: 8, kind: 'meta' }))).toBe(true);
    expect(isoBmffSafeForExif(makePng({ seed: 1 }))).toBe(true); // not ISO-BMFF: unaffected
  });

  it('a 32-byte HEIC with a zero-size box uploads without hanging the server', async () => {
    const claimId = seedClaim();
    const boundary = '----claimdeskheic';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nphoto\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="IMG_0001.HEIC"\r\nContent-Type: image/heic\r\n\r\n`),
      heic({ size: 0, kind: 'free' }),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await t.app.inject({ method: 'POST', url: `/api/claims/${claimId}/evidence`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { bytes: number; exif?: unknown })).toMatchObject({ bytes: 32 });
    expect((res.json() as { exif?: unknown }).exif).toBeUndefined();
  });
});

describe('chunked uploads', () => {
  async function put(id: string, offset: number, data: Buffer, headers: Record<string, string> = {}) {
    const res = await t.app.inject({ method: 'PUT', url: `/api/uploads/${id}?offset=${offset}`, payload: data, headers: { 'content-type': 'application/octet-stream', ...headers } });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> & ErrorBody };
  }

  it('evidence: abort at 40 %, restart, resume from GET /uploads/:id, complete → evidence row with the right hash', async () => {
    setEnv('CHUNK_MB', '1');
    const claimId = seedClaim();
    const file = block(99, 10 * MIB);
    const sha = createHash('sha256').update(file).digest('hex');
    const created = await t.api<{ uploadId: string; chunkBytes: number; receivedBytes: number }>('POST', '/uploads', { filename: 'engineer-photos.zip', bytes: file.length, mime: 'application/zip', purpose: 'evidence', claimId, fields: { kind: 'document', description: 'photos from the engineer' } });
    expect(created.status).toBe(201);
    expect(created.body.chunkBytes).toBe(MIB);
    expect(created.body.receivedBytes).toBe(0);
    const id = created.body.uploadId;

    for (let off = 0; off < 4 * MIB; off += MIB) {
      const r = await put(id, off, file.subarray(off, off + MIB));
      expect(r.status).toBe(200);
      expect(r.body.receivedBytes).toBe(off + MIB);
    }
    // connection drops part-way through the 5th chunk: the server keeps 4 MiB (40 %)
    const cut = Readable.from([file.subarray(4 * MIB, 4 * MIB + 300_000)]);
    const dropped = await t.app.inject({ method: 'PUT', url: `/api/uploads/${id}?offset=${4 * MIB}`, payload: cut, headers: { 'content-type': 'application/octet-stream', 'content-length': String(MIB) } });
    expect(dropped.statusCode).toBeGreaterThanOrEqual(400);

    // the app restarts: the in-memory hash is gone and is rebuilt from data.part
    forgetLiveUploadHashes();
    const state = await t.api<{ receivedBytes: number; bytes: number; status: string }>('GET', `/uploads/${id}`);
    expect(state.body).toMatchObject({ receivedBytes: 4 * MIB, bytes: file.length, status: 'receiving' });

    // resending from the wrong place is refused with the right offset
    const wrong = await put(id, 3 * MIB, file.subarray(3 * MIB, 4 * MIB));
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('OFFSET_MISMATCH');
    expect(wrong.body.error.details?.receivedBytes).toBe(4 * MIB);

    // completing early is refused
    const early = await t.api<ErrorBody>('POST', `/uploads/${id}/complete`, {});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('UPLOAD_INCOMPLETE');

    for (let off = state.body.receivedBytes; off < file.length; off += MIB) {
      const r = await put(id, off, file.subarray(off, off + MIB));
      expect(r.status).toBe(200);
    }
    const done = await t.api<{ id: string; sha256: string; bytes: number; claimId: string; kind: string; deduped: boolean }>('POST', `/uploads/${id}/complete`, { sha256: sha });
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ sha256: sha, bytes: file.length, claimId, kind: 'document', deduped: false });
    const rows = t.ctx.repos.listEvidenceForClaim(t.ctx.db, claimId, {});
    expect(rows.some((e) => e.id === done.body.id && e.sha256 === sha)).toBe(true);
    const back = await t.app.inject({ method: 'GET', url: `/api/evidence/${done.body.id}/file` });
    expect(back.rawPayload.equals(file)).toBe(true);
    expect(incomingFiles()).toEqual([]);
    expect(existsSync(path.join(uploadsRoot(t.ctx), id, 'data.part'))).toBe(false);

    // a repeated complete (lost response) answers with the same evidence
    const again = await t.api<{ id: string }>('POST', `/uploads/${id}/complete`, {});
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(done.body.id);
    // and no more chunks are taken
    expect((await put(id, file.length, Buffer.from('x'))).status).toBe(409);
  }, 60_000);

  it('refuses an oversized chunk (413), a wrong device hash (409) and enforces the evidence limit', async () => {
    setEnv('CHUNK_MB', '1');
    const claimId = seedClaim();
    const created = await t.api<{ uploadId: string }>('POST', '/uploads', { filename: 'a.bin', bytes: 4 * MIB, purpose: 'evidence', claimId, fields: { kind: 'document' } });
    const big = await put(created.body.uploadId, 0, Buffer.alloc(2 * MIB + 10));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
    const data = block(3, 4 * MIB);
    for (let off = 0; off < data.length; off += MIB) expect((await put(created.body.uploadId, off, data.subarray(off, off + MIB))).status).toBe(200);
    const bad = await t.api<ErrorBody>('POST', `/uploads/${created.body.uploadId}/complete`, { sha256: 'a'.repeat(64) });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('HASH_MISMATCH');

    setEnv('MAX_EVIDENCE_UPLOAD_MB', '2');
    const tooBig = await t.api<ErrorBody>('POST', '/uploads', { filename: 'b.bin', bytes: 3 * MIB, purpose: 'evidence', claimId });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
    const noClaim = await t.api<ErrorBody>('POST', '/uploads', { filename: 'b.bin', bytes: 10, purpose: 'evidence' });
    expect(noClaim.status).toBe(400);
  });

  it('purpose intake → a staged import listed under GET /imports', async () => {
    const claimId = seedClaim();
    const data = Buffer.from('%PDF-1.4 synthetic V5C for tests\n%%EOF\n');
    const created = await t.api<{ uploadId: string }>('POST', '/uploads', { filename: 'V5C scan.pdf', bytes: data.length, mime: 'application/pdf', purpose: 'intake', claimId });
    expect(created.status).toBe(201);
    expect((await put(created.body.uploadId, 0, data)).status).toBe(200);
    const done = await t.api<{ importId: string; sha256: string }>('POST', `/uploads/${created.body.uploadId}/complete`, {});
    expect(done.status).toBe(201);
    expect(done.body.importId).toBeTruthy();
    const list = await t.api<{ items: Array<{ id: string; purpose: string; filename: string; sha256: string; source: string; status: string; claimRef?: string; bytes: number; mime: string }> }>('GET', '/imports?purpose=intake&status=staged');
    expect(list.status).toBe(200);
    const item = list.body.items.find((i) => i.id === done.body.importId);
    expect(item).toMatchObject({ purpose: 'intake', filename: 'V5C scan.pdf', source: 'upload', status: 'staged', bytes: data.length, mime: 'application/pdf', sha256: createHash('sha256').update(data).digest('hex') });
    expect(item?.claimRef).toMatch(/^CCG-\d{4}-\d{5}$/);
    const one = await t.api<{ id: string }>('GET', `/imports/${done.body.importId}`);
    expect(one.body.id).toBe(done.body.importId);
  });

  it('checks free disk space (507), deletes a session, and forgets sessions idle for 7 days', async () => {
    const huge = await t.api<ErrorBody>('POST', '/uploads', { filename: 'huge.cab', bytes: 2 ** 52, purpose: 'engineer-data' });
    expect(huge.status).toBe(507);
    expect(huge.body.error.code).toBe('INSUFFICIENT_STORAGE');

    const a = await t.api<{ uploadId: string }>('POST', '/uploads', { filename: 'a.ccbrain', bytes: 10, purpose: 'brain-packs' });
    expect(a.status).toBe(201);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/uploads/${a.body.uploadId}` });
    expect(del.statusCode).toBe(204);
    expect((await t.api('GET', `/uploads/${a.body.uploadId}`)).status).toBe(404);

    const b = await t.api<{ uploadId: string }>('POST', '/uploads', { filename: 'b.cab', bytes: 10, purpose: 'engineer-data' });
    expect((await t.api('GET', `/uploads/${b.body.uploadId}`)).status).toBe(200);
    t.setNow('2026-10-11T09:00:00.000Z'); // 6 days idle: kept
    expect((await t.api('GET', `/uploads/${b.body.uploadId}`)).status).toBe(200);
    t.setNow('2026-10-12T09:00:01.000Z'); // just over 7 days since the last chunk: deleted
    expect((await t.api('GET', `/uploads/${b.body.uploadId}`)).status).toBe(404);
    expect(existsSync(path.join(uploadsRoot(t.ctx), b.body.uploadId))).toBe(false);
  });

  it('takes default-size 8 MiB chunks (past the 2 MiB JSON body limit) for an engineer data pack', async () => {
    setEnv('CHUNK_MB', undefined);
    const data = block(17, 9 * MIB);
    const created = await t.api<{ uploadId: string; chunkBytes: number }>('POST', '/uploads', { filename: 'AUDATEX.cab', bytes: data.length, purpose: 'engineer-data' });
    expect(created.body.chunkBytes).toBe(8 * MIB);
    expect((await put(created.body.uploadId, 0, data.subarray(0, 8 * MIB))).status).toBe(200);
    expect((await put(created.body.uploadId, 8 * MIB, data.subarray(8 * MIB))).status).toBe(200);
    const done = await t.api<{ importId: string; sha256: string }>('POST', `/uploads/${created.body.uploadId}/complete`, {});
    expect(done.status).toBe(201);
    expect(done.body.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    const imp = await t.api<{ purpose: string; mime: string; bytes: number }>('GET', `/imports/${done.body.importId}`);
    expect(imp.body).toMatchObject({ purpose: 'engineer-data', mime: 'application/vnd.ms-cab-compressed', bytes: data.length });
  });

  it('validates the session body', async () => {
    expect((await t.api('POST', '/uploads', { filename: 'x', bytes: 0, purpose: 'intake' })).status).toBe(400);
    expect((await t.api('POST', '/uploads', { filename: 'x', bytes: 5, purpose: 'mail' })).status).toBe(400);
    expect((await t.api('GET', '/uploads/not-a-real-upload-id')).status).toBe(404);
    expect((await t.api('GET', '/uploads/..%2F..%2Fetc')).status).toBe(404);
  });
});
