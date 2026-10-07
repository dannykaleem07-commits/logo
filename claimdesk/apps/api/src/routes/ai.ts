// owned by gateway
/**
 * Settings > AI routes (docs/SUPREME-DESIGN.md §A.7, §L.6, §N.6 gateway row):
 *   GET    /ai/status            driver health, Claude Code path/version/sign-in, secret presence, checklist, usage
 *   PATCH  /ai/settings          (admin) driver, models/effort per job, quality, lanes, reserve, daily cap, prices,
 *                                 agents on/off — validated and audited (`ai.settings`); agents can only be switched on
 *                                 when every checklist item is ticked and the selected driver is healthy
 *   PUT/DELETE /ai/token         (admin) the Claude Code setup token (secret store; never returned)
 *   PUT/DELETE /ai/api-key       (admin) the Anthropic API key (secret store; never returned)
 *   POST   /ai/open-setup-token  (admin) Windows: a visible console running `claude.exe setup-token`; elsewhere 501
 *   POST   /ai/check             re-run detection + `claude auth status` / key check (no model call)
 *   POST   /ai/test-run          (admin) one tiny real call — refused when real AI is forbidden in this process
 *   POST   /ai/checklist         (admin) tick / untick a setup checklist item
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_JOB_DEFAULTS, aiJobModel, CHECKLIST_ITEM_IDS, type AiSettings, type ChecklistItemId, type JobType } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError, conflict, badRequest } from '../errors.js';
import { parse } from '../schemas/common.js';
import { requireRole } from './helpers.js';
import type { DriverHealth } from '../ai/types.js';
import { buildCliEnv, claudeAuthStatus, detectClaudeCli, MIN_CLAUDE_CODE_VERSION, type CliDetection } from '../ai/cliDetect.js';
import { cliOptionsFor, getDriver, selectedDriver, type DriverChoice } from '../ai/driverFactory.js';
import type { SecretName } from '../services/secrets.js';
import { ApiKeyDriver } from '../ai/apiKeyDriver.js';

export const TERMS_NOTICE =
  'Subscription sign-in (Claude Code with your Claude Max account) is meant for ordinary individual use. Running ClaimDesk’s agents around the clock for the business is heavy automation: Anthropic’s API (a paid API key) is the intended route for that, and you can switch to it here at any time. Usage on the subscription is shared with your own Claude use, and the five-hour and weekly limits pause the agents until they reset (work is queued, never lost).';
export const TRAINING_NOTICE = 'Consumer Claude accounts may use chats to improve Claude unless you turn it off: claude.ai → Settings → Privacy → “Help improve Claude” → off.';
export const CLAUDE_PRIVACY_URL = 'https://claude.ai/settings/data-privacy-controls';

export interface CliStatus {
  path: string | null;
  version: string | null;
  minVersion: string;
  minVersionOk: boolean;
  authMethod: string | null;
  loggedIn: boolean | null;
  problems: string[];
  checkedAt: string;
}

const cliCache = new WeakMap<AppContext, CliStatus>();
const CLI_CACHE_MS = 60_000;

function realAiForbidden(ctx: AppContext): boolean {
  return ctx.config.forbidRealAi || process.env.CLAIMDESK_FORBID_REAL_AI === '1';
}

/** Detect Claude Code and check its sign-in with the saved token (cached for a minute unless `refresh`). */
export async function cliStatus(ctx: AppContext, refresh = false): Promise<CliStatus> {
  const cached = cliCache.get(ctx);
  if (!refresh && cached && Date.now() - Date.parse(cached.checkedAt) < CLI_CACHE_MS) return cached;
  const opts = cliOptionsFor(ctx);
  const env = opts.baseEnv ?? process.env;
  const det: CliDetection = await detectClaudeCli(env, {
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.run ? { run: opts.run } : {}),
    ...(opts.claudeCommand ? { claudeCommand: opts.claudeCommand } : {}),
    forbidRealAi: realAiForbidden(ctx),
  });
  const status: CliStatus = {
    path: det.path ?? null,
    version: det.version ?? null,
    minVersion: MIN_CLAUDE_CODE_VERSION,
    minVersionOk: det.minVersionOk,
    authMethod: null,
    loggedIn: null,
    problems: [...det.problems],
    checkedAt: new Date().toISOString(),
  };
  if (det.command && det.version) {
    const token = await ctx.secrets.get('claude_oauth_token');
    const auth = await claudeAuthStatus(det.command, token, { appHome: ctx.config.appHome, baseEnv: env, ...(opts.run ? { run: opts.run } : {}) });
    status.authMethod = auth.authMethod ?? null;
    status.loggedIn = auth.loggedIn ?? null;
    for (const p of auth.problems) if (!status.problems.includes(p)) status.problems.push(p);
  }
  cliCache.set(ctx, status);
  return status;
}

