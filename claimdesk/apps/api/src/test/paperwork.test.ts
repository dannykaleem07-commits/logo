// owned by ap-paperwork
/**
 * Paperwork and signing (docs/SUPREME-AUTOPILOT.md §D.6, §E, §J.2 "Packs", "Kiosk", "Wet signature"):
 * stage packs prepared from the file and reviewed together → approve_pack (owner) → emailed with the cover letter;
 * the in-person kiosk (token auth only, one code per pack, handler-code fallback audited, drawn signature as evidence,
 * exit needs the password); emailed PDFs chased after 2 and 5 days, a call after 7; a returned scan matched and
 * confirmed by a person; the signed pack proves the hire's enforceability; agents can do none of the human steps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DocumentPack, GeneratedDocument, HireAgreement, Reservation } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { asAgent, holdBody, MONDAY, seedClaim, seedFleet, type ApiErr, type Fleet } from './bookingFixtures.js';
import { setUpMail, queued, run, runJob } from './fixtures/mail/helpers.js';
import { resolveNeedsYouItem } from '../agent/needsYou.js';
import { hashPassword } from '../services/auth.js';
import { storeEvidenceBuffer } from '../services/evidence.js';
import { documentPdfPath } from '../services/documents.js';
import { actAsAutopilot } from '../autopilot/act.js';
import { buildSigningLanApp, setLanBaseUrlForTests } from '../signing/lanServer.js';
import { signedPackStatus } from '../signing/status.js';
import { provenFromPack } from '../signing/enforceability.js';
import { preparePack } from '../signing/packs.js';
import type { JobType } from '@ccguk/domain';

const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!process.env.CHROMIUM_PATH && existsSync(CHROMIUM)) process.env.CHROMIUM_PATH = CHROMIUM;

/** A 1×1 PNG. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF_BYTES = Buffer.from(`%PDF-1.4\n% returned scan (invented)\n${'0'.repeat(400)}\n%%EOF\n`);

type PackBody = { pack: DocumentPack & { view: Array<{ templateId: string; status: string; documentId?: string; title?: string }> }; created: Array<{ documentId: string; templateId: string }>; failed: Array<{ templateId: string; code: string }>; reused: boolean };
type Held = { reservation: Reservation };

let t: TestApp;
let fleet: Fleet;
let owner: { userId: string };

beforeEach(async () => {
  t = await createTestApp(MONDAY, { config: { aiDriverOverride: 'fake' } });
  fleet = seedFleet(t);
  owner = { userId: t.ctx.config.defaultUserId };
});
afterEach(async () => {
  setLanBaseUrlForTests(undefined);
  await t.close();
});

async function drain(...types: JobType[]): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    let ran = 0;
    for (const type of types) for (const j of queued(t.ctx, type)) {
      await runJob(t.ctx, j);
      ran += 1;
    }
    if (!ran) return;
  }
}

/** A confirmed booking (agreement number allocated) for a fresh claim. */
async function confirmedBooking(): Promise<{ claimId: string; reservation: Reservation }> {
  const claim = await seedClaim(t);
  const b = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A, { confirm: true }));
  expect(b.status).toBe(201);
  return { claimId: claim.id, reservation: b.body.reservation };
}

/** A hire-start pack of HTML documents only (deterministic in tests): express request (sign), Sch 3 + cover (give). */
async function htmlHireStartPack(claimId: string, reservationId: string): Promise<DocumentPack> {
  t.ctx.repos.createDocumentPack(t.ctx.db, {
    claimId,
    stage: 'hire_start',
    reservationId,
    items: [
      { templateId: 'form.express_request_to_start', format: 'html', purpose: 'sign', signer: 'hirer', status: 'pending' },
      { templateId: 'form.cancellation_sch3', format: 'html', purpose: 'give', signer: 'hirer', status: 'pending' },
      { templateId: 'form.hire_cover_confirmation', format: 'html', purpose: 'give', signer: 'hirer', status: 'pending' },
    ],
    createdBy: owner.userId,
  });
  const r = await preparePack(t.ctx, { claimId, stage: 'hire_start', reservationId, actor: owner });
  expect(r.failed).toEqual([]);
  expect(r.created).toHaveLength(3);
  return r.pack;
}

async function approveOnly(packId: string): Promise<void> {
  const a = await t.api<{ approved: string[] }>('POST', `/packs/${packId}/approve`, { send: false });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
}

