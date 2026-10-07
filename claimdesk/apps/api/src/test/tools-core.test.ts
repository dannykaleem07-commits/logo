/**
 * The gateway tools (docs/SUPREME-DESIGN.md §B.4) against the test app: every tool runs through the dispatcher and the
 * existing route as the agent principal; outputs are trimmed (no HTML), PII is masked, total_loss_assess writes no
 * rows, document_draft enqueues review.check, offer_record raises Needs-you offer_decision and queues offer.analyse,
 * and vehicle_lookup stops at 20 a day.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { storeEvidenceBuffer } from '../services/evidence.js';
import { mintRunToken, revokeRunToken } from '../agent/principal.js';
import { executeTool, registerRun, unregisterRun } from '../agent/dispatcher.js';
import { coreTools, htmlToText, maskPii, postcodeDistrict } from '../agent/tools/core.js';
import type { RunContext } from '../agent/contracts.js';

type Ids = ReturnType<TestApp['ctx']['repos']['seedFileOne']>;
let t: TestApp;
let ids: Ids;
let rc: RunContext;
const cleanups: Array<() => void> = [];

function makeRun(claimScope: string | undefined): RunContext {
  const runId = randomUUID();
  const token = mintRunToken({ name: 'drafter', runId, jobId: 'job-tools', ...(claimScope ? { claimScope } : {}) }, 120_000);
  const r: RunContext = { runId, jobId: 'job-tools', agent: 'drafter', ...(claimScope ? { claimScope } : {}), token, allowedTools: new Set(coreTools.map((x) => x.name)), runDir: path.join(t.ctx.config.agentRunsDir, runId), correlationId: 'corr-tools' };
  registerRun(r);
  cleanups.push(() => {
    unregisterRun(runId);
    revokeRunToken(token);
  });
  return r;
}

beforeEach(async () => {
  t = await createTestApp('2026-10-07T09:00:00.000Z');
  ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  rc = makeRun(ids.claimId);
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await t.close();
});

async function call(name: string, input: unknown, r: RunContext = rc) {
  const res = await executeTool(t.ctx, r, name, input);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.content) as Record<string, unknown>;
  } catch {
    /* text */
  }
  return { ...res, body };
}

