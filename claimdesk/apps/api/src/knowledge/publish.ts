// owned by knowledge-core
/**
 * The learned pack: versions, diff, rollback, export (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.6, KR-12).
 *
 *  - Members: every `active` item whose origin is not `computed` (computed figures are rebuilt nightly, so rolling
 *    them back makes no sense).
 *  - `publishLearnedPack`: when the members' sha differs from the active version, insert version n + 1 with its members
 *    and the diff against the previous version, and make it active. Label `learned@1.<n>.0`.
 *  - `schedulePublish`: debounced — a `knowledge.publish` job 5 minutes after an approval or auto-apply, keyed by the
 *    members' sha (so a burst of changes collapses to one publish per resulting set).
 *  - `activateVersion` (rollback or roll-forward, human only): version n + 1 with the same members as v; items not in
 *    v are retired (reason `rollback to v<v>`), members are set back to active. History is linear; nothing is deleted.
 *  - `exportVersion`: a `.ccbrain` (zip: manifest.json + entries/learned.jsonl) under DATA_DIR\knowledge-store\exports\
 *    — never inside the repo.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { learnedPackLabel, stableStringify, type ItemSummary, type KnowledgeItem, type KnowledgeVersionDiff } from '@ccguk/domain';
import type { Actor, Db, KnowledgePackVersionRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import type { JobRecord } from '../agent/contracts.js';
import { enqueueJob } from '../agent/core.js';
import { badRequest, notFound } from '../errors.js';
import { assertHuman } from '../services/humanOnly.js';
import { knowledgeStoreDir } from './settings.js';
import { recordKnowledgeChange } from './changes.js';

/** Debounce for publishing after a change (§4.6). */
export const PUBLISH_DEBOUNCE_MS = 5 * 60_000;

const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

/** Current member items (active, not computed), ordered by item key. */
export function currentMembers(ctx: AppContext, db: Db = ctx.db): KnowledgeItem[] {
  return ctx.repos.listActiveKnowledge(db, { excludeOrigin: 'computed' });
}

/** The identity of a member set: sha256 over the sorted (id, content sha) pairs. */
export function membersSha(items: readonly Pick<KnowledgeItem, 'id' | 'contentSha256'>[]): string {
  return sha256(stableStringify([...items].map((i) => [i.id, i.contentSha256]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))));
}

const summary = (i: KnowledgeItem): ItemSummary => ({ id: i.id, itemKey: i.itemKey, kind: i.kind, area: i.area, title: i.title, version: i.version });

const DIFF_FIELDS = ['title', 'body', 'data', 'scope', 'useLimit', 'tags', 'business', 'area', 'kind'] as const;

/** Diff between two member sets (by item key: same key, different id = changed). */
export function diffMembers(from: readonly KnowledgeItem[], to: readonly KnowledgeItem[]): KnowledgeVersionDiff {
  const fromByKey = new Map(from.map((i) => [i.itemKey, i]));
  const toByKey = new Map(to.map((i) => [i.itemKey, i]));
  const added: ItemSummary[] = [];
  const removed: ItemSummary[] = [];
  const changed: KnowledgeVersionDiff['changed'] = [];
  for (const [key, t] of [...toByKey].sort(([a], [b]) => a.localeCompare(b))) {
    const f = fromByKey.get(key);
    if (!f) added.push(summary(t));
    else if (f.id !== t.id) changed.push({ itemKey: key, fromId: f.id, toId: t.id, fields: DIFF_FIELDS.filter((k) => stableStringify(f[k]) !== stableStringify(t[k])) });
  }
  for (const [key, f] of [...fromByKey].sort(([a], [b]) => a.localeCompare(b))) if (!toByKey.has(key)) removed.push(summary(f));
  return { added, removed, changed };
}

/** Queue a debounced publish (no-op when learning-paused publishing would change nothing). */
export function schedulePublish(ctx: AppContext, opts: { reason: string; createdBy: string; delayMs?: number }): JobRecord | undefined {
  try {
    const sha = membersSha(currentMembers(ctx));
    const runAfter = new Date(Date.parse(ctx.now()) + (opts.delayMs ?? PUBLISH_DEBOUNCE_MS)).toISOString();
    return enqueueJob(ctx, { type: 'knowledge.publish', payload: { reason: opts.reason.slice(0, 300) }, runAfter, idempotencyKey: `knowledge.publish:${sha}`, createdBy: opts.createdBy });
  } catch (err) {
    ctx.logger.warn('could not queue a learned-pack publish', { error: String(err) });
    return undefined;
  }
}

