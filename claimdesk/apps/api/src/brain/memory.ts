// owned by casework
/**
 * Memory and learning (docs/SUPREME-DESIGN.md §E.6): proposed / approved / retired memory items. Only approved items
 * reach prompts. Owner edits made before approving a Needs-you item are stored as `correction` items (proposed) through
 * `recordCorrection`, which casework registers on `ctx.services` for the runtime's resolver flow.
 */
import type { Basis, MemoryKind } from '@ccguk/domain';
import type { Actor, MemoryItemRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import type { CorrectionInput } from '../agent/needsYou.js';
import { maskDeep, maskText } from '../casework/mask.js';

export const claimScope = (claimId: string): string => `claim:${claimId}`;

/** Scopes visible from a claim: the claim, its at-fault insurer, and global. */
export function scopesForClaim(ctx: AppContext, claimId: string | undefined): string[] {
  const scopes = ['global'];
  if (!claimId) return scopes;
  scopes.unshift(claimScope(claimId));
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  if (claim?.atFaultInsurerId) scopes.push(`insurer:${claim.atFaultInsurerId}`);
  return scopes;
}

export function memoryRecall(ctx: AppContext, input: { q: string; scope?: string | null; claimId?: string; limit?: number }): Array<{ id: string; kind: MemoryKind; scope: string; text: string }> {
  const scopes = input.scope ? [input.scope] : scopesForClaim(ctx, input.claimId);
  return ctx.repos.recallMemory(ctx.db, { q: input.q, scopes, limit: input.limit ?? 10 }).map((m) => ({ id: m.id, kind: m.kind, scope: m.scope, text: maskText(m.text) }));
}

export function proposeMemory(ctx: AppContext, input: { kind: MemoryKind; scope: string; text: string; basis: Basis[]; data?: unknown; createdBy: string; approve?: boolean }): MemoryItemRecord {
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    const item = ctx.repos.createMemoryItem(tx, { kind: input.kind, scope: input.scope, text: input.text, basis: input.basis, data: input.data, status: input.approve ? 'approved' : 'proposed', createdBy: input.createdBy, now });
    ctx.repos.appendAudit(tx, { actor: { userId: input.createdBy }, action: 'memory.create', entity: 'memory_items', entityId: item.id, after: { kind: item.kind, scope: item.scope, status: item.status }, at: now });
    return item;
  });
}

export function decideMemory(ctx: AppContext, id: string, status: 'approved' | 'retired', actor: Actor): MemoryItemRecord {
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    const before = ctx.repos.requireMemoryItem(tx, id);
    const item = ctx.repos.decideMemoryItem(tx, id, { status, actor, now });
    ctx.repos.appendAudit(tx, { actor, action: status === 'approved' ? 'memory.approve' : 'memory.retire', entity: 'memory_items', entityId: id, before: { status: before.status }, after: { status: item.status, kind: item.kind, scope: item.scope }, at: now });
    return item;
  });
}

/** A short human-readable diff of the changed top-level fields (strings compared after trimming). */
export function describeEdit(before: unknown, after: unknown): string[] {
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === 'object' ? after : { value: after }) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(a).sort()) {
    const x = JSON.stringify(b[k] ?? null);
    const y = JSON.stringify(a[k] ?? null);
    if (x !== y) out.push(`${k}: ${x.slice(0, 200)} → ${y.slice(0, 200)}`);
  }
  return out;
}

/**
 * Store an owner's edit of a prepared item as a proposed `correction` memory item (§C.7, §E.6). Registered on
 * `ctx.services.recordCorrection`; the runtime calls it after the resolver ran. Personal data in the stored diff is
 * masked.
 */
export function recordCorrection(ctx: AppContext, input: CorrectionInput): MemoryItemRecord {
  const changes = describeEdit(input.before, input.after);
  const text = `Owner edited a prepared ${input.kind.replace(/_/g, ' ')} before choosing "${input.optionId}"${changes.length ? `: ${changes.slice(0, 5).join('; ')}` : ''}${input.note ? ` — note: ${input.note}` : ''}`;
  return proposeMemory(ctx, {
    kind: 'correction',
    scope: input.claimId ? claimScope(input.claimId) : 'global',
    text: maskText(text).slice(0, 4000),
    basis: [{ kind: 'rule', id: `needs_you:${input.needsYouId}`, label: input.kind }],
    data: { needsYouId: input.needsYouId, kind: input.kind, optionId: input.optionId, before: maskDeep(input.before), after: maskDeep(input.after), note: input.note ?? null },
    createdBy: input.actor.userId,
  });
}
