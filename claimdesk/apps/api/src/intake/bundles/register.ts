// owned by intake-server
/**
 * Register a bundle as a new claim (docs/SMART-INTAKE.md §6.7) — the owner's Register button, the Needs-you resolver,
 * or (only when Settings > Intake allows it and nothing needs the owner) the automatic job as `agent:intake`.
 *
 *  1 lock (`registering`) · 2 the owner's options as decisions, recompute, blockers for the mode · 3 auto: the autonomy
 *  policy must say `auto` (part of the auto blockers) · 4 `createClaimFromFnol` (STRICT gate) · 5 file the evidence,
 *  link the items · 6 details POST /claims cannot carry (none today) · 7 ticked chronology · 8 damage observations ·
 *  9 leftover groups (attach / split off / exclude) · 10 missing-documents request · 11 clash check + Autopilot nudge ·
 *  12 bundle registered, card superseded, audit · 13 corrections · 14 auto: a "please look it over" card.
 * Steps 5–10 are idempotent; a failure after step 4 leaves the bundle registered with `error` naming the step, and
 * `retryRegistration` re-runs them.
 */
import { preselectedChoices, type Blocker } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { createNeedsYou } from '../../agent/core.js';
import { claimChanged } from '../../autopilot/claimChanged.js';
import { conflict, HttpError } from '../../errors.js';
import { createClaimFromFnol } from '../../routes/claims.js';
import { appendTimelineEvents, attachGroup, checklistAgainstClaim } from './attach.js';
import { briefFor } from './brief.js';
import { recordBundleCorrections } from './corrections.js';
import { recordDamageObservations } from './damage.js';
import { fileBundleEvidence, linkItemsToClaim } from './file.js';
import { BUNDLE_AGENT, CLOSED_STATUSES } from './hooks.js';
import { openCard, recomputeBundle, type BundleState } from './recompute.js';
import { prepareMissingDocsRequest, type RequestResult } from './requestDocs.js';
import { decide, requireBundle } from './service.js';
import { splitOffGroup } from './splitOff.js';
import { bundleSummary, type BundleSummaryView } from './views.js';

export interface RegisterOptions {
  mode: 'owner' | 'auto';
  acceptPreselected?: boolean;
  confirmNew?: boolean;
  timeline?: { tick: string[]; untick: string[] };
  requestMissingDocs?: boolean;
  groups?: Record<string, 'split_off' | 'attach' | 'exclude'>;
  /** The Needs-you card being resolved (the resolve flow closes it itself). */
  viaCardId?: string;
}

/** Test seam: make a step after the claim is created fail once (the retry test). Never set outside tests. */
export const registerTestHooks: { failAtStep: number | null } = { failAtStep: null };

interface StepsOutcome {
  filed: { evidence: number; duplicatesSkipped: number };
  events: number;
  damage: number;
  splitOff: BundleSummaryView[];
  attached: Array<{ claimId: string; reference: string; files: number }>;
  request: RequestResult;
}

function restoreStatus(ctx: AppContext, bundleId: string): void {
  const b = ctx.repos.requireIntakeBundle(ctx.db, bundleId);
  if (b.status !== 'registering') return;
  ctx.repos.updateIntakeBundle(ctx.db, bundleId, { status: openCard(ctx, b) ? 'needs_you' : 'ready' }, ctx.now());
}

