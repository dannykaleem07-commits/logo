// owned by the Knowledge Builder verifier (integration of the five knowledge slices)
/**
 * Integration checks that close the slices' left-over items (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.2, §7.2, §10.5,
 * §12.1, §15): every knowledge audit action the API writes is catalogued, a learned contact reported failed twice turns
 * stale and leaves retrieval, the Sources tab learns whether the FCA key is saved (presence only), the FCA key can be
 * saved from Settings ▸ AI, a rule's approval waits for its gate replay on the Needs-you card too, and draft replay
 * uses its own result schema. Every insurer, contact and number is invented; no model and no network are used.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_AUDIT_ACTIONS, RESULT_SCHEMAS, filterReason, type ContactData, type KnowledgeCandidate, type KnowledgeProposal } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { resolveNeedsYouItem } from '../agent/needsYou.js';
import { proposeKnowledge } from '../knowledge/store.js';
import { publishLearnedPack } from '../knowledge/publish.js';
import { markFailedContacts, reportNamesContact } from '../knowledge/learners/contacts.js';
import { REPLAY_DRAFTS_SPEC, runReplayGate } from '../knowledge/evals/replay.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NOW = '2026-10-10T10:00:00.000Z';
const OWNER = { userId: 'courtesycars' };
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
});
afterEach(async () => {
  await t.close();
});

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'test' || f === 'fixtures' ? [] : sourceFiles(p);
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });
}

describe('§10.5 audit actions', () => {
  it('every knowledge.* action the API writes is in KNOWLEDGE_AUDIT_ACTIONS', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(srcRoot)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/action: '(knowledge\.[a-z_]+(?:\.[a-z_]+)?)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(10);
    const catalogue = new Set<string>(KNOWLEDGE_AUDIT_ACTIONS);
    expect([...used].filter((a) => !catalogue.has(a)).sort()).toEqual([]);
  });
});

const contact = (over: Partial<ContactData> = {}): KnowledgeProposal<ContactData> => ({
  kind: 'contact',
  area: 'contact',
  title: 'Jo Example — Example Insurance Ltd',
  body: 'Jo Example, claims handler. Phone 0161 496 0123. Email jo.example@example-insurer.test.',
  data: { insurerSlug: 'example-insurer', team: null, name: 'Jo Example', role: 'Claims handler', phone: '01614960123', phoneKind: 'direct', email: 'jo.example@example-insurer.test', ivr: null, hours: null, observations: 2, independentThreads: 2, lastSeenAt: NOW, ...over },
  tags: ['learned_contact'],
  scope: { kind: 'insurer', slug: 'example-insurer' },
  business: ['ccguk'],
  useLimit: 'internal',
  origin: 'observed',
  confidence: 0.9,
  supportN: 2,
  provenance: [{ kind: 'email', mailMessageId: 'm-1', fromDomain: 'example-insurer.test', dmarc: 'pass', observedAt: NOW }],
  createdBy: 'agent:supervisor',
});

describe('§6.2 a learned contact reported failed twice becomes stale', () => {
  const report = (note: string, entityId = 'example-insurer') =>
    t.ctx.repos.appendAudit(t.ctx.db, { actor: { userId: 'agent:mail', runId: 'run-x' }, action: 'directory.report_failed', entity: 'directory_overrides', entityId, after: { field: 'email', note }, at: '2026-10-10T11:00:00.000Z' });

  it('matches the email or the phone in the report text', () => {
    expect(reportNamesContact('bounced: Jo.Example@example-insurer.test', { email: 'jo.example@example-insurer.test', phone: null })).toBe(true);
    expect(reportNamesContact('wrong number +44 161 496 0123', { email: null, phone: '01614960123' })).toBe(true);
    expect(reportNamesContact('wrong number 0161 496 0999', { email: null, phone: '01614960123' })).toBe(false);
  });

  it('two reports for its insurer turn it stale (recorded as a health change); one report, or another insurer, does not', () => {
    const r = proposeKnowledge(t.ctx, contact(), { contact: { domainCheck: 'own_domain', dmarc: 'pass', independentThreads: 2 } });
    expect(r.item).toMatchObject({ status: 'active', health: 'ok', verification: 'unverified' });
    report('bounced: jo.example@example-insurer.test');
    report('jo.example@example-insurer.test bounced', 'another-insurer');
    expect(markFailedContacts(t.ctx).staled).toEqual([]);
    report('wrong number 0161 496 0123');
    expect(markFailedContacts(t.ctx).staled).toEqual([r.item.id]);
    const after = t.ctx.repos.getKnowledgeItem(t.ctx.db, r.item.id)!;
    expect(after).toMatchObject({ health: 'stale', status: 'active', verification: 'unverified' });
    const changes = t.ctx.handle.sqlite.prepare(`SELECT action FROM knowledge_changes WHERE item_id = ? AND action = 'knowledge.item.health'`).all(r.item.id);
    expect(changes).toHaveLength(1);
  });

  it('a stale learned contact is filtered out of retrieval', () => {
    const base = { id: 'ki:x', layer: 'learned', kind: 'contact', useLimit: 'internal', validTo: null, business: ['ccguk'], fos: false, injury: false, tags: [], title: 'x', text: 'x', scope: { kind: 'global' } } as unknown as KnowledgeCandidate;
    const req = { today: '2026-10-10', claim: null } as never;
    expect(filterReason({ ...base, health: 'ok' } as KnowledgeCandidate, req)).toBeNull();
    expect(filterReason({ ...base, health: 'stale' } as KnowledgeCandidate, req)).toMatch(/stale learned contact/);
  });
});

describe('§15 the optional FCA Handbook key', () => {
  it('can be saved and removed in Settings ▸ AI; the Sources tab and AI status show presence only', async () => {
    expect((await t.api<{ fcaKeyPresent: boolean }>('GET', '/knowledge/sources')).body.fcaKeyPresent).toBe(false);
    expect((await t.api('PUT', '/ai/fca-key', { value: 'sk-ant-api03-not-an-fca-key-xxxxxxxx' })).status).toBe(400);
    const put = await t.api('PUT', '/ai/fca-key', { value: 'fca-invented-test-key-0123456789abcdef' });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain('0123456789abcdef');
    const sources = await t.api<{ fcaKeyPresent: boolean }>('GET', '/knowledge/sources');
    expect(sources.body.fcaKeyPresent).toBe(true);
    expect(JSON.stringify(sources.body)).not.toContain('0123456789abcdef');
    const status = await t.api<{ secrets: { fcaHandbookKey: boolean } }>('GET', '/ai/status');
    expect(status.body.secrets.fcaHandbookKey).toBe(true);
    expect((await t.api('DELETE', '/ai/fca-key')).status).toBe(200);
    expect((await t.api<{ fcaKeyPresent: boolean }>('GET', '/knowledge/sources')).body.fcaKeyPresent).toBe(false);
  });
});

describe('§12.1 activation waits for the replay — from the Needs-you card too', () => {
  it('approving a card with a rule is refused until its gate replay has run; nothing on the card is approved', async () => {
    const rule = proposeKnowledge(t.ctx, {
      ...contact(),
      kind: 'rule',
      area: 'style',
      origin: 'curated',
      title: 'Avoid a stock opening',
      body: 'Do not open emails to this insurer with a stock phrase.',
      tags: [],
      supportN: 3,
      provenance: [],
      data: { when: { '==': [{ var: 'insurer.slug' }, 'example-insurer'] }, then: [{ kind: 'avoid_phrase', phrase: 'trust you are well' }], why: 'invented', severity: 'info' } as never,
    });
    expect(rule.item.status).toBe('proposed');
    expect(rule.needsYouId).toBeTruthy();
    await expect(resolveNeedsYouItem(t.ctx, rule.needsYouId!, { optionId: 'approve' }, OWNER)).rejects.toThrow(/KNOWLEDGE_REPLAY_PENDING|replayed against past claims/);
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, rule.item.id)!.status).toBe('proposed');
    const gate = runReplayGate(t.ctx, [rule.item.id]);
    expect(gate.verdict).toBe('inconclusive'); // fewer than minCases (10) past cases
    expect(gate.summary).toMatch(/inconclusive|fewer|too few/i);
    const runs = await t.api<{ runs: { id: string }[] }>('GET', `/knowledge/evals/runs?itemId=${rule.item.id}&mode=gate`);
    expect(runs.body.runs.map((r) => r.id)).toEqual([gate.evalRunId]);
    await resolveNeedsYouItem(t.ctx, rule.needsYouId!, { optionId: 'approve' }, OWNER);
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, rule.item.id)).toMatchObject({ status: 'active', verification: 'owner_confirmed' });
    // §11 Versions: the version that adds the rule links its replay run
    const published = publishLearnedPack(t.ctx, { reason: 'test', actor: { userId: 'agent:supervisor' } });
    expect(published.published).toBe(true);
    expect(t.ctx.repos.getKnowledgePackVersion(t.ctx.db, published.version!)!.replayRunId).toBe(gate.evalRunId);
  });
});

describe('§12.1 draft replay has its own result schema', () => {
  it('REPLAY_DRAFTS_SPEC uses draft_replay with a body field', () => {
    expect(REPLAY_DRAFTS_SPEC.resultSchemaId).toBe('draft_replay');
    expect(JSON.stringify(RESULT_SCHEMAS.draft_replay)).toContain('"body"');
  });
});