describe('stage packs (§D.6)', () => {
  it('prepares the closure pack from the file, reviews it with its pack, and raises one approve_pack card', async () => {
    const { claimId } = await confirmedBooking();
    const prep = await t.api<PackBody>('POST', `/claims/${claimId}/packs`, { stage: 'closure' });
    expect(prep.status).toBe(201);
    expect(prep.body.failed).toEqual([]);
    expect(prep.body.pack.status).toBe('reviewing');
    const docId = prep.body.created[0]!.documentId;
    expect(t.ctx.repos.requireDocument(t.ctx.db, docId).status).toBe('draft'); // drafted, never approved by code
    expect(queued(t.ctx, 'review.check').some((j) => (j.payload as { targetId?: string }).targetId === docId)).toBe(true);
    // Again: idempotent (the open pack is reused).
    const again = await t.api<PackBody>('POST', `/claims/${claimId}/packs`, { stage: 'closure' });
    expect(again.status).toBe(200);
    expect(again.body.pack.id).toBe(prep.body.pack.id);

    await drain('review.check', 'document.after_review');
    const pack = t.ctx.repos.requireDocumentPack(t.ctx.db, prep.body.pack.id);
    expect(pack.status).toBe('awaiting_approval');
    expect(pack.items[0]).toMatchObject({ status: 'reviewed' });
    const cards = t.ctx.repos.listNeedsYou(t.ctx.db, { claimId, status: 'open' });
    expect(cards.filter((c) => c.kind === 'approve_pack')).toHaveLength(1);
    expect(cards.filter((c) => c.kind === 'approve_document')).toHaveLength(0); // pack members are never approved one by one
  });

  it('prepares the hire-start pack for a booking before the hire exists; data that is not on file is reported, never invented', async () => {
    const { claimId, reservation } = await confirmedBooking();
    const prep = await t.api<PackBody>('POST', `/claims/${claimId}/packs`, { stage: 'hire_start', reservationId: reservation.id });
    expect(prep.status).toBe(201);
    const drafted = new Set(prep.body.created.map((c) => c.templateId));
    // The CCR 2013 forms come from the confirmed booking (no hire record yet).
    expect(drafted.has('form.cancellation_sch3')).toBe(true);
    expect(drafted.has('form.express_request_to_start')).toBe(true);
    expect(drafted.has('form.hire_cover_confirmation')).toBe(true);
    const sch3 = t.ctx.repos.requireDocument(t.ctx.db, prep.body.created.find((c) => c.templateId === 'form.cancellation_sch3')!.documentId, { includeHtml: true });
    expect(sch3.html).toContain(reservation.agreementNumber!);
    expect(prep.body.created.length + prep.body.failed.length).toBe(6);
    if (prep.body.failed.length) {
      expect(prep.body.pack.status).toBe('preparing');
      const q = t.ctx.repos.listNeedsYou(t.ctx.db, { claimId, status: 'open' }).find((c) => c.kind === 'question' && c.dedupeKey === `pack_missing:${prep.body.pack.id}`);
      expect(q?.summary).toContain(prep.body.failed[0]!.templateId);
    }
  });

  it('approve_pack → Approve and send: the owner approves every document and the pack is emailed with the cover letter', async () => {
    const { smtp } = await setUpMail(t.ctx);
    const { claimId, reservation } = await confirmedBooking();
    const pack = await htmlHireStartPack(claimId, reservation.id);
    await drain('review.check', 'document.after_review');
    const card = t.ctx.repos.listNeedsYou(t.ctx.db, { claimId, status: 'open' }).find((c) => c.kind === 'approve_pack')!;
    expect(card).toBeDefined();
    expect((card.payload as { items: unknown[] }).items).toHaveLength(3);
    await resolveNeedsYouItem(t.ctx, card.id, { optionId: 'approve_send' }, owner);
    const after = t.ctx.repos.requireDocumentPack(t.ctx.db, pack.id);
    expect(after.status).toBe('sent');
    expect(after.approvedBy).toBe(owner.userId);
    for (const i of after.items) expect(t.ctx.repos.requireDocument(t.ctx.db, i.documentId!).status).toBe('approved');
    // One signature request (the express request), chased from day 2.
    const reqs = t.ctx.repos.listSignatureRequests(t.ctx.db, { packId: pack.id });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ method: 'wet_email', status: 'sent', nextChaseAt: '2026-10-14T08:00:00.000Z' });
    // Owner-approved outbox (30-second Undo) with the cover letter first.
    const o = t.ctx.repos.requireOutbox(t.ctx.db, after.outboxId!);
    expect(o).toMatchObject({ kind: 'signature_request', status: 'held', approvedBy: owner.userId });
    expect(o.attachmentsJson).toHaveLength(4);
    expect(t.ctx.repos.requireDocument(t.ctx.db, o.attachmentsJson[0]!.documentId!).templateId).toBe('letter.signature_request');
    t.setNow('2026-10-12T08:01:00.000Z');
    await drain('outbox.release');
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.from).toContain('Claims Team, Courtesy Cars Group UK Ltd');
    expect(smtp.sent[0]!.attachments.map((a) => a.contentType)).toEqual(['application/pdf', 'application/pdf', 'application/pdf', 'application/pdf']);
    // Durable medium: the Sch 3 form went to the client.
    expect(t.ctx.repos.requireDocument(t.ctx.db, after.items[1]!.documentId!).sentAt).toBeDefined();
    expect(provenFromPack(t.ctx, t.ctx.db, reservation.id).enforceability?.schedule3FormProvidedAt).toBeDefined();
  });

  it('agents cannot approve, send, open the kiosk, mark signed or change hire paperwork (human-only), but can queue a pack', async () => {
    const { claimId, reservation } = await confirmedBooking();
    const pack = await htmlHireStartPack(claimId, reservation.id);
    const docId = pack.items[0]!.documentId!;
    for (const [method, url, body] of [
      ['POST', `/packs/${pack.id}/approve`, { send: true }],
      ['POST', `/packs/${pack.id}/send-for-signature`, {}],
      ['POST', `/packs/${pack.id}/kiosk`, {}],
      ['POST', `/documents/${docId}/mark-signed`, { evidenceId: 'x', signedOn: '2026-10-12', method: 'scan' }],
      ['POST', `/claims/${claimId}/packs`, { stage: 'closure' }],
    ] as const) {
      const r = await asAgent<ApiErr>(t, claimId, method, url, body);
      expect(r.status, url).toBe(403);
    }
    const kiosk = await asAgent<ApiErr>(t, claimId, 'GET', '/kiosk/abcdefghijklmnopqrstuvwxyz');
    expect(kiosk.status).toBe(403);
    // pack_prepare (draft) goes through the policy and queues pack.prepare.
    const res = await actAsAutopilot(t.ctx, { claimId, step: { id: 'signup.pack', mode: 'confirm', green: false }, tool: 'pack_prepare', input: { claimId, stage: 'signup', reservationId: null } });
    expect(res.ok, res.content).toBe(true);
    expect(queued(t.ctx, 'pack.prepare').map((j) => (j.payload as { stage: string }).stage)).toContain('signup');
    const listed = await actAsAutopilot(t.ctx, { claimId, step: null, tool: 'signatures_list', input: { claimId } });
    expect(listed.ok, listed.content).toBe(true);
    expect(JSON.parse(listed.content).packs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('in-person kiosk (§E.2)', () => {
  it('every kiosk route refuses a wrong token (token auth only) and writes nothing', async () => {
    const bad = 'x'.repeat(43);
    const calls: Array<['GET' | 'POST', string, unknown]> = [
      ['GET', `/kiosk/${bad}`, undefined],
      ['GET', `/kiosk/${bad}/documents/doc-1/pdf`, undefined],
      ['POST', `/kiosk/${bad}/read`, { documentId: 'doc-1' }],
      ['POST', `/kiosk/${bad}/otp/start`, {}],
      ['POST', `/kiosk/${bad}/sign`, { typedName: 'Someone', drawnSignaturePngBase64: PNG_1X1, code: '123456', consent: true }],
      ['POST', `/kiosk/${bad}/close`, { password: 'x' }],
    ];
    for (const [method, url, body] of calls) {
      const r = await t.api<ApiErr>(method, url, body);
      expect(r.status, url).toBe(401);
      expect(r.body.error.code, url).toBe('KIOSK_TOKEN');
    }
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'kiosk.open' })).toHaveLength(0);
  });

  async function readyKiosk(): Promise<{ claimId: string; reservation: Reservation; pack: DocumentPack; token: string }> {
    const { claimId, reservation } = await confirmedBooking();
    const pack = await htmlHireStartPack(claimId, reservation.id);
    await approveOnly(pack.id);
    const k = await t.api<{ token: string; path: string; expiresAt: string; lanUrl?: string }>('POST', `/packs/${pack.id}/kiosk`, {});
    expect(k.status).toBe(201);
    expect(k.body.path).toBe(`/sign/kiosk/${k.body.token}`);
    expect(k.body.expiresAt).toBe('2026-10-12T08:30:00.000Z');
    return { claimId, reservation, pack, token: k.body.token };
  }

  it('signs the whole pack with one code shown to the handler, stores the drawn signature and proves the hire paperwork', async () => {
    const { claimId, reservation, pack, token } = await readyKiosk();
    // token auth only: a wrong token is 401; the stored row has the hash, never the token
    expect((await t.api<ApiErr>('GET', '/kiosk/not-the-right-token-at-all-xxxxxxxx')).status).toBe(401);
    expect(t.ctx.repos.listKioskSessions(t.ctx.db, { packId: pack.id })[0]!.tokenSha256).not.toContain(token);
    const summary = await t.api<{ documents: Array<{ id: string; purpose: string; read: boolean }>; otp: { delivery: string } }>('GET', `/kiosk/${token}`);
    expect(summary.status).toBe(200);
    expect(summary.body.documents.map((d) => d.purpose)).toEqual(['sign', 'give', 'give']);
    expect(summary.body.otp.delivery).toBe('handler'); // no mailbox in this test
    const pdf = await t.app.inject({ method: 'GET', url: `/api/kiosk/${token}/documents/${summary.body.documents[0]!.id}/pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    // one code for the pack, shown to the handler (audited)
    const otp = await t.api<{ channel: string; handlerCode: string }>('POST', `/kiosk/${token}/otp/start`, {});
    expect(otp.status).toBe(200);
    expect(otp.body.channel).toBe('handler');
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'document.sign.code_shown_to_handler' })).toHaveLength(1);
    const signBody = { typedName: 'Client Signer', drawnSignaturePngBase64: PNG_1X1, code: otp.body.handlerCode, consent: true };
    // every document must be read first
    expect((await t.api<ApiErr>('POST', `/kiosk/${token}/sign`, signBody)).body.error.code).toBe('KIOSK_NOT_READ');
    for (const d of summary.body.documents) expect((await t.api('POST', `/kiosk/${token}/read`, { documentId: d.id })).status).toBe(200);
    const wrong = await t.api<ApiErr>('POST', `/kiosk/${token}/sign`, { ...signBody, code: otp.body.handlerCode === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('OTP_INVALID');
    const signed = await t.api<{ signed: Array<{ documentId: string; certificateId: string }>; given: string[] }>('POST', `/kiosk/${token}/sign`, signBody);
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.signed).toHaveLength(1);
    expect(signed.body.given).toHaveLength(2);
    const doc = t.ctx.repos.requireDocument(t.ctx.db, signed.body.signed[0]!.documentId);
    expect(doc.status).toBe('signed');
    expect(doc.signature).toMatchObject({ method: 'kiosk_handler_code', otpChannel: 'none', signerName: 'Client Signer', packId: pack.id });
    const ev = t.ctx.repos.requireEvidence(t.ctx.db, doc.signature!.evidenceId!);
    expect(ev.kind).toBe('signature_image');
    expect(ev.sha256).toBe(doc.signature!.drawnSignatureSha256);
    expect(t.ctx.repos.getSignatureProvenance(t.ctx.db, doc.signature!.certificateId)).toMatchObject({ method: 'kiosk_handler_code', evidenceId: ev.id, packId: pack.id });
    const certJson = documentPdfPath(t.ctx, doc).absolute.replace(/\.pdf$/, `.${doc.signature!.certificateId}.json`);
    const cert = JSON.parse(readFileSync(certJson, 'utf8')) as { lines: string[]; provenance: { drawnSignatureSha256: string } };
    expect(cert.provenance.drawnSignatureSha256).toBe(ev.sha256);
    expect(cert.lines.join('\n')).toContain('code shown to the Claims Team member');
    expect(t.ctx.repos.listEvents(t.ctx.db, claimId).some((e) => e.type === 'documents_signed')).toBe(true);
    // the signed pack proves the hire paperwork and the handover check passes
    expect(signedPackStatus(t.ctx, reservation.id)).toEqual({ signed: true, missing: [] });
    const proven = provenFromPack(t.ctx, t.ctx.db, reservation.id);
    expect(proven.enforceability).toMatchObject({ expressRequestToStartAt: doc.signature!.signedAt, schedule3FormProvidedAt: expect.any(String) });
    // the session is done; exit needs the creator's password
    expect((await t.api<ApiErr>('POST', `/kiosk/${token}/otp/start`, {})).body.error.code).toBe('KIOSK_DONE');
    t.ctx.repos.setPassword(t.ctx.db, owner.userId, await hashPassword('Correct-Horse-1'));
    expect((await t.api<ApiErr>('POST', `/kiosk/${token}/close`, { password: 'wrong' })).status).toBe(401);
    expect((await t.api('POST', `/kiosk/${token}/close`, { password: 'Correct-Horse-1' })).status).toBe(200);
    const closed = await t.api<ApiErr>('GET', `/kiosk/${token}`);
    expect(closed.status).toBe(401);
    expect(closed.body.error.code).toBe('KIOSK_CLOSED');
  });

  it('emails the code when the mailbox is set up, is pinned to the first device, and expires', async () => {
    const { smtp } = await setUpMail(t.ctx);
    const { token } = await readyKiosk();
    const otp = await t.api<{ channel: string; contactMasked: string; handlerCode?: string }>('POST', `/kiosk/${token}/otp/start`, {});
    expect(otp.body.channel).toBe('email');
    expect(otp.body.handlerCode).toBeUndefined();
    expect(smtp.sent).toHaveLength(1);
    const code = /code to sign your documents with Courtesy Cars Group UK Ltd is: (\d{6})/.exec(smtp.sent[0]!.text)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'document.sign.otp_sent' })).toHaveLength(1);
    const summary = await t.api<{ documents: Array<{ id: string }> }>('GET', `/kiosk/${token}`);
    for (const d of summary.body.documents) await t.api('POST', `/kiosk/${token}/read`, { documentId: d.id });
    const signed = await t.api<{ signed: Array<{ documentId: string }> }>('POST', `/kiosk/${token}/sign`, { typedName: 'Client Signer', drawnSignaturePngBase64: PNG_1X1, code, consent: true });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(t.ctx.repos.requireDocument(t.ctx.db, signed.body.signed[0]!.documentId).signature).toMatchObject({ method: 'kiosk_otp_email', otpChannel: 'email' });
    // another device
    const other = await t.app.inject({ method: 'GET', url: `/api/kiosk/${token}`, headers: { 'user-agent': 'Some tablet' } });
    expect(other.statusCode).toBe(401);
    expect(JSON.parse(other.body).error.code).toBe('KIOSK_DEVICE');
    // expiry
    t.setNow('2026-10-12T09:00:00.000Z');
    expect((await t.api<ApiErr>('GET', `/kiosk/${token}`)).body.error.code).toBe('KIOSK_EXPIRED');
  });

  it('shows the LAN address when the tablet listener runs, and the LAN app serves only the kiosk', async () => {
    setLanBaseUrlForTests('http://192.168.1.20:5181');
    const { token } = await readyKiosk();
    const sessions = t.ctx.repos.listKioskSessions(t.ctx.db);
    expect(sessions[0]!.lan).toBe(true);
    const webDist = path.join(t.ctx.config.dataDir, 'lan-web');
    mkdirSync(webDist, { recursive: true });
    writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>ClaimDesk</title><div id="root"></div>');
    const lan = await buildSigningLanApp({ ...t.ctx, config: { ...t.ctx.config, webDistDir: webDist } });
    try {
      expect((await lan.inject({ method: 'GET', url: '/api/claims' })).statusCode).toBe(404);
      expect((await lan.inject({ method: 'GET', url: '/api/needs-you' })).statusCode).toBe(404);
      expect((await lan.inject({ method: 'POST', url: `/api/packs/x/kiosk` })).statusCode).toBe(404);
      const page = await lan.inject({ method: 'GET', url: `/sign/kiosk/${token}` });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('id="root"');
      const summary = await lan.inject({ method: 'GET', url: `/api/kiosk/${token}`, headers: { 'user-agent': 'Tablet', cookie: 'claimdesk_session=stolen', authorization: 'Bearer nope' } });
      expect(summary.statusCode).toBe(200);
      expect(JSON.parse(summary.body).documents).toHaveLength(3);
      expect((await lan.inject({ method: 'GET', url: '/api/kiosk/wrong-token-wrong-token-wrong' })).statusCode).toBe(401);
    } finally {
      await lan.close();
    }
  });
});

describe('emailed PDFs, chasing and returned scans (§E.4)', () => {
  it('chases after 2 and 5 days, asks for a call after 7, then a returned scan is matched and confirmed by a person', async () => {
    await setUpMail(t.ctx);
    const { claimId, reservation } = await confirmedBooking();
    const pack = await htmlHireStartPack(claimId, reservation.id);
    await drain('review.check', 'document.after_review');
    const sent = await t.api<{ signatureRequestIds: string[] }>('POST', `/packs/${pack.id}/approve`, { send: true });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const [reqId] = sent.body.signatureRequestIds;
    const chaseOnce = async (at: string) => {
      t.setNow(at);
      const r = await run(t.ctx, 'signing.chase', {});
      expect(r.outcome.kind).toBe('done');
      return (r.outcome as { result: { chased: Array<{ outboxId?: string; error?: string }>; calls: unknown[] } }).result;
    };
    expect((await chaseOnce('2026-10-13T08:15:00.000Z')).chased).toHaveLength(0); // day 1: nothing yet
    const c1 = await chaseOnce('2026-10-14T08:15:00.000Z');
    expect(c1.chased[0]?.error).toBeUndefined();
    const o1 = t.ctx.repos.requireOutbox(t.ctx.db, c1.chased[0]!.outboxId!);
    expect(o1).toMatchObject({ kind: 'chaser', createdBy: 'agent:autopilot', status: 'reviewing' }); // reviewer + policy decide
    expect(t.ctx.repos.requireSignatureRequest(t.ctx.db, reqId!)).toMatchObject({ status: 'chased', chaseCount: 1, nextChaseAt: '2026-10-17T08:00:00.000Z' });
    const c2 = await chaseOnce('2026-10-17T08:15:00.000Z');
    expect(c2.chased).toHaveLength(1);
    const c3 = await chaseOnce('2026-10-19T08:15:00.000Z');
    expect(c3.calls).toHaveLength(1);
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { claimId, status: 'open' }).some((c) => c.kind === 'question' && c.title.startsWith('Call'))).toBe(true);
    expect(t.ctx.repos.listTasks(t.ctx.db, { claimId }).some((x) => x.kind === 'call')).toBe(true);
    expect((await chaseOnce('2026-10-22T08:15:00.000Z')).chased).toHaveLength(0);

    // A returned scan arrives (uploaded): matched by type, title and signer name.
    const doc = t.ctx.repos.requireDocument(t.ctx.db, pack.items[0]!.documentId!);
    const signer = t.ctx.repos.requireParty(t.ctx.db, t.ctx.repos.requireClaim(t.ctx.db, claimId).claimantId);
    t.setNow('2026-10-22T10:00:00.000Z');
    const scan = await storeEvidenceBuffer(t.ctx, PDF_BYTES, { claimId, filename: `${doc.title} signed by ${signer.name}.pdf`, mime: 'application/pdf', fields: { kind: 'signed_document' }, actor: owner });
    const m = await run(t.ctx, 'signing.match_return', {});
    const matched = (m.outcome as { result: { matched: Array<{ needsYouId: string; evidenceId: string }> } }).result.matched;
    expect(matched).toHaveLength(1);
    expect(matched[0]!.evidenceId).toBe(scan.evidence.id);
    expect(t.ctx.repos.requireSignatureRequest(t.ctx.db, reqId!)).toMatchObject({ status: 'returned', returnedEvidenceId: scan.evidence.id });
    // the agent never marks it signed; the owner confirms through the human-only route
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.id).status).not.toBe('signed');
    await resolveNeedsYouItem(t.ctx, matched[0]!.needsYouId, { optionId: 'confirm', edits: { signedOn: '2026-10-21' } }, owner);
    const signedDoc = t.ctx.repos.requireDocument(t.ctx.db, doc.id) as GeneratedDocument;
    expect(signedDoc.status).toBe('signed');
    expect(signedDoc.signature).toMatchObject({ method: 'scan', otpChannel: 'none', evidenceId: scan.evidence.id, signedAt: '2026-10-21T12:00:00.000Z' });
    expect(t.ctx.repos.requireSignatureRequest(t.ctx.db, reqId!)).toMatchObject({ status: 'signed', confirmedBy: owner.userId });
    expect(t.ctx.repos.listSignatureRequestEvents(t.ctx.db, reqId!).map((e) => e.toStatus)).toEqual(['sent', 'chased', 'chased', 'chased', 'returned', 'signed']);
    expect(provenFromPack(t.ctx, t.ctx.db, reservation.id).enforceability?.expressRequestToStartAt).toBe('2026-10-21T12:00:00.000Z');
  });

  it('a returned copy the owner rejects puts the request back to waiting', async () => {
    await setUpMail(t.ctx);
    const { claimId, reservation } = await confirmedBooking();
    const pack = await htmlHireStartPack(claimId, reservation.id);
    await drain('review.check', 'document.after_review');
    const sent = await t.api<{ signatureRequestIds: string[] }>('POST', `/packs/${pack.id}/approve`, { send: true });
    const reqId = sent.body.signatureRequestIds[0]!;
    t.setNow('2026-10-13T10:00:00.000Z');
    const doc = t.ctx.repos.requireDocument(t.ctx.db, pack.items[0]!.documentId!);
    await storeEvidenceBuffer(t.ctx, PDF_BYTES, { claimId, filename: `${doc.title}.pdf`, mime: 'application/pdf', fields: { kind: 'signed_document' }, actor: owner });
    const m = await run(t.ctx, 'signing.match_return', {});
    const ny = (m.outcome as { result: { matched: Array<{ needsYouId: string }> } }).result.matched[0]!.needsYouId;
    await resolveNeedsYouItem(t.ctx, ny, { optionId: 'not_signed' }, owner);
    expect(t.ctx.repos.requireSignatureRequest(t.ctx.db, reqId)).toMatchObject({ status: 'sent' });
    // the same scan is not offered again
    const again = await run(t.ctx, 'signing.match_return', {});
    expect((again.outcome as { result: { matched: unknown[] } }).result.matched).toHaveLength(0);
  });
});

describe('hire enforceability from the signed pack (§E.5)', () => {
  it('the handover creates the hire with the proven fields; the owner confirms art 60F on an existing hire', async () => {
    const { claimId, reservation } = await confirmedBooking();
    const pack = await htmlHireStartPack(claimId, reservation.id);
    await approveOnly(pack.id);
    const k = await t.api<{ token: string }>('POST', `/packs/${pack.id}/kiosk`, {});
    const otp = await t.api<{ handlerCode: string }>('POST', `/kiosk/${k.body.token}/otp/start`, {});
    for (const i of pack.items) await t.api('POST', `/kiosk/${k.body.token}/read`, { documentId: i.documentId });
    expect((await t.api('POST', `/kiosk/${k.body.token}/sign`, { typedName: 'Client Signer', drawnSignaturePngBase64: PNG_1X1, code: otp.body.handlerCode, consent: true })).status).toBe(200);
    t.setNow('2026-10-12T11:30:00.000Z');
    const handoverBody = { at: '2026-10-12T11:30:00.000Z', odometerOut: 12000, fuelEighths: 8, licenceEvidenceId: 'ev-licence', dvlaCheck: { checkedAt: '2026-10-12T09:00:00.000Z', summary: 'Full licence' }, keys: 2 };
    const ho = await t.api<{ hire: HireAgreement } & ApiErr>('POST', `/bookings/${reservation.id}/handover`, handoverBody);
    expect(ho.status, JSON.stringify(ho.body)).toBe(201);
    expect(ho.body.hire.enforceability).toMatchObject({ expressRequestToStartAt: expect.any(String), schedule3FormProvidedAt: expect.any(String), cca60fCompliant: false });
    const patched = await t.api<{ hire: HireAgreement }>('PATCH', `/claims/${claimId}/hire/${ho.body.hire.id}/paperwork`, { cca60fCompliant: true, cancellationInfoProvidedAt: '2026-10-12T10:00:00.000Z' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.hire.enforceability).toMatchObject({ cca60fCompliant: true, cancellationInfoProvidedAt: '2026-10-12T10:00:00.000Z' });
    expect((await asAgent<ApiErr>(t, claimId, 'PATCH', `/claims/${claimId}/hire/${ho.body.hire.id}/paperwork`, { cca60fCompliant: true })).status).toBe(403);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'hire.paperwork' })).toHaveLength(1);
  });
});