/** Steps 5–10 (idempotent). */
async function postCreateSteps(ctx: AppContext, bundleId: string, claimId: string, actor: Actor, opts: RegisterOptions, outcome: StepsOutcome): Promise<void> {
  const step = (n: number) => {
    if (registerTestHooks.failAtStep === n) {
      registerTestHooks.failAtStep = null;
      throw new Error(`injected failure at step ${n}`);
    }
  };
  let state = recomputeBundle(ctx, bundleId);
  const main = state.mainAll;
  // 5 evidence + items
  step(5);
  const filing = await fileBundleEvidence(ctx, state, claimId, main, actor, { copies: state.owner.fileCopies });
  linkItemsToClaim(ctx, state, claimId, main, actor);
  outcome.filed = { evidence: filing.evidence, duplicatesSkipped: filing.duplicatesSkipped };
  // 6 nothing today: every reconciled detail travels in the POST /claims body
  // 7 chronology
  step(7);
  const auto = opts.mode === 'auto';
  const minConf = state.settings.bundles.autoRegisterMinConfidence;
  const mainIds = new Set(main);
  const ticked = state.computed.timeline.filter((t) => t.ticked && t.sources.some((s) => mainIds.has(s.fileId)) && (!auto || ((t.class === 'record' || t.class === 'clock') && t.confidence >= minConf)));
  outcome.events = appendTimelineEvents(ctx, state, claimId, ticked, filing.filed, actor);
  // 8 damage
  step(8);
  outcome.damage = recordDamageObservations(ctx, state, claimId, filing.filed, actor, { fileIds: mainIds });
  // 9 leftover groups
  step(9);
  for (const g of state.computed.groups) {
    if (g.kind === 'main' || g.kind === 'excluded') continue;
    const choice = opts.groups?.[g.key];
    if (choice === 'exclude') continue; // recorded before the claim was created
    if (choice === 'attach' && g.claim && !auto) {
      const a = await attachGroup(ctx, bundleId, actor, { claimId: g.claim.id, groupKey: g.key, internal: true, state });
      const now = ctx.now();
      const revision = ctx.repos.bumpBundleRevision(ctx.db, bundleId, now);
      ctx.repos.appendBundleDecision(ctx.db, { bundleId, revision, kind: 'attach', subject: g.key, after: { claimId: a.claim.id, reference: a.claim.reference, groupKey: g.key, fileIds: g.fileIds, events: a.events, duplicatesSkipped: a.filed.duplicatesSkipped }, actor: actor.userId, at: now });
      ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.bundle.attach', entity: 'intake_bundles', entityId: bundleId, after: { claimId: a.claim.id, reference: a.claim.reference, groupKey: g.key, files: a.files, filed: a.filed.evidence, events: a.events }, at: now });
      outcome.attached.push({ claimId: a.claim.id, reference: a.claim.reference, files: a.files });
    } else {
      const s = splitOffGroup(ctx, bundleId, g.key, undefined, actor, { internal: true });
      outcome.splitOff.push(bundleSummary(ctx, s.bundle));
    }
    state = recomputeBundle(ctx, bundleId);
  }
  // 10 missing documents (never sent without the owner)
  step(10);
  const already = ctx.handle.sqlite.prepare(`SELECT id FROM outbox WHERE claim_id = ? AND kind = 'doc_request' AND created_by = ? LIMIT 1`).get(claimId, BUNDLE_AGENT) as { id: string } | undefined;
  if (opts.requestMissingDocs ?? state.settings.bundles.prepareMissingDocsRequest) {
    outcome.request = already ? { outboxId: already.id, needsYouId: null, reason: null } : prepareMissingDocsRequest(ctx, { claimId, bundleId, items: checklistAgainstClaim(ctx, claimId, state.computed.checklist.items) });
  } else outcome.request = { outboxId: null, needsYouId: null, reason: 'You chose not to prepare a request' };
}

function emptyOutcome(): StepsOutcome {
  return { filed: { evidence: 0, duplicatesSkipped: 0 }, events: 0, damage: 0, splitOff: [], attached: [], request: { outboxId: null, needsYouId: null, reason: null } };
}

async function finish(ctx: AppContext, bundleId: string, claimId: string, actor: Actor, opts: RegisterOptions, retry: boolean) {
  const outcome = emptyOutcome();
  let error: string | null = null;
  try {
    await postCreateSteps(ctx, bundleId, claimId, actor, opts, outcome);
  } catch (err) {
    error = `Registered, but a later step failed: ${err instanceof Error ? err.message : String(err)} — press Retry to finish it`.slice(0, 1000);
    ctx.logger.warn('intake: bundle registration step failed', { bundleId, claimId, error: String(err) });
  }
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  // 11 clash check + Autopilot
  claimChanged(ctx, [claimId], actor.userId, 'registered from intake bundle');
  const now = ctx.now();
  const state: BundleState = recomputeBundle(ctx, bundleId);
  const b = state.bundle;
  // 12 bundle registered
  const revision = ctx.repos.bumpBundleRevision(ctx.db, bundleId, now);
  const conflictsResolved = state.computed.conflicts.filter((c) => c.status === 'resolved').length;
  ctx.repos.appendBundleDecision(ctx.db, {
    bundleId,
    revision,
    kind: 'register',
    after: { claimId, reference: claim.reference, mode: opts.mode, retry, filed: outcome.filed.evidence, duplicatesSkipped: outcome.filed.duplicatesSkipped, events: outcome.events, request: outcome.request, splitOff: outcome.splitOff.map((s) => s.id), attached: outcome.attached, error },
    actor: actor.userId,
    ...(actor.runId ? { runId: actor.runId } : {}),
    at: now,
  });
  const card = openCard(ctx, b);
  if (card && card.id !== opts.viaCardId) ctx.repos.transitionNeedsYou(ctx.db, card.id, { to: 'superseded', actor: actor.userId, note: `registered as ${claim.reference}`, now });
  ctx.repos.updateIntakeBundle(ctx.db, bundleId, { status: 'registered', outcome: 'registered', claimId, closedBy: actor.userId, closedAt: now, error }, now);
  ctx.repos.appendAudit(ctx.db, {
    actor,
    action: retry ? 'intake.bundle.register_retry' : 'intake.bundle.register',
    entity: 'intake_bundles',
    entityId: bundleId,
    after: { claimId, reference: claim.reference, mode: opts.mode, files: state.mainAll.length, filed: outcome.filed.evidence, duplicatesSkipped: outcome.filed.duplicatesSkipped, events: outcome.events, conflictsResolved, signals: state.computed.signals.map((s) => s.code), splitOff: outcome.splitOff.map((s) => s.id), attached: outcome.attached.map((a) => a.reference), error },
    at: now,
  });
  // 13 corrections (first registration only)
  if (!retry) recordBundleCorrections(ctx, state, claimId, actor);
  // 14 automatic: ask the owner to look it over
  if (opts.mode === 'auto' && !retry) {
    createNeedsYou(ctx, {
      kind: 'question',
      claimId,
      title: `Registered automatically from '${b.name}': ${claim.reference} — please look it over`,
      summary: `${claim.reference} was opened from ${state.mainAll.length} documents because nothing needed you (Settings > Intake). Check the claim and the brief; call the client to confirm their account.`,
      options: [
        { id: 'ok', label: 'Looks right', tone: 'primary' },
        { id: 'fix', label: 'I need to fix something', tone: 'neutral' },
      ],
      payload: { bundleId, claimId, text: 'registered automatically' },
      priority: 'low',
      createdBy: BUNDLE_AGENT,
      dedupeKey: `intake:auto_registered:${bundleId}`,
    });
  }
  const fresh = ctx.repos.requireIntakeBundle(ctx.db, bundleId);
  return {
    claim: { id: claim.id, reference: claim.reference },
    bundle: bundleSummary(ctx, fresh),
    filed: outcome.filed,
    events: outcome.events,
    proposals: { applied: 0, pending: 0, needsYouId: null as string | null },
    request: outcome.request,
    splitOff: outcome.splitOff,
    attached: outcome.attached,
    brief: briefFor(ctx, fresh, claim.id),
    error,
  };
}
export type RegisterResult = Awaited<ReturnType<typeof finish>>;

