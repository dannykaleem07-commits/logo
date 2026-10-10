// owned by knowledge-learners
/**
 * Conflict detection wiring (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.7). `conflictsFor` is registered as
 * `KnowledgeHooks.conflictsFor`, so the store runs it on every proposal (learners, researcher, curator, owner); the
 * nightly sweep (`knowledge.consolidate` 02:00) re-checks every active learned item against the current KB, packs and
 * directory. Only code records conflicts; the store and `recordConflicts` raise the cards.
 *
 * Computed items (profiles, statistics, engineering medians) are not checked on proposal: they are rebuilt from the
 * records nightly and must never be held back; their stats-vs-note direction runs nightly in outcomes.ts.
 */
import { detectConflicts, itemKeyFor, type ConflictContext, type ConflictFinding, type ContactData, type KnowledgeItem, type KnowledgeProposal } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { activeRedLines } from '../../brain/search.js';
import { recordConflicts } from '../store.js';
import { LEARNER, directoryEntry, directoryValues } from './common.js';

function contextFor(ctx: AppContext, p: KnowledgeProposal, excludeId?: string): ConflictContext {
  const key = itemKeyFor(p);
  const sameKey = ctx.repos.activeKnowledgeByKey(ctx.db, key);
  const scoped =
    p.scope.kind === 'insurer'
      ? ctx.repos.listKnowledgeItems(ctx.db, { status: 'active', scopeKind: 'insurer', scopeValue: p.scope.slug, limit: 500 }).items
      : p.scope.kind === 'claim_type'
        ? ctx.repos.listKnowledgeItems(ctx.db, { status: 'active', scopeKind: 'claim_type', scopeValue: p.scope.tag, limit: 500 }).items
        : [];
  const byId = new Map<string, KnowledgeItem>();
  for (const i of [...(sameKey ? [sameKey] : []), ...scoped]) if (i.id !== excludeId) byId.set(i.id, i);
  const slug = p.kind === 'contact' ? (p.data as Partial<ContactData>).insurerSlug ?? (p.scope.kind === 'insurer' ? p.scope.slug : null) : null;
  const entry = directoryEntry(ctx, slug);
  let redLines: ConflictContext['redLines'] = [];
  try {
    redLines = activeRedLines(ctx)
      .filter((r) => typeof r.pattern === 'string' && r.pattern)
      .map((r) => ({ id: r.ref.replace(/^pack:/, ''), pattern: r.pattern!, scope: r.scope ?? null }));
  } catch (err) {
    ctx.logger.warn('red lines unavailable for conflict detection', { error: String(err) });
  }
  const kb = ['fact', 'precedent', 'procedure'].includes(p.kind)
    ? ctx.kb.entries().map((e) => ({ id: e.id, citation: e.citation ?? null, text: `${e.principle ?? ''} ${e.text ?? ''}`.trim(), tags: [...(e.tags ?? []), ...(e.topics ?? [])] }))
    : [];
  return { active: [...byId.values()], directory: entry ? directoryValues(entry) : null, redLines, kb };
}

/** KnowledgeHooks.conflictsFor — run by the store on every proposal. */
export function conflictsFor(ctx: AppContext, p: KnowledgeProposal): ConflictFinding[] {
  if (p.origin === 'computed') return [];
  return detectConflicts(p, contextFor(ctx, p));
}

/** Nightly: re-check every active learned (non-computed) item; new findings are recorded with cards. */
export function sweepConflicts(ctx: AppContext): { checked: number; recorded: number } {
  const items = ctx.repos.listKnowledgeItems(ctx.db, { status: 'active', limit: 5000 }).items.filter((i) => i.origin !== 'computed' && i.origin !== 'owner');
  const findings: ConflictFinding[] = [];
  for (const i of items) {
    const p: KnowledgeProposal = { ...i, itemKey: i.itemKey, createdBy: i.createdBy };
    for (const f of detectConflicts(p, contextFor(ctx, p, i.id))) {
      // The existing version of the same key is the item itself (or an older one it superseded): not a conflict.
      if (f.kind === 'duplicate') continue;
      findings.push({ ...f, leftRef: f.leftRef === 'new' ? `ki:${i.id}` : f.leftRef, rightRef: f.rightRef === 'new' ? `ki:${i.id}` : f.rightRef });
    }
  }
  const recorded = findings.length ? recordConflicts(ctx, findings, { detectedBy: LEARNER }) : [];
  return { checked: items.length, recorded: recorded.length };
}