/** Health of the selected driver (no model call). Real drivers that cannot be built here report why. */
export async function driverHealth(ctx: AppContext, choice: DriverChoice, cli: CliStatus, refresh = false): Promise<DriverHealth> {
  if (choice === 'off') return { kind: 'fake', ready: false, problems: ['AI is switched off: choose a driver'] };
  try {
    if (choice === 'subscription_cli') {
      // Built from the cached CLI status so a status call does not run Claude Code twice.
      getDriver(ctx); // throws REAL_AI_FORBIDDEN when the process forbids real AI
      const token = ctx.secrets.has('claude_oauth_token');
      const problems = [...cli.problems];
      const ready = Boolean(cli.path && cli.version && cli.minVersionOk && token && cli.authMethod === 'oauth_token' && cli.loggedIn !== false);
      return { kind: 'subscription_cli', ready, problems, cli: { minVersionOk: cli.minVersionOk, ...(cli.path ? { path: cli.path } : {}), ...(cli.version ? { version: cli.version } : {}), ...(cli.authMethod ? { authMethod: cli.authMethod } : {}), ...(cli.loggedIn !== null ? { loggedIn: cli.loggedIn } : {}) } };
    }
    const driver = getDriver(ctx);
    if (refresh && driver instanceof ApiKeyDriver) return await driver.checkKey();
    return await driver.health();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: choice, ready: false, problems: [message], ...(choice === 'api_key' ? { apiKeyPresent: ctx.secrets.has('anthropic_api_key') } : {}) };
  }
}

export function checklistComplete(ctx: AppContext): boolean {
  const c = ctx.repos.getAgentSettings(ctx.db).checklist;
  return CHECKLIST_ITEM_IDS.every((id) => c[id]?.done);
}

async function buildStatus(ctx: AppContext, refresh = false) {
  const settings = ctx.repos.getAgentSettings(ctx.db);
  const choice = selectedDriver(ctx);
  const cli = await cliStatus(ctx, refresh);
  const health = await driverHealth(ctx, choice, cli, refresh);
  const usage = ctx.repos.getAiUsageState(ctx.db);
  const now = ctx.now();
  const complete = CHECKLIST_ITEM_IDS.every((id) => settings.checklist[id]?.done);
  const blockers: string[] = [];
  if (choice === 'off') blockers.push('Choose a driver (subscription or API key)');
  if (!complete) blockers.push('Tick every item of the setup checklist');
  if (choice !== 'off' && !health.ready) blockers.push(...(health.problems.length ? health.problems : ['The selected driver is not ready']));
  const jobModels = (Object.keys(AI_JOB_DEFAULTS) as JobType[]).map((jobType) => {
    const d = AI_JOB_DEFAULTS[jobType]!;
    return { jobType, agent: d.agent, defaults: { model: d.model, effort: d.effort, maxTurns: d.maxTurns, timeoutMs: d.timeoutMs }, effective: aiJobModel(settings.ai, jobType)! };
  });
  return {
    driver: { selected: choice, override: ctx.config.aiDriverOverride ?? null, health },
    cli,
    secrets: { claudeToken: ctx.secrets.has('claude_oauth_token'), apiKey: ctx.secrets.has('anthropic_api_key') },
    settings: settings.ai,
    jobModels,
    agents: { enabled: settings.agents.enabled },
    checklist: settings.checklist,
    checklistComplete: complete,
    usage: { ...usage, paused: usage.pausedUntil !== undefined && usage.pausedUntil > now },
    canEnableAgents: blockers.length === 0,
    blockers,
    realAiForbidden: realAiForbidden(ctx),
    fakeAllowed: ctx.config.allowFakeAi || ctx.config.env === 'test',
    platform: process.platform,
    notices: { terms: TERMS_NOTICE, training: TRAINING_NOTICE, privacyUrl: CLAUDE_PRIVACY_URL },
  };
}

