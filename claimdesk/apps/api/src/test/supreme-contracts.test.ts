/**
 * Cross-slice contracts (docs/SUPREME-DESIGN.md §B.3, §C.2, §C.7, §P) — owned by the integrator. Producers and consumers
 * live in different slices; these checks keep them agreeing:
 *  - every agent tool's declared HTTP route is a real route of the app (the perimeter allow-list is built from them);
 *  - every Phase 1 job type has exactly one handler whose lane, AI use and default priority match JOB_TYPE_INFO;
 *  - every Phase 1 tool name is registered, and every Needs-you kind that a slice owns has a resolver;
 *  - the default schedules only name job types that have a handler;
 *  - real AI is forbidden for the whole test process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_TYPES, JOB_TYPE_INFO, NEEDS_YOU_KINDS, PHASE1_TOOL_NAMES } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { allJobHandlers, allNeedsYouResolvers, getJobHandler, registryProblems } from '../agent/handlers/index.js';
import { agentRouteAllowlist, allTools } from '../agent/tools/index.js';
import { seedSchedules } from '../agent/scheduler.js';
import { computeGates } from '../agent/supervisor.js';
import { currentLaneLimits } from '../agent/queue.js';
import { agentsStatus } from '../routes/agents.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('test process', () => {
  it('forbids real AI', () => {
    expect(process.env.CLAIMDESK_FORBID_REAL_AI).toBe('1');
  });
});

describe('tool registry vs routes', () => {
  it('every declared tool route and every allow-listed route exists in the app', () => {
    // hasRoute matches the registered pattern exactly (sanity: a made-up route is not found, a real one is).
    expect(t.app.hasRoute({ method: 'GET', url: '/api/claims/:id/no-such-thing' })).toBe(false);
    expect(t.app.hasRoute({ method: 'GET', url: '/api/claims/:id' })).toBe(true);
    const missing: string[] = [];
    for (const key of agentRouteAllowlist()) {
      const [method, url] = key.split(' ') as [string, string];
      if (!t.app.hasRoute({ method: method as 'GET', url })) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it('every HTTP tool declares its route; tool names are unique; Phase 1 names are all registered', () => {
    const tools = allTools();
    expect(tools.filter((x) => x.http && !x.httpRoute).map((x) => x.name)).toEqual([]);
    const names = tools.map((x) => x.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    expect(PHASE1_TOOL_NAMES.filter((n) => !names.includes(n))).toEqual([]);
  });

  it('the unscoped claim list stays off the agent allow-list', () => {
    expect(agentRouteAllowlist().has('GET /api/claims')).toBe(false);
  });
});

describe('job handlers vs job types', () => {
  it('has no duplicate handlers or resolvers', () => {
    expect(registryProblems()).toEqual([]);
  });

  it('every Phase 1 job type has a handler matching JOB_TYPE_INFO', () => {
    const problems: string[] = [];
    for (const type of JOB_TYPES) {
      const h = getJobHandler(type);
      const info = JOB_TYPE_INFO[type];
      if (!h) {
        problems.push(`${type}: no handler`);
        continue;
      }
      if (h.lane !== info.lane) problems.push(`${type}: lane ${h.lane} ≠ ${info.lane}`);
      if (h.defaultPriority !== info.defaultPriority) problems.push(`${type}: priority ${h.defaultPriority} ≠ ${info.defaultPriority}`);
      if (h.usesAi !== (info.usesAi !== false && info.usesAi !== 'optional')) problems.push(`${type}: usesAi ${h.usesAi} ≠ ${String(info.usesAi)}`);
      if (h.mutatesClaim !== info.mutatesClaim) problems.push(`${type}: mutatesClaim ${h.mutatesClaim} ≠ ${info.mutatesClaim}`);
    }
    expect(problems).toEqual([]);
    expect(allJobHandlers().map((h) => h.type).filter((x) => !(JOB_TYPES as readonly string[]).includes(x))).toEqual([]);
  });

  it('every seeded schedule names a job type with a handler', () => {
    const rows = seedSchedules(t.ctx);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !getJobHandler(r.jobType)).map((r) => r.jobType)).toEqual([]);
  });
});

describe('Needs-you kinds vs resolvers', () => {
  it('every kind a slice acts on has a resolver (override_needed is answered by the generic record only)', () => {
    const kinds = new Set(allNeedsYouResolvers().map((r) => r.kind));
    expect(NEEDS_YOU_KINDS.filter((k) => k !== 'override_needed' && !kinds.has(k))).toEqual([]);
  });
});

describe('AI_DRIVER override vs the runtime gates (gateway ↔ runtime)', () => {
  it('the lanes, gates and status use the driver the gateway will run, not only Settings > AI', async () => {
    const f = await createTestApp('2026-10-07T09:00:00.000Z', { config: { aiDriverOverride: 'fake' } });
    try {
      // Settings > AI still says "off" (the install default); AI_DRIVER=fake is what runAgent will use.
      f.ctx.repos.patchAgentSettings(f.ctx.db, { agents: { enabled: true } }, { userId: 'test' });
      const { gates, ai } = computeGates(f.ctx, f.ctx.now());
      expect(ai).toMatchObject({ enabled: true, driver: 'fake' });
      expect(gates.lanes.ai.open).toBe(true);
      expect(agentsStatus(f.ctx)).toMatchObject({ enabled: true, driver: 'fake' });
      expect(currentLaneLimits(f.ctx).lanes.ai).toBe(1);
    } finally {
      await f.close();
    }
    // Without the override the stored "off" keeps the AI lane shut.
    t.ctx.repos.patchAgentSettings(t.ctx.db, { agents: { enabled: true } }, { userId: 'test' });
    expect(computeGates(t.ctx, t.ctx.now()).gates.lanes.ai).toMatchObject({ open: false, reason: 'agents_off' });
    expect(agentsStatus(t.ctx).pill.state).toBe('off');
    t.ctx.repos.patchAgentSettings(t.ctx.db, { agents: { enabled: false } }, { userId: 'test' });
  });
});
