// owned by claimai-server
/**
 * Standing case instructions (docs/CLAIM-AI-INPUT.md §7): create (superseding an older one with the same effect),
 * retire, the view the panel shows, the views the Autopilot / outbox / case manager / prompts read, and the timed end
 * (`claim.instruction_due`). Instructions never widen what an agent may do: code enforces holds and "ask first".
 */
import {
  ACCUSATION_WORDS,
  AGENT_SCOPE_LABEL,
  BANNED_INTAKE_WORDS,
  activeInstructions,
  appliesToAgent,
  effectLabel,
  isAgentScope,
  parseEffect,
  sameEffect,
  scopeLabel,
  type AgentScope,
  type AutopilotOutboxFact,
  type InstructionEffect,
  type InstructionView,
} from '@ccguk/domain';
import type { Actor, ClaimInstructionRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { enqueueJob } from '../agent/core.js';
import { HttpError } from '../errors.js';
import { assertHuman } from '../services/humanOnly.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';

export const SUPERVISOR = 'agent:supervisor';

export function toView(r: ClaimInstructionRecord): InstructionView {
  return {
    id: r.id,
    text: r.text,
    appliesTo: (r.appliesTo.filter(isAgentScope) as AgentScope[]).length ? (r.appliesTo.filter(isAgentScope) as AgentScope[]) : ['all'],
    effect: parseEffect(r.effect),
    activeFrom: r.activeFrom,
    until: r.until ?? null,
  };
}

/** The instructions in force on a claim now, for one agent's runs (all, or scoped to it). */
export function activeInstructionViews(ctx: AppContext, claimId: string, opts: { agent?: string; at?: string } = {}): InstructionView[] {
  const at = opts.at ?? ctx.now();
  const all = ctx.repos.listInstructions(ctx.db, { claimId, status: 'active' }).map(toView);
  const live = activeInstructions(all, at);
  return opts.agent ? live.filter((i) => appliesToAgent(i, opts.agent!)) : live;
}

/** Virtual `sent` outbox facts for off-system letters / emails with an email kind (CLAIM-AI-INPUT §9). */
export function offSystemOutboxFacts(ctx: AppContext, claimId: string): AutopilotOutboxFact[] {
  return ctx.repos
    .listCorrespondence(ctx.db, claimId, { direction: 'out' })
    .filter((r) => r.emailKind)
    .map((r) => ({ id: `corr:${r.id}`, kind: r.emailKind!, status: 'sent', autopilotStepId: null, createdAt: r.at, sentAt: r.at, offSystem: true as const }));
}

export interface StandingInstructionView {
  id: string;
  claimId: string;
  text: string;
  appliesTo: AgentScope[];
  appliesToLabel: string;
  effect: InstructionEffect | null;
  effectLabel: string | null;
  activeFrom: string;
  until: string | null;
  status: 'active' | 'ended' | 'retired';
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  source: { inputId: string; actionKey: string | null } | null;
  retiredBy: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
}

export function userName(ctx: AppContext, id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.startsWith('agent:')) return id.slice(6).replace(/_/g, ' ');
  if (id === 'system') return 'ClaimDesk';
  try {
    const u = ctx.repos.getUser(ctx.db, id);
    return u?.name ?? u?.username ?? null;
  } catch {
    return null;
  }
}

export function instructionView(ctx: AppContext, r: ClaimInstructionRecord): StandingInstructionView {
  const v = toView(r);
  const ended = r.status === 'active' && Boolean(r.until && Date.parse(r.until) <= Date.parse(ctx.now()));
  return {
    id: r.id,
    claimId: r.claimId,
    text: r.text,
    appliesTo: v.appliesTo,
    appliesToLabel: scopeLabel(v.appliesTo),
    effect: v.effect,
    effectLabel: effectLabel(v.effect, v.until),
    activeFrom: r.activeFrom,
    until: r.until ?? null,
    status: r.status === 'retired' ? 'retired' : ended ? 'ended' : 'active',
    createdBy: r.createdBy,
    createdByName: userName(ctx, r.createdBy),
    createdAt: r.createdAt,
    source: r.sourceInputId ? { inputId: r.sourceInputId, actionKey: r.sourceActionKey ?? null } : null,
    retiredBy: r.retiredBy ?? null,
    retiredAt: r.retiredAt ?? null,
    retiredReason: r.retiredReason ?? null,
  };
}