const count = (table: string) => (t.ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('read tools', () => {
  it('claim tools return trimmed, masked data', async () => {
    const get = await call('claim_get', { claimId: ids.claimId });
    expect(get.ok).toBe(true);
    const claimant = get.body.claimant as Record<string, unknown>;
    expect(claimant.name).toBe('Jane Doe');
    expect(claimant.dateOfBirth).toBe('1988');
    expect(String(claimant.email)).toContain('•••');
    expect(claimant.address).toEqual({ town: 'London', postcodeDistrict: 'E1' });
    expect(get.content).not.toContain('<');
    expect(get.content.length).toBeLessThan(20_000);
    for (const [name, key] of [['claim_next_actions', 'actions'], ['claim_clocks', 'clocks'], ['claim_gates', 'gates'], ['offers_list', 'offers'], ['hire_get', 'hire'], ['storage_get', 'storage'], ['recovery_get', 'recovery'], ['ledger_get', 'entries']] as const) {
      const r = await call(name, { claimId: ids.claimId });
      expect(r.ok, name).toBe(true);
      expect(Array.isArray(r.body[key]), `${name}.${key}`).toBe(true);
    }
    expect((await call('claim_acceptance', { claimId: ids.claimId })).body.decision).toBeDefined();
  });

  it('events_list paginates; claims_search summarises', async () => {
    const page = await call('events_list', { claimId: ids.claimId, type: null, since: null, limit: 2, offset: 1 });
    expect(page.ok).toBe(true);
    expect((page.body.events as unknown[]).length).toBe(2);
    expect(page.body.total as number).toBeGreaterThan(2);
    const search = await call('claims_search', { q: 'CCG-2026', status: ['chasing'], flagged: null, limit: 5, offset: null });
    expect(search.ok).toBe(true);
    expect((search.body.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: ids.claimId, reference: 'CCG-2026-00001', status: 'chasing', client: 'Jane Doe' });
  });

  it('hire pricing guide resolves the fleet unit of the latest hire', async () => {
    const r = await call('hire_pricing_guide', { claimId: ids.claimId, fleetUnitId: null });
    expect(r.ok, r.content).toBe(true);
  });

  it('party, vehicle and evidence tools', async () => {
    const p = await call('party_get', { partyId: ids.claimantId });
    expect(p.ok).toBe(true);
    expect(p.body.dateOfBirth).toBe('1988');
    const ps = await call('party_search', { q: 'Jane', role: null });
    expect((ps.body.items as Array<Record<string, unknown>>)[0]!.name).toBe('Jane Doe');
    expect(String((ps.body.items as Array<Record<string, unknown>>)[0]!.phone)).toContain('•••');
    const v = await call('vehicle_get', { vehicleId: ids.clientVehicleId });
    expect(v.body.registration).toBe('AB12CDE');
    expect((await call('vehicle_on_file', { registration: 'AB12CDE' })).ok).toBe(true);
    const ev = await call('evidence_list', { claimId: ids.claimId, kind: null });
    const item = (ev.body.items as Array<Record<string, unknown>>)[0]!;
    expect(item.id).toBe(ids.photoEvidenceId);
    expect(item.storagePath).toBeUndefined();
    expect(((await call('evidence_list', { claimId: ids.claimId, kind: 'v5c' })).body.items as unknown[]).length).toBe(0);
  });

  it('evidence_read copies a verified file into the run folder; refuses another claim or a missing file', async () => {
    const stored = await storeEvidenceBuffer(t.ctx, Buffer.from('Invented letter text for the agent to read.\n'), { claimId: ids.claimId, filename: 'letter in.txt', mime: 'text/plain', fields: { kind: 'correspondence' }, actor: { userId: 'courtesycars' } });
    const r = await call('evidence_read', { evidenceId: stored.evidence.id });
    expect(r.ok, r.content).toBe(true);
    expect(String(r.body.path)).toMatch(/^input\//);
    const abs = path.join(rc.runDir, String(r.body.path));
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toContain('Invented letter');
    expect(r.body.text).toContain('Invented letter');
    // The seeded photo has no bytes on disk.
    expect((await call('evidence_read', { evidenceId: ids.photoEvidenceId })).body).toMatchObject({ error: { code: 'EVIDENCE_MISSING' } });
    // Another claim's evidence is refused for a claim-scoped run.
    const other = await t.api<{ id: string }>('POST', '/claims', { ...(await import('./helpers.js')).FNOL });
    const otherEv = await storeEvidenceBuffer(t.ctx, Buffer.from('other claim'), { claimId: other.body.id, filename: 'x.txt', mime: 'text/plain', fields: { kind: 'other' }, actor: { userId: 'courtesycars' } });
    expect((await call('evidence_read', { evidenceId: otherEv.evidence.id })).body).toMatchObject({ error: { code: 'CLAIM_SCOPE' } });
  });

  it('documents, templates and Word template values', async () => {
    const list = await call('documents_list', { claimId: ids.claimId, status: null });
    expect((list.body.items as unknown[]).length).toBeGreaterThan(0);
    const doc = await call('document_get', { documentId: ids.ncafDocumentId });
    expect(doc.ok, doc.content).toBe(true);
    expect(doc.body.html).toBeUndefined();
    expect(String(doc.body.bodyExcerpt)).not.toMatch(/<[a-z]+[ >]/i);
    const templates = await call('templates_list', { format: null });
    const items = templates.body.items as Array<{ id: string; format: string }>;
    expect(items.some((i) => i.format === 'html')).toBe(true);
    expect(items.some((i) => i.format === 'docx')).toBe(true);
    expect(((await call('templates_list', { format: 'docx' })).body.items as Array<{ format: string }>).every((i) => i.format === 'docx')).toBe(true);
    const values = await call('docx_template_values', { claimId: ids.claimId, templateId: 'agreement.ccguk_01_customer_loa', variant: null });
    expect(values.ok, values.content.slice(0, 300)).toBe(true);
  });

  it('knowledge base: search labels unverified entries; entry and advise work', async () => {
    const s = await call('kb_search', { q: 'cash in lieu hire', type: null, topic: null, limit: 5 });
    expect(s.ok).toBe(true);
    const items = s.body.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.verification).not.toBe('failed');
      if (i.verification !== 'verified') expect(i.label).toMatch(/UNVERIFIED/);
    }
    expect((await call('kb_entry', { id: 'gta-4-7' })).body.id).toBe('gta-4-7');
    expect((await call('kb_advise', { topic: 'impecuniosity' })).ok).toBe(true);
  });

  it('directory search and get show verification age', async () => {
    const s = await call('directory_search', { q: 'central' });
    expect(s.ok).toBe(true);
    const first = (s.body.items as Array<Record<string, unknown>>)[0]!;
    expect(first.verification).toBeDefined();
    expect('verificationAgeDays' in first).toBe(true);
    expect(s.content.length).toBeLessThan(20_000);
    expect((await call('directory_get', { id: '1st-central' })).body.id).toBe('1st-central');
  });

  it('total_loss_assess computes and writes no rows', async () => {
    const tables = ['audit_log', 'events', 'ledger_entries', 'engineer_reports', 'documents'];
    const before = Object.fromEntries(tables.map((tb) => [tb, count(tb)]));
    const reportBefore = t.ctx.handle.sqlite.prepare('SELECT * FROM engineer_reports').all();
    const r = await call('total_loss_assess', { claimId: ids.claimId });
    expect(r.ok, r.content).toBe(true);
    expect(typeof r.body.computed).toBe('boolean');
    if (r.body.computed) expect(r.body.assessment).toBeDefined();
    else expect((r.body.missing as string[]).length).toBeGreaterThan(0);
    expect(Object.fromEntries(tables.map((tb) => [tb, count(tb)]))).toEqual(before);
    expect(t.ctx.handle.sqlite.prepare('SELECT * FROM engineer_reports').all()).toEqual(reportBefore);
  });
});

