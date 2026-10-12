// owned by claimai-server
/**
 * Catch-up upload (docs/CLAIM-AI-INPUT.md §8, §16.3): a smart-intake bundle with the claim fixed — no new-claim card,
 * no auto-register, no signals; per-file plan (direction, real date, kind, already on file / recorded, other claim);
 * owner overrides re-plan; automatic apply as agent:intake (only "Will do" lines) and owner apply; field proposals;
 * the bundle attached; intake routes refuse a catch-up bundle; GET /intake/bundles hides it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from './helpers.js';
import { uploadToBundle } from './fixtures/smartIntake/scenario.js';
import { textPdf } from './fixtures/smartIntake/files.js';
import { addEvidence, audits, claimAiApp, drainCatchUp, getInput, jobRows, seedScenario, type Json, type Seeded } from './fixtures/claimai/scenario.js';
import { clientEmail, handlingRefRequest, insurerAck, ncafSent, otherClaimLetter, pack, photo, plainLetter, v5cBytes, v5cCopy } from './fixtures/claimai/files.js';
import { MAILBOX, setUpMail } from './fixtures/mail/helpers.js';
import { CLIENT, INSURER, OTHER } from './fixtures/claimai/scenario.js';

let t: TestApp;
let s: Seeded;
let inputId: string;
let bundleId: string;
let v5cId: string;
let v5c: Buffer; // the same bytes for the V5C on file and its copy (a PDF carries its creation time)

const file = (d: Json, name: string): Json => d.catchUp.files.find((f: Json) => f.filename === name && f.role !== 'container');
const settle = async () => {
  await drainCatchUp(t);
  return getInput(t, s.claim1.id, inputId);
};

beforeAll(async () => {
  t = await claimAiApp({ agents: false });
  await setUpMail(t.ctx);
  s = await seedScenario(t);
  v5c = await v5cBytes();
  v5cId = (await addEvidence(t, s.claim1.id, 'V5C.pdf', 'v5c', v5c)).id;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('catch-up upload', () => {
  it('creates a catch-up with its bundle; the bundle is hidden from the intake list', async () => {
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/catch-up`, { note: 'Opened late — letters we sent by post', autoApply: true });
    expect(r.status).toBe(201);
    inputId = r.body.id;
    bundleId = r.body.catchUp.bundleId;
    expect(r.body.kind).toBe('catch_up');
    expect(r.body.status).toBe('reading');
    expect(r.body.catchUp.autoApply).toBe(true);
    const list = await t.api<Json>('GET', '/intake/bundles?status=all');
    expect(list.body.items.some((b: Json) => b.id === bundleId)).toBe(false);
    const all = await t.api<Json>('GET', '/intake/bundles?status=all&mode=all');
    const mine = all.body.items.find((b: Json) => b.id === bundleId);
    expect(mine.mode).toBe('catch_up');
    expect(mine.targetClaim.id).toBe(s.claim1.id);
  });

  it('reads the files and plans each one; auto apply files and records as agent:intake', async () => {
    const batch1 = [await ncafSent(s.claim1.reference), await insurerAck(s.claim1.reference), handlingRefRequest(s.claim1.reference, MAILBOX), clientEmail(s.claim1.reference, MAILBOX), photo()];
    const up1 = await uploadToBundle(t, bundleId, batch1);
    expect(up1.status).toBe(201);
    // the second batch partly through the chunked upload ({uploadId})
    const plain = await plainLetter(s.claim1.reference);
    const u = await t.api<Json>('POST', '/uploads', { filename: plain.filename, bytes: plain.content.length, mime: plain.mime, purpose: 'intake' });
    await t.app.inject({ method: 'PUT', url: `/api/uploads/${u.body.uploadId}?offset=0`, payload: plain.content, headers: { 'content-type': 'application/octet-stream' } });
    expect((await t.api('POST', `/uploads/${u.body.uploadId}/complete`, {})).status).toBe(201);
    expect((await t.api('POST', `/intake/bundles/${bundleId}/files`, { uploadId: u.body.uploadId })).status).toBe(201);
    const up2 = await uploadToBundle(t, bundleId, [v5cCopy(v5c), await otherClaimLetter(s.claim2.reference, OTHER.vrm, OTHER.name), await pack(s.claim1.reference)]);
    expect(up2.status).toBe(201);
    const done = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${inputId}/files-done`, {});
    expect(done.status).toBe(200);
    expect(done.body.catchUp.filesDone).toBe(true);
    const d = await settle();

    // per-file plan (§16.4)
    expect(file(d, 'CATCHUP-NCAF-SENT.pdf')).toMatchObject({ plan: 'file_and_record', direction: 'out', realDate: '2026-10-02', dateSource: 'document', kind: 'ncaf' });
    expect(file(d, 'CATCHUP-INSURER-ACK.pdf')).toMatchObject({ plan: 'file_and_record', direction: 'in', realDate: '2026-10-06', kind: 'acknowledgement' });
    expect(file(d, 'CATCHUP-HANDLING-REF-REQUEST.eml')).toMatchObject({ plan: 'file_and_record', direction: 'out', dateSource: 'email_header', kind: 'handling_ref_request' });
    expect(file(d, 'CATCHUP-HANDLING-REF-REQUEST.eml').realDate).toBe('2026-10-09T10:05:00.000Z');
    expect(file(d, 'CATCHUP-CLIENT-EMAIL.eml')).toMatchObject({ plan: 'file_and_record', direction: 'in', kind: 'client_message' });
    expect(file(d, 'CATCHUP-PHOTO.png')).toMatchObject({ plan: 'file_only', direction: 'none' });
    expect(file(d, 'CATCHUP-V5C-COPY.pdf')).toMatchObject({ plan: 'already_on_file', alreadyOnFile: { evidenceId: v5cId, how: 'same_file' }, filed: null });
    expect(file(d, 'CATCHUP-PLAIN-LETTER.pdf')).toMatchObject({ plan: 'ask', direction: 'unknown', planLabel: 'Who sent it?' });
    expect(file(d, 'CATCHUP-OTHER-CLAIM.pdf')).toMatchObject({ plan: 'other_claim', filed: null });
    expect(file(d, 'CATCHUP-OTHER-CLAIM.pdf').otherClaim.reference).toBe(s.claim2.reference);
    expect(file(d, 'CATCHUP-OTHER-CLAIM.pdf').planLabel).toBe(`Belongs to ${s.claim2.reference}`);
    const segments = d.catchUp.files.filter((f: Json) => f.role === 'segment');
    expect(segments).toHaveLength(3);
    expect(segments.map((f: Json) => f.docType)).toEqual(['police_report', 'bodyshop_estimate', 'mot_certificate']);
    expect(segments.every((f: Json) => f.filed)).toBe(true);
    // no date flags on documents that are not letters (V5C 2021, MOT March)
    expect(d.catchUp.blockers.filter((b: Json) => b.code === 'CHECK_DATE')).toEqual([]);
    expect(d.catchUp.blockers.map((b: Json) => b.code)).toEqual(expect.arrayContaining(['WHO_SENT', 'OTHER_CLAIM']));

    // automatic apply ran as agent:intake; only "Will do" lines
    const applied = audits(t.ctx, 'claim_ai.catch_up.apply').filter((a) => (a.after as Json)?.inputId === inputId);
    expect(applied.length).toBeGreaterThanOrEqual(1);
    expect(applied[0]!.user_id).toBe('agent:intake');
    expect(d.status).toBe('partly_applied');
    const ask = d.actions.find((a: Json) => a.type === 'record_correspondence' && a.bundleFileId === file(d, 'CATCHUP-PLAIN-LETTER.pdf').fileId);
    expect(ask.tier).toBe('confirm');
    expect(ask.state).toBe('proposed');
    // filed: every main file except the V5C copy and the other claim's letter (+ the pack's pages)
    const evidence = t.ctx.repos.listEvidenceForClaim(t.ctx.db, s.claim1.id);
    expect(evidence.filter((e) => e.filename === 'CATCHUP-V5C-COPY.pdf')).toHaveLength(0);
    expect(evidence.filter((e) => e.filename === 'CATCHUP-OTHER-CLAIM.pdf')).toHaveLength(0);
    for (const name of ['CATCHUP-NCAF-SENT.pdf', 'CATCHUP-INSURER-ACK.pdf', 'CATCHUP-HANDLING-REF-REQUEST.eml', 'CATCHUP-CLIENT-EMAIL.eml', 'CATCHUP-PHOTO.png', 'CATCHUP-PLAIN-LETTER.pdf']) expect(evidence.some((e) => e.filename === name), name).toBe(true);
    // back-dated events, marked recorded late
    const events = t.ctx.repos.listEvents(t.ctx.db, s.claim1.id);
    const late = events.filter((e) => (e.data as Json)?.recordedLate);
    expect(late.map((e) => e.type)).toEqual(expect.arrayContaining(['ncaf_sent', 'letter_in', 'handling_ref_received', 'email_in', 'email_out', 'estimate_received']));
    expect(events.find((e) => e.type === 'ncaf_sent')!.at.slice(0, 10)).toBe('2026-10-02');
    expect(events.find((e) => e.type === 'handling_ref_received')!.at.slice(0, 10)).toBe('2026-10-06');
    expect(late.every((e) => String((e.data as Json).lateSource?.filename ?? '').startsWith('CATCHUP-'))).toBe(true);
    // off-system correspondence records
    const records = t.ctx.repos.listCorrespondence(t.ctx.db, s.claim1.id);
    expect(records.map((r) => `${r.direction}:${r.kind}`).sort()).toEqual(['in:acknowledgement', 'in:client_message', 'out:handling_ref_request', 'out:ncaf']);
    // clocks: the NCAF and the handling reference met on their real dates
    const clocks = t.ctx.repos.listClocks(t.ctx.db, s.claim1.id);
    expect(clocks.find((c) => c.kind === 'gta_4_1_ncaf_1wd')).toMatchObject({ status: 'met' });
    expect(clocks.find((c) => c.kind === 'gta_4_1_ncaf_1wd')!.metAt!.slice(0, 10)).toBe('2026-10-02');
    expect(clocks.find((c) => c.kind === 'gta_4_2_handling_ref_5wd')!.metAt!.slice(0, 10)).toBe('2026-10-06');
    // read by rules only (agents off): the empty insurer reference waits on one confirm card
    const ref = d.actions.find((a: Json) => a.type === 'field_update' && a.params.target === 'claim.atFaultInsurerRef');
    expect(ref.state).toBe('needs_you');
    const card = t.ctx.repos.getNeedsYouItem(t.ctx.db, ref.result.refs.needsYouId);
    expect(card?.kind).toBe('confirm_fields');
    // the smart-intake engine stayed in its lane: no new-claim card, no auto-register, no signals
    const bundle = await t.api<Json>('GET', `/intake/bundles/${bundleId}`);
    expect(bundle.body.signals ?? []).toEqual([]);
    expect(bundle.body.status).not.toBe('registered');
    expect(t.ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM needs_you WHERE kind = 'new_claim'`).get()).toMatchObject({ n: 0 });
    expect(jobRows(t.ctx, 'intake.auto_register')).toHaveLength(0);
  });

  it('the catch-up view and its files carry exactly the keys of the contract (§11.1)', async () => {
    const d = await getInput(t, s.claim1.id, inputId);
    const keys = (o: Json) => Object.keys(o).sort();
    expect(keys(d.catchUp)).toEqual(['bundleId', 'readiness', 'autoApply', 'filesDone', 'fileCounts', 'files', 'willDo', 'blockers', 'note'].sort());
    expect(keys(d.catchUp.fileCounts)).toEqual(['total', 'read', 'inProgress', 'waitingAi', 'failed', 'skipped', 'duplicates'].sort());
    expect(keys(d.catchUp.files[0])).toEqual(
      ['fileId', 'itemId', 'evidenceId', 'filename', 'mime', 'bytes', 'role', 'parentFileId', 'segment', 'stage', 'stageLabel', 'waiting', 'docType', 'docTypeLabel', 'pages', 'groupKey', 'plan', 'planLabel', 'alreadyOnFile', 'duplicateOf', 'otherClaim', 'direction', 'directionWhy', 'directionConfidence', 'directionSetBy', 'realDate', 'dateSource', 'dateWhy', 'dateFlag', 'kind', 'kindLabel', 'counterparty', 'alreadyRecorded', 'evidenceKind', 'filed', 'recorded', 'fileUrl'].sort(),
    );
    expect(keys(d.bundle)).toEqual(['id', 'files', 'inProgress', 'filed'].sort());
  });

  it('the owner says the plain letter was sent by us on 5 October and files it', async () => {
    const before = await getInput(t, s.claim1.id, inputId);
    const plainId = file(before, 'CATCHUP-PLAIN-LETTER.pdf').fileId;
    const bad = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${inputId}/files/${plainId}`, { date: '2026-12-01' });
    expect(bad.status).toBe(400);
    const o = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${inputId}/files/${plainId}`, { direction: 'out', date: '2026-10-05' });
    expect(o.status).toBe(200);
    const f = file(o.body, 'CATCHUP-PLAIN-LETTER.pdf');
    expect(f).toMatchObject({ direction: 'out', directionSetBy: 'owner', realDate: '2026-10-05', dateSource: 'owner', plan: 'file_and_record' });
    const line = o.body.actions.find((a: Json) => a.type === 'record_correspondence' && a.bundleFileId === plainId);
    expect(line.state).toBe('proposed');
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${inputId}/apply`, { actions: [{ key: line.key, ticked: true }] });
    expect(r.status).toBe(200);
    const after = r.body.actions.find((a: Json) => a.key === line.key);
    expect(after.state).toBe('applied');
    const rec = t.ctx.repos.listCorrespondence(t.ctx.db, s.claim1.id).find((c) => c.at.startsWith('2026-10-05'));
    expect(rec?.direction).toBe('out');
    expect(rec?.createdBy).not.toMatch(/^agent:/);
    expect(r.body.whatChanged.lines.length).toBeGreaterThan(0);
    // nothing of this claim left to file → the bundle is attached
    expect(t.ctx.repos.requireIntakeBundle(t.ctx.db, bundleId).status).toBe('attached');
  });

  it('the owner confirms the insurer reference on the card', async () => {
    const d = await getInput(t, s.claim1.id, inputId);
    const ref = d.actions.find((a: Json) => a.type === 'field_update' && a.params.target === 'claim.atFaultInsurerRef');
    const res = await t.api<Json>('POST', `/needs-you/${ref.result.refs.needsYouId}/resolve`, { optionId: 'apply' });
    expect(res.status).toBe(200);
    expect(t.ctx.repos.requireClaim(t.ctx.db, s.claim1.id).atFaultInsurerRef).toBe('TPI/778812');
  });

  it('intake routes refuse the catch-up bundle', async () => {
    for (const path of ['register', 'attach', 'wizard-draft', 'think-again']) {
      const r = await t.api<Json>('POST', `/intake/bundles/${bundleId}/${path}`, path === 'attach' ? { claimId: s.claim1.id } : {});
      expect(r.status, path).toBe(409);
      expect(r.body.error.code).toBe('CATCH_UP_BUNDLE');
    }
    const p = await t.api<Json>('PATCH', `/claims/${s.claim1.id}/ai-input/${inputId}`, { autoApply: false });
    expect([200, 409]).toContain(p.status);
  });

  it('a catch-up with Apply automatically off waits for the owner', async () => {
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/catch-up`, { autoApply: false });
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect((await uploadToBundle(t, r.body.catchUp.bundleId, [photo()])).status).toBe(201);
    await t.api('POST', `/claims/${s.claim1.id}/ai-input/${id}/files-done`, {});
    await drainCatchUp(t);
    const d = await getInput(t, s.claim1.id, id);
    expect(d.status).toBe('preview');
    expect(d.actions.every((a: Json) => a.state === 'proposed' || a.type === 'private_note')).toBe(true);
    const on = await t.api<Json>('PATCH', `/claims/${s.claim1.id}/ai-input/${id}`, { autoApply: true });
    expect(on.status).toBe(200);
    expect(on.body.catchUp.autoApply).toBe(true);
    const wrong = await t.api<Json>('PATCH', `/claims/${s.claim1.id}/ai-input/${id}`, { autoApply: 'yes' });
    expect(wrong.status).toBe(400);
    const c = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${id}/cancel`, {});
    expect([200, 409]).toContain(c.status);
  });

  it("a letter naming our client's car (\"Vehicle: KX21 ABC\") never proposes it as the other side's registration", async () => {
    const r = await t.api<Json>('POST', `/claims/${s.claim2.id}/ai-input/catch-up`, { autoApply: false });
    expect(r.status).toBe(201);
    // As on a claim opened before the other vehicle is known (no third-party vehicle on file yet).
    t.ctx.handle.sqlite.prepare('UPDATE claims SET third_party_vehicle_id = NULL WHERE id = ?').run(s.claim2.id);
    const claim2 = t.ctx.repos.requireClaim(t.ctx.db, s.claim2.id);
    const ownPlate = t.ctx.repos.getVehicle(t.ctx.db, claim2.clientVehicleId!)!.registration;
    const letter = await textPdf([[
      INSURER, 'Claims Department, 1 Mutual Way, Sampleton SA1 1MP', 'Our ref: TPI/990011', `Your ref: ${s.claim2.reference}`, '7 October 2026',
      'Courtesy Cars Group UK Ltd', '44 Syon Lane, Isleworth, London TW7 5NQ', 'Dear Sirs,', `Our client: ${OTHER.name}. Vehicle: ${ownPlate}.`,
      'We acknowledge your letter and will revert.', 'Yours faithfully,', `Third Party Claims, ${INSURER}`,
    ]]);
    expect((await uploadToBundle(t, r.body.catchUp.bundleId, [{ filename: 'LETTER-NAMES-OUR-CAR.pdf', mime: 'application/pdf', content: letter }])).status).toBe(201);
    await t.api('POST', `/claims/${s.claim2.id}/ai-input/${r.body.id}/files-done`, {});
    await drainCatchUp(t);
    const d = await getInput(t, s.claim2.id, r.body.id);
    const norm = (v: unknown) => String(v).replace(/\s+/g, '').toUpperCase();
    const swapped = d.actions.filter((a: Json) => a.type === 'field_update' && /tp|third/i.test(String(a.params.target)) && /registration|vrm/i.test(String(a.params.target)) && norm(a.params.value) === norm(ownPlate));
    expect(swapped).toEqual([]);
  });
});
