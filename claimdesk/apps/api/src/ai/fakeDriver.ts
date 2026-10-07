/**
 * FakeDriver (docs/SUPREME-DESIGN.md §A.4) — owned by `gateway`. Deterministic; the only driver CI and vitest use.
 * Selectable in a running app only with CLAIMDESK_ALLOW_FAKE_AI=1 (tests always may).
 *
 * Fixtures are JSON files under `apps/api/src/ai/fixtures/**` (each slice keeps its own sub-folder; a file holds one
 * fixture or an array). Matching: `jobType` + every `userContains` substring (case-insensitive) + payload predicates
 * (`"*"` = present; objects recurse; anything else equal); the first match wins; no match → `invalid_output` listing
 * the fixture ids, so a missing fixture fails loudly. `steps` run through the REAL ToolExecutor (dispatcher → policy →
 * perimeter → routes), with `$job.*` and `$step[n].*` substitution, exactly as a model's tool calls would.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../context.js';
import type { AiDriver, AiRunOutcome, AiRunRequest, AiUsage, DriverHealth, ToolCallResult, ToolExecutor } from './types.js';

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export type FakeOutcomeKind = 'ok' | 'usage_limited' | 'auth_failed' | 'refused' | 'invalid_output' | 'error' | 'timeout';

export interface FakeFixture {
  id: string;
  match: { jobType: string; agent?: string; userContains?: string[]; payload?: Record<string, unknown> };
  steps?: Array<{ tool: string; input: unknown }>;
  outcome: FakeOutcomeKind;
  /** usage_limited: resets this many minutes after "now". */
  resetsInMinutes?: number;
  limitType?: string;
  result?: unknown;
  usage?: Partial<AiUsage>;
  /** error / auth_failed message; refused explanation. */
  message?: string;
  code?: string;
  retryable?: boolean;
  category?: string;
  raw?: string;
  errors?: string[];
  /** Where the fixture came from (set by the loader). */
  source?: string;
}