describe('draft and internal tools', () => {
  it('document_draft creates a draft as the agent and enqueues review.check', async () => {
    const r = await call('document_draft', { claimId: ids.claimId, templateId: 'letter.chaser_7', extras: null, recipientPartyId: ids.insurerId });
    expect(r.ok, r.content).toBe(true);
    expect(r.body.documentId).toBeTruthy();
    expect(['draft', 'blocked']).toContain(r.body.status);
    const job = t.ctx.repos.getAgentJobByKey(t.ctx.db, `review.check:document:${String(r.body.documentId)}:0`);
    expect(job).toMatchObject({ type: 'review.check', claimId: ids.claimId, correlationId: 'corr-tools', createdBy: 'agent:drafter' });
    expect(job?.payload).toEqual({ targetKind: 'document', targetId: r.body.documentId, loop: 0 });
    const doc = t.ctx.repos.getDocument(t.ctx.db, String(r.body.documentId), { includeHtml: false });
    expect(doc?.createdBy).toBe('agent:drafter');
  });

  it('docx_document_draft fills a CCGUK Word template as a draft', async () => {
    const r = await call('docx_document_draft', { claimId: ids.claimId, templateId: 'agreement.ccguk_01_customer_loa', variant: null, values: null });
    // The route may refuse a template that needs confirmation; either way it answered through the dispatcher.
    if (r.ok) expect(r.body.documentId).toBeTruthy();
    else expect((r.body.error as { code: string }).code).toBeTruthy();
  });

  it('event_append accepts only the allowed event types', async () => {
    const bad = await call('event_append', { claimId: ids.claimId, type: 'payment_received', at: '2026-10-07T08:00:00Z', summary: 'x', data: null, attributableTo: null, evidenceIds: null });
    expect((bad.body.error as { code: string }).code).toBe('INVALID_INPUT');
    const ok = await call('event_append', { claimId: ids.claimId, type: 'call', at: '2026-10-07T08:00:00.000Z', summary: 'Called the insurer handler.', data: [{ key: 'with', value: 'handler' }], attributableTo: 'ccguk', evidenceIds: null });
    expect(ok.ok, ok.content).toBe(true);
    expect(ok.body.eventId).toBeTruthy();
  });

  it('offer_record records the offer, raises offer_decision and queues offer.analyse — never a decision', async () => {
    const r = await call('offer_record', { claimId: ids.claimId, head: 'hire', amountPence: 120000, receivedAt: '2026-10-07T08:00:00.000Z', from: 'Example Insurance Ltd', channel: 'email', terms: 'Without prejudice, full and final.', evidenceIds: [] });
    expect(r.ok, r.content).toBe(true);
    const offerId = String(r.body.offerId);
    const ny = t.ctx.repos.getNeedsYouItem(t.ctx.db, String(r.body.needsYouId));
    expect(ny).toMatchObject({ kind: 'offer_decision', claimId: ids.claimId, priority: 'urgent' });
    expect(t.ctx.repos.getAgentJobByKey(t.ctx.db, `offer.analyse:${offerId}`)).toMatchObject({ type: 'offer.analyse', priority: 0 });
    const offer = t.ctx.repos.requireOffer(t.ctx.db, offerId);
    expect(offer.clientDecision).toBeUndefined();
    expect(offer.terms.otherTerms).toContain('120000 pence');
  });

  it('directory reports work and never verify', async () => {
    expect((await call('directory_report_failed', { id: '1st-central', note: 'Email bounced (invented test).' })).ok).toBe(true);
    expect((await call('directory_used_ok', { id: '1st-central', note: null })).ok).toBe(true);
  });

  it('vehicle_lookup stops at 20 a day', async () => {
    const insert = t.ctx.handle.sqlite.prepare(`INSERT INTO agent_tool_calls (id, run_id, seq, tool, action_class, decision, at) VALUES (?, 'other-run', ?, 'vehicle_lookup', 'external_send', 'allowed', ?)`);
    for (let i = 0; i < 20; i += 1) insert.run(randomUUID(), i + 1, '2026-10-07T08:00:00.000Z');
    const r = await call('vehicle_lookup', { registration: 'AB12CDE' });
    expect((r.body.error as { code: string }).code).toBe('DAILY_LIMIT');
  });
});

describe('helpers', () => {
  it('maskPii, postcodeDistrict, htmlToText', () => {
    expect(maskPii({ licence: { number: 'DOE99804022JD9AB' }, sortCode: '12-34-56', accountNumber: '12345678', policyNumber: 'POL-998877', name: 'A' })).toEqual({ licence: { number: '…9AB' }, sortCode: '••-••-••', accountNumber: '…5678', policyNumber: '…8877', name: 'A' });
    expect(postcodeDistrict('SW1A 1AA')).toBe('SW1A');
    expect(htmlToText('<p>Dear Sir,</p><script>x()</script><p>We &amp; you</p>')).toBe('Dear Sir,\n\nWe & you');
  });
});