export interface PublishResult {
  published: boolean;
  version: number | null;
  itemCount: number;
  diff: KnowledgeVersionDiff | null;
}

/** Publish the current member set as version n + 1 when it differs from the active version. */
export function publishLearnedPack(ctx: AppContext, opts: { reason: string; actor: Actor; replayRunId?: string | null }): PublishResult {
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    const members = currentMembers(ctx, tx);
    const sha = membersSha(members);
    const state = ctx.repos.getKnowledgePackState(tx);
    const active = state.activeVersion !== null ? ctx.repos.getKnowledgePackVersion(tx, state.activeVersion) : undefined;
    if (active && active.itemsSha256 === sha) return { published: false, version: active.version, itemCount: active.itemCount, diff: null };
    if (!active && members.length === 0) return { published: false, version: null, itemCount: 0, diff: null };
    const previous = active ? ctx.repos.getKnowledgeItems(tx, ctx.repos.listKnowledgePackMembers(tx, active.version)) : [];
    const diff = diffMembers(previous, members);
    const version = ctx.repos.latestKnowledgePackVersion(tx) + 1;
    // §11 Versions: link the version to the gate replay of the newest rule it adds (when the caller did not name one).
    const replayRunId =
      opts.replayRunId !== undefined
        ? opts.replayRunId
        : (diff.added
            .filter((a) => a.kind === 'rule')
            .map((a) => ctx.repos.listEvalRuns(tx, { mode: 'gate', itemId: a.id, limit: 1 })[0])
            .filter((r): r is NonNullable<typeof r> => Boolean(r))
            .sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0]?.id ?? null);
    ctx.repos.insertKnowledgePackVersion(
      tx,
      { version, label: learnedPackLabel(version), itemsSha256: sha, itemCount: members.length, diff, reason: opts.reason.slice(0, 500), basedOnVersion: active?.version ?? null, rollbackOf: null, replayRunId, createdBy: opts.actor.userId, createdAt: now },
      members.map((m) => m.id),
    );
    ctx.repos.setKnowledgePackState(tx, { activeVersion: version, activatedBy: opts.actor.userId, activatedAt: now });
    recordKnowledgeChange(ctx, tx, opts.actor, now, { action: 'knowledge.pack.publish', packVersion: version, after: { version, label: learnedPackLabel(version), items: members.length, added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length }, reason: opts.reason });
    return { published: true, version, itemCount: members.length, diff };
  });
}

/**
 * Rollback or roll-forward (human only): version n + 1 with the same members as `v`. Items active now but not in `v`
 * are retired; members of `v` that are retired or superseded are set back to active (any other active version of the
 * same key is retired first). Quarantined members stay quarantined (an alarm put them there) and are left out.
 */
export function activateVersion(ctx: AppContext, v: number, reason: string, actor: Actor): { version: KnowledgePackVersionRecord; retired: string[]; reactivated: string[]; skipped: string[] } {
  assertHuman(actor, 'activate a learned-pack version');
  if (!reason?.trim()) throw badRequest('Give a reason for the rollback');
  const target = ctx.repos.getKnowledgePackVersion(ctx.db, v);
  if (!target) throw notFound('learned-pack version', String(v));
  const now = ctx.now();
  const result = ctx.db.transaction((tx) => {
    const state = ctx.repos.getKnowledgePackState(tx);
    const targetMembers = ctx.repos.getKnowledgeItems(tx, ctx.repos.listKnowledgePackMembers(tx, v));
    const keep = new Set(targetMembers.map((m) => m.id));
    const retired: string[] = [];
    const reactivated: string[] = [];
    const skipped: string[] = [];
    for (const item of currentMembers(ctx, tx)) {
      if (keep.has(item.id)) continue;
      ctx.repos.updateKnowledgeItemState(tx, item.id, { status: 'retired', decidedBy: actor.userId, decidedAt: now, decisionNote: `rollback to v${v}`, updatedAt: now });
      recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.retire', item, before: { status: 'active' }, after: { status: 'retired' }, reason: `rollback to v${v}` });
      retired.push(item.id);
    }
    for (const m of targetMembers) {
      if (m.status === 'active') continue;
      if (m.status !== 'retired' && m.status !== 'superseded') {
        skipped.push(m.id);
        continue;
      }
      const other = ctx.repos.activeKnowledgeByKey(tx, m.itemKey);
      if (other && other.id !== m.id) {
        ctx.repos.updateKnowledgeItemState(tx, other.id, { status: 'retired', decidedBy: actor.userId, decidedAt: now, decisionNote: `rollback to v${v}`, updatedAt: now });
        recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.retire', item: other, before: { status: 'active' }, after: { status: 'retired' }, reason: `rollback to v${v}` });
        retired.push(other.id);
      }
      ctx.repos.updateKnowledgeItemState(tx, m.id, { status: 'active', decidedBy: actor.userId, decidedAt: now, decisionNote: `rollback to v${v}`, updatedAt: now });
      recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.activate', item: m, before: { status: m.status }, after: { status: 'active' }, reason: `rollback to v${v}` });
      reactivated.push(m.id);
    }
    const members = currentMembers(ctx, tx);
    const previous = state.activeVersion !== null ? ctx.repos.getKnowledgeItems(tx, ctx.repos.listKnowledgePackMembers(tx, state.activeVersion)) : [];
    const version = ctx.repos.latestKnowledgePackVersion(tx) + 1;
    const record = ctx.repos.insertKnowledgePackVersion(
      tx,
      { version, label: learnedPackLabel(version), itemsSha256: membersSha(members), itemCount: members.length, diff: diffMembers(previous, members), reason: reason.slice(0, 500), basedOnVersion: state.activeVersion, rollbackOf: v, replayRunId: null, createdBy: actor.userId, createdAt: now },
      members.map((m) => m.id),
    );
    ctx.repos.setKnowledgePackState(tx, { activeVersion: version, activatedBy: actor.userId, activatedAt: now });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.pack.activate', packVersion: version, after: { version, rollbackOf: v, retired: retired.length, reactivated: reactivated.length, skipped: skipped.length }, reason });
    return { version: record, retired, reactivated, skipped };
  });
  return result;
}