const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const aiJobTypes = Object.keys(AI_JOB_DEFAULTS) as [string, ...string[]];
const settingsPatchBody = z
  .object({
    driver: z.enum(['subscription_cli', 'api_key', 'off']).optional(),
    quality: z.enum(['standard', 'economy', 'best']).optional(),
    perJob: z
      .record(
        z.enum(aiJobTypes),
        z.object({ model: z.string().trim().min(3).max(80).regex(/^[a-z0-9][a-z0-9.\-[\]]*$/i).optional(), effort: effort.optional(), maxTurns: z.number().int().min(1).max(50).optional(), timeoutMs: z.number().int().min(30_000).max(60 * 60_000).optional() }).strict(),
      )
      .optional(),
    lanes: z.object({ ai: z.number().int().min(1).max(6).optional(), io: z.number().int().min(1).max(8).optional(), cpu: z.number().int().min(1).max(4).optional() }).strict().optional(),
    reservePercent: z.number().int().min(0).max(90).optional(),
    dailyUsdCap: z.number().min(0).max(10_000).optional(),
    prices: z.record(z.string().min(3).max(80), z.object({ inputPerMTokUsd: z.number().min(0).max(1000), outputPerMTokUsd: z.number().min(0).max(1000), cacheReadPerMTokUsd: z.number().min(0).max(1000) }).strict()).optional(),
    perClaimRunsPerDay: z.number().int().min(1).max(100).optional(),
    debugTranscripts: z.boolean().optional(),
    agentsEnabled: z.boolean().optional(),
  })
  .strict();

