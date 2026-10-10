// owned by knowledge-use
/**
 * The reviewer's knowledge check (docs/SUPREME-KNOWLEDGE-BUILDER.md §8.3), called once from tier a of the casework
 * reviewer. It finds the run(s) that created the draft through `audit_log.run_id` of the draft's creation, reads what
 * those runs were given (knowledge_usage, injected) and what they relied on (their result's basis[]), works out which
 * refs the draft cites — `{{cite:ki:…}}` / `[ki:…]` markers, or an outbound-citable item whose words the draft states —
 * runs the pure `checkKnowledgeUse`, and records every cited ref as a knowledge_usage row with `cited = 1` and the
 * draft as target (append-only; once per target and ref).
 *
 * Never throws into the reviewer: a failure is logged and the existing checks still run.
 */
import { checkKnowledgeUse, sharedShingle, type KnowledgeBadge, type KnowledgeUsedResponse, type ConsistencyFlag, type KnowledgeHit, type KnowledgeRef, type RecipientRole, type ReviewTargetKind } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { resolveKnowledgeRef } from './retrieve.js';
import { rows } from './sql.js';

/** Words in a row that make an outbound item "stated" by the draft. */
export const STATED_WORDS = 6;

const REF_RE = /\b(ki|kb|pack|mem):[A-Za-z0-9][A-Za-z0-9._@#:-]*/g;

/** Refs written into the text as markers ({{cite:…}}, [ki:…] or a bare ki: id). */
export function markerRefs(text: string): KnowledgeRef[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*cite:\s*([^}\s]+)\s*\}\}/g)) out.add(m[1]!);
  for (const m of text.matchAll(REF_RE)) if (m[0].startsWith('ki:') || m[0].startsWith('kb:')) out.add(m[0].replace(/[.,;:)\]]+$/, ''));
  return [...out].filter((r) => /^(ki|kb|pack|mem):/.test(r)).sort() as KnowledgeRef[];
}

/** The agent runs that created a draft (audit rows of its creation carry run_id). */
export function draftRunIds(ctx: AppContext, targetId: string): string[] {
  try {
    return [...new Set(rows<{ run_id: string }>(ctx, `SELECT run_id FROM audit_log WHERE entity_id = ? AND entity IN ('outbox','documents') AND run_id IS NOT NULL ORDER BY at`, targetId).map((r) => r.run_id))];
  } catch {
    return [];
  }
}

/** Knowledge refs in a run result's basis[] (any depth). */
export function basisRefsOf(result: unknown): KnowledgeRef[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.kind === 'string' && typeof o.id === 'string') {
      if (o.kind === 'knowledge') out.add(o.id.startsWith('ki:') ? o.id : `ki:${o.id}`);
      else if (o.kind === 'kb') out.add(o.id.startsWith('kb:') ? o.id : `kb:${o.id}`);
      else if (o.kind === 'pack' && o.id.startsWith('pack:')) out.add(o.id);
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(result, 0);
  return [...out].sort() as KnowledgeRef[];
}

export interface KnowledgeReviewTarget {
  kind: ReviewTargetKind;
  id: string;
  claimId: string;
  text: string;
  recipientRole?: RecipientRole;
}

export interface KnowledgeReviewOutcome {
  flags: ConsistencyFlag[];
  cited: KnowledgeRef[];
  injected: KnowledgeRef[];
  runIds: string[];
}

