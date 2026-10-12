/**
 * SubscriptionCliDriver (docs/SUPREME-DESIGN.md §A.2) with a fake `claude` (test/fixtures/fake-claude.mjs) — no model
 * is ever called. Checks the exact flags (never --bare), the allow-listed environment (no ANTHROPIC_API_KEY even when
 * the parent has one), the MCP round trip with the per-run token, every usage-limit pattern, auth failure, timeout
 * (killed by PID), invalid output, MCP not connected, detection and the REAL_AI_FORBIDDEN guard.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { RESULT_SCHEMAS } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { buildCliArgs, buildCliEnv, mcpToolName, RealAiForbiddenError, SubscriptionCliDriver } from '../ai/subscriptionCliDriver.js';
import { candidatePaths, compareVersions, detectClaudeCli, MIN_CLAUDE_CODE_VERSION, parseClaudeVersion, type CommandRunner } from '../ai/cliDetect.js';
import { classifyFailure, AUTH_PATTERNS, USAGE_LIMIT_PATTERNS } from '../ai/usageLimits.js';
import { normaliseRateLimit, StreamJsonParser } from '../ai/streamJson.js';
import { enqueueJob } from '../agent/core.js';
import { runAgent } from '../agent/runAgent.js';
import { setDriverOptions, setDriverOverride } from '../ai/driverFactory.js';
import type { AgentSpec } from '../agent/contracts.js';
import type { AiRunRequest } from '../ai/types.js';

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const COMMAND = [process.execPath, FAKE];
const RESULT = { answer: 'Invented answer from the fake CLI.', citations: [], confidence: 0.7 };

let t: TestApp;
let claimId: string;
let mcpUrl: string;
let driver: SubscriptionCliDriver;
const savedApiKey = process.env.ANTHROPIC_API_KEY;

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-should-never-reach-the-child';
});
afterAll(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
});

beforeEach(async () => {
  // Real drivers can only be constructed with forbidRealAi off; the process still has CLAIMDESK_FORBID_REAL_AI=1, so
  // the driver only ever spawns the injected fake command.
  t = await createTestApp('2026-10-07T09:00:00.000Z', { config: { forbidRealAi: false } });
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  mcpUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/mcp`;
  await t.ctx.secrets.set('claude_oauth_token', 'sk-ant-oat-invented-test-token-0000000000');
  driver = new SubscriptionCliDriver(t.ctx, { claudeCommand: COMMAND, mcpUrl });
});
afterEach(async () => {
  setDriverOverride(t.ctx, undefined);
  await t.close();
});

function request(user: string, over: Partial<AiRunRequest> = {}): AiRunRequest {
  const runId = randomUUID();
  return {
    runId,
    jobId: 'job-cli',
    agent: 'researcher',
    jobType: 'research.ask',
    model: 'claude-sonnet-5-5',
    effort: 'low',
    maxTurns: 3,
    timeoutMs: 20_000,
    system: [{ id: 'identity', text: 'Invented system prompt.', stable: true }],
    user,
    attachments: [],
    tools: [],
    allowRead: false,
    resultSchema: RESULT_SCHEMAS.research_answer,
    resultSchemaId: 'research_answer',
    runDir: path.join(t.ctx.config.agentRunsDir, runId),
    promptVersion: 'v',
    ...over,
  };
}
const noTools = { call: async () => ({ ok: false, content: '{}' }) };
const record = (req: AiRunRequest) => JSON.parse(readFileSync(path.join(req.runDir, 'fake-claude-record.json'), 'utf8')) as { argv: string[]; envKeys: string[]; env: Record<string, unknown>; stdin: string; mcp: Array<{ method: string; status: number; body: Record<string, unknown> }> };

describe('construction guard', () => {
  it('throws REAL_AI_FORBIDDEN when the process forbids real AI', async () => {
    const forbidden = await createTestApp();
    try {
      expect(forbidden.ctx.config.forbidRealAi).toBe(true);
      expect(() => new SubscriptionCliDriver(forbidden.ctx, { claudeCommand: COMMAND })).toThrow(RealAiForbiddenError);
      expect(() => new SubscriptionCliDriver(forbidden.ctx)).toThrow(/REAL_AI_FORBIDDEN|forbidden/);
    } finally {
      await forbidden.close();
    }
  });

  it('refuses to spawn anything but an injected command or a Node-script fake while CLAIMDESK_FORBID_REAL_AI=1', async () => {
    let executed = false;
    // An existing binary that is not a Node script stands in for a real claude.exe.
    const real = new SubscriptionCliDriver(t.ctx, { mcpUrl, baseEnv: { CLAIMDESK_CLAUDE_PATH: process.execPath }, run: async () => ((executed = true), { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' }) });
    const out = await real.run(request('hello'), noTools, new AbortController().signal);
    // Detection never executes a real binary under the guard, so the run cannot start.
    expect(out).toMatchObject({ kind: 'error', retryable: false });
    expect(executed).toBe(false);
    expect(real.lastPid).toBeUndefined();
  });
});

describe('arguments and environment', () => {
  it('builds the exact flag list (never --bare)', () => {
    const req = request('x', { tools: ['claim_clocks', 'kb_search'], allowRead: true, maxTurns: 7, model: 'claude-opus-5-5', effort: 'high' });
    const args = buildCliArgs(req, { mcpConfig: '/run/mcp.json', systemPrompt: '/run/system.md' });
    expect(args.slice(0, 3)).toEqual(['-p', '--restricted', '--strict-mcp-config']);
    expect(args).not.toContain('--bare');
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--mcp-config')).toBe('/run/mcp.json');
    expect(at('--tools')).toBe('Read');
    expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 4)).toEqual([mcpToolName('claim_clocks'), mcpToolName('kb_search'), 'Read']);
    expect(at('--permission-mode')).toBe('dontAsk');
    expect(at('--permission-prompts')).toBe('none');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--disable-slash-commands');
    expect(at('--max-turns')).toBe('7');
    expect(at('--model')).toBe('claude-opus-5-5');
    expect(at('--effort')).toBe('high');
    expect(at('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(JSON.parse(at('--json-schema')!)).toEqual(RESULT_SCHEMAS.research_answer);
    expect(at('--json-schema')).not.toContain('\n');
    expect(at('--system-prompt-file')).toBe('/run/system.md');
  });

  it('with no tools: --tools "" and no MCP config, no allowedTools', () => {
    const args = buildCliArgs(request('x'), { systemPrompt: '/s.md' });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--allowedTools');
    expect(args).toContain('--strict-mcp-config');
  });

  it('passes an allow-listed environment only (no ANTHROPIC_* / CLAUDE_CODE_USE_*)', () => {
    const env = buildCliEnv({ PATH: '/bin', Path: '/x', SystemRoot: 'C:\\Windows', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1', SECRET_THING: 's', HOME: '/root' }, 'tok', '/home/app');
    expect(env).toEqual({
      PATH: '/bin',
      Path: '/x',
      SystemRoot: 'C:\\Windows',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      CLAUDE_CONFIG_DIR: path.join('/home/app', 'claude-home'),
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      MAX_MCP_OUTPUT_TOKENS: '20000',
    });
  });
});

describe('a full run through runAgent (MCP round trip)', () => {
  it('connects to /api/mcp with the run token, calls a tool, returns the structured output', async () => {
    setDriverOverride(t.ctx, driver);
    const spec: AgentSpec = { name: 'researcher', jobType: 'research.ask', title: 'Research', promptFiles: [], tools: ['claim_clocks', 'kb_search'], allowRead: false, resultSchemaId: 'research_answer', defaults: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 5, timeoutMs: 30_000 } };
    const job = enqueueJob(t.ctx, { type: 'research.ask', payload: {}, claimId, createdBy: 'test' });
    const r = await runAgent(t.ctx, spec, job, { task: `Check the clocks [[fake:call:claim_clocks:{"claimId":"${claimId}"}]] [[fake:result:${JSON.stringify(RESULT)}]]` });
    expect(r.outcome.kind, JSON.stringify(r.outcome)).toBe('ok');
    expect(r.result).toEqual(RESULT);
    const runDir = path.join(t.ctx.config.agentRunsDir, r.runId);
    const rec = JSON.parse(readFileSync(path.join(runDir, 'fake-claude-record.json'), 'utf8')) as ReturnType<typeof record> & { mcpConfig: { type: string; url: string; hasAuth: boolean } };
    expect(rec.argv).toContain('--restricted');
    expect(rec.argv).toContain('--strict-mcp-config');
    expect(rec.argv[rec.argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(rec.argv).not.toContain('--bare');
    expect(rec.envKeys).not.toContain('ANTHROPIC_API_KEY');
    expect(rec.envKeys.some((k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_USE_'))).toBe(false);
    expect(rec.env).toMatchObject({ hasOauthToken: true, DISABLE_AUTOUPDATER: '1', MAX_MCP_OUTPUT_TOKENS: '20000' });
    expect(rec.stdin).toContain('Check the clocks');
    expect(rec.mcpConfig).toEqual({ type: 'http', url: mcpUrl, hasAuth: true });
    expect(rec.mcp.map((m) => [m.method, m.status])).toEqual([
      ['initialize', 200],
      ['tools/list', 200],
      ['tools/call', 200],
    ]);
    const listed = (rec.mcp[1]!.body.result as { tools: Array<{ name: string }> }).tools.map((x) => x.name).sort();
    expect(listed).toEqual(['claim_clocks', 'kb_search']);
    expect(t.ctx.repos.listAgentToolCalls(t.ctx.db, r.runId)[0]).toMatchObject({ tool: 'claim_clocks', decision: 'allowed' });
    // mcp.json is deleted after the run; the system prompt file stays for the run record.
    expect(existsSync(path.join(runDir, 'mcp.json'))).toBe(false);
    expect(readFileSync(path.join(runDir, 'system.md'), 'utf8')).toContain('Claims Team, Courtesy Cars Group UK Ltd');
    // The rate-limit snapshot was stored as it arrived (utilisation normalised to 0..1).
    expect(t.ctx.repos.getAiUsageState(t.ctx.db).fiveHour).toMatchObject({ status: 'allowed', type: 'five_hour', utilization: 0.42 });
    expect(t.ctx.repos.getAgentRun(t.ctx.db, r.runId)).toMatchObject({ outcome: 'ok', driver: 'subscription_cli', inputTokens: 100, cacheReadTokens: 50 });
  });

  it('fails fast (retryable) when the claimdesk MCP server is not connected', async () => {
    setDriverOverride(t.ctx, driver);
    const spec: AgentSpec = { name: 'researcher', jobType: 'research.ask', title: 'Research', promptFiles: [], tools: ['claim_clocks'], allowRead: false, resultSchemaId: 'research_answer', defaults: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 5, timeoutMs: 30_000 } };
    const job = enqueueJob(t.ctx, { type: 'research.ask', payload: {}, claimId, createdBy: 'test' });
    const r = await runAgent(t.ctx, spec, job, { task: '[[fake:mcp_down]]' });
    expect(r.outcome).toMatchObject({ kind: 'error', retryable: true, code: 'MCP_NOT_CONNECTED' });
  });
});

describe('outcomes', () => {
  const run = (marker: string, over: Partial<AiRunRequest> = {}) => {
    const req = request(`[[fake:${marker}]]`, over);
    return driver.run(req, noTools, new AbortController().signal).then((o) => ({ o, req }));
  };

  it.each(['usage_event', 'api_error_limit', 'legacy_limit', 'window_limit'])('usage limit pattern %s → usage_limited with a reset time', async (marker) => {
    const { o } = await run(marker);
    expect(o.kind).toBe('usage_limited');
    if (o.kind === 'usage_limited') {
      expect(Date.parse(o.resetsAt!)).toBeGreaterThan(Date.now());
    }
  });

  it('a rejected rate_limit_event is stored as it arrives', async () => {
    await run('usage_event');
    expect(t.ctx.repos.getAiUsageState(t.ctx.db).fiveHour).toMatchObject({ status: 'rejected' });
  });

  it('auth failure → auth_failed', async () => {
    expect((await run('auth')).o.kind).toBe('auth_failed');
  });

  it('invalid output, schema retries, max turns, no result, typed PDF error', async () => {
    expect((await run('invalid')).o.kind).toBe('invalid_output');
    expect((await run('schema_retries')).o.kind).toBe('invalid_output');
    expect((await run('max_turns')).o).toMatchObject({ kind: 'error', retryable: false, code: 'max_turns' });
    expect((await run('no_result')).o).toMatchObject({ kind: 'error', retryable: true, code: 'NO_RESULT' });
    expect((await run('pdf_too_large')).o).toMatchObject({ kind: 'error', retryable: false, code: 'pdf_too_large' });
  });

  it('timeout kills the child by PID', async () => {
    const started = Date.now();
    const { o } = await run('sleep', { timeoutMs: 1500 });
    expect(o.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = driver.lastPid!;
    expect(pid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('an abort signal cancels the run', async () => {
    const ac = new AbortController();
    const p = driver.run(request('[[fake:sleep]]'), noTools, ac.signal);
    setTimeout(() => ac.abort(), 300);
    expect((await p).kind).toBe('timeout');
  });
});

describe('health and detection', () => {
  it('health: version, oauth_token sign-in, ready', async () => {
    const h = await driver.health();
    expect(h).toMatchObject({ kind: 'subscription_cli', ready: true, cli: { version: '2.1.300', authMethod: 'oauth_token', loggedIn: true, minVersionOk: true } });
    await t.ctx.secrets.delete('claude_oauth_token');
    const noToken = await driver.health();
    expect(noToken.ready).toBe(false);
    expect(noToken.problems.join(' ')).toMatch(/token/i);
  });

  it('detection order: CLAIMDESK_CLAUDE_PATH → native installer → where.exe (.exe only) → WinGet links; never .cmd', async () => {
    const runs: string[][] = [];
    const runner: CommandRunner = async (cmd, args) => {
      runs.push([cmd, ...args]);
      if (cmd === 'where.exe') return { code: 0, stdout: 'C:\\Users\\o\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Tools\\claude.exe\r\n', stderr: '' };
      return { code: 0, stdout: '2.1.300 (Claude Code)\n', stderr: '' };
    };
    const env = { USERPROFILE: 'C:\\Users\\o', LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local' };
    const viaWhere = await detectClaudeCli(env, { platform: 'win32', exists: () => false, run: runner, forbidRealAi: false });
    expect(viaWhere.path).toBe('C:\\Tools\\claude.exe');
    expect(viaWhere.version).toBe('2.1.300');
    const native = await detectClaudeCli(env, { platform: 'win32', exists: (p) => p === 'C:\\Users\\o\\.local\\bin\\claude.exe', run: runner, forbidRealAi: false });
    expect(native.path).toBe('C:\\Users\\o\\.local\\bin\\claude.exe');
    const explicit = await detectClaudeCli({ ...env, CLAIMDESK_CLAUDE_PATH: 'D:\\claude.exe' }, { platform: 'win32', exists: () => true, run: runner, forbidRealAi: false });
    expect(explicit.path).toBe('D:\\claude.exe');
    const shim = await detectClaudeCli({ ...env, CLAIMDESK_CLAUDE_PATH: 'C:\\npm\\claude.cmd' }, { platform: 'win32', exists: (p) => p.endsWith('.cmd'), run: async (cmd) => (cmd === 'where.exe' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' }), forbidRealAi: false });
    expect(shim.problems.join(' ')).toMatch(/\.cmd/);
    expect(shim.path).toBeUndefined();
    const winget = await detectClaudeCli(env, { platform: 'win32', exists: (p) => p.endsWith('WinGet\\Links\\claude.exe'), run: async (cmd) => (cmd === 'where.exe' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' }), forbidRealAi: false });
    expect(winget.path).toBe('C:\\Users\\o\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe');
    expect(candidatePaths(env, 'win32').map((c) => c.source)).toEqual(['native installer']);
  });

  it('version parsing and the minimum version', async () => {
    expect(parseClaudeVersion('2.1.292 (Claude Code)')).toBe('2.1.292');
    expect(parseClaudeVersion('claude 2.1.292')).toBeUndefined();
    expect(compareVersions('2.1.300', MIN_CLAUDE_CODE_VERSION)).toBe(1);
    expect(compareVersions('2.1.29', MIN_CLAUDE_CODE_VERSION)).toBe(-1);
    const old = await detectClaudeCli({}, { platform: 'linux', claudeCommand: ['x'], run: async () => ({ code: 0, stdout: '2.0.1 (Claude Code)', stderr: '' }) });
    expect(old.minVersionOk).toBe(false);
    expect(old.problems.join(' ')).toMatch(/update Claude Code/);
  });

  it('under CLAIMDESK_FORBID_REAL_AI a real binary is never executed by detection', async () => {
    let ran = false;
    const det = await detectClaudeCli({ CLAIMDESK_CLAUDE_PATH: '/opt/claude' }, { platform: 'linux', exists: () => true, run: async () => ((ran = true), { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' }), forbidRealAi: true });
    expect(ran).toBe(false);
    expect(det.problems.join(' ')).toMatch(/disabled/);
  });
});

describe('usage-limit and auth patterns (table)', () => {
  const epoch = 1_791_000_000;
  const cases: Array<[string, Parameters<typeof classifyFailure>[0], string, string | undefined]> = [
    ['rate_limit_event_rejected', { texts: [], rateLimit: { status: 'rejected', type: 'seven_day', resetsAt: '2026-10-08T00:00:00.000Z' } }, 'usage_limited', '2026-10-08T00:00:00.000Z'],
    ['api_error_usage_limit_reached', { texts: [], apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { resetsAt: epoch } } }, 'usage_limited', new Date(epoch * 1000).toISOString()],
    ['legacy_usage_limit_text', { texts: [`Claude AI usage limit reached|${epoch}`] }, 'usage_limited', new Date(epoch * 1000).toISOString()],
    ['window_limit_reached_text', { texts: ['Weekly limit reached ∙ resets Oct 9, 3pm'] }, 'usage_limited', undefined],
    ['http_401', { texts: [], status: 401 }, 'auth_failed', undefined],
    ['oauth_token_expired', { texts: ['OAuth token has expired.'] }, 'auth_failed', undefined],
    ['please_run_login', { texts: ['Invalid API key · Please run /login'] }, 'auth_failed', undefined],
    ['authentication_error', { texts: ['{"type":"error","error":{"type":"authentication_error"}}'] }, 'auth_failed', undefined],
  ];
  it.each(cases)('%s', (pattern, signals, kind, resetsAt) => {
    const c = classifyFailure(signals)!;
    expect(c.kind).toBe(kind);
    expect(c.pattern).toBe(pattern);
    if (c.kind === 'usage_limited') expect(c.resetsAt).toBe(resetsAt);
  });

  it('every pattern in the tables is covered above', () => {
    const ids = cases.map((c) => c[0]);
    for (const p of [...USAGE_LIMIT_PATTERNS, ...AUTH_PATTERNS]) expect(ids).toContain(p.id);
  });

  it('typed errors and unknown failures', () => {
    expect(classifyFailure({ texts: [], apiError: 'pdf_password_protected' })).toMatchObject({ kind: 'error', retryable: false });
    expect(classifyFailure({ texts: ['no_response'] })).toMatchObject({ kind: 'error', retryable: true });
    expect(classifyFailure({ texts: ['something else'] })).toBeUndefined();
  });

  it('normalises rate-limit events', () => {
    expect(normaliseRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 85, resetsAt: epoch, rateLimitType: 'five_hour' } })).toEqual({ status: 'allowed_warning', type: 'five_hour', utilization: 0.85, resetsAt: new Date(epoch * 1000).toISOString() });
    expect(normaliseRateLimit({ rate_limit_info: { status: 'allowed', utilization: 0.3 } })).toEqual({ status: 'allowed', utilization: 0.3 });
    expect(normaliseRateLimit({ rate_limit_info: {} })).toBeUndefined();
  });

  it('the stream parser tolerates chunking and stray lines', () => {
    const p = new StreamJsonParser({ requireMcp: false });
    const lines = ['not json', JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [] }), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { a: 1 }, usage: { input_tokens: 3, output_tokens: 4 }, num_turns: 1 })].join('\n');
    for (let i = 0; i < lines.length; i += 7) p.push(lines.slice(i, i + 7));
    p.end();
    expect(p.outcome({ model: 'm', durationMs: 1, exitCode: 0, stderr: '', timedOut: false })).toMatchObject({ kind: 'ok', result: { a: 1 }, usage: { inputTokens: 3, outputTokens: 4 } });
  });
});

describe('Settings > AI routes (with the fake CLI)', () => {
  beforeEach(() => {
    setDriverOptions(t.ctx, { cli: { claudeCommand: COMMAND, mcpUrl } });
  });

  it('status reports Claude Code, sign-in, secrets presence (never values), checklist and blockers', async () => {
    const s = await t.api<Record<string, any>>('GET', '/ai/status'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(s.status).toBe(200);
    expect(s.body.driver.selected).toBe('off');
    expect(s.body.cli).toMatchObject({ version: '2.1.300', minVersion: MIN_CLAUDE_CODE_VERSION, minVersionOk: true, authMethod: 'oauth_token', loggedIn: true });
    expect(s.body.secrets).toEqual({ claudeToken: true, apiKey: false, fcaHandbookKey: false });
    expect(JSON.stringify(s.body)).not.toContain('sk-ant-oat-invented');
    expect(s.body.canEnableAgents).toBe(false);
    expect(s.body.blockers.join(' ')).toMatch(/driver/);
    expect(s.body.notices.terms).toMatch(/ordinary individual use/);
    expect(s.body.jobModels.find((j: { jobType: string }) => j.jobType === 'mail.triage').effective).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it('agents can be switched on only after the checklist and a healthy driver', async () => {
    expect((await t.api('PATCH', '/ai/settings', { driver: 'subscription_cli' })).status).toBe(200);
    const refused = await t.api<{ error: { code: string; details: { blockers: string[] } } }>('PATCH', '/ai/settings', { agentsEnabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('AGENTS_NOT_READY');
    expect(refused.body.error.details.blockers.join(' ')).toMatch(/checklist/);
    for (const item of ['training_opt_out', 'subscription_terms', 'mailbox_connected', 'background_running']) {
      expect((await t.api('POST', '/ai/checklist', { item, done: true })).status).toBe(200);
    }
    const on = await t.api<{ agents: { enabled: boolean }; canEnableAgents: boolean }>('PATCH', '/ai/settings', { agentsEnabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.agents.enabled).toBe(true);
    // Unticking an item switches the agents off again.
    const off = await t.api<{ agents: { enabled: boolean } }>('POST', '/ai/checklist', { item: 'training_opt_out', done: false });
    expect(off.body.agents.enabled).toBe(false);
    const audit = t.ctx.handle.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'ai.settings'").get() as { n: number };
    expect(audit.n).toBeGreaterThan(3);
  });

  it('validates settings (lanes on the subscription, job types, effort)', async () => {
    expect((await t.api('PATCH', '/ai/settings', { driver: 'subscription_cli', lanes: { ai: 5 } })).status).toBe(400);
    expect((await t.api('PATCH', '/ai/settings', { perJob: { 'mail.sync': { effort: 'low' } } })).status).toBe(400);
    expect((await t.api('PATCH', '/ai/settings', { perJob: { 'mail.reply': { effort: 'turbo' } } })).status).toBe(400);
    const ok = await t.api<{ settings: { perJob: Record<string, unknown>; quality: string } }>('PATCH', '/ai/settings', { quality: 'economy', perJob: { 'mail.reply': { effort: 'high' } } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.quality).toBe('economy');
  });

  it('secrets: PUT stores (presence only), DELETE removes, wrong kind refused, audited by name', async () => {
    const put = await t.api<Record<string, unknown>>('PUT', '/ai/api-key', { value: 'sk-ant-api03-invented-key-0000000000000000' });
    expect(put.body).toEqual({ name: 'anthropic_api_key', present: true });
    expect(t.ctx.secrets.has('anthropic_api_key')).toBe(true);
    expect((await t.api('PUT', '/ai/token', { value: 'sk-ant-api03-invented-key-0000000000000000' })).status).toBe(400);
    expect((await t.api('PUT', '/ai/api-key', { value: 'sk-ant-oat01-invented-token-00000000000000' })).status).toBe(400);
    expect((await t.api('DELETE', '/ai/api-key')).body).toEqual({ name: 'anthropic_api_key', present: false });
    const rows = t.ctx.handle.sqlite.prepare("SELECT after FROM audit_log WHERE action IN ('secret.set','secret.delete')").all() as Array<{ after: string }>;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.after).join(' ')).not.toContain('invented-key');
  });

  it('admin only for changes; test-run refused when real AI is forbidden; setup window only on Windows', async () => {
    const handler = t.ctx.handle.sqlite.prepare("SELECT id FROM users WHERE role = 'handler' AND id <> 'handler' LIMIT 1").get() as { id: string } | undefined;
    expect(handler).toBeDefined();
    expect((await t.api('PATCH', '/ai/settings', { quality: 'best' }, { 'x-user-id': handler!.id })).status).toBe(403);
    expect((await t.api('PUT', '/ai/token', { value: 'sk-ant-oat01-invented-token-00000000000000' }, { 'x-user-id': handler!.id })).status).toBe(403);
    const test = await t.api<{ error: { code: string } }>('POST', '/ai/test-run');
    expect(test.status).toBe(409);
    expect(test.body.error.code).toBe('REAL_AI_FORBIDDEN');
    if (process.platform !== 'win32') expect((await t.api('POST', '/ai/open-setup-token')).status).toBe(501);
    expect((await t.api('POST', '/ai/check')).status).toBe(200);
  });
});