const secretBody = z.object({ value: z.string().trim().min(20).max(4096).regex(/^\S+$/, 'must not contain spaces') }).strict();
const checklistBody = z.object({ item: z.enum(CHECKLIST_ITEM_IDS as unknown as [ChecklistItemId, ...ChecklistItemId[]]), done: z.boolean() }).strict();

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ai/status', async () => buildStatus(ctx));

  app.post('/ai/check', async () => buildStatus(ctx, true));

  app.patch('/ai/settings', async (request) => {
    requireRole(request, ['admin']);
    const body = parse(settingsPatchBody, request.body ?? {});
    const { agentsEnabled, ...ai } = body;
    const current = ctx.repos.getAgentSettings(ctx.db);
    const nextDriver = ai.driver ?? current.ai.driver;
    const aiLane = ai.lanes?.ai ?? current.ai.lanes.ai;
    if (nextDriver === 'subscription_cli' && aiLane > 3) throw badRequest('On the subscription the AI lane allows at most 3 jobs at once', { field: 'lanes.ai' });
    const patch: Parameters<typeof ctx.repos.patchAgentSettings>[1] = {};
    if (Object.keys(ai).length) patch.ai = ai as Partial<AiSettings>;
    // No driver → no agents.
    if (ai.driver === 'off' && current.agents.enabled) patch.agents = { enabled: false };
    if (Object.keys(patch).length) ctx.repos.patchAgentSettings(ctx.db, patch, request.actor, ctx.now());
    if (agentsEnabled === true) {
      const status = await buildStatus(ctx, true);
      if (!status.canEnableAgents) throw conflict('AGENTS_NOT_READY', `Agents cannot be switched on yet: ${status.blockers.join('; ')}`, { blockers: status.blockers });
      ctx.repos.patchAgentSettings(ctx.db, { agents: { enabled: true } }, request.actor, ctx.now());
    } else if (agentsEnabled === false) {
      ctx.repos.patchAgentSettings(ctx.db, { agents: { enabled: false } }, request.actor, ctx.now());
    }
    return buildStatus(ctx);
  });

  const secretRoutes: Array<{ url: string; name: SecretName; wrongPrefix: RegExp; wrongMessage: string }> = [
    { url: '/ai/token', name: 'claude_oauth_token', wrongPrefix: /^sk-ant-api/i, wrongMessage: 'That looks like an Anthropic API key — paste it under “API key” instead' },
    { url: '/ai/api-key', name: 'anthropic_api_key', wrongPrefix: /^sk-ant-oat/i, wrongMessage: 'That looks like a Claude Code sign-in token — paste it under “Sign-in token” instead' },
  ];
  for (const s of secretRoutes) {
    app.put(s.url, async (request) => {
      requireRole(request, ['admin']);
      const { value } = parse(secretBody, request.body ?? {});
      if (s.wrongPrefix.test(value)) throw badRequest(s.wrongMessage);
      await ctx.secrets.set(s.name, value);
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'secret.set', entity: 'secrets', entityId: s.name, after: { name: s.name }, at: ctx.now() });
      cliCache.delete(ctx);
      return { name: s.name, present: true };
    });
    app.delete(s.url, async (request) => {
      requireRole(request, ['admin']);
      await ctx.secrets.delete(s.name);
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'secret.delete', entity: 'secrets', entityId: s.name, after: { name: s.name }, at: ctx.now() });
      cliCache.delete(ctx);
      return { name: s.name, present: false };
    });
  }

  app.post('/ai/open-setup-token', async (request) => {
    requireRole(request, ['admin']);
    if (process.platform !== 'win32') throw new HttpError(501, 'NOT_SUPPORTED', 'The sign-in window opens on Windows only. Run `claude setup-token` in a terminal, sign in with the Max account, and paste the printed token here.');
    if (realAiForbidden(ctx)) throw conflict('REAL_AI_FORBIDDEN', 'Claude Code cannot be started in this process (CLAIMDESK_FORBID_REAL_AI=1)');
    const cli = await cliStatus(ctx, true);
    if (!cli.path || !/\.exe$/i.test(cli.path)) throw conflict('CLI_NOT_FOUND', 'Claude Code (claude.exe) was not found: install it with `winget install Anthropic.ClaudeCode`, then press Check');
    const child = spawn('cmd.exe', ['/c', 'start', 'Claude sign-in', cli.path, 'setup-token'], { shell: false, detached: true, windowsHide: false, stdio: 'ignore', env: buildCliEnv(process.env, undefined, ctx.config.appHome) });
    child.on('error', (err) => ctx.logger.warn('could not open the Claude sign-in window', { error: String(err) }));
    child.unref();
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'ai.setup_token.open', entity: 'agent_settings', entityId: 'default', after: { cli: cli.path }, at: ctx.now() });
    return { opened: true, instructions: 'Sign in with your Claude Max account in the browser, copy the token the window prints, and paste it into “Sign-in token”.' };
  });

  app.post('/ai/test-run', async (request) => {
    requireRole(request, ['admin']);
    if (realAiForbidden(ctx)) throw conflict('REAL_AI_FORBIDDEN', 'Test runs are disabled in this process (CLAIMDESK_FORBID_REAL_AI=1)');
    const choice = selectedDriver(ctx);
    if (choice === 'off') throw conflict('AI_OFF', 'Choose a driver first');
    const driver = getDriver(ctx);
    const runId = `test-${randomUUID()}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 150_000);
    try {
      const outcome = await driver.run(
        {
          runId,
          jobId: runId,
          agent: 'supervisor',
          jobType: 'dailylog.compile',
          model: 'claude-sonnet-5-5',
          effort: 'low',
          maxTurns: 1,
          timeoutMs: 120_000,
          system: [{ id: 'test', text: 'You are checking that ClaimDesk can reach Claude. Answer with the JSON result only.', stable: true }],
          user: 'Return {"ok": true}.',
          attachments: [],
          tools: [],
          allowRead: false,
          resultSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          resultSchemaId: 'research_answer',
          runDir: path.join(ctx.config.agentRunsDir, runId),
          promptVersion: 'test-run',
        },
        { call: async () => ({ ok: false, content: '{"error":{"code":"NO_TOOLS"}}' }) },
        ac.signal,
      );
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'ai.test_run', entity: 'agent_settings', entityId: 'default', after: { driver: driver.kind, outcome: outcome.kind }, at: ctx.now() });
      return { driver: driver.kind, outcome: outcome.kind, ...(outcome.kind === 'ok' ? { model: outcome.model, usage: outcome.usage } : {}), ...('message' in outcome ? { message: outcome.message } : {}), ...(outcome.kind === 'usage_limited' ? { resetsAt: outcome.resetsAt ?? null } : {}) };
    } finally {
      clearTimeout(timer);
    }
  });

  app.post('/ai/checklist', async (request) => {
    requireRole(request, ['admin']);
    const { item, done } = parse(checklistBody, request.body ?? {});
    const at = ctx.now();
    const current = ctx.repos.getAgentSettings(ctx.db);
    const patch: Parameters<typeof ctx.repos.patchAgentSettings>[1] = { checklist: { [item]: { done, at: done ? at : null, by: done ? request.actor.userId : null } } };
    // Unticking an item while agents run switches them off: the checklist must stay complete.
    if (!done && current.agents.enabled) patch.agents = { enabled: false };
    ctx.repos.patchAgentSettings(ctx.db, patch, request.actor, at);
    return buildStatus(ctx);
  });
}
