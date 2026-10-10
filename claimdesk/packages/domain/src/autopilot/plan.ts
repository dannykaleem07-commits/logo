// owned by ap-autopilot
/**
 * planAutopilot (docs/SUPREME-AUTOPILOT.md §A.5): the pure state machine. For every step of the catalogue, in order:
 *
 *   1 appliesWhen false → not_applicable
 *   2 claim override skip → skipped; done → done; snooze (future) → waiting on time
 *   3 doneWhen → done
 *   4 an `after` step not done / skipped / not applicable → upcoming
 *   5 a readyWhen false → upcoming
 *   6 a missing requirement → blocked (requirement)
 *   7 an open block finding with a code in blockingClashes → blocked (clash)
 *   8 an open job / outbox item / Needs-you item for the step → in_progress (waiting on the owner for Needs-you)
 *   9 waitingOn.when → waiting
 *  10 otherwise due (dueAt from the deadline, overdue when past)
 *  11 the claim paused (autopilot or SD pause) → every due step becomes paused
 *
 * The effective mode is max(floor, settings ?? default, claim override "ask"), lowered to the floor by an "auto"
 * override, and raised to "Ask me" when a green-gated step is not green. `modeReasons` says why in plain English.
 * The plan is derived — never the source of truth — and its hash is identical for identical facts.
 */
import { addWorkingDays } from '../calendar/calendar.js';
import { greenTest, type GreenResult } from '../booking/green.js';
import { sha256Hex } from '../evidence/hash.js';
import type { ISODateTime } from '../types.js';
import { configuredStepMode, floorReason } from './settings.js';
import { STAGELESS_STEPS, STEP_CATALOGUE, STEP_RELATED_NEEDS_YOU, stepTitle } from './steps.js';
import { DATE_FACTS, REQUIREMENTS, holds, hireNeeded, missingRequirements } from './predicates.js';
import { activeReservation, currentOffer, liveReservation, msOf, packOf, type AutopilotFacts } from './facts.js';
import {
  GREEN_GATED_STEPS,
  STAGE_ORDER,
  STEP_MODE_RANK,
  stricterMode,
  type AutopilotPlan,
  type AutopilotStepId,
  type StageId,
  type StepDef,
  type StepMode,
  type StepOption,
  type StepRefs,
  type StepState,
  type StepStatus,
  type TerminalStage,
} from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIVE_JOB = new Set(['queued', 'leased', 'waiting_usage', 'waiting_user']);
const OUTBOX_IN_PROGRESS = new Set(['draft', 'reviewing', 'held', 'queued', 'sending']);

const iso = (ms: number): ISODateTime => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Green (§D.1) per green-gated step
// ---------------------------------------------------------------------------

/** Is the step green? Only green-gated steps can be "not green"; every other step is green. */
export function greenFor(f: AutopilotFacts, id: AutopilotStepId): GreenResult {
  switch (id) {
    case 'qualify.driver': {
      const d = f.eligibility?.driver;
      if (!d) return { green: false, reasons: ['Driver eligibility is not known yet.'] };
      const all = [d, ...(f.eligibility?.additionalDrivers ?? [])];
      const bad = all.filter((x) => x.outcome !== 'eligible');
      if (!bad.length) return { green: true, reasons: [] };
      return { green: false, reasons: bad.flatMap((x) => (x.outcome === 'refer' ? ['The driver needs a referral to the insurer — never booked without the owner.'] : x.reasons.map((r) => r.message))).slice(0, 5) };
    }
    case 'qualify.need': {
      const level = f.eligibility?.need.level ?? 'unknown';
      return level === 'strong' || level === 'moderate' ? { green: true, reasons: [] } : { green: false, reasons: [level === 'unknown' ? "The client's need for a car is not established yet." : `The client's need for a car is ${level}.`] };
    }
    case 'hire.choose':
    case 'hire.offer': {
      const live = liveReservation(f);
      if (live && f.ownerChosenReservationIds.includes(live.id)) return { green: true, reasons: [] };
      const offer = currentOffer(f);
      if (offer && offer.authorisedBy !== 'autopilot_green') return { green: true, reasons: [] };
      const candidate = live?.ranking ?? f.availability?.ranked[0] ?? null;
      const ra = f.recordedAcceptance;
      return greenTest({
        candidate,
        minLikeForLike: f.settings.green.minLikeForLike,
        findings: f.clashes,
        acceptance: { decision: ra?.decision ?? null, conditionsMet: (ra?.conditions.length ?? 0) === 0 },
        need: f.eligibility?.need.level ?? 'unknown',
        interventionUnanswered: f.bundle.offers.some((o) => !o.replySentAt),
        clientWantsHire: f.needs?.clientWantsHire ?? null,
        clientEmail: f.clientEmail,
        claimPaused: false,
        autoOffersToday: f.autoOffersToday,
        maxAutoOffersPerDay: f.settings.green.maxAutoOffersPerDay,
      });
    }
    default:
      return { green: true, reasons: [] };
  }
}