/** Diff between two stored versions (`against` defaults to the version before `v`). */
export function diffVersions(ctx: AppContext, v: number, against?: number): KnowledgeVersionDiff {
  const to = ctx.repos.getKnowledgePackVersion(ctx.db, v);
  if (!to) throw notFound('learned-pack version', String(v));
  const fromV = against ?? to.basedOnVersion ?? v - 1;
  const from = fromV > 0 ? ctx.repos.getKnowledgePackVersion(ctx.db, fromV) : undefined;
  if (against !== undefined && !from) throw notFound('learned-pack version', String(against));
  const fromItems = from ? ctx.repos.getKnowledgeItems(ctx.db, ctx.repos.listKnowledgePackMembers(ctx.db, from.version)) : [];
  const toItems = ctx.repos.getKnowledgeItems(ctx.db, ctx.repos.listKnowledgePackMembers(ctx.db, v));
  return diffMembers(fromItems, toItems);
}

/** Write a `.ccbrain` of version `v` to DATA_DIR\knowledge-store\exports\ (owner button; never into the repo). */
export function exportVersion(ctx: AppContext, v: number, actor: Actor): { version: number; file: string; bytes: number; sha256: string } {
  assertHuman(actor, 'export the learned pack');
  const record = ctx.repos.getKnowledgePackVersion(ctx.db, v);
  if (!record) throw notFound('learned-pack version', String(v));
  const items = ctx.repos.getKnowledgeItems(ctx.db, ctx.repos.listKnowledgePackMembers(ctx.db, v)).sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  const now = ctx.now();
  const entries = items.map((i) => JSON.stringify({ id: i.id, itemKey: i.itemKey, version: i.version, kind: i.kind, area: i.area, title: i.title, body: i.body, data: i.data, tags: i.tags, scope: i.scope, business: i.business, useLimit: i.useLimit, origin: i.origin, verification: i.verification, provenance: i.provenance })).join('\n');
  const entriesBytes = strToU8(entries ? `${entries}\n` : '');
  const manifest = {
    id: 'learned',
    name: 'ClaimDesk learned knowledge',
    kind: 'learned',
    version: learnedPackLabel(v).replace(/^learned@/, ''),
    business: ['ccguk'],
    createdAt: now,
    items: items.length,
    files: { 'entries/learned.jsonl': sha256(entriesBytes) },
    note: 'Private: exported from the owner’s ClaimDesk. Never commit this file.',
  };
  const zip = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), 'entries/learned.jsonl': entriesBytes }, { level: 6, mtime: new Date(Date.parse(now)) });
  const dir = path.join(knowledgeStoreDir(ctx), 'exports');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `learned-v${v}-${now.replace(/[:.]/g, '').slice(0, 15)}.ccbrain`);
  writeFileSync(file, zip);
  const digest = sha256(zip);
  ctx.db.transaction((tx) => recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.pack.export', packVersion: v, after: { version: v, file: path.basename(file), bytes: zip.byteLength, sha256: digest } }));
  return { version: v, file, bytes: zip.byteLength, sha256: digest };
}