export function reviewKnowledgeUse(ctx: AppContext, t: KnowledgeReviewTarget): KnowledgeReviewOutcome {
  const role = t.recipientRole ?? null;
  const runIds = draftRunIds(ctx, t.id);
  const usage = runIds.length ? ctx.repos.listKnowledgeUsage(ctx.db, { runIds, limit: 1000 }) : [];
  const injectedRows = usage.filter((u) => u.injected);
  const injected = [...new Set(injectedRows.map((u) => u.ref))].sort() as KnowledgeRef[];
  const basis = new Set<KnowledgeRef>();
  for (const id of runIds) for (const r of basisRefsOf(ctx.repos.getAgentRun(ctx.db, id)?.result)) basis.add(r);

  const cache = new Map<string, KnowledgeHit | undefined>();
  const resolve = (ref: KnowledgeRef): KnowledgeHit | undefined => {
    if (!cache.has(ref)) cache.set(ref, resolveKnowledgeRef(ctx, ref, role));
    return cache.get(ref);
  };
  // Stated: an outbound-citable item (injected or in the basis) whose words appear in the draft.
  const cited = new Set<KnowledgeRef>(markerRefs(t.text));
  for (const ref of [...new Set([...injected, ...basis])].sort()) {
    const h = resolve(ref);
    if (!h || h.useLimit !== 'outbound_ok' || h.computed) continue;
    if (sharedShingle(t.text, h.text, STATED_WORDS)) cited.add(ref);
  }
  // Internal bodies: computed / internal items that were injected (text even if the item has since been retired).
  const internalBodies: { ref: KnowledgeRef; text: string }[] = [];
  for (const ref of injected) {
    const h = resolve(ref) ?? resolveKnowledgeRef(ctx, ref, role, { anyStatus: true });
    if (h && (h.computed || h.useLimit !== 'outbound_ok')) internalBodies.push({ ref, text: `${h.title}. ${h.text}` });
  }
  const flags = checkKnowledgeUse({ text: t.text, recipientRole: role, citedRefs: [...cited], basisRefs: [...basis], internalBodies, resolve });

  // knowledge_usage.cited = 1 rows for this draft (once per target and ref).
  const already = new Set(ctx.repos.listKnowledgeUsage(ctx.db, { targetKind: t.kind, targetId: t.id, cited: true, limit: 1000 }).map((u) => u.ref));
  const fresh = [...cited].filter((r) => !already.has(r)).sort();
  if (fresh.length && !t.id.startsWith('replay:')) {
    const at = ctx.now();
    const rankOf = new Map(injectedRows.map((u) => [u.ref, u.rank] as const));
    ctx.db.transaction((tx) => {
      ctx.repos.insertKnowledgeUsage(
        tx,
        fresh.map((ref) => ({ runId: runIds[runIds.length - 1] ?? `review:${t.id}`, claimId: t.claimId, ref, badges: resolve(ref)?.badges ?? [], rank: rankOf.get(ref) ?? 0, injected: injected.includes(ref), cited: true, targetKind: t.kind, targetId: t.id, at })),
      );
    });
  }
  return { flags, cited: [...cited].sort(), injected, runIds };
}

/** The tier-a call: flags only, never throwing (a failure is logged; the other checks still run). */
export function knowledgeReviewFlags(ctx: AppContext, t: KnowledgeReviewTarget): ConsistencyFlag[] {
  try {
    return reviewKnowledgeUse(ctx, t).flags;
  } catch (err) {
    ctx.logger.warn('knowledge review check failed', { error: err instanceof Error ? err.message : String(err), targetId: t.id });
    return [];
  }
}

/** Badges for a draft (GET /knowledge/used): cited rows for the target plus the creating runs' injected rows. */
export function knowledgeUsedFor(ctx: AppContext, targetKind: ReviewTargetKind, targetId: string): KnowledgeUsedResponse['refs'] {
  const runIds = draftRunIds(ctx, targetId);
  const rowsFor = [...ctx.repos.listKnowledgeUsage(ctx.db, { targetKind, targetId, limit: 1000 }), ...(runIds.length ? ctx.repos.listKnowledgeUsage(ctx.db, { runIds, limit: 1000 }) : [])];
  const byRef = new Map<string, KnowledgeUsedResponse['refs'][number]>();
  for (const u of rowsFor) {
    const prev = byRef.get(u.ref);
    if (prev) {
      prev.cited = prev.cited || u.cited;
      continue;
    }
    const hit = resolveKnowledgeRef(ctx, u.ref, null, { anyStatus: true });
    byRef.set(u.ref, { ref: u.ref, badges: hit?.badges ?? (u.badges as KnowledgeBadge[]), cited: u.cited, title: hit?.title ?? null, itemId: u.ref.startsWith('ki:') ? u.ref.slice(3) : null });
  }
  return [...byRef.values()].sort((a, b) => Number(b.cited) - Number(a.cited) || a.ref.localeCompare(b.ref));
}