export class FakeAiNotAllowedError extends Error {
  readonly code = 'FAKE_AI_NOT_ALLOWED';
  constructor() {
    super('The fake AI driver is for tests and CI only (set CLAIMDESK_ALLOW_FAKE_AI=1 for a CI smoke run)');
  }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

function isFixture(v: unknown): v is FakeFixture {
  const f = v as FakeFixture;
  return Boolean(f && typeof f === 'object' && typeof f.id === 'string' && f.match && typeof f.match.jobType === 'string' && typeof f.outcome === 'string');
}

/** Load every fixture under `dir` (recursively, files sorted by path). Invalid files throw with their path. */
export function loadFixtures(dir: string = FIXTURES_DIR): FakeFixture[] {
  const out: FakeFixture[] = [];
  for (const file of walk(dir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Fake AI fixture ${file} is not valid JSON: ${String(err)}`);
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const f of list) {
      if (!isFixture(f)) throw new Error(`Fake AI fixture in ${file} is missing id / match.jobType / outcome`);
      out.push({ ...f, source: path.relative(dir, file) });
    }
  }
  return out;
}

function matchesPayload(expected: unknown, actual: unknown): boolean {
  if (expected === '*') return actual !== undefined && actual !== null;
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => matchesPayload(v, (actual as Record<string, unknown>)[k]));
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

export interface FakeJobView {
  id: string;
  runId: string;
  claimId?: string;
  agent: string;
  jobType: string;
  payload: unknown;
}

/** The first fixture matching the request (or undefined). */
export function findFixture(fixtures: FakeFixture[], req: AiRunRequest, job: FakeJobView): FakeFixture | undefined {
  const user = req.user.toLowerCase();
  return fixtures.find(
    (f) =>
      f.match.jobType === req.jobType &&
      (!f.match.agent || f.match.agent === req.agent) &&
      (f.match.userContains ?? []).every((s) => user.includes(s.toLowerCase())) &&
      (!f.match.payload || matchesPayload(f.match.payload, job.payload)),
  );
}

function getPath(root: unknown, dotted: string): unknown {
  let cur: unknown = root;
  for (const part of dotted.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    const m = /^(\w+)\[(\d+)\]$/.exec(part);
    if (m) {
      const list = (cur as Record<string, unknown>)[m[1]!];
      cur = Array.isArray(list) ? list[Number(m[2])] : undefined;
    } else {
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

const TOKEN = /\$(job|step\[(\d+)\])((?:\.[A-Za-z0-9_]+(?:\[\d+\])?)*)/g;

/** Substitute `$job.*` and `$step[n].*` (a whole-string token keeps the value's type; inside text it is stringified). */
export function substitute(value: unknown, job: FakeJobView, steps: unknown[]): unknown {
  if (typeof value === 'string') {
    const resolve = (kind: string, n: string | undefined, rest: string): unknown => (kind === 'job' ? getPath(job, rest) : getPath(steps[Number(n)], rest));
    const whole = new RegExp(`^${TOKEN.source}$`).exec(value);
    if (whole) return resolve(whole[1]!, whole[2], whole[3] ?? '');
    return value.replace(TOKEN, (_m, kind: string, n: string | undefined, rest: string) => {
      const v = resolve(kind, n, rest ?? '');
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, job, steps));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, job, steps)]));
  return value;
}

export interface FakeDriverOptions {
  /** Extra fixtures checked before the files (tests). */
  fixtures?: FakeFixture[];
  /** Fixture folder (default apps/api/src/ai/fixtures). */
  dir?: string;
}

export interface FakeStepRecord {
  tool: string;
  input: unknown;
  result: ToolCallResult;
}

export class FakeDriver implements AiDriver {
  readonly kind = 'fake' as const;
  private fileFixtures: FakeFixture[] | undefined;
  /** The steps of the most recent run (tests inspect them). */
  lastSteps: FakeStepRecord[] = [];
  lastFixtureId: string | undefined;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: FakeDriverOptions = {},
  ) {
    if (ctx.config.env !== 'test' && !ctx.config.allowFakeAi) throw new FakeAiNotAllowedError();
  }

  fixtures(): FakeFixture[] {
    if (!this.fileFixtures) this.fileFixtures = loadFixtures(this.opts.dir ?? FIXTURES_DIR);
    return [...(this.opts.fixtures ?? []), ...this.fileFixtures];
  }

  async health(): Promise<DriverHealth> {
    const problems: string[] = [];
    try {
      this.fixtures();
    } catch (err) {
      problems.push(String(err instanceof Error ? err.message : err));
    }
    return { kind: this.kind, ready: problems.length === 0, problems };
  }

  async run(req: AiRunRequest, tools: ToolExecutor, signal: AbortSignal): Promise<AiRunOutcome> {
    const started = Date.now();
    this.lastSteps = [];
    const stored = this.ctx.repos.getAgentJob(this.ctx.db, req.jobId);
    const job: FakeJobView = { id: req.jobId, runId: req.runId, ...(req.claimId ?? stored?.claimId ? { claimId: req.claimId ?? stored?.claimId } : {}), agent: req.agent, jobType: req.jobType, payload: stored?.payload ?? {} };
    const all = this.fixtures();
    const fixture = findFixture(all, req, job);
    this.lastFixtureId = fixture?.id;
    if (!fixture) {
      const ids = all.filter((f) => f.match.jobType === req.jobType).map((f) => f.id);
      return { kind: 'invalid_output', raw: '', errors: [`no fake AI fixture matches job type ${req.jobType}${ids.length ? `; fixtures for it: ${ids.join(', ')}` : `; known fixtures: ${all.map((f) => f.id).join(', ') || 'none'}`}`] };
    }
    const stepResults: unknown[] = [];
    for (const step of fixture.steps ?? []) {
      if (signal.aborted) return { kind: 'timeout' };
      const input = substitute(step.input, job, stepResults);
      const result = await tools.call(step.tool, input);
      this.lastSteps.push({ tool: step.tool, input, result });
      let parsed: unknown = result.content;
      try {
        parsed = JSON.parse(result.content);
      } catch {
        /* keep text */
      }
      stepResults.push(parsed);
    }
    if (signal.aborted) return { kind: 'timeout' };
    const usage: AiUsage = {
      inputTokens: fixture.usage?.inputTokens ?? 0,
      outputTokens: fixture.usage?.outputTokens ?? 0,
      cacheReadTokens: fixture.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: fixture.usage?.cacheWriteTokens ?? 0,
      durationMs: fixture.usage?.durationMs ?? Date.now() - started,
      numTurns: fixture.usage?.numTurns ?? (fixture.steps?.length ?? 0) + 1,
      costUsd: fixture.usage?.costUsd ?? 0,
    };
    switch (fixture.outcome) {
      case 'ok':
        return { kind: 'ok', result: substitute(fixture.result, job, stepResults), usage, model: req.model, stopReason: 'end_turn' };
      case 'usage_limited': {
        const resetsAt = new Date(Date.parse(this.ctx.now()) + (fixture.resetsInMinutes ?? 15) * 60_000).toISOString();
        return { kind: 'usage_limited', resetsAt, limitType: fixture.limitType ?? 'five_hour', usage };
      }
      case 'auth_failed':
        return { kind: 'auth_failed', message: fixture.message ?? 'OAuth token has expired (fake)' };
      case 'refused':
        return { kind: 'refused', ...(fixture.category ? { category: fixture.category } : {}), ...(fixture.message ? { explanation: fixture.message } : {}), usage };
      case 'invalid_output':
        return { kind: 'invalid_output', raw: fixture.raw ?? JSON.stringify(fixture.result ?? null), errors: fixture.errors ?? ['fixture outcome invalid_output'], usage };
      case 'timeout':
        return { kind: 'timeout', usage };
      case 'error':
      default:
        return { kind: 'error', retryable: fixture.retryable ?? true, message: fixture.message ?? 'fake error', ...(fixture.code ? { code: fixture.code } : {}), usage };
    }
  }
}