export async function registerBundle(ctx: AppContext, bundleId: string, actor: Actor, opts: RegisterOptions): Promise<RegisterResult> {
  const b0 = requireBundle(ctx, bundleId);
  if (CLOSED_STATUSES.has(b0.status)) throw conflict('BUNDLE_CLOSED', `This bundle is already ${b0.status}`, { status: b0.status });
  // 1 lock
  if (!ctx.repos.casBundleStatus(ctx.db, bundleId, ['ready', 'needs_you', 'open', 'reconciling', 'reading'], 'registering', ctx.now())) throw conflict('BUNDLE_BUSY', 'This bundle is being registered or changed right now');
  let claimId: string;
  try {
    // 2 options → decisions; blockers
    let state = recomputeBundle(ctx, bundleId);
    if (opts.acceptPreselected) {
      const list = preselectedChoices(state.computed.conflicts);
      if (list.length) state = decide(ctx, bundleId, { kind: 'accept_preselected', after: { conflicts: list }, audit: { conflicts: list.length } }, actor, { allowClosed: true });
    }
    if (opts.confirmNew && state.computed.groups.find((g) => g.key === 'main')?.claim && !state.owner.confirmNew) state = decide(ctx, bundleId, { kind: 'confirm_new' }, actor, { allowClosed: true });
    for (const id of opts.timeline?.tick ?? []) if (state.computed.timeline.some((t) => t.id === id && t.class !== 'owner_only')) state = decide(ctx, bundleId, { kind: 'tick_timeline', subject: id }, actor, { allowClosed: true });
    for (const id of opts.timeline?.untick ?? []) if (state.computed.timeline.some((t) => t.id === id)) state = decide(ctx, bundleId, { kind: 'untick_timeline', subject: id }, actor, { allowClosed: true });
    for (const [key, choice] of Object.entries(opts.groups ?? {})) {
      if (choice !== 'exclude') continue;
      for (const fileId of state.computed.groups.find((g) => g.key === key)?.fileIds ?? []) state = decide(ctx, bundleId, { kind: 'exclude_file', subject: fileId, note: 'Excluded at registration', audit: { groupKey: key } }, actor, { allowClosed: true });
    }
    const blockers: Blocker[] = opts.mode === 'owner' ? state.computed.register.blockers : state.computed.auto.blockers;
    if (blockers.length) throw new HttpError(409, 'BUNDLE_NOT_READY', blockers.map((x) => x.text).join('; '), { blockers });
    if (!state.body) throw new HttpError(400, 'FNOL_INCOMPLETE', 'The claim form cannot be built yet', { missing: state.bodyMissing, errors: [] });
    // 4 the claim
    const created = createClaimFromFnol(ctx, state.body, actor);
    claimId = created.id;
    ctx.repos.updateIntakeBundle(ctx.db, bundleId, { claimId }, ctx.now());
  } catch (err) {
    restoreStatus(ctx, bundleId);
    throw err;
  }
  return finish(ctx, bundleId, claimId, actor, opts, false);
}

/** Re-run steps 5–10 after a failure (owner only). */
export async function retryRegistration(ctx: AppContext, bundleId: string, actor: Actor): Promise<RegisterResult> {
  const b = requireBundle(ctx, bundleId);
  if (b.status !== 'registered' || !b.claimId) throw conflict('BUNDLE_NOT_REGISTERED', 'Only a registered bundle can be retried');
  const last = ctx.repos.listBundleDecisions(ctx.db, bundleId).reverse().find((d) => d.kind === 'register');
  const mode = ((last?.after as { mode?: 'owner' | 'auto' } | undefined)?.mode ?? 'owner') as 'owner' | 'auto';
  return finish(ctx, bundleId, b.claimId, actor, { mode }, true);
}
