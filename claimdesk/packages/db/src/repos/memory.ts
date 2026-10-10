// owned by casework
/**
 * Memory items (docs/SUPREME-DESIGN.md §E.1 L5/L6, §E.6, §N.4): notes, owner corrections, outcomes, preferences and
 * research answers. Lifecycle `proposed → approved | retired`, `approved → retired`; only `approved` items reach
 * prompts. The text of an item never changes (a correction is a new item); every decision records who and when.
 * Scopes: `claim:<id>`, `insurer:<partyId or directory id>`, `global`.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Basis, ISODateTime, MemoryKind, MemoryStatus } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { memoryItems, type MemoryItemRow } from '../schema.js';
import { denull, nowIso } from '../util.js';
import type { Actor } from './audit.js';

export const MEMORY_KINDS: readonly MemoryKind[] = ['note', 'correction', 'outcome', 'preference', 'research'];

export interface MemoryItemRecord {
  id: string;
  kind: MemoryKind;
  scope: string;
  text: string;
  basis: Basis[];
  data?: unknown;
  status: MemoryStatus;
  createdBy: string;
  createdAt: ISODateTime;
  decidedBy?: string;
  decidedAt?: ISODateTime;
}

export interface CreateMemoryItemInput {
  kind: MemoryKind;
  scope: string;
  text: string;
  basis?: Basis[];
  data?: unknown;
  /** Default `proposed`. `approved` is for code paths the design allows to approve directly (claim-scope research notes). */
  status?: Extract<MemoryStatus, 'proposed' | 'approved'>;
  createdBy: string;
  now?: ISODateTime;
}

const toItem = (r: MemoryItemRow): MemoryItemRecord => ({ ...(denull(r) as MemoryItemRecord), basis: r.basis ?? [] });

const SCOPE_RE = /^(global|claim:[A-Za-z0-9_-]{1,128}|insurer:[A-Za-z0-9_.-]{1,128}|template:[A-Za-z0-9_.-]{1,128})$/;
export const isMemoryScope = (s: string): boolean => SCOPE_RE.test(s);

export function createMemoryItem(db: Db, input: CreateMemoryItemInput): MemoryItemRecord {
  if (!MEMORY_KINDS.includes(input.kind)) throw new ValidationError(`unknown memory kind ${input.kind}`);
  if (!isMemoryScope(input.scope)) throw new ValidationError(`memory scope must be global, claim:<id>, insurer:<id> or template:<id> (got ${input.scope})`);
  const text = input.text.trim();
  if (!text) throw new ValidationError('memory text is required');
  const now = input.now ?? nowIso();
  const status = input.status ?? 'proposed';
  const row = {
    id: randomUUID(),
    kind: input.kind,
    scope: input.scope,
    text: text.slice(0, 20_000),
    basis: input.basis ?? [],
    data: input.data ?? null,
    status,
    createdBy: input.createdBy,
    createdAt: now,
    decidedBy: status === 'approved' ? input.createdBy : null,
    decidedAt: status === 'approved' ? now : null,
  };
  return toItem(db.insert(memoryItems).values(row).returning().get());
}

export function getMemoryItem(db: Db, id: string): MemoryItemRecord | undefined {
  const r = db.select().from(memoryItems).where(eq(memoryItems.id, id)).get();
  return r ? toItem(r) : undefined;
}

export function requireMemoryItem(db: Db, id: string): MemoryItemRecord {
  const m = getMemoryItem(db, id);
  if (!m) throw new NotFoundError('memory_items', id);
  return m;
}

export interface ListMemoryFilter {
  scope?: string | readonly string[];
  status?: MemoryStatus | readonly MemoryStatus[];
  kind?: MemoryKind | readonly MemoryKind[];
  limit?: number;
  offset?: number;
}

const many = <T>(v: T | readonly T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? [...(v as T[])] : [v as T]);

/** Newest first (stable: created_at, then id). */
export function listMemoryItems(db: Db, f: ListMemoryFilter = {}): MemoryItemRecord[] {
  const where: SQL[] = [];
  const scopes = many(f.scope);
  if (scopes?.length) where.push(inArray(memoryItems.scope, scopes));
  const st = many(f.status);
  if (st?.length) where.push(inArray(memoryItems.status, st));
  const kinds = many(f.kind);
  if (kinds?.length) where.push(inArray(memoryItems.kind, kinds));
  return db
    .select()
    .from(memoryItems)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(memoryItems.createdAt), asc(memoryItems.id))
    .limit(Math.max(1, Math.min(f.limit ?? 200, 1000)))
    .offset(f.offset ?? 0)
    .all()
    .map(toItem);
}

export function countMemoryItems(db: Db, f: Omit<ListMemoryFilter, 'limit' | 'offset'> = {}): number {
  const where: SQL[] = [];
  const scopes = many(f.scope);
  if (scopes?.length) where.push(inArray(memoryItems.scope, scopes));
  const st = many(f.status);
  if (st?.length) where.push(inArray(memoryItems.status, st));
  const kinds = many(f.kind);
  if (kinds?.length) where.push(inArray(memoryItems.kind, kinds));
  const r = db.select({ n: sql<number>`count(*)` }).from(memoryItems).where(where.length ? and(...where) : undefined).get();
  return Number(r?.n ?? 0);
}

const ALLOWED: Readonly<Record<MemoryStatus, readonly MemoryStatus[]>> = { proposed: ['approved', 'retired'], approved: ['retired'], retired: [] };

/** Approve or retire an item (validated transition; records who and when). */
export function decideMemoryItem(db: Db, id: string, input: { status: Extract<MemoryStatus, 'approved' | 'retired'>; actor: Actor; now?: ISODateTime }): MemoryItemRecord {
  const item = requireMemoryItem(db, id);
  if (!ALLOWED[item.status].includes(input.status)) throw new ValidationError(`Memory item ${id} is ${item.status}; it cannot become ${input.status}`);
  const now = input.now ?? nowIso();
  return toItem(db.update(memoryItems).set({ status: input.status, decidedBy: input.actor.userId, decidedAt: now }).where(eq(memoryItems.id, id)).returning().get()!);
}

/**
 * Approved items in the given scopes whose text shares words with `q` (all approved items when `q` is empty), best
 * overlap first then newest. A small corpus, so a word-overlap score is enough (no FTS table for memory).
 */
export function recallMemory(db: Db, input: { q: string; scopes: readonly string[]; limit?: number }): Array<MemoryItemRecord & { score: number }> {
  if (!input.scopes.length) return [];
  const items = listMemoryItems(db, { scope: input.scopes, status: 'approved', limit: 1000 });
  const words = new Set((input.q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)));
  const scored = items.map((m) => {
    if (!words.size) return { ...m, score: 0 };
    const text = new Set(m.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    let score = 0;
    for (const w of words) if (text.has(w)) score += 1;
    return { ...m, score };
  });
  const kept = words.size ? scored.filter((m) => m.score > 0) : scored;
  return kept.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, Math.max(1, Math.min(input.limit ?? 10, 100)));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'you', 'your', 'our', 'their', 'what', 'when', 'which', 'who', 'how', 'why']);
