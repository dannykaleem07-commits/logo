// owned by claimai-server
/**
 * Claim AI input end to end (docs/CLAIM-AI-INPUT.md §16.5): a claim opened late is caught up from nine documents the
 * owner had sent and received outside ClaimDesk, then kept current from typed updates — the agents act on it (the
 * Autopilot does not resend, the drafter attaches the report, holds are kept) and every step is audited as the owner,
 * undoable and in the daily log. Every document is generated at test time; no model or network is called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCUSATION_WORDS } from '@ccguk/domain';
import type { TestApp } from './helpers.js';
import { textPdf } from './fixtures/smartIntake/files.js';
import { uploadToBundle } from './fixtures/smartIntake/scenario.js';
import { addEvidence, audits, CLIENT, claimAiApp, drainCatchUp, getInput, jobRows, line, OTHER, postUpdate, seedScenario, setAgents, type Json, type Seeded } from './fixtures/claimai/scenario.js';
import { clientEmail, handlingRefRequest, insurerAck, ncafSent, otherClaimLetter, pack, photo, plainLetter, v5cBytes, v5cCopy } from './fixtures/claimai/files.js';
import { drain, MAILBOX, run, setUpMail, TOUCHES_NONE } from './fixtures/mail/helpers.js';
import { assemblePrompts } from '../ai/prompts.js';
import { CASE_REVIEW_SPEC } from '../casework/specs.js';
import { ALREADY_DONE_HEADER, INSTRUCTIONS_HEADER } from '../claimai/promptBlock.js';
import { afterReview, createEmailDraft } from '../mail/outbox.js';
import { compileDailyLog } from '../agent/dailyLog.js';

let t: TestApp;
let s: Seeded;
let catchUpId: string;
let bundleId: string;
let v5c: Buffer;
let hireUpdate: Json;
let holdUpdate: Json;
const ownerTexts = new Map<string, string>();

const file = (d: Json, name: string): Json => d.catchUp.files.find((f: Json) => f.filename === name);
const update = async (text: string): Promise<Json> => {
  const d = await postUpdate(t, s.claim1.id, text);
  ownerTexts.set(d.id, text);
  if (d.status !== 'interpreting') return d;
  await drain(t.ctx, 'claim.input_interpret');
  return getInput(t, s.claim1.id, d.id);
};
const apply = async (id: string, actions?: Json[]): Promise<Json> => {
  const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${id}/apply`, actions ? { actions } : {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

beforeAll(async () => {
  t = await claimAiApp({ agents: false });
  await setUpMail(t.ctx);
  s = await seedScenario(t);
  v5c = await v5cBytes();
  await addEvidence(t, s.claim1.id, 'V5C.pdf', 'v5c', v5c);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('claim AI input end to end', () => {
  it('1–2 catch-up: nine documents read, planned and filed automatically (agents off)', async () => {
    expect(s.claim1.reference).toBe('CCG-2026-00001');
    const c = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/catch-up`, { note: 'Claim opened late — what we sent by post and email' });
    expect(c.status).toBe(201);
    catchUpId = c.body.id;
    bundleId = c.body.catchUp.bundleId;
    expect((await uploadToBundle(t, bundleId, [await ncafSent(s.claim1.reference), await insurerAck(s.claim1.reference), handlingRefRequest(s.claim1.reference, MAILBOX), clientEmail(s.claim1.reference, MAILBOX), photo()])).status).toBe(201);
    const plain = await plainLetter(s.claim1.reference);
    const u = await t.api<Json>('POST', '/uploads', { filename: plain.filename, bytes: plain.content.length, mime: plain.mime, purpose: 'intake' });
    await t.app.inject({ method: 'PUT', url: `/api/uploads/${u.body.uploadId}?offset=0`, payload: plain.content, headers: { 'content-type': 'application/octet-stream' } });
    expect((await t.api('POST', `/uploads/${u.body.uploadId}/complete`, {})).status).toBe(201);
    expect((await t.api('POST', `/intake/bundles/${bundleId}/files`, { uploadId: u.body.uploadId })).status).toBe(201);
    expect((await uploadToBundle(t, bundleId, [v5cCopy(v5c), await otherClaimLetter(s.claim2.reference, OTHER.vrm, OTHER.name), await pack(s.claim1.reference)])).status).toBe(201);
    expect((await t.api('POST', `/claims/${s.claim1.id}/ai-input/${catchUpId}/files-done`, {})).status).toBe(200);
    await drainCatchUp(t);
    const d = await getInput(t, s.claim1.id, catchUpId);
    expect(d.catchUp.files.filter((f: Json) => f.role !== 'segment')).toHaveLength(9);
    expect(d.catchUp.files.filter((f: Json) => f.role === 'segment')).toHaveLength(3);
    expect(file(d, 'CATCHUP-PLAIN-LETTER.pdf').planLabel).toBe('Who sent it?');
    expect(file(d, 'CATCHUP-OTHER-CLAIM.pdf').filed).toBeNull();
    expect(file(d, 'CATCHUP-V5C-COPY.pdf').plan).toBe('already_on_file');
    expect(audits(t.ctx, 'claim_ai.catch_up.apply').some((a) => a.user_id === 'agent:intake' && (a.after as Json)?.inputId === catchUpId)).toBe(true);
    const records = t.ctx.repos.listCorrespondence(t.ctx.db, s.claim1.id);
    expect(records.map((r) => `${r.direction}:${r.kind}:${r.at.slice(0, 10)}`).sort()).toEqual(['in:acknowledgement:2026-10-06', 'in:client_message:2026-10-08', 'out:handling_ref_request:2026-10-09', 'out:ncaf:2026-10-02']);
    const events = t.ctx.repos.listEvents(t.ctx.db, s.claim1.id);
    const late = events.filter((e) => (e.data as Json)?.recordedLate);
    expect(late.length).toBeGreaterThanOrEqual(5);
    expect(late.every((e) => ((e as Json).createdBy ?? (e as Json).actor) === 'agent:intake')).toBe(true);
    expect(events.find((e) => e.type === 'handling_ref_received')!.at.slice(0, 10)).toBe('2026-10-06');
    const clocks = t.ctx.repos.listClocks(t.ctx.db, s.claim1.id);
    expect(clocks.find((k) => k.kind === 'gta_4_1_ncaf_1wd')!.metAt!.slice(0, 10)).toBe('2026-10-02');
    expect(clocks.find((k) => k.kind === 'gta_4_2_handling_ref_5wd')!.metAt!.slice(0, 10)).toBe('2026-10-06');
    expect(d.status).toBe('partly_applied');
  });

  it('3 the owner answers "Sent by us, 5 October", files it and confirms the insurer reference', async () => {
    const d = await getInput(t, s.claim1.id, catchUpId);
    const plainId = file(d, 'CATCHUP-PLAIN-LETTER.pdf').fileId;
    const o = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${catchUpId}/files/${plainId}`, { direction: 'out', date: '2026-10-05' });
    expect(o.status).toBe(200);
    const rec = o.body.actions.find((a: Json) => a.type === 'record_correspondence' && a.bundleFileId === plainId);
    const r = await apply(catchUpId, [{ key: rec.key, ticked: true }]);
    expect(r.actions.find((a: Json) => a.key === rec.key).state).toBe('applied');
    expect(t.ctx.repos.requireIntakeBundle(t.ctx.db, bundleId).status).toBe('attached');
    const ref = r.actions.find((a: Json) => a.type === 'field_update' && a.params.target === 'claim.atFaultInsurerRef');
    expect((await t.api('POST', `/needs-you/${ref.result.refs.needsYouId}/resolve`, { optionId: 'apply' })).status).toBe(200);
    expect(t.ctx.repos.requireClaim(t.ctx.db, s.claim1.id).atFaultInsurerRef).toBe('TPI/778812');
    expect(r.whatChanged.lines.length).toBeGreaterThan(0);
  });

  it('4 the Autopilot does not resend what was sent outside ClaimDesk', async () => {
    const r = await run(t.ctx, 'autopilot.tick', { claimId: s.claim1.id }, { claimId: s.claim1.id });
    expect(r.outcome.kind).toBe('done');
    expect(t.ctx.repos.listOutbox(t.ctx.db, { claimId: s.claim1.id }).filter((o) => o.kind === 'handling_ref_request' || o.kind === 'ncaf_cover')).toHaveLength(0);
    const docs = t.ctx.handle.sqlite.prepare('SELECT template_id FROM documents WHERE claim_id = ?').all(s.claim1.id) as Array<{ template_id: string }>;
    expect(docs.filter((x) => x.template_id === 'letter.ncaf' || x.template_id === 'letter.handling_ref_request')).toHaveLength(0);
    const view = (await t.api<Json>('GET', `/claims/${s.claim1.id}/autopilot`)).body;
    expect((view.plan?.steps ?? view.steps).find((x: Json) => (x.stepId ?? x.id) === 'notify.ncaf')?.status).toBe('done');
  });

  it('5 agents on: "client called, car repaired, hire ended yesterday" → Do it', async () => {
    setAgents(t.ctx, true);
    hireUpdate = await update('client called, car repaired, hire ended yesterday');
    expect(hireUpdate.engine).toBe('rules');
    const r = await apply(hireUpdate.id);
    expect(t.ctx.repos.requireHire(t.ctx.db, s.hire.id).endAt!.slice(0, 10)).toBe('2026-10-11');
    expect(r.whatChanged.lines.some((l: Json) => l.kind === 'hire')).toBe(true);
    expect(r.whatChanged.clocks.length).toBeGreaterThan(0);
  });

  it('6 "TP insurer admitted liability on the phone today and gave AB123 as their number" → the owner ticks liability, leaves the reference', async () => {
    // ("…, ref AB123" is read by the phrase parser alone — parse.test.ts P12; this wording needs the AI for the number.)
    const d = await update('TP insurer admitted liability on the phone today and gave AB123 as their number');
    expect(d.engine).toBe('rules_ai');
    const ref = line(d, 'field_update');
    expect(ref).toMatchObject({ tier: 'confirm', current: 'TPI/778812', ticked: false });
    const liab = line(d, 'liability_position');
    await apply(d.id, [{ key: liab.key, ticked: true }, { key: ref.key, ticked: false }]);
    const claim = t.ctx.repos.requireClaim(t.ctx.db, s.claim1.id);
    expect(claim.liability).toBe('admitted');
    expect(claim.atFaultInsurerRef).toBe('TPI/778812');
    expect((t.ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM memory_items WHERE kind = 'correction' AND data LIKE '%aiInputAction%'`).get() as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it('7 "don\'t chase the client until Monday" → held: a client email asks the owner; the prompts carry it', async () => {
    holdUpdate = await update("don't chase the client until Monday");
    await apply(holdUpdate.id);
    const ins = (await t.api<Json>('GET', `/claims/${s.claim1.id}/instructions?status=active`)).body.items.find((i: Json) => i.source?.inputId === holdUpdate.id);
    expect(ins.until).toBe('2026-10-18T23:00:00.000Z');
    const draft = createEmailDraft(t.ctx, { claimId: s.claim1.id, kind: 'ack', to: [CLIENT.email], cc: [], subject: 'Your claim', bodyText: 'Dear Jane,\n\nWe are working on your claim.\n\nClaims Team', attach: [], inReplyToMessageId: null } as never, 'agent:mail', { loop: 0 });
    const review = t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'outbox', targetId: draft.outbox.id, claimId: s.claim1.id, loop: 0, rules: { issues: [] }, facts: { issues: [] }, critic: { confidence: 0.97, issues: [] }, verdict: 'pass', touches: TOUCHES_NONE, now: t.ctx.now() });
    const ar = await afterReview(t.ctx, draft.outbox.id, review.id, { id: 'e2e-job', correlationId: null } as never);
    expect(ar.outcome).toBe('asked');
    expect(t.ctx.repos.requireOutbox(t.ctx.db, draft.outbox.id).status).toBe('awaiting_approval');
    expect(JSON.stringify(t.ctx.repos.requireOutbox(t.ctx.db, draft.outbox.id).policy)).toContain('owner_instruction');
    const prompt = assemblePrompts(CASE_REVIEW_SPEC, { task: 'Review the claim.', brief: { claimId: s.claim1.id }, question: 'Return JSON.' }, t.ctx, { claimId: s.claim1.id });
    expect(prompt.user).toContain(INSTRUCTIONS_HEADER);
    expect(prompt.user).toContain(ALREADY_DONE_HEADER);
    expect(prompt.user).toMatch(/New Claim Advice Form/);
  });

  it('8 "send the engineer report to the insurer" → a draft attaching it, through review', async () => {
    const ev = await addEvidence(t, s.claim1.id, 'ENGINEER-REPORT.pdf', 'engineer_report', await textPdf([['Engineer report', `Vehicle ${CLIENT.vrm}`, 'Repairable']]));
    const d = await update('send the engineer report to the insurer');
    expect(line(d, 'run_job').params.evidenceIds).toEqual([ev.id]);
    await apply(d.id);
    const job = jobRows(t.ctx, 'draft.compose').find((j) => String(j.idempotency_key).startsWith(`draft.compose:ai-input:${d.id}:`));
    expect(job?.payload.attachEvidenceIds).toEqual([ev.id]);
    await drain(t.ctx, 'draft.compose');
    const out = t.ctx.repos.listOutbox(t.ctx.db, { claimId: s.claim1.id }).find((o) => o.attachmentsJson.some((a) => (a as Json).evidenceId === ev.id));
    expect(out?.status).toBe('reviewing');
  });

  it('9 a solicitor → legal review + hold; "the client is lying, decline it" → private note + a question; nothing declined', async () => {
    const sol = await update('client now has a solicitor');
    const r = await apply(sol.id);
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, line(r, 'legal').result.refs.needsYouId)?.kind).toBe('legal_review');
    const acc = await update('the client is lying, decline it');
    expect(line(acc, 'private_note').tier).toBe('private');
    const r2 = await apply(acc.id);
    expect(line(r2, 'close_or_decline').state).toBe('needs_you');
    expect(t.ctx.repos.requireClaim(t.ctx.db, s.claim1.id).status).not.toBe('declined');
    // the words appear in no prompt, event, outbox body or daily-log line
    const prompt = assemblePrompts(CASE_REVIEW_SPEC, { task: 'Review the claim.', brief: { claimId: s.claim1.id }, question: 'Return JSON.' }, t.ctx, { claimId: s.claim1.id });
    // (the knowledge base may discuss fraud markers as law; the owner's suspicion itself never reaches a prompt)
    expect(prompt.user).not.toMatch(/client is lying/i);
    expect(prompt.user).not.toMatch(/\blying\b/i);
    for (const e of t.ctx.repos.listEvents(t.ctx.db, s.claim1.id)) expect(ACCUSATION_WORDS.test(`${e.summary} ${JSON.stringify(e.data ?? {})}`), e.type).toBe(false);
    for (const o of t.ctx.repos.listOutbox(t.ctx.db, { claimId: s.claim1.id })) expect(ACCUSATION_WORDS.test(`${o.subject} ${o.bodyText}`)).toBe(false);
  });

  it('10 Undo: the hire end re-opens the hire; Undo all on the hold retires it', async () => {
    const end = line(hireUpdate, 'hire_end');
    const u = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${hireUpdate.id}/undo`, { actionKeys: [end.key] });
    expect(u.status).toBe(200);
    expect(t.ctx.repos.requireHire(t.ctx.db, s.hire.id).endAt ?? null).toBeNull();
    const all = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${holdUpdate.id}/undo`, {});
    expect(all.status).toBe(200);
    expect(all.body.status).toBe('undone');
    const ins = (await t.api<Json>('GET', `/claims/${s.claim1.id}/instructions`)).body.items.find((i: Json) => i.source?.inputId === holdUpdate.id);
    expect(ins.status).toBe('retired');
  });

  it('11 daily log, audit trail, append-only tables and the owner\'s words', async () => {
    const log = compileDailyLog(t.ctx, '2026-10-12');
    const texts = (log.sections.claimAi ?? []).map((l) => l.text);
    expect(texts.some((x) => x.startsWith(`Caught up ${s.claim1.reference}:`))).toBe(true);
    expect(texts.some((x) => x.startsWith(`Your update on ${s.claim1.reference}:`))).toBe(true);
    expect(texts.some((x) => x.startsWith(`Standing instruction on ${s.claim1.reference}:`))).toBe(true);
    expect(texts.some((x) => ACCUSATION_WORDS.test(x))).toBe(false);
    for (const a of ['claim_ai.input.create', 'claim_ai.input.apply', 'claim_ai.catch_up.create', 'claim_ai.catch_up.apply', 'claim_ai.instruction.create', 'claim_ai.action.undo']) expect(audits(t.ctx, a).length, a).toBeGreaterThan(0);
    const sql = t.ctx.handle.sqlite;
    expect(() => sql.prepare('UPDATE claim_ai_input_log SET note = ? WHERE input_id = ?').run('x', hireUpdate.id)).toThrow();
    expect(() => sql.prepare('DELETE FROM claim_ai_input_log WHERE input_id = ?').run(hireUpdate.id)).toThrow();
    expect(() => sql.prepare('UPDATE claim_correspondence SET kind = ?').run('other_out')).toThrow();
    expect(() => sql.prepare('DELETE FROM claim_correspondence').run()).toThrow();
    expect(() => sql.prepare('DELETE FROM claim_ai_inputs WHERE id = ?').run(hireUpdate.id)).toThrow();
    expect(() => sql.prepare('UPDATE claim_ai_inputs SET text = ? WHERE id = ?').run('changed', hireUpdate.id)).toThrow();
    for (const [id, text] of ownerTexts) expect(t.ctx.repos.requireAiInput(t.ctx.db, id).text).toBe(text);
  });
});
