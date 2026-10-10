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
import { KNOWLEDGE_JOB_TYPES, AUTOPILOT_JOB_TYPES, AUTOPILOT_NEEDS_YOU_KINDS, JOB_TYPES, JOB_TYPE_INFO, NEEDS_YOU_KINDS, PHASE1_TOOL_NAMES } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { allJobHandlers, allNeedsYouResolvers, getJobHandler, registryProblems } from '../agent/handlers/index.js';
import { agentRouteAllowlist, allTools } from '../agent/tools/index.js';
import { seedSchedules } from '../agent/scheduler.js';
import { computeGates } from '../agent/supervisor.js';
import { currentLaneLimits } from '../agent/queue.js';
import { agentsStatus } from '../routes/agents.js';

/**
 * Autopilot job types, Needs-you kinds and schedules whose handler / resolver its owning slice has not registered yet
 * (docs/SUPREME-AUTOPILOT.md §K: ap-foundation adds the vocabulary, each wave-2/3 slice registers its own). Each slice
 * removes its entries here when it registers them; after wave 3 both maps must be empty.
 */
const AWAITING_SLICE_JOB_TYPES: Readonly<Record<string, string>> = {
  'autopilot.tick': 'ap-autopilot',
  'autopilot.sweep': 'ap-autopilot',
  'autopilot.judge': 'ap-autopilot',
  'hire_offer.parse_reply': 'ap-autopilot',
  'pack.prepare': 'ap-paperwork',
  'signing.chase': 'ap-paperwork',
  'signing.match_return': 'ap-paperwork',
  'booking.expire_holds': 'ap-booking',
  'fleet.status_sync': 'ap-booking',
  'fleet.compliance_watch': 'ap-booking',
  'movement.remind': 'ap-booking',
  'clash.check': 'ap-clash',
  'clash.sweep': 'ap-clash',
};
const AWAITING_SLICE_NEEDS_YOU_KINDS: Readonly<Record<string, string>> = {
  choose_car: 'ap-autopilot',
  autopilot_step: 'ap-autopilot',
  approve_pack: 'ap-paperwork',
  confirm_signed: 'ap-paperwork',
  clash_review: 'ap-clash',
  eligibility_review: 'ap-clash',
};
/** Knowledge Builder job types whose handler their slice has not registered yet (KB §13; same rule as above). */
const AWAITING_KNOWLEDGE_JOB_TYPES: Readonly<Record<string, string>> = {
  'knowledge.observe': 'knowledge-learners',
  'knowledge.consolidate': 'knowledge-learners',
  'knowledge.learn_stats': 'knowledge-learners',
  'knowledge.curate': 'knowledge-learners',
  'knowledge.gap_scan': 'knowledge-research',
  'knowledge.research': 'knowledge-research',
  'knowledge.research_web': 'knowledge-research',
  'knowledge.fetch': 'knowledge-research',
  'knowledge.watch': 'knowledge-research',
  'knowledge.replay': 'knowledge-use',
  'knowledge.replay_drafts': 'knowledge-use',
  'knowledge.drift': 'knowledge-use',
};
const awaitingHandler = (type: string): boolean => (type in AWAITING_SLICE_JOB_TYPES || type in AWAITING_KNOWLEDGE_JOB_TYPES) && !getJobHandler(type as never);

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
        if (!(type in AWAITING_SLICE_JOB_TYPES) && !(type in AWAITING_KNOWLEDGE_JOB_TYPES)) problems.push(`${type}: no handler`);
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
    expect(rows.filter((r) => !getJobHandler(r.jobType) && !awaitingHandler(r.jobType)).map((r) => r.jobType)).toEqual([]);
  });
});

describe('Autopilot vocabulary awaiting its slices', () => {
  it('lists only Autopilot types and kinds, and drops an entry once its handler or resolver is registered', () => {
    expect(Object.keys(AWAITING_SLICE_JOB_TYPES).every((k) => (AUTOPILOT_JOB_TYPES as readonly string[]).includes(k))).toBe(true);
    expect(Object.keys(AWAITING_SLICE_NEEDS_YOU_KINDS).every((k) => (AUTOPILOT_NEEDS_YOU_KINDS as readonly string[]).includes(k))).toBe(true);
    // A registered handler / resolver must be removed from the waiting list (keeps the contract strict).
    expect(Object.keys(AWAITING_SLICE_JOB_TYPES).filter((k) => getJobHandler(k as never))).toEqual([]);
    const kinds = new Set(allNeedsYouResolvers().map((r) => r.kind));
    expect(Object.keys(AWAITING_SLICE_NEEDS_YOU_KINDS).filter((k) => kinds.has(k as never))).toEqual([]);
  });
});

describe('Knowledge Builder vocabulary awaiting its slices', () => {
  it('lists only knowledge job types and drops an entry once its handler is registered', () => {
    expect(Object.keys(AWAITING_KNOWLEDGE_JOB_TYPES).every((k) => (KNOWLEDGE_JOB_TYPES as readonly string[]).includes(k))).toBe(true);
    expect(Object.keys(AWAITING_KNOWLEDGE_JOB_TYPES).filter((k) => getJobHandler(k as never))).toEqual([]);
  });
});

describe('Needs-you kinds vs resolvers', () => {
  it('every kind a slice acts on has a resolver (override_needed is answered by the generic record only)', () => {
    const kinds = new Set(allNeedsYouResolvers().map((r) => r.kind));
    expect(NEEDS_YOU_KINDS.filter((k) => k !== 'override_needed' && !kinds.has(k) && !(k in AWAITING_SLICE_NEEDS_YOU_KINDS))).toEqual([]);
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