// ---------------------------------------------------------------------------
// Effective mode (§A.5)
// ---------------------------------------------------------------------------

const MODE_WORD: Record<StepMode, string> = { auto: 'Auto', confirm: 'Ask me', owner: 'I do it' };

export function effectiveMode(def: StepDef, f: AutopilotFacts, green: GreenResult, stage?: StageId | TerminalStage): { mode: StepMode; reasons: string[] } {
  const reasons: string[] = [];
  let mode = configuredStepMode(f.settings, def.id, def.defaultMode);
  const floorWhy = floorReason(def.id);
  if (def.floor !== 'auto' && floorWhy) reasons.push(floorWhy);
  if (STEP_MODE_RANK[mode] > STEP_MODE_RANK[def.defaultMode]) reasons.push(`Settings > Autopilot set this step to "${MODE_WORD[mode]}"`);
  const o = f.claimAutopilot.overrides[def.id];
  if (o?.action === 'ask') {
    if (STEP_MODE_RANK[mode] < STEP_MODE_RANK.confirm) reasons.push('You asked to be asked first on this claim');
    mode = stricterMode(mode, 'confirm');
  } else if (o?.action === 'auto') {
    mode = def.floor;
  }
  if ((GREEN_GATED_STEPS as readonly string[]).includes(def.id) && !green.green) {
    if (STEP_MODE_RANK[mode] < STEP_MODE_RANK.confirm) reasons.push(`Not green: ${green.reasons.join(' ')}`.slice(0, 600));
    mode = stricterMode(mode, 'confirm');
  }
  if (stage === 'legal' && def.action.kind === 'draft' && def.action.recipient === 'at_fault_insurer') {
    if (STEP_MODE_RANK[mode] < STEP_MODE_RANK.confirm) reasons.push('The claim is with the legal team: nothing goes to the other side automatically');
    mode = stricterMode(mode, 'confirm');
  }
  return { mode, reasons };
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

export function deadlineFor(def: StepDef, f: AutopilotFacts): ISODateTime | undefined {
  const d = def.deadline;
  if (!d) return undefined;
  if (d.clock) {
    const c = f.bundle.clocks.filter((x) => x.kind === d.clock && x.status === 'running').sort((a, b) => msOf(a.dueAt) - msOf(b.dueAt))[0];
    if (c) return iso(msOf(c.dueAt));
  }
  const from = d.fromFact ? DATE_FACTS[d.fromFact]?.(f) : undefined;
  if (!from || !Number.isFinite(msOf(from))) return undefined;
  let at = from;
  if (d.workingDays) at = addWorkingDays(at, d.workingDays);
  let ms = msOf(at);
  if (d.days) ms += d.days * DAY;
  if (d.hours) ms += d.hours * HOUR;
  return iso(ms);
}

// ---------------------------------------------------------------------------
// Refs and in-progress detection (§A.5 rule 8)
// ---------------------------------------------------------------------------

function refsFor(def: StepDef, f: AutopilotFacts): StepRefs {
  const refs: StepRefs = {};
  if (def.track === 'hire') {
    const r = activeReservation(f);
    if (r) refs.reservationId = r.id;
    const o = currentOffer(f);
    if (o && (def.id === 'hire.offer' || def.id === 'hire.acceptance' || def.id === 'hire.confirm')) refs.hireOfferId = o.id;
    const kind = def.id === 'hire.delivery' || def.id === 'hire.handover' ? 'delivery' : def.id === 'hire.offhire' || def.id === 'hire.return' ? 'collection' : undefined;
    const m = kind ? f.movements.find((x) => x.reservationId === r?.id && x.kind === kind && x.status !== 'cancelled') : undefined;
    if (m) refs.movementId = m.id;
    const hire = f.bundle.hire.find((h) => h.reservationId === r?.id) ?? (def.id === 'hire.monitor' || def.id === 'hire.return' ? f.bundle.hire.find((h) => !h.endAt) : undefined);
    if (hire) refs.hireId = hire.id;
  }
  if (def.action.kind === 'pack') {
    const p = packOf(f, def.action.stage);
    if (p) {
      refs.packId = p.id;
      const docs = p.items.map((i) => i.documentId).filter((x): x is string => Boolean(x));
      if (docs.length) refs.documentIds = docs;
    }
  }
  const outboxIds = f.outbox.filter((o) => o.autopilotStepId === def.id).map((o) => o.id);
  if (outboxIds.length) refs.outboxIds = outboxIds;
  const ny = needsYouFor(def, f);
  if (ny) refs.needsYouId = ny.id;
  const job = jobFor(def, f);
  if (job) refs.jobId = job.id;
  return refs;
}

function needsYouFor(def: StepDef, f: AutopilotFacts): { id: string } | undefined {
  const prefix = `autopilot:${f.bundle.claim.id}:${def.id}:`;
  const own = f.openNeedsYou.find((n) => n.dedupeKey?.startsWith(prefix));
  if (own) return own;
  const kinds = STEP_RELATED_NEEDS_YOU[def.id];
  if (!kinds) return undefined;
  return f.openNeedsYou.find((n) => kinds.includes(n.kind));
}

function jobFor(def: StepDef, f: AutopilotFacts): { id: string } | undefined {
  const claimId = f.bundle.claim.id;
  const prefixes = [`autopilot.judge:${claimId}:${def.id}:`];
  if (def.action.kind === 'pack') prefixes.push(`pack.prepare:${claimId}:${def.action.stage}:`);
  if (def.action.kind === 'draft' && def.actionCode) prefixes.push(`draft.compose:${claimId}:${def.actionCode}:`);
  if (def.id === 'hire.acceptance') prefixes.push('hire_offer.parse_reply:');
  return f.openJobs.find((j) => LIVE_JOB.has(j.status) && j.idempotencyKey !== null && prefixes.some((p) => j.idempotencyKey!.startsWith(p)));
}

function progressOf(def: StepDef, f: AutopilotFacts): 'in_progress' | 'owner' | undefined {
  if (needsYouFor(def, f)) return 'owner';
  if (def.action.kind === 'pack') {
    const p = packOf(f, def.action.stage);
    if (p?.status === 'awaiting_approval') return 'owner';
    if (p && (p.status === 'preparing' || p.status === 'reviewing')) return 'in_progress';
  }
  const mine = f.outbox.filter((o) => o.autopilotStepId === def.id);
  if (mine.some((o) => o.status === 'awaiting_approval')) return 'owner';
  if (mine.some((o) => OUTBOX_IN_PROGRESS.has(o.status))) return 'in_progress';
  if (jobFor(def, f)) return 'in_progress';
  return undefined;
}

// ---------------------------------------------------------------------------
// Options (choose_car)
// ---------------------------------------------------------------------------

function optionsFor(def: StepDef, f: AutopilotFacts): StepOption[] | undefined {
  if (def.id !== 'hire.choose' && def.id !== 'hire.search') return undefined;
  const ranked = f.availability?.ranked ?? [];
  if (!ranked.length) return undefined;
  const top = ranked.slice(0, Math.max(1, 1 + f.settings.booking.alternativesShown));
  return [
    ...top.map((c, i) => ({ id: `unit:${c.fleetUnitId}`, label: `${c.registration} — ${c.label}`, detail: `Score ${Math.round(c.score)}. ${c.likeForLike.sentence}`, recommended: i === 0 })),
    { id: 'search_again', label: 'Search again', detail: 'Change the needs or the period and search again', recommended: false },
    { id: 'no_hire', label: 'No hire', detail: 'The client does not need a car from us (give the reason)', recommended: false },
  ];
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const WAITING_WORD: Record<string, string> = { client: 'the client', insurer: 'the insurer', engineer: 'the engineer', repairer: 'the repairer', supplier: 'the supplier', owner: 'you', handler: 'the handler', time: 'the right time', agent: 'an agent' };

function nextSentence(def: StepDef, st: Omit<StepState, 'next'>, f: AutopilotFacts): string {
  const t = def.title;
  switch (st.status) {
    case 'done':
      return `${t}: done.`;
    case 'not_applicable':
      return `${t}: not needed on this claim.`;
    case 'skipped':
      return `${t}: skipped — ${f.claimAutopilot.overrides[def.id]?.reason ?? 'by you'}.`;
    case 'upcoming':
      return `${t}: not ready yet${st.blockedBy.length ? ` (${st.blockedBy[0]!.message})` : ''}.`;
    case 'blocked':
      return `${t}: blocked — ${st.blockedBy[0]?.message ?? 'see the step'}.`;
    case 'in_progress':
      return `${t}: in progress.`;
    case 'waiting':
      return st.waitingOn === 'owner' ? `${t}: waiting for you in Needs-you.` : `${t}: waiting on ${WAITING_WORD[st.waitingOn ?? 'time'] ?? st.waitingOn}.`;
    case 'paused':
      return `${t}: due, but the autopilot is paused on this claim.`;
    case 'failed':
      return `${t}: failed last time; it will be tried again.`;
    case 'due':
      return st.mode === 'auto' ? `Next: ${t.toLowerCase()} — automatic.` : st.mode === 'confirm' ? `Next: ${t.toLowerCase()} — prepared for you to confirm.` : `Next: ${t.toLowerCase()} — you do this step.`;
  }
}

/** The claim's lifecycle stage (§A.5 last paragraph). */
export function stageOf(f: AutopilotFacts, statuses: ReadonlyMap<AutopilotStepId, StepStatus>): StageId | TerminalStage {
  const s = f.bundle.claim.status;
  if (s === 'declined') return 'declined';
  if (s === 'closed' || s === 'settled') return 'closed';
  if (s === 'pre_action' || s === 'litigation') return 'legal';
  const needsHire = hireNeeded(f);
  for (const stage of STAGE_ORDER) {
    if (stage === 'vehicle_secured' && needsHire) continue;
    const open = STEP_CATALOGUE.some((d) => d.stage === stage && !STAGELESS_STEPS.has(d.id) && !['done', 'skipped', 'not_applicable'].includes(statuses.get(d.id) ?? 'not_applicable'));
    if (open) return stage;
  }
  return 'closure';
}

/** Canonical JSON (sorted keys) — the hash input. */
export function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => [k, sort((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
}

function evaluateStep(def: StepDef, f: AutopilotFacts, done: ReadonlyMap<AutopilotStepId, StepStatus>, stage?: StageId | TerminalStage): StepState {
  const green = greenFor(f, def.id);
  const { mode, reasons } = effectiveMode(def, f, green, stage);
  const base: Omit<StepState, 'next' | 'status'> = { id: def.id, mode, modeReasons: reasons, green: green.green, overdue: false, missing: [], blockedBy: [], refs: {} };
  const finish = (status: StepStatus, extra: Partial<StepState> = {}): StepState => {
    const st = { ...base, refs: refsFor(def, f), ...extra, status } as Omit<StepState, 'next'>;
    const options = status === 'due' || status === 'waiting' || status === 'in_progress' ? optionsFor(def, f) : undefined;
    return { ...st, ...(options ? { options } : {}), next: nextSentence(def, st, f) };
  };
  if (!holds(f, def.appliesWhen)) return finish('not_applicable');
  const o = f.claimAutopilot.overrides[def.id];
  if (o?.action === 'skip') return finish('skipped', { since: o.at });
  if (o?.action === 'done') return finish('done', { since: o.at });
  if (holds(f, def.doneWhen)) return finish('done');
  if (o?.action === 'snooze' && o.until && msOf(o.until) > msOf(f.now)) return finish('waiting', { waitingOn: 'time', dueAt: o.until });
  const forced = f.forceStepId === def.id;
  const pending = def.after.filter((a) => !['done', 'skipped', 'not_applicable'].includes(done.get(a) ?? 'upcoming'));
  if (pending.length && !forced) return finish('upcoming', { blockedBy: pending.map((p) => ({ kind: 'step' as const, code: p, message: `after "${stepTitle(p)}"` })) });
  const notReady = def.readyWhen.filter((p) => !holds(f, p));
  if (notReady.length && !forced) return finish('upcoming');
  const missingIds = missingRequirements(f, def.requires);
  if (missingIds.length) {
    const missing = missingIds.map((id) => REQUIREMENTS[id]!.label);
    return finish('blocked', { missing, blockedBy: missingIds.map((id) => ({ kind: 'requirement' as const, code: id, message: `we need ${REQUIREMENTS[id]!.label} (we ask the ${REQUIREMENTS[id]!.ask === 'owner' ? 'owner' : REQUIREMENTS[id]!.ask})` })) });
  }
  const clash = f.clashes.filter((c) => c.severity === 'block' && (def.blockingClashes as readonly string[]).includes(c.code));
  if (clash.length) return finish('blocked', { blockedBy: clash.map((c) => ({ kind: 'clash' as const, code: c.code, message: c.message })) });
  if (def.id === 'qualify.driver' && (f.eligibility?.driver.outcome === 'ineligible' || f.eligibility?.additionalDrivers.some((d) => d.outcome === 'ineligible'))) {
    return finish('blocked', { blockedBy: [{ kind: 'eligibility', code: 'DRIVER_INELIGIBLE', message: 'the driver is not eligible to drive our cars under the policy criteria' }] });
  }
  const dueAt = deadlineFor(def, f);
  const progress = progressOf(def, f);
  if (progress === 'owner') return finish('waiting', { waitingOn: 'owner', ...(dueAt ? { dueAt } : {}) });
  if (progress === 'in_progress' && !forced) return finish('in_progress', dueAt ? { dueAt } : {});
  if (def.waitingOn && holds(f, def.waitingOn.when) && !forced) return finish('waiting', { waitingOn: def.waitingOn.who, ...(dueAt ? { dueAt } : {}) });
  const overdue = dueAt !== undefined && msOf(dueAt) < msOf(f.now);
  return finish('due', { ...(dueAt ? { dueAt } : {}), overdue });
}

/** Evaluate the whole catalogue against the facts. */
export function planAutopilot(f: AutopilotFacts): AutopilotPlan {
  const statuses = new Map<AutopilotStepId, StepStatus>();
  const steps: StepState[] = [];
  for (const def of STEP_CATALOGUE) {
    if (def.id === 'status.sync') continue;
    const st = evaluateStep(def, f, statuses);
    statuses.set(def.id, st.status);
    steps.push(st);
  }
  const stage = stageOf(f, statuses);
  // Second pass for steps that depend on the stage (legal: nothing to the other side automatically; status.sync).
  const final: StepState[] = [];
  for (const def of STEP_CATALOGUE) {
    let st: StepState;
    if (def.id === 'status.sync') st = evaluateStep(def, { ...f, stage } as AutopilotFacts, statuses, stage);
    else st = stage === 'legal' ? evaluateStep(def, f, statuses, stage) : steps.find((s) => s.id === def.id)!;
    final.push(st);
  }
  const terminal = stage === 'declined' || stage === 'closed';
  const claimPaused = f.claimAutopilot.mode !== 'on' || f.agentPaused;
  for (const st of final) {
    if (st.status !== 'due') continue;
    if (terminal || claimPaused) {
      st.status = 'paused';
      st.next = terminal ? `${stepTitle(st.id)}: the claim is ${stage}; nothing more is done automatically.` : nextSentence(STEP_CATALOGUE.find((d) => d.id === st.id)!, st, f);
    }
  }
  const order = new Map(STEP_CATALOGUE.map((d, i) => [d.id, i]));
  const due = final
    .filter((s) => s.status === 'due')
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (msOf(a.dueAt) || Infinity) - (msOf(b.dueAt) || Infinity) || order.get(a.id)! - order.get(b.id)!)
    .map((s) => s.id);
  const nowMs = msOf(f.now);
  const candidates: number[] = [nowMs + 6 * HOUR];
  for (const s of final) if (s.dueAt && (s.status === 'waiting' || s.status === 'due' || s.status === 'in_progress' || s.status === 'upcoming') && msOf(s.dueAt) > nowMs) candidates.push(msOf(s.dueAt));
  const live = liveReservation(f);
  if (live?.holdExpiresAt && msOf(live.holdExpiresAt) > nowMs) candidates.push(msOf(live.holdExpiresAt));
  const offer = currentOffer(f);
  if (offer?.status === 'sent') {
    const remind = msOf(offer.sentAt) + f.settings.booking.offerReminderHours * HOUR;
    if (remind > nowMs) candidates.push(remind);
    if (msOf(offer.expiresAt) > nowMs) candidates.push(msOf(offer.expiresAt));
  }
  const nextCheckAt = iso(Math.max(nowMs + 60_000, Math.min(...candidates.filter((x) => Number.isFinite(x)))));
  const stageIndex = (STAGE_ORDER as readonly string[]).indexOf(stage) + 1;
  const mode = f.claimAutopilot.mode;
  const hashInput = { stage, mode, steps: final.map(({ overdue: _o, ...s }) => s) };
  return {
    version: 'autopilot/1',
    claimId: f.bundle.claim.id,
    evaluatedAt: f.now,
    stage,
    stageIndex: stageIndex > 0 ? stageIndex : 0,
    mode,
    steps: final,
    due,
    waiting: final.filter((s) => s.status === 'waiting').map((s) => s.id),
    done: final.filter((s) => s.status === 'done').map((s) => s.id),
    nextCheckAt,
    planHash: sha256Hex(stableJson(hashInput)),
  };
}

export interface PlanTransition {
  stepId: AutopilotStepId;
  from: StepStatus | 'reopened' | null;
  to: StepStatus | 'reopened';
  refs: StepRefs;
}

/**
 * Status changes between two plans (§A.7 step 2). A step that was done and is no longer done is reported `reopened`
 * (then evaluated again: a second row carries its new status).
 */
export function diffPlans(prev: AutopilotPlan | undefined | null, next: AutopilotPlan): PlanTransition[] {
  const before = new Map((prev?.steps ?? []).map((s) => [s.id, s.status]));
  const out: PlanTransition[] = [];
  for (const s of next.steps) {
    const from = before.get(s.id) ?? null;
    if (from === s.status) continue;
    if (from === 'done' && s.status !== 'done') out.push({ stepId: s.id, from, to: 'reopened', refs: s.refs });
    out.push({ stepId: s.id, from: from === 'done' ? 'reopened' : from, to: s.status, refs: s.refs });
  }
  return out;
}

/** The trimmed plan the autopilot_plan tool and the Case Brief show. */
export function trimPlan(plan: AutopilotPlan): { stage: string; mode: string; due: Array<{ id: string; title: string; dueAt: string | null; mode: StepMode }>; waiting: Array<{ id: string; title: string; on: string }>; blocked: Array<{ id: string; reason: string }>; done: string[] } {
  const by = new Map(plan.steps.map((s) => [s.id, s]));
  return {
    stage: plan.stage,
    mode: plan.mode,
    due: plan.due.map((id) => ({ id, title: stepTitle(id), dueAt: by.get(id)?.dueAt ?? null, mode: by.get(id)!.mode })),
    waiting: plan.waiting.map((id) => ({ id, title: stepTitle(id), on: by.get(id)?.waitingOn ?? 'time' })),
    blocked: plan.steps.filter((s) => s.status === 'blocked').map((s) => ({ id: s.id, reason: s.blockedBy[0]?.message ?? 'blocked' })),
    done: plan.done,
  };
}