/** Active first, then ended / retired (newest first). */
export function listInstructionViews(ctx: AppContext, claimId: string, opts: { status?: 'active' | 'all'; limit?: number } = {}): StandingInstructionView[] {
  const all = ctx.repos.listInstructions(ctx.db, { claimId, status: 'all' }).map((r) => instructionView(ctx, r));
  const rank = (s: StandingInstructionView['status']) => (s === 'active' ? 0 : 1);
  const sorted = all.sort((a, b) => rank(a.status) - rank(b.status) || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const filtered = opts.status === 'active' ? sorted.filter((s) => s.status === 'active') : sorted;
  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

export interface CreateInstructionInput {
  claimId: string;
  text: string;
  appliesTo?: AgentScope[];
  effect?: InstructionEffect | null;
  until?: string | null;
  sourceInputId?: string | null;
  sourceActionKey?: string | null;
}

/**
 * Create a standing instruction as the owner. Accusation words are refused (never stored as an instruction). A newer
 * instruction with the same effect and contacts retires the older one. Holds / timed pauses get their end job.
 */
export function createStandingInstruction(ctx: AppContext, input: CreateInstructionInput, actor: Actor): ClaimInstructionRecord {
  assertHuman(actor, 'give a standing instruction');
  const text = input.text.replace(/\s+/g, ' ').trim();
  if (text.length < 3 || text.length > 1000) throw new HttpError(400, 'VALIDATION', 'An instruction is 3–1000 characters');
  if (ACCUSATION_WORDS.test(text) || BANNED_INTAKE_WORDS.test(text)) {
    throw new HttpError(400, 'ACCUSATION_NOT_ALLOWED', 'Instructions cannot carry an accusation — keep it as a private note; agents never act on it and never decline a claim');
  }
  const claim = ctx.repos.getClaim(ctx.db, input.claimId);
  if (!claim) throw new HttpError(404, 'NOT_FOUND', `claim ${input.claimId} not found`);
  const now = ctx.now();
  if (input.until && Date.parse(input.until) <= Date.parse(now)) throw new HttpError(400, 'VALIDATION', 'The end date is in the past');
  const effect = input.effect ? parseEffect(input.effect) : null;
  if (input.effect && !effect) throw new HttpError(400, 'VALIDATION', 'Unknown instruction effect');
  const appliesTo = (input.appliesTo ?? ['all']).filter(isAgentScope);
  // the newer instruction with the same effect replaces the older one
  const replaced: string[] = [];
  for (const old of ctx.repos.listInstructions(ctx.db, { claimId: claim.id, status: 'active' })) {
    if (effect && sameEffect(parseEffect(old.effect), effect)) {
      ctx.repos.retireInstruction(ctx.db, old.id, { by: actor.userId, reason: 'replaced by a newer instruction', now });
      replaced.push(old.id);
    }
  }
  const rec = ctx.repos.createInstruction(ctx.db, {
    claimId: claim.id,
    text,
    appliesTo: appliesTo.length ? appliesTo : ['all'],
    effect,
    activeFrom: now,
    until: input.until ?? null,
    sourceInputId: input.sourceInputId ?? null,
    sourceActionKey: input.sourceActionKey ?? null,
    createdBy: actor.userId,
    now,
  });
  ctx.repos.appendAudit(ctx.db, {
    actor,
    action: 'claim_ai.instruction.create',
    entity: 'claim_instructions',
    entityId: rec.id,
    after: { claimId: claim.id, length: text.length, appliesTo: rec.appliesTo, effect: effect?.kind ?? null, until: rec.until ?? null, sourceInputId: rec.sourceInputId ?? null, replaced },
    at: now,
  });
  if (rec.until && effect && effect.kind !== 'none') {
    enqueueJob(ctx, {
      type: 'claim.instruction_due',
      payload: { instructionId: rec.id, claimId: claim.id, until: rec.until },
      claimId: claim.id,
      runAfter: rec.until,
      idempotencyKey: `claim.instruction_due:${rec.id}:${rec.until}`,
      createdBy: SUPERVISOR,
    });
  }
  nudgeAutopilot(ctx, claim.id, 'standing instruction added');
  return rec;
}

export function retireStandingInstruction(ctx: AppContext, claimId: string, id: string, actor: Actor, reason?: string | null): ClaimInstructionRecord {
  assertHuman(actor, 'remove a standing instruction');
  const cur = ctx.repos.getInstruction(ctx.db, id);
  if (!cur || cur.claimId !== claimId) throw new HttpError(404, 'NOT_FOUND', `instruction ${id} not found`);
  if (cur.status === 'retired') throw new HttpError(409, 'INSTRUCTION_RETIRED', 'This instruction was already removed');
  const now = ctx.now();
  const rec = ctx.repos.retireInstruction(ctx.db, id, { by: actor.userId, reason: reason ?? null, now });
  ctx.repos.appendAudit(ctx.db, { actor, action: 'claim_ai.instruction.retire', entity: 'claim_instructions', entityId: id, after: { claimId, reason: reason ? reason.length : 0 }, at: now });
  // a timed pause from this instruction is lifted with it
  if (parseEffect(cur.effect)?.kind === 'pause_agents' && ctx.repos.getClaimAgentState(ctx.db, claimId).paused) {
    ctx.repos.resumeClaimAgents(ctx.db, claimId, { actor, now });
  }
  nudgeAutopilot(ctx, claimId, 'standing instruction removed');
  return rec;
}

export { AGENT_SCOPE_LABEL };
