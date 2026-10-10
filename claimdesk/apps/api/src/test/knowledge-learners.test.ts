// owned by knowledge-learners
/**
 * Knowledge learners (docs/SUPREME-KNOWLEDGE-BUILDER.md §6, §14 scenarios 1–3): insurer statistics with n, contacts
 * from verified signatures (copycat → spoof warning, directory difference → conflict card), offers from both
 * registers, corrections → the curator (FakeDriver fixture), engineering figures (Audatex → code_only), the owner's
 * own wording as snippets, the kill switch and the routes. Every insurer, person, number and domain is invented; no
 * model and no network are used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addWorkingDays, type InsurerDirectoryEntry, type InsurerProfileData, type KnowledgeItem } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { mintRunToken } from '../agent/principal.js';
import { createNeedsYou, enqueueJob } from '../agent/core.js';
import { resolveNeedsYouItem } from '../agent/needsYou.js';
import { getJobHandler } from '../agent/handlers/index.js';
import type { JobRecord } from '../agent/contracts.js';
import { setLearningEnabled } from '../knowledge/settings.js';
import { knowledgeHooks } from '../knowledge/hooks.js';
import { proposeKnowledge } from '../knowledge/store.js';
import { executorFor } from '../agent/dispatcher.js';

// Seeding claims and running the learners is real SQLite work: allow for a busy machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NOW = '2026-10-10T10:00:00.000Z';
const OWNER = { userId: 'courtesycars' };
const DOMAIN = 'example-insurer.test';

const DIRECTORY: InsurerDirectoryEntry[] = [
  {
    id: 'example-insurer',
    name: 'Example Insurance Ltd',
    brands: ['Example Direct'],
    claimsEmail: `claims@${DOMAIN}`,
    thirdPartyClaimsPhone: '0161 496 0000',
    copycatDomains: ['examp1e-insurer.test'],
    copycatNumbers: [],
    verification: { status: 'unverified' } as InsurerDirectoryEntry['verification'],
  },
  {
    id: 'sample-mutual',
    name: 'Sample Mutual',
    brands: [],
    claimsEmail: 'claims@sample-mutual.test',
    copycatDomains: [],
    copycatNumbers: [],
    verification: { status: 'unverified' } as InsurerDirectoryEntry['verification'],
  },
];

let t: TestApp;
let seq = 0;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  t.ctx.kb.directory = () => DIRECTORY;
  seq = 0;
});
afterEach(async () => {
  await t.close();
});

const sql = (text: string, ...params: unknown[]) => t.ctx.handle.sqlite.prepare(text).run(...params);
const rows = <T>(text: string, ...params: unknown[]) => t.ctx.handle.sqlite.prepare(text).all(...params) as T[];

const insurerParties = new Map<string, string>();
function insurerParty(name: string): string {
  if (!insurerParties.has(`${t.ctx.config.dataDir}|${name}`)) insurerParties.set(`${t.ctx.config.dataDir}|${name}`, t.ctx.repos.createParty(t.ctx.db, { kind: 'company', name, roles: ['insurer'] } as never).id);
  return insurerParties.get(`${t.ctx.config.dataDir}|${name}`)!;
}

function makeClaim(insurerName: string, o: { make?: string; model?: string } = {}): { id: string; vehicleId: string } {
  seq += 1;
  const claimant = t.ctx.repos.createParty(t.ctx.db, { kind: 'individual', name: `Pat Example${seq}`, roles: ['claimant'] } as never);
  const vehicle = t.ctx.repos.upsertVehicle(t.ctx.db, { registration: `KX${String(10 + seq).slice(-2)}ABC`, make: o.make ?? 'Testmake', model: o.model ?? 'Alpha 1.0', ownership: 'client' } as never);
  const claim = t.ctx.repos.createClaim(t.ctx.db, {
    openedAt: '2026-05-01T09:00:00.000Z',
    accident: { occurredAt: '2026-04-20T10:00:00.000Z', location: 'Invented Road', circumstances: 'Invented test accident.' },
    liability: 'admitted',
    claimantId: claimant.id,
    clientVehicleId: vehicle.id,
    thirdPartyIds: [],
    atFaultInsurerId: insurerParty(insurerName),
  } as never);
  return { id: claim.id, vehicleId: vehicle.id };
}

const ledger = (claimId: string, head: string, kind: string, amountPence: number, date: string) => t.ctx.repos.appendLedgerEntry(t.ctx.db, { claimId, head, kind, amountPence, date, description: `${kind} ${head}`, createdBy: 'courtesycars' } as never);
const event = (claimId: string, type: string, at: string, data?: Record<string, unknown>) => t.ctx.repos.appendEvent(t.ctx.db, { claimId, type, at, summary: type, createdBy: 'courtesycars', ...(data ? { data } : {}) } as never);

async function runJob(type: Parameters<typeof enqueueJob>[1]['type'], payload: unknown, createdBy = 'agent:supervisor', job?: JobRecord) {
  const j = job ?? enqueueJob(t.ctx, { type, payload, idempotencyKey: `test:${type}:${Math.random()}`, createdBy });
  return getJobHandler(type)!.run({ ctx: t.ctx, job: j, payload: j.payload as never, signal: new AbortController().signal, log: t.ctx.logger });
}

const active = (key: string): KnowledgeItem | undefined => t.ctx.repos.activeKnowledgeByKey(t.ctx.db, key);

// ---------------------------------------------------------------------------

describe('L1 statistics (scenario 1)', () => {
  function seedPaidClaims(insurer: string, n: number, offset = 0): string[] {
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) {
      const c = makeClaim(insurer);
      const packAt = '2026-06-01T09:00:00.000Z';
      ledger(c.id, 'hire', 'claimed', 100_000, '2026-05-20');
      ledger(c.id, 'hire', 'reduced', 10_000, '2026-06-05');
      ledger(c.id, 'hire', 'paid', 90_000, addWorkingDays(packAt, 10 + i + offset).slice(0, 10));
      event(c.id, 'payment_pack_sent', packAt);
      ids.push(c.id);
    }
    return ids;
  }

  it('links insurers by exact name, builds a profile with n and hand-checkable medians; n = 2 is "too few claims"', async () => {
    seedPaidClaims('Example Insurance Ltd', 12);
    seedPaidClaims('Sample Mutual', 2);
    const out = await runJob('knowledge.learn_stats', {});
    expect(out.kind).toBe('done');
    expect(t.ctx.repos.listInsurerLinks(t.ctx.db).map((l) => [l.insurerSlug, l.method, l.decidedBy]).sort()).toEqual([
      ['example-insurer', 'exact_name', 'agent:supervisor'],
      ['sample-mutual', 'exact_name', 'agent:supervisor'],
    ]);
    const all = active('profile:example-insurer:all')!;
    expect(all).toMatchObject({ kind: 'insurer_profile', origin: 'computed', useLimit: 'internal', status: 'active', verification: 'unverified', supportN: 12 });
    const p = all.data as InsurerProfileData;
    expect(p.n).toEqual({ claims: 12, settled: 12 });
    // working days 11..22 → nearest-rank median (6th) 16, p90 (11th) 21
    expect(p.daysToPay).toEqual({ medianWorkingDays: 16, p90WorkingDays: 21, n: 12 });
    expect(p.heads.hire?.paidOfClaimedPct).toEqual({ median: 90, p25: 90, p75: 90, n: 12 });
    expect(all.autonomy.ruleIds).toEqual(['KN-14']);
    expect(active('profile:example-insurer:12m')).toBeDefined();
    expect(active('profile:sample-mutual:all')).toBeUndefined();
    const sample = await t.api<{ tooFewClaims: boolean; profileAll: unknown }>('GET', '/knowledge/insurers/sample-mutual');
    expect(sample.body).toMatchObject({ tooFewClaims: true, profileAll: null });
    const list = await t.api<{ insurers: { insurerSlug: string; claims: number; medianWorkingDaysToPay: number | null }[] }>('GET', '/knowledge/insurers');
    expect(list.body.insurers).toEqual(expect.arrayContaining([expect.objectContaining({ insurerSlug: 'example-insurer', claims: 12, medianWorkingDaysToPay: 16 })]));
    expect(rows<{ c: number }>(`SELECT count(*) AS c FROM claim_outcomes`)[0]!.c).toBe(14);
  });

  it('a profile is superseded only when a figure changes', async () => {
    seedPaidClaims('Example Insurance Ltd', 4);
    await runJob('knowledge.learn_stats', {});
    const first = active('profile:example-insurer:all')!;
    t.setNow('2026-10-11T10:00:00.000Z');
    await runJob('knowledge.learn_stats', {});
    expect(t.ctx.repos.listKnowledgeItemVersions(t.ctx.db, 'profile:example-insurer:all')).toHaveLength(1);
    seedPaidClaims('Example Insurance Ltd', 1, 20);
    await runJob('knowledge.learn_stats', {});
    const versions = t.ctx.repos.listKnowledgeItemVersions(t.ctx.db, 'profile:example-insurer:all');
    expect(versions.map((v) => v.status)).toEqual(['active', 'superseded']);
    expect(versions[1]!.id).toBe(first.id);
  });

  it('an ambiguous insurer name asks the owner; the answer is applied as the owner', async () => {
    seedPaidClaims('Example Insurance Services', 1);
    await runJob('knowledge.learn_stats', {});
    const q = rows<{ id: string; options: string }>(`SELECT id, options FROM needs_you WHERE kind = 'question' AND dedupe_key LIKE 'knowledge.link:%'`);
    expect(q).toHaveLength(1);
    expect(JSON.parse(q[0]!.options).map((o: { id: string }) => o.id)).toContain('insurer:example-insurer');
    const unlinked = await t.api<{ parties: { name: string }[] }>('GET', '/knowledge/insurer-links?unlinked=1');
    expect(unlinked.body.parties.map((p) => p.name)).toEqual(['Example Insurance Services']);
    await resolveNeedsYouItem(t.ctx, q[0]!.id, { optionId: 'insurer:example-insurer' }, OWNER);
    await runJob('knowledge.learn_stats', {});
    expect(t.ctx.repos.listInsurerLinks(t.ctx.db)).toEqual([expect.objectContaining({ insurerSlug: 'example-insurer', method: 'owner', decidedBy: 'courtesycars' })]);
  });

  it('step statistics are computed facts ("followed by"), internal, auto-applied', async () => {
    for (let i = 0; i < 5; i++) {
      const c = makeClaim('Example Insurance Ltd');
      ledger(c.id, 'hire', 'claimed', 50_000, '2026-05-20');
      event(c.id, 'chaser_sent', '2026-06-01T09:00:00.000Z');
      if (i < 4) ledger(c.id, 'hire', 'paid', 50_000, '2026-06-08');
    }
    await runJob('knowledge.learn_stats', {});
    const fact = active('stat:step_effectiveness:insurer:example-insurer:event:chaser_sent:payment:all')!;
    expect(fact).toMatchObject({ kind: 'fact', origin: 'computed', area: 'statistics', useLimit: 'internal', status: 'active' });
    expect((fact.data as { stat: { hits: number; n: number } }).stat).toMatchObject({ hits: 4, n: 5, withinWorkingDays: 20 });
    expect(fact.body).toMatch(/followed by/);
    expect(fact.body).not.toMatch(/caused/);
  });
});

// ---------------------------------------------------------------------------

describe('L4 contacts from signatures (scenario 2)', () => {
  const signature = (name: string, lines: string[]) => `Thank you for your email.\n\nKind regards\n\n${name}\n${lines.join('\n')}\n\nThis email and any attachments are confidential.`;
  let claimId: string;
  let n = 0;
  const mail = (from: string, thread: string, body: string, auth: unknown = { dmarc: 'pass' }) => {
    n += 1;
    return t.ctx.repos.insertMailMessage(t.ctx.db, { accountId: 'acc-1', threadKey: thread, direction: 'in', fromAddr: from, to: ['claims@ccguk-test.example'], cc: [], subject: `Re: claim ${n}`, receivedAt: `2026-10-0${Math.min(9, n)}T09:00:00.000Z`, rawEvidenceId: `ev-${n}`, rawSha256: `sha-${n}-${Math.random()}`, bodyText: body, auth, claimId, source: 'file', status: 'matched' } as never);
  };

  beforeEach(async () => {
    claimId = makeClaim('Example Insurance Ltd').id;
    n = 0;
    await runJob('knowledge.learn_stats', {}); // links the party
  });

  it('two DMARC-pass emails in different threads from the insurer’s own domain → an auto-applied, unverified contact', async () => {
    const body = signature('Jane Example', ['Claims Handler', 'DDI: 0161 496 0123', `jane.example@${DOMAIN}`]);
    mail(`jane.example@${DOMAIN}`, 'thread-a', body);
    let out = await runJob('knowledge.observe', { source: 'mail' });
    expect(out).toMatchObject({ kind: 'done' });
    await runJob('knowledge.consolidate', { reason: 'observe' });
    expect(active(`contact:example-insurer:jane.example@${DOMAIN}`)).toBeUndefined(); // one thread: waits
    mail(`jane.example@${DOMAIN}`, 'thread-b', body);
    out = await runJob('knowledge.observe', { source: 'mail' });
    expect((out as { followUps?: { type: string }[] }).followUps?.[0]?.type).toBe('knowledge.consolidate');
    await runJob('knowledge.consolidate', { reason: 'observe' });
    const c = active(`contact:example-insurer:jane.example@${DOMAIN}`)!;
    expect(c).toMatchObject({ kind: 'contact', origin: 'observed', useLimit: 'internal', verification: 'unverified', supportN: 2 });
    expect(c.autonomy.ruleIds).toEqual(['KN-15']);
    expect(c.data).toMatchObject({ name: 'Jane Example', role: 'Claims Handler', phone: '01614960123', phoneKind: 'direct', independentThreads: 2 });
    // idempotent: nothing new on a re-run
    await runJob('knowledge.observe', { source: 'mail' });
    await runJob('knowledge.consolidate', {});
    expect(t.ctx.repos.listKnowledgeItemVersions(t.ctx.db, c.itemKey)).toHaveLength(1);
  });

  it('a copycat domain is never a contact: observation flagged and a spoof warning raised', async () => {
    mail('jane@examp1e-insurer.test', 'thread-c', signature('Jane Example', ['DDI: 0161 496 0123', 'jane@examp1e-insurer.test']));
    await runJob('knowledge.observe', { source: 'mail' });
    const obs = t.ctx.repos.listContactObservations(t.ctx.db);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ domainCheck: 'copycat' });
    expect(obs[0]!.copycat).toMatch(/examp1e-insurer\.test/);
    const warn = rows<{ kind: string; priority: string }>(`SELECT kind, priority FROM needs_you WHERE kind = 'spoof_warning'`);
    expect(warn).toEqual([{ kind: 'spoof_warning', priority: 'urgent' }]);
    await runJob('knowledge.consolidate', {});
    expect(rows(`SELECT id FROM knowledge_items WHERE kind = 'contact'`)).toHaveLength(0);
  });

  it('a contact that differs from the directory waits behind a conflict card; failed DMARC never counts', async () => {
    const body = signature('Tom Sample', ['Switchboard: 0161 496 9999', `tp.team@${DOMAIN}`]);
    mail(`tp.team@${DOMAIN}`, 'thread-d', body);
    mail(`tp.team@${DOMAIN}`, 'thread-e', body);
    mail(`tp.team@${DOMAIN}`, 'thread-f', signature('Mallory Fake', ['DDI: 0161 496 0555', `mallory@${DOMAIN}`]), { dmarc: 'fail' });
    await runJob('knowledge.observe', { source: 'mail' });
    await runJob('knowledge.consolidate', { reason: 'observe' });
    const item = t.ctx.repos.latestKnowledgeVersion(t.ctx.db, `contact:example-insurer:tp.team@${DOMAIN}`)!;
    expect(item).toMatchObject({ status: 'proposed', health: 'conflicted' });
    expect(item.autonomy.ruleIds).toEqual(['KN-06']);
    const conflicts = t.ctx.repos.listKnowledgeConflicts(t.ctx.db, { status: 'open' });
    expect(conflicts).toEqual([expect.objectContaining({ kind: 'directory_mismatch', leftRef: `ki:${item.id}`, rightRef: 'dir:example-insurer' })]);
    expect(rows(`SELECT id FROM needs_you WHERE kind = 'knowledge_review'`).length).toBeGreaterThan(0);
    expect(t.ctx.repos.listContactObservations(t.ctx.db).find((o) => o.name === 'Mallory Fake')).toMatchObject({ domainCheck: 'spoof_suspect', dmarc: 'fail' });
  });
});

// ---------------------------------------------------------------------------

describe('offers (§6.3, AP §N)', () => {
  it('settlement offers come from settlement_offers; intervention_offers are courtesy-car offers only; decisions append', async () => {
    const c = makeClaim('Example Insurance Ltd');
    ledger(c.id, 'hire', 'claimed', 200_000, '2026-05-20');
    const so = t.ctx.repos.createSettlementOffer(t.ctx.db, { claimId: c.id, head: 'hire', amountPence: 150_000, receivedAt: '2026-06-10T09:00:00.000Z', offerorName: 'Example Insurance Ltd', channel: 'email', createdBy: 'courtesycars' } as never);
    sql(
      `INSERT INTO intervention_offers (id, claim_id, received_at, channel, offeror_name, daily_rate_pence, terms, suitability_reasons, client_decision, evidence_ids, created_at, updated_at) VALUES ('io-1', ?, '2026-05-02T09:00:00.000Z', 'phone', 'Example Direct', 4500, '{}', '[]', 'declined', '[]', ?, ?)`,
      c.id,
      NOW,
      NOW,
    );
    await runJob('knowledge.observe', { source: 'offers' });
    const obs = t.ctx.repos.listOfferObservations(t.ctx.db, { claimId: c.id });
    expect(obs.map((o) => [o.source, o.offerKind, o.head, o.amountPence, o.claimedPence, o.decision])).toEqual([
      ['intervention_register', 'intervention', 'hire', 4500, null, null],
      ['intervention_register', 'intervention', 'hire', 4500, null, 'reject'],
      ['settlement_register', 'settlement', 'hire', 150_000, 200_000, null],
    ]);
    sql(`UPDATE settlement_offers SET status = 'accepted', decided_by = 'courtesycars', decided_at = ? WHERE id = ?`, NOW, so.id);
    await runJob('knowledge.observe', { source: 'offers' });
    await runJob('knowledge.observe', { source: 'offers' });
    expect(t.ctx.repos.listOfferObservations(t.ctx.db, { claimId: c.id }).filter((o) => o.source === 'settlement_register').map((o) => o.decision)).toEqual([null, 'accept']);
    // append-only
    expect(() => sql(`UPDATE offer_observations SET amount_pence = 1`)).toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------

describe('L3 corrections → curator (scenario 3)', () => {
  const OPENING = 'I hope this email finds you well.';
  async function ownerEdits(k: number): Promise<void> {
    for (let i = 0; i < k; i++) {
      const c = makeClaim('Example Insurance Ltd');
      const body = `${OPENING} Please let us have payment of the outstanding hire charges on claim number ${i + 1}.\n\nClaims Team, Courtesy Cars Group UK Ltd`;
      const o = t.ctx.repos.createOutbox(t.ctx.db, { claimId: c.id, accountId: 'acc-1', kind: 'chaser', to: [`claims@${DOMAIN}`], subject: `Chaser ${i}`, bodyText: body, createdBy: 'agent:mail' } as never);
      const ny = createNeedsYou(t.ctx, {
        kind: 'approve_send',
        claimId: c.id,
        title: `Approve email ${i}`,
        summary: 'Prepared chaser',
        options: [
          { id: 'approve', label: 'Approve', tone: 'primary' },
          { id: 'reject', label: 'Reject', tone: 'danger', requiresReason: true },
        ],
        payload: { outboxId: o.id, email: { to: o.toJson, cc: [], subject: o.subject, bodyText: body, attachments: [], kind: 'chaser' } },
        priority: 'normal',
        createdBy: 'agent:mail',
      });
      await resolveNeedsYouItem(t.ctx, ny.id, { optionId: 'approve', edits: { bodyText: body.replace(`${OPENING} `, '') } }, OWNER);
    }
  }

  it('three identical owner edits are captured, cluster, and the curator proposes an auto-applied style note and a queued rule', async () => {
    await ownerEdits(3);
    const out = await runJob('knowledge.observe', { source: 'corrections' });
    const corr = (out as { result: { corrections: { captured: number; curateQueued: string[] } } }).result.corrections;
    expect(corr.captured).toBe(3);
    expect(corr.curateQueued).toHaveLength(1);
    const list = t.ctx.repos.listCorrections(t.ctx.db);
    expect(new Set(list.map((c) => c.clusterKey)).size).toBe(1);
    expect(list[0]).toMatchObject({ source: 'needs_you_edit', agent: 'mail', emailKind: 'chaser', insurerSlug: null });
    expect(() => sql(`DELETE FROM corrections`)).toThrow(/append-only/);

    const clusters = await t.api<{ clusters: { clusterKey: string; corrections: number; sinceLastCuration: number }[] }>('GET', '/knowledge/corrections/clusters');
    expect(clusters.body.clusters).toEqual([expect.objectContaining({ corrections: 3, sinceLastCuration: 3 })]);
    const views = await t.api<{ corrections: Record<string, unknown>[] }>('GET', '/knowledge/corrections');
    expect(views.body.corrections).toHaveLength(3);
    expect(JSON.stringify(views.body)).not.toContain('hope this email'); // the list never carries the text

    const job = t.ctx.repos.getAgentJob(t.ctx.db, corr.curateQueued[0]!) as unknown as JobRecord;
    const curated = await runJob('knowledge.curate', job.payload, job.createdBy, job);
    expect(curated.kind).toBe('done');
    const r = (curated as { result: { result: string; proposedItemIds: string[]; noPattern: boolean } }).result;
    expect(r).toMatchObject({ result: 'curated', noPattern: false });
    expect(r.proposedItemIds).toHaveLength(2);
    const [style, rule] = t.ctx.repos.getKnowledgeItems(t.ctx.db, r.proposedItemIds).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(style).toMatchObject({ kind: 'fact', area: 'style', origin: 'curated', status: 'active', supportN: 3, verification: 'unverified' });
    expect(style!.autonomy.ruleIds).toEqual(['KN-18']);
    expect(rule).toMatchObject({ kind: 'rule', origin: 'curated', status: 'proposed' });
    expect(rule!.autonomy.ruleIds).toEqual(['KN-07']);
    expect(rule!.provenance[0]).toMatchObject({ kind: 'correction' });
    expect(rows(`SELECT id FROM needs_you WHERE kind = 'knowledge_review'`)).toHaveLength(1);
    const after = await t.api<{ clusters: { sinceLastCuration: number }[] }>('GET', '/knowledge/corrections/clusters');
    expect(after.body.clusters[0]!.sinceLastCuration).toBe(0);
  });

  it('corrections_get and knowledge_curate_propose refuse any job other than knowledge.curate', async () => {
    const job = enqueueJob(t.ctx, { type: 'knowledge.consolidate', payload: {}, idempotencyKey: 'x', createdBy: 'agent:supervisor' });
    const rc = { runId: 'run-x', jobId: job.id, agent: 'researcher' as const, token: mintRunToken({ name: 'researcher', runId: 'run-x', jobId: job.id }, 60_000), allowedTools: new Set(['corrections_get']), runDir: t.ctx.config.agentRunsDir, correlationId: 'c' };
    const res = await executorFor(t.ctx, rc).call('corrections_get', { clusterKey: 'corr:mail:chaser:tone' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/CURATE_ONLY|only for the knowledge curator/);
  });
});

// ---------------------------------------------------------------------------

describe('L5 engineering and L6 owner wording', () => {
  const estimate = (claimId: string, vehicleId: string, hours: number, o: { imported?: boolean; panel?: string } = {}) =>
    sql(
      `INSERT INTO estimates (id, claim_id, vehicle_id, lines, labour_rate_pence, paint_rate_pence, paint_materials_method, vat_rate, totals, created_at, approved_by, updated_at, imported_from_evidence_id) VALUES (?, ?, ?, ?, 5000, 5500, 'per_hour', 0.2, '{}', ?, 'courtesycars', ?, ?)`,
      `est-${Math.random()}`,
      claimId,
      vehicleId,
      JSON.stringify([{ id: 'l1', kind: 'labour', operation: 'Replace', panel: o.panel ?? 'Front bumper', description: 'x', quantity: 1, hours, source: o.imported ? 'import' : 'manual', confirmedByEngineer: true }]),
      NOW,
      NOW,
      o.imported ? 'ev-audatex' : null,
    );

  it('engineer-confirmed figures with n ≥ 3 become internal engineering figures; Audatex-derived ones are code_only', async () => {
    for (const h of [2, 3, 4]) {
      const c = makeClaim('Example Insurance Ltd');
      estimate(c.id, c.vehicleId, h);
      estimate(c.id, c.vehicleId, h + 1, { imported: true, panel: 'Bonnet' });
    }
    await runJob('knowledge.observe', { source: 'engineering' });
    const bumper = active('eng:testmake:alpha:front-bumper:replace:labour_hours')!;
    expect(bumper).toMatchObject({ kind: 'engineering_figure', useLimit: 'internal', status: 'active', origin: 'computed' });
    expect(bumper.data).toMatchObject({ median: 3, p25: 2, p75: 4, n: 3 });
    expect(active('eng:testmake:alpha:bonnet:replace:labour_hours')).toMatchObject({ useLimit: 'code_only', status: 'active' });
  });

  it('the owner’s own sent email becomes a generalised snippet; one with a literal left waits', async () => {
    const c = makeClaim('Example Insurance Ltd');
    const send = (body: string) => {
      const o = t.ctx.repos.createOutbox(t.ctx.db, { claimId: c.id, accountId: 'acc-1', kind: 'chaser', to: [`claims@${DOMAIN}`], subject: 'Hire charges', bodyText: body, createdBy: 'courtesycars' } as never);
      sql(`UPDATE outbox SET status = 'sent', updated_at = ? WHERE id = ?`, NOW, o.id);
    };
    send('Dear Sirs,\n\nFurther to our telephone conversation on 3 March 2026 we enclose the repair invoice for £1,234.56 under our reference CCG-2026-00001 and ask that you confirm settlement within fourteen days please.\n\nClaims Team, Courtesy Cars Group UK Ltd');
    send('Dear Sirs,\n\nPlease send the remittance advice for the interim payment directly to our accounts team at accounts@ccguk-test.example so that it can be allocated against the correct invoice today.\n\nClaims Team');
    await runJob('knowledge.observe', { source: 'owner_text' });
    const snippets = rows<{ status: string; body: string; autonomy: string }>(`SELECT status, body, autonomy FROM knowledge_items WHERE kind = 'template_snippet' ORDER BY body`);
    expect(snippets).toHaveLength(2);
    const generalised = snippets.find((s) => s.body.startsWith('Further'))!;
    expect(generalised.status).toBe('active');
    expect(generalised.body).toBe('Further to our telephone conversation on [date] we enclose the repair invoice for [amount] under our reference [ref] and ask that you confirm settlement within fourteen days please.');
    expect(JSON.parse(generalised.autonomy).ruleIds).toEqual(['KN-17']);
    expect(snippets.find((s) => s.body.startsWith('Please'))!.status).toBe('proposed');
    // re-run: nothing new
    await runJob('knowledge.observe', { source: 'owner_text' });
    expect(rows(`SELECT id FROM knowledge_items WHERE kind = 'template_snippet'`)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('kill switch, conflicts hook and routes', () => {
  it('with learning paused every learner finishes learning_off and writes nothing', async () => {
    const c = makeClaim('Example Insurance Ltd');
    ledger(c.id, 'hire', 'claimed', 1000, '2026-05-20');
    setLearningEnabled(t.ctx, false, OWNER);
    for (const [type, payload] of [
      ['knowledge.observe', { source: 'all' }],
      ['knowledge.consolidate', {}],
      ['knowledge.learn_stats', {}],
      ['knowledge.curate', { weekly: true }],
    ] as const) {
      const out = await runJob(type, payload);
      expect((out as { result: { result: string } }).result.result, type).toBe('learning_off');
    }
    expect(rows(`SELECT 1 FROM claim_outcomes`)).toHaveLength(0);
    expect(rows(`SELECT 1 FROM insurer_links`)).toHaveLength(0);
  });

  it('conflictsFor is registered: a red-line-free FOS note for CCGUK is queued behind a perimeter conflict', () => {
    expect(knowledgeHooks(t.ctx).conflictsFor).toBeTypeOf('function');
    const r = proposeKnowledge(t.ctx, {
      kind: 'procedure',
      area: 'procedural',
      title: 'Escalate slow payers',
      body: 'If the insurer delays payment, escalate the complaint to the Financial Ombudsman Service.',
      data: { steps: ['Escalate to the Financial Ombudsman Service'], forWhom: 'insurer', channel: 'email', insurerSlug: null },
      tags: [],
      scope: { kind: 'global' },
      business: ['ccguk'],
      useLimit: 'internal',
      origin: 'observed',
      confidence: 0.9,
      supportN: 2,
      provenance: [],
      createdBy: 'agent:supervisor',
    });
    expect(r.decision.ruleIds).toEqual(['KN-06']);
    expect(r.conflicts).toEqual([expect.objectContaining({ kind: 'perimeter', rightRef: 'perimeter:FORUM_NOT_OPEN' })]);
  });

  it('POST /knowledge/learn/run is human-only and queues the learner', async () => {
    const ok = await t.api<{ jobId: string; learner: string }>('POST', '/knowledge/learn/run', { learner: 'learn_stats' });
    expect(ok.status).toBe(202);
    expect(t.ctx.repos.getAgentJob(t.ctx.db, ok.body.jobId)).toMatchObject({ type: 'knowledge.learn_stats' });
    const tok = mintRunToken({ name: 'researcher', runId: 'run-l-1', jobId: 'job-l-1' }, 60_000);
    const res = await t.app.inject({ method: 'POST', url: '/api/knowledge/learn/run', payload: { learner: 'observe' }, headers: { authorization: `Bearer ${tok}` } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const bad = await t.api('POST', '/knowledge/learn/run', { learner: 'research' });
    expect(bad.status).toBe(400);
  });
});
