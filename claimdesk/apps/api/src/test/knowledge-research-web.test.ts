// owned by knowledge-research
/**
 * Optional web research (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.8, KR-8; §14 scenario 7) through the real
 * SubscriptionCliDriver and the fake `claude` (test/fixtures/fake-claude.mjs, which records its argv): with the owner's
 * switch on, a `knowledge.research_web` run gets `--tools WebFetch`, only allow-listed `WebFetch(domain:…)` rules, the
 * deny list in `--disallowedTools`, and never WebSearch, Read, Write or Bash. With the switch off, runAgent refuses the
 * web policy and nothing is spawned. No model and no network are used.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESULT_SCHEMAS } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { enqueueJob } from '../agent/core.js';
import { runAgent } from '../agent/runAgent.js';
import { setDriverOverride } from '../ai/driverFactory.js';
import { buildCliArgs, SubscriptionCliDriver, webFetchRules } from '../ai/subscriptionCliDriver.js';
import type { AiRunRequest } from '../ai/types.js';
import { patchKnowledgeSettings } from '../knowledge/settings.js';
import { reportGap } from '../knowledge/research/gaps.js';
import { webResearchSpec } from '../knowledge/research/researcher.js';

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const OWNER = { userId: 'owner-1' };
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp('2026-10-10T10:00:00.000Z', { config: { forbidRealAi: false } });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const mcpUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/mcp`;
  await t.ctx.secrets.set('claude_oauth_token', 'sk-ant-oat-invented-test-token-0000000000');
  setDriverOverride(t.ctx, new SubscriptionCliDriver(t.ctx, { claudeCommand: [process.execPath, FAKE], mcpUrl }));
});
afterEach(async () => {
  setDriverOverride(t.ctx, undefined);
  await t.close();
});

const valueOf = (argv: string[], flag: string): string[] => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < argv.length && !argv[j]!.startsWith('--'); j += 1) out.push(argv[j]!);
  return out;
};

describe('knowledge.research_web CLI arguments (§7.8)', () => {
  it('buildCliArgs: WebFetch only, allow-listed domain rules, the deny list disallowed, no other built-in tool', () => {
    const req = { tools: ['source_fetch', 'knowledge_propose'], allowRead: true, maxTurns: 12, model: 'claude-sonnet-5-5', effort: 'medium', resultSchema: {}, web: { fetchDomains: ['www.gov.uk', 'www.legislation.gov.uk', 'bad domain;rm'], denyDomains: ['www.bailii.org'], maxFetches: 6, allowSearch: true } } as unknown as AiRunRequest;
    const args = buildCliArgs(req, { mcpConfig: '/run/mcp.json', systemPrompt: '/run/system.md' });
    expect(valueOf(args, '--tools')).toEqual(['WebFetch']);
    expect(valueOf(args, '--allowedTools')).toEqual(['mcp__claimdesk__source_fetch', 'mcp__claimdesk__knowledge_propose', 'WebFetch(domain:www.gov.uk)', 'WebFetch(domain:www.legislation.gov.uk)']);
    expect(valueOf(args, '--disallowedTools')).toEqual(['WebFetch(domain:www.bailii.org)']);
    expect(args.join(' ')).not.toMatch(/WebSearch|\bRead\b|\bWrite\b|\bBash\b/);
    expect(args).toContain('--restricted');
    expect(valueOf(args, '--permission-mode')).toEqual(['dontAsk']);
    expect(webFetchRules(['*.example.gov.uk', 'x'])).toEqual(['WebFetch(domain:*.example.gov.uk)']);
    // without req.web nothing changes
    const plain = buildCliArgs({ ...req, web: undefined } as AiRunRequest, { systemPrompt: '/run/system.md' });
    expect(valueOf(plain, '--tools')).toEqual(['Read']);
    expect(plain.join(' ')).not.toContain('WebFetch');
  });

  it('runAgent passes the allow-list to the fake CLI only when the owner switched web research on', async () => {
    const gap = reportGap(t.ctx, { kind: 'procedure', question: 'Which official page explains the wombat procedure?', area: 'procedural', scope: { kind: 'global' }, origin: 'owner', raisedBy: OWNER.userId });
    const job = enqueueJob(t.ctx, { type: 'knowledge.research_web', payload: { gapId: gap.gap.id }, idempotencyKey: 'web-1', createdBy: 'agent:supervisor' });
    const result = { gapId: gap.gap.id, outcome: 'no_answer', summary: 'Invented.', proposedItemIds: [], snapshotIds: [], ownerQuestion: null, confidence: 0.1 };
    const input = { task: `Web research [[fake:result:${JSON.stringify(result)}]]`, question: 'Invented question.' };

    const off = await runAgent(t.ctx, webResearchSpec(), job, input);
    expect(off.outcome).toMatchObject({ kind: 'error', code: 'WEB_RESEARCH_REFUSED', retryable: false });

    patchKnowledgeSettings(t.ctx, { webResearchEnabled: true, acknowledge: true }, OWNER);
    const on = await runAgent(t.ctx, webResearchSpec(), job, input);
    expect(on.outcome.kind).toBe('ok');
    const rec = JSON.parse(readFileSync(path.join(t.ctx.config.agentRunsDir, on.runId, 'fake-claude-record.json'), 'utf8')) as { argv: string[] };
    expect(valueOf(rec.argv, '--tools')).toEqual(['WebFetch']);
    const allowed = valueOf(rec.argv, '--allowedTools');
    const fetchRules = allowed.filter((a) => a.startsWith('WebFetch('));
    expect(fetchRules).toContain('WebFetch(domain:www.legislation.gov.uk)');
    expect(fetchRules).toContain('WebFetch(domain:www.gov.uk)');
    expect(fetchRules.some((r) => /bailii|askmid|caselaw\.nationalarchives/.test(r))).toBe(false);
    expect(allowed.filter((a) => a.startsWith('mcp__')).every((a) => !/brain_search|memory_recall/.test(a))).toBe(true);
    expect(valueOf(rec.argv, '--disallowedTools')).toEqual(expect.arrayContaining(['WebFetch(domain:www.bailii.org)', 'WebFetch(domain:www.askmid.com)', 'WebFetch(domain:caselaw.nationalarchives.gov.uk)']));
    expect(rec.argv.join(' ')).not.toMatch(/WebSearch|\bBash\b|\bWrite\b/);
    expect(valueOf(rec.argv, '--json-schema')[0]).toBe(JSON.stringify(RESULT_SCHEMAS.knowledge_research));
  });

  it('a web policy is never handed to any other job type', async () => {
    patchKnowledgeSettings(t.ctx, { webResearchEnabled: true, acknowledge: true }, OWNER);
    const gap = reportGap(t.ctx, { kind: 'procedure', question: 'Which official page explains the wombat steps?', area: 'procedural', scope: { kind: 'global' }, origin: 'owner', raisedBy: OWNER.userId });
    const job = enqueueJob(t.ctx, { type: 'knowledge.research', payload: { gapId: gap.gap.id }, idempotencyKey: 'web-2', createdBy: 'agent:supervisor' });
    const result = { gapId: gap.gap.id, outcome: 'no_answer', summary: 'Invented.', proposedItemIds: [], snapshotIds: [], ownerQuestion: null, confidence: 0.1 };
    const run = await runAgent(t.ctx, { ...webResearchSpec(), jobType: 'knowledge.research', promptFiles: ['knowledge-researcher.md'] }, job, { task: `Research [[fake:result:${JSON.stringify(result)}]]` });
    expect(run.outcome.kind).toBe('ok');
    const rec = JSON.parse(readFileSync(path.join(t.ctx.config.agentRunsDir, run.runId, 'fake-claude-record.json'), 'utf8')) as { argv: string[] };
    expect(valueOf(rec.argv, '--tools')).toEqual(['']);
    expect(rec.argv.join(' ')).not.toContain('WebFetch');
  });
});
