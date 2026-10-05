/**
 * Hardening checks (adversarial review): CORS defaults to localhost origins, the /api namespace never falls through to
 * the SPA shell, zod guards every body and query, store paths are contained, and every evidence / PDF read re-hashes
 * the bytes — tampered files are refused and the attempt is audited. Nothing is ever transmitted by `send`.
 */
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeneratedDocument } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { parseCorsOrigins } from '../config.js';
import { absoluteEvidencePath } from '../services/evidence.js';
import { resolvePdfPath } from '../services/documents.js';
import { recomputeClocks } from '../services/claimView.js';
import { makePng } from '../seed/png.js';

const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!process.env.CHROMIUM_PATH && existsSync(CHROMIUM)) process.env.CHROMIUM_PATH = CHROMIUM;

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string } };

function multipart(fields: Record<string, string>, file: { name: string; mime: string; data: Buffer }): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----claimdesk${Date.now()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z');
});
afterEach(async () => {
  await t.close();
});

function seedFileOne() {
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  return ids;
}

describe('CORS', () => {
  it('allows localhost origins by default and never reflects another origin', async () => {
    const ok = await t.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://localhost:5173' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const loopback = await t.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://127.0.0.1:3000' } });
    expect(loopback.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');

    const evil = await t.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await t.app.inject({ method: 'OPTIONS', url: '/api/claims', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    // a lookalike host is not localhost
    const lookalike = await t.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'http://localhost.evil.example' } });
    expect(lookalike.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS_ORIGINS replaces the default list; * reflects any origin (opt-in only)', () => {
    expect(parseCorsOrigins(undefined)).toHaveLength(3);
    expect(parseCorsOrigins('')).toHaveLength(3);
    expect(parseCorsOrigins('https://claims.example.com, https://ops.example.com')).toEqual(['https://claims.example.com', 'https://ops.example.com']);
    expect(parseCorsOrigins('*')).toBe(true);
  });
});

describe('/api namespace and error envelope', () => {
  it('unknown /api routes answer JSON 404 with a request id, never the SPA shell', async () => {
    const res = await t.api<ErrorBody>('GET', '/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
    for (const url of ['/api', '/api?x=1', '/api/']) {
      const r = await t.app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(404);
      expect(r.headers['content-type']).toMatch(/application\/json/);
    }
    const post = await t.app.inject({ method: 'POST', url: '/api/nope', payload: {} });
    expect(post.statusCode).toBe(404);
  });

  it('health exposes key presence flags only', async () => {
    const res = await t.api<{ lookups: Record<string, boolean | string>; engines: unknown }>('GET', '/health');
    expect(res.status).toBe(200);
    // `mode` is the derived lookup mode ('live' | 'manual'); every other entry is a key-presence flag
    expect(res.body.lookups.mode).toBe('manual');
    for (const [k, v] of Object.entries(res.body.lookups)) if (k !== 'mode') expect(typeof v).toBe('boolean');
    expect(JSON.stringify(res.body)).not.toMatch(/secret|apiKey|password/i);
  });
});

describe('zod on every body and query', () => {
  it('rejects a non-boolean force on report issue and malformed list filters', async () => {
    const ids = seedFileOne();
    const report = await t.api<{ id: string }>('POST', `/claims/${ids.claimId}/engineer-report`, { engineerPartyId: ids.engineerId, roadworthy: true, roadworthyReason: 'Cosmetic damage only', damageDescription: 'NSF wing and bumper scuffed', preAccidentCondition: 'Good' });
    expect(report.status).toBe(201);
    const bad = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/engineer-report/${report.body.id}/issue`, { force: 'yes' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');
    expect((await t.api<ErrorBody>('GET', '/fleet/penalties?open=maybe')).status).toBe(400);
    expect((await t.api<ErrorBody>('GET', '/watch?riskLevel=extreme')).status).toBe(400);
    expect((await t.api<ErrorBody>('GET', '/fleet/penalties?open=true')).status).toBe(200);
  });

  it('refuses a send body without a channel and an unknown channel', async () => {
    const ids = seedFileOne();
    const noVia = await t.api<ErrorBody>('POST', `/documents/${ids.ncafDocumentId}/send`, {});
    expect(noVia.status).toBe(400);
    const badVia = await t.api<ErrorBody>('POST', `/documents/${ids.ncafDocumentId}/send`, { via: 'carrier-pigeon' });
    expect(badVia.status).toBe(400);
  });
});

describe('store integrity', () => {
  it('refuses to serve evidence whose bytes no longer hash to the record, and audits the attempt', async () => {
    const ids = seedFileOne();
    const png = makePng({ seed: 42 });
    const up = multipart({ kind: 'photo', description: 'front left' }, { name: 'front_left.png', mime: 'image/png', data: png });
    const created = await t.api<{ id: string; sha256: string; storagePath: string }>('POST', `/claims/${ids.claimId}/evidence`, up.payload, up.headers);
    expect(created.status).toBe(201);
    const ok = await t.app.inject({ method: 'GET', url: `/api/evidence/${created.body.id}/file` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-sha256']).toBe(created.body.sha256);
    expect(ok.headers['content-length']).toBe(String(png.length));
    expect(ok.rawPayload.equals(png)).toBe(true);

    const abs = absoluteEvidencePath(t.ctx, created.body.storagePath);
    chmodSync(abs, 0o644);
    writeFileSync(abs, Buffer.concat([png, Buffer.from('tampered')]));
    const refused = await t.api<ErrorBody>('GET', `/evidence/${created.body.id}/file`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('EVIDENCE_TAMPERED');
    expect(refused.body.error.details?.recordedSha256).toBe(created.body.sha256);
    const verify = await t.api<{ status: string }>('GET', `/evidence/${created.body.id}/verify`);
    expect(verify.body.status).toBe('tampered');
    const audit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'evidence', entityId: created.body.id }).map((a) => a.action);
    expect(audit).toContain('evidence.read.tampered');
  });

  it('refuses store paths that escape the evidence or documents directory', () => {
    expect(() => absoluteEvidencePath(t.ctx, '../../etc/passwd')).toThrowError(/outside its store/);
    expect(() => absoluteEvidencePath(t.ctx, '/etc/passwd')).toThrowError(/outside its store/);
    expect(() => absoluteEvidencePath(t.ctx, 'evidence/../../x')).toThrowError(/outside its store/);
    expect(() => resolvePdfPath(t.ctx, '../outside.pdf')).toThrowError(/outside its store/);
    expect(() => resolvePdfPath(t.ctx, '/etc/passwd')).toThrowError(/outside its store/);
    // in-store paths resolve
    expect(absoluteEvidencePath(t.ctx, 'claim/ab/abcd.png').startsWith(t.ctx.config.evidenceDir)).toBe(true);
    expect(resolvePdfPath(t.ctx, 'claim/doc.pdf').startsWith(t.ctx.config.documentsDir)).toBe(true);
  });

  it('serves the certificate after signing, refuses an altered PDF (read and send) and never re-renders a signed PDF', async () => {
    const ids = seedFileOne();
    const draft = await t.api<GeneratedDocument>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.chaser_7' });
    expect(draft.status).toBe(201);
    const approved = await t.api<GeneratedDocument>('POST', `/documents/${draft.body.id}/approve`, {});
    expect(approved.status).toBe(200);
    const pdf = await t.app.inject({ method: 'GET', url: `/api/documents/${draft.body.id}/pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['x-sha256']).toBe(approved.body.sha256);

    // no certificate before signing
    expect((await t.api<ErrorBody>('GET', `/documents/${draft.body.id}/certificate`)).status).toBe(404);
    const start = await t.api<{ challengeId: string; devCode?: string }>('POST', `/documents/${draft.body.id}/sign/start`, { signerPartyId: ids.claimantId, contact: '07700900123', channel: 'sms' });
    expect(start.status).toBe(200);
    t.setNow('2026-10-05T09:02:00.000Z');
    const signed = await t.api<GeneratedDocument & { certificateId: string }>('POST', `/documents/${draft.body.id}/sign/verify`, { challengeId: start.body.challengeId, code: start.body.devCode! });
    expect(signed.status).toBe(200);
    expect(signed.body.status).toBe('signed');
    const cert = await t.app.inject({ method: 'GET', url: `/api/documents/${draft.body.id}/certificate` });
    expect(cert.statusCode).toBe(200);
    expect(cert.headers['content-type']).toBe('application/pdf');
    expect(cert.headers['x-certificate-id']).toBe(signed.body.certificateId);
    expect(cert.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // tamper with the approved PDF → refused on read and on send; the document state is untouched
    const abs = resolvePdfPath(t.ctx, approved.body.pdfPath!);
    writeFileSync(abs, Buffer.concat([pdf.rawPayload, Buffer.from('%tampered')]));
    const refused = await t.api<ErrorBody>('GET', `/documents/${draft.body.id}/pdf`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('DOCUMENT_PDF_TAMPERED');
    const send = await t.api<ErrorBody>('POST', `/documents/${draft.body.id}/send`, { via: 'email' });
    expect(send.status).toBe(409);
    expect(send.body.error.code).toBe('DOCUMENT_PDF_TAMPERED');
    expect((await t.api<GeneratedDocument>('GET', `/documents/${draft.body.id}?html=false`)).body.status).toBe('signed');

    // a signed PDF that has gone is not silently re-rendered (that would break the signature's hash chain)
    unlinkSync(abs);
    expect((await t.api<ErrorBody>('GET', `/documents/${draft.body.id}/pdf`)).status).toBe(404);
    const missing = await t.api<ErrorBody>('POST', `/documents/${draft.body.id}/send`, { via: 'post' });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('DOCUMENT_PDF_MISSING');
    expect(t.ctx.repos.listEvents(t.ctx.db, ids.claimId).some((e) => e.documentId === draft.body.id && (e.type === 'email_out' || e.type === 'letter_out'))).toBe(false);
  }, 120_000);
});

describe('Content-Security-Policy', () => {
  it('the web app shell is served with a script-src self policy; JSON gets nosniff', async () => {
    const { mkdtempSync, rmSync: rm } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const web = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-web-'));
    writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
    const w = await createTestApp('2026-10-05T09:00:00.000Z', { config: { webDistDir: web } });
    try {
      const shell = await w.app.inject({ method: 'GET', url: '/claims/abc' });
      expect(shell.statusCode).toBe(200);
      const csp = String(shell.headers['content-security-policy'] ?? '');
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe/);
      const json = await w.app.inject({ method: 'GET', url: '/api/health' });
      expect(json.headers['x-content-type-options']).toBe('nosniff');
      expect(json.headers['content-security-policy']).toBeUndefined();
    } finally {
      await w.close();
      rm(web, { recursive: true, force: true });
    }
  });
});

describe('roles on shared configuration', () => {
  it('a handler cannot change GTA rates, the catalogue or the template library; an admin or approver can', async () => {
    t.ctx.repos.createUser(t.ctx.db, { id: 'boss', name: 'Admin (test)', email: 'boss@ccguk.test', role: 'admin' });
    const users = t.ctx.repos.listUsers(t.ctx.db);
    const handler = users.find((u) => u.role === 'handler')!;
    const boss = users.find((u) => u.id === 'boss')!;
    expect(handler).toBeDefined();
    expect(boss).toBeDefined();
    const as = (id: string) => ({ 'x-user-id': id });
    const rate = { group: 'S9', period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', dailyRatePence: 5000 };
    const refused = await t.api<ErrorBody>('POST', '/settings/gta-rates', rate, as(handler.id));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
    expect((await t.api<ErrorBody>('PUT', '/settings/gta-segments/suv-small', { group: 'M1' }, as(handler.id))).status).toBe(403);
    expect((await t.api<ErrorBody>('POST', '/catalogue/custom', { level: 'make', make: 'Test' }, as(handler.id))).status).toBe(403);
    expect((await t.api<ErrorBody>('POST', '/docx-templates/letter.ccguk_letterhead_formal/acknowledge', {}, as(handler.id))).status).toBe(403);
    expect((await t.api<ErrorBody>('DELETE', '/docx-templates/letter.ccguk_letterhead_formal/mapping', undefined, as(handler.id))).status).toBe(403);
    // reading stays open to every signed-in user
    expect((await t.api('GET', '/docx-templates', undefined, as(handler.id))).status).toBe(200);
    const allowed = await t.api<ErrorBody>('POST', '/settings/gta-rates', rate, as(boss.id));
    expect(allowed.status).not.toBe(403);
  });
});
