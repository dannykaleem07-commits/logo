// owned by knowledge-learners
/**
 * L3 owner corrections (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.4) — capture (`knowledge.observe` source `corrections`).
 *
 *   needs_you_edit      a resolved approve_send / missing_info card: before = the prepared draft in the card's payload
 *                       (immutable), after = the owner's edited body (the resolution edits, else the outbox body)
 *   owner_reject        the same cards rejected with a reason (stored for context; not clustered)
 *   document_supersede  a document a person wrote that supersedes a document an agent drafted
 *   memory_item         a `correction` memory item whose Needs-you card was not captured above (cross-check)
 * The Phase 1 approve_send payload already carries the original text, so no capture is added to the mail resolver.
 *
 * Each correction stores the token diff, its stats and categories and a cluster key; a cluster with at least 3 new
 * corrections since its last curation queues `knowledge.curate` (budget: curateRunsPerDay).
 */
import { categoriseCorrection, clusterKeyOf, diffStats, generaliseSnippet, isoWeekOf, tokenDiff, type DiffOp } from '@ccguk/domain';
import type { CorrectionInput, CorrectionRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { enqueueJob, londonDay, londonDayWindow } from '../../agent/core.js';
import { maskText } from '../../casework/mask.js';
import { getKnowledgeSettings } from '../settings.js';
import { LEARNER, advanceWatermark, all, documentHtmlToText, insurerSlugsByClaim, isPerson, json, one, watermark } from './common.js';

export const CURATE_MIN_NEW = 3;
const agentName = (createdBy: string | null | undefined): string | null => (createdBy?.startsWith('agent:') ? createdBy.slice(6) : createdBy === 'system' ? 'system' : null);

function build(ctx: AppContext, base: Omit<CorrectionInput, 'diff' | 'stats' | 'categories' | 'clusterKey' | 'capturedAt'>, opts: { cluster: boolean }): CorrectionInput | null {
  const ops = tokenDiff(base.beforeText, base.afterText);
  if (!ops.some((o) => o.op !== 'eq')) return null;
  const categories = categoriseCorrection(base.beforeText, base.afterText, ops);
  return {
    ...base,
    diff: ops,
    stats: diffStats(ops),
    categories,
    clusterKey: opts.cluster ? clusterKeyOf({ agent: base.agent, templateId: base.templateId, emailKind: base.emailKind, insurerSlug: base.insurerSlug, categories, recurringEdits: [] }) : null,
    capturedAt: ctx.now(),
  };
}

export interface CaptureResult {
  captured: number;
  bySource: Record<string, number>;
  curateQueued: string[];
}

export function captureCorrections(ctx: AppContext): CaptureResult {
  const out: CaptureResult = { captured: 0, bySource: {}, curateQueued: [] };
  const slugs = insurerSlugsByClaim(ctx);
  const save = (c: CorrectionInput | null): void => {
    if (!c) return;
    const { created } = ctx.repos.insertCorrection(ctx.db, c);
    if (created) {
      out.captured += 1;
      out.bySource[c.source] = (out.bySource[c.source] ?? 0) + 1;
    }
  };

  // 1 Needs-you approve_send / missing_info.
  const wNy = watermark(ctx, 'corrections');
  const cards = all<{ id: string; kind: string; claim_id: string | null; payload: string; resolution: string | null; resolved_at: string; resolved_by: string | null }>(
    ctx,
    `SELECT id, kind, claim_id, payload, resolution, resolved_at, resolved_by FROM needs_you WHERE kind IN ('approve_send','missing_info') AND status = 'resolved' AND resolved_at IS NOT NULL
       AND (resolved_at > ? OR (resolved_at = ? AND id > ?)) ORDER BY resolved_at, id LIMIT 5000`,
    wNy.lastAt,
    wNy.lastAt,
    wNy.lastId ?? '',
  );
  for (const n of cards) {
    if (!isPerson(n.resolved_by)) continue;
    const p = json<{ outboxId?: string; email?: { bodyText?: string; kind?: string } }>(n.payload) ?? {};
    const before = p.email?.bodyText;
    if (!p.outboxId || typeof before !== 'string') continue;
    const r = json<{ optionId?: string; note?: string | null; edits?: { bodyText?: unknown } }>(n.resolution) ?? {};
    const o = one<{ body_text: string; kind: string; created_by: string; claim_id: string | null }>(ctx, `SELECT body_text, kind, created_by, claim_id FROM outbox WHERE id = ?`, p.outboxId);
    const claimId = n.claim_id ?? o?.claim_id ?? null;
    const base = { sourceId: n.id, needsYouId: n.id, claimId, targetKind: 'outbox', targetId: p.outboxId, agent: agentName(o?.created_by), templateId: null, emailKind: o?.kind ?? p.email?.kind ?? null, insurerSlug: claimId ? (slugs.get(claimId) ?? null) : null, beforeText: before };
    if (r.optionId === 'reject' || r.optionId === 'cancel') {
      if (r.note?.trim()) save({ ...base, source: 'owner_reject', afterText: '', diff: [{ op: 'del', text: before.slice(0, 20_000) }], stats: { inserted: 0, deleted: before.split(/\s+/).filter(Boolean).length, changedRatio: 1 }, categories: [], clusterKey: null, ownerNote: r.note.trim().slice(0, 2000), capturedAt: ctx.now() });
      continue;
    }
    const after = typeof r.edits?.bodyText === 'string' ? r.edits.bodyText : o?.body_text;
    if (typeof after !== 'string' || after === before) continue;
    save(build(ctx, { ...base, source: 'needs_you_edit', afterText: after, ownerNote: r.note?.trim() || null }, { cluster: true }));
  }
  if (cards.length) advanceWatermark(ctx, 'corrections', cards[cards.length - 1]!.resolved_at, cards[cards.length - 1]!.id);

  // 2 Documents a person wrote that supersede an agent's draft.
  const wDoc = watermark(ctx, 'corrections:documents');
  const docs = all<{ id: string; claim_id: string | null; template_id: string; html: string; created_by: string; created_at: string; old_html: string; old_created_by: string }>(
    ctx,
    `SELECT d.id, d.claim_id, d.template_id, d.html, d.created_by, d.created_at, o.html AS old_html, o.created_by AS old_created_by FROM documents d JOIN documents o ON o.id = d.supersedes_id
      WHERE (d.created_at > ? OR (d.created_at = ? AND d.id > ?)) ORDER BY d.created_at, d.id LIMIT 2000`,
    wDoc.lastAt,
    wDoc.lastAt,
    wDoc.lastId ?? '',
  );
  for (const d of docs) {
    if (!isPerson(d.created_by) || isPerson(d.old_created_by)) continue;
    save(build(ctx, { source: 'document_supersede', sourceId: d.id, needsYouId: null, claimId: d.claim_id, targetKind: 'document', targetId: d.id, agent: agentName(d.old_created_by), templateId: d.template_id, emailKind: null, insurerSlug: d.claim_id ? (slugs.get(d.claim_id) ?? null) : null, beforeText: documentHtmlToText(d.old_html), afterText: documentHtmlToText(d.html), ownerNote: null }, { cluster: true }));
  }
  if (docs.length) advanceWatermark(ctx, 'corrections:documents', docs[docs.length - 1]!.created_at, docs[docs.length - 1]!.id);

  // 3 Memory corrections not captured from their card (cross-check; already masked by casework).
  const wMem = watermark(ctx, 'corrections:memory');
  const mems = all<{ id: string; data: string | null; created_at: string; created_by: string; scope: string }>(
    ctx,
    `SELECT id, data, created_at, created_by, scope FROM memory_items WHERE kind = 'correction' AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT 2000`,
    wMem.lastAt,
    wMem.lastAt,
    wMem.lastId ?? '',
  );
  for (const m of mems) {
    const d = json<{ needsYouId?: string; kind?: string; before?: { email?: { bodyText?: string; kind?: string } }; after?: { bodyText?: unknown }; note?: string | null }>(m.data) ?? {};
    if (!d.needsYouId || ctx.repos.hasCorrectionSource(ctx.db, 'needs_you_edit', d.needsYouId) || ctx.repos.hasCorrectionSource(ctx.db, 'owner_reject', d.needsYouId)) continue;
    const before = d.before?.email?.bodyText;
    const after = d.after?.bodyText;
    if (typeof before !== 'string' || typeof after !== 'string' || before === after) continue;
    const claimId = m.scope.startsWith('claim:') ? m.scope.slice(6) : null;
    save(build(ctx, { source: 'memory_item', sourceId: m.id, needsYouId: d.needsYouId, claimId, targetKind: 'outbox', targetId: null, agent: null, templateId: null, emailKind: d.before?.email?.kind ?? null, insurerSlug: claimId ? (slugs.get(claimId) ?? null) : null, beforeText: before, afterText: after, ownerNote: d.note ?? null }, { cluster: true }));
  }
  if (mems.length) advanceWatermark(ctx, 'corrections:memory', mems[mems.length - 1]!.created_at, mems[mems.length - 1]!.id);

  out.curateQueued = queueCurations(ctx);
  return out;
}

// ---------------------------------------------------------------------------
// Clusters and curation triggers
// ---------------------------------------------------------------------------

const curateMark = (clusterKey: string): string => `curate:${clusterKey}`;

/** Corrections of a cluster captured after its last curation. */
export function newSinceCuration(ctx: AppContext, clusterKey: string): CorrectionRecord[] {
  const w = watermark(ctx, curateMark(clusterKey));
  return ctx.repos.listCorrections(ctx.db, { clusterKey, ...(w.lastAt ? { after: w.lastAt } : {}), limit: 5000 });
}

/** Mark a cluster curated up to its newest correction. */
export function markCurated(ctx: AppContext, clusterKey: string): void {
  const last = ctx.repos.listCorrections(ctx.db, { clusterKey, limit: 1, newestFirst: true })[0];
  if (last) advanceWatermark(ctx, curateMark(clusterKey), last.capturedAt, last.id);
}

/** knowledge.curate jobs queued today (London day): the budget counts them. */
export function curateRunsToday(ctx: AppContext): number {
  const { dayStart, dayEnd } = londonDayWindow(ctx.now());
  return Number(one<{ c: number }>(ctx, `SELECT count(*) AS c FROM agent_jobs WHERE type = 'knowledge.curate' AND created_at >= ? AND created_at < ?`, dayStart, dayEnd)?.c ?? 0);
}

/** Queue knowledge.curate for every cluster with ≥ 3 new corrections, within the daily budget. */
export function queueCurations(ctx: AppContext): string[] {
  const settings = getKnowledgeSettings(ctx);
  const queued: string[] = [];
  let budget = settings.budgets.curateRunsPerDay - curateRunsToday(ctx);
  for (const c of ctx.repos.listCorrectionClusters(ctx.db)) {
    if (budget <= 0) break;
    if (newSinceCuration(ctx, c.clusterKey).length < CURATE_MIN_NEW) continue;
    const job = enqueueJob(ctx, { type: 'knowledge.curate', payload: { clusterKey: c.clusterKey }, idempotencyKey: `knowledge.curate:${c.clusterKey}:${isoWeekOf(londonDay(ctx.now()))}`, createdBy: LEARNER });
    queued.push(job.id);
    budget -= 1;
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Masked diffs for the curator (corrections_get)
// ---------------------------------------------------------------------------

export interface MaskedCorrection {
  id: string;
  source: string;
  agent: string | null;
  templateId: string | null;
  emailKind: string | null;
  insurerSlug: string | null;
  categories: string[];
  ops: DiffOp[];
  ownerNote: string | null;
}

/** Party names on a claim (to generalise them to [name]). */
function namesOnClaim(ctx: AppContext, claimId: string | null): string[] {
  if (!claimId) return [];
  const c = one<{ claimant_id: string; driver_id: string | null; third_party_ids: string; at_fault_insurer_id: string | null; reference: string }>(ctx, `SELECT claimant_id, driver_id, third_party_ids, at_fault_insurer_id, reference FROM claims WHERE id = ?`, claimId);
  if (!c) return [];
  const ids = [c.claimant_id, c.driver_id, ...(json<string[]>(c.third_party_ids) ?? [])].filter((x): x is string => Boolean(x));
  const names = ids.map((id) => one<{ name: string }>(ctx, `SELECT name FROM parties WHERE id = ?`, id)?.name).filter((x): x is string => Boolean(x));
  const parts = names.flatMap((n) => [n, ...n.split(/\s+/).filter((w) => w.length >= 3 && /^[A-Z]/.test(w))]);
  return [...new Set([...parts, c.reference])];
}

/** SD §K.3 masks plus placeholders for figures, dates, references and party names. */
export function maskCorrectionText(ctx: AppContext, text: string, claimId: string | null): string {
  return generaliseSnippet(maskText(text), namesOnClaim(ctx, claimId)).text;
}

/** The cluster's corrections, masked, for the curator (never the raw text). */
export function maskedCluster(ctx: AppContext, clusterKey: string, limit = 30): MaskedCorrection[] {
  return ctx.repos
    .listCorrections(ctx.db, { clusterKey, limit, newestFirst: true })
    .reverse()
    .map((c) => ({
      id: c.id,
      source: c.source,
      agent: c.agent,
      templateId: c.templateId,
      emailKind: c.emailKind,
      insurerSlug: c.insurerSlug,
      categories: c.categories,
      ops: c.diff.map((o) => ({ op: o.op, text: o.op === 'eq' ? (o.text.length > 400 ? `${maskCorrectionText(ctx, o.text.slice(0, 200), c.claimId)} … ${maskCorrectionText(ctx, o.text.slice(-200), c.claimId)}` : maskCorrectionText(ctx, o.text, c.claimId)) : maskCorrectionText(ctx, o.text, c.claimId) })),
      ownerNote: c.ownerNote ? maskText(c.ownerNote) : null,
    }));
}
