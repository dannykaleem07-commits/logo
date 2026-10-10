// owned by knowledge-research
/**
 * Watching sources (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.5, `knowledge.watch`, Sunday 03:30) and the source self-test
 * (§7.4, `knowledge.fetch {selftest: true}`, on first enable and weekly).
 *
 * Watch re-fetches the snapshot URLs behind every active item and every human KB check. A changed text hash marks the
 * items `source_changed` (display health only, KR-2 — verification is never touched) and opens a `source_changed` gap
 * (originRef `ki:<id>` or `kb:<entryId>`) with the old and new snapshots for re-checking; knowledge-use's KB overlay
 * shows those KB entries as stale.
 *
 * The self-test fetches robots.txt and one known page per built-in source and records the result in
 * `knowledge_sources.selftest`; a source that fails is disabled until the owner re-enables it.
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SOURCE_POLICIES, effectivePolicyKind, type GapKind } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { getKnowledgeSettings, knowledgeStoreDir } from '../settings.js';
import { recordKnowledgeChange } from '../changes.js';
import { setHealth } from '../store.js';
import { fetchSource, type FetchDeps } from './fetcher.js';
import { reportGap } from './gaps.js';
import { disableSourceAfterSelftest, ensureResearchSources } from './sources.js';

const SUPERVISOR: Actor = { userId: 'agent:supervisor' };

/** One known public page per built-in source (the self-test, §7.4). Link-only and denied sources are not fetched. */
export const SELFTEST_PAGES: Readonly<Record<string, string>> = {
  'www.legislation.gov.uk': 'https://www.legislation.gov.uk/ukpga/1988/52/section/143',
  'www.justice.gov.uk': 'https://www.justice.gov.uk/courts/procedure-rules/civil/rules',
  'www.judiciary.uk': 'https://www.judiciary.uk/',
  'www.financial-ombudsman.org.uk': 'https://www.financial-ombudsman.org.uk/',
  'handbook.fca.org.uk': 'https://handbook.fca.org.uk/',
  'www.fca.org.uk': 'https://www.fca.org.uk/',
  'www.gov.uk': 'https://www.gov.uk/api/content/vehicle-insurance',
  'ico.org.uk': 'https://ico.org.uk/',
  'www.abi.org.uk': 'https://www.abi.org.uk/',
  'www.gtacredithire.com': 'https://www.gtacredithire.com/',
  'www.mib.org.uk': 'https://www.mib.org.uk/',
  'www.thatcham.org': 'https://www.thatcham.org/',
  'tfl.gov.uk': 'https://tfl.gov.uk/',
  'www.met.police.uk': 'https://www.met.police.uk/',
};

export interface SelftestRow {
  domain: string;
  ok: boolean;
  status: number | null;
  detail: string;
}

/** Run the self-test over the built-in sources (or `domains`). Failing sources are disabled. */
export async function runSelftest(ctx: AppContext, opts: { domains?: string[]; jobId?: string | null; createdBy?: string } & FetchDeps = {}): Promise<SelftestRow[]> {
  ensureResearchSources(ctx);
  const s = getKnowledgeSettings(ctx);
  const out: SelftestRow[] = [];
  for (const p of SOURCE_POLICIES) {
    if (opts.domains && !opts.domains.includes(p.domain)) continue;
    const kind = effectivePolicyKind(p, s);
    if (kind === 'deny' || kind === 'link_only') continue;
    const row = ctx.repos.getKnowledgeSource(ctx.db, p.domain);
    if (row && !row.enabled && !opts.domains) continue;
    const page = SELFTEST_PAGES[p.domain];
    if (!page) continue;
    // A fresh robots.txt check for the self-test.
    if (row) ctx.repos.updateKnowledgeSource(ctx.db, p.domain, { robotsCheckedAt: null, updatedBy: row.updatedBy, updatedAt: row.updatedAt });
    const r = await fetchSource(ctx, { url: page, reason: 'source self-test', jobId: opts.jobId ?? null, createdBy: opts.createdBy ?? SUPERVISOR.userId }, opts);
    const result: SelftestRow = r.ok ? { domain: p.domain, ok: true, status: r.snapshot.httpStatus, detail: `fetched ${r.snapshot.bytes} bytes` } : { domain: p.domain, ok: false, status: r.status ?? null, detail: `${r.code}: ${r.reason}` };
    // Budget, rate-limit, kill-switch or no-network refusals say nothing about the source: not a failure.
    const inconclusive = !r.ok && ['BUDGET_DAY', 'BUDGET_DOMAIN_DAY', 'RATE_LIMITED', 'NOT_ALLOWED', 'NETWORK', 'SOURCE_DISABLED'].includes(r.code) && !(r.code === 'NETWORK' && r.reason !== 'this process may not reach the network');
    const at = ctx.now();
    const current = ctx.repos.getKnowledgeSource(ctx.db, p.domain);
    if (current) ctx.repos.updateKnowledgeSource(ctx.db, p.domain, { selftest: { at, ok: result.ok, status: result.status, detail: result.detail.slice(0, 300), page, inconclusive }, updatedBy: current.updatedBy, updatedAt: current.updatedAt });
    if (!result.ok && !inconclusive) disableSourceAfterSelftest(ctx, p.domain, result.detail);
    out.push(result);
  }
  return out;
}

/** Has any built-in source ever been self-tested? (the first-run self-test bootstrap) */
export function selftestDone(ctx: AppContext): boolean {
  ensureResearchSources(ctx);
  return ctx.repos.listKnowledgeSources(ctx.db, { origin: 'builtin' }).some((r) => r.selftest !== null && r.selftest !== undefined);
}

export interface WatchResult {
  urls: number;
  fetched: number;
  changed: number;
  refused: number;
  gaps: string[];
  stoppedEarly: boolean;
}

const gapKindFor = (kind: string, area: string): GapKind => (kind === 'precedent' || area === 'legal' ? 'legal_point' : area === 'quantum' ? 'quantum_point' : kind === 'procedure' ? 'procedure' : kind === 'contact' ? 'missing_contact' : 'other');

/** knowledge.watch: re-fetch every URL behind active items and human KB checks (§7.5). */
export async function runWatch(ctx: AppContext, opts: { jobId?: string | null } & FetchDeps = {}): Promise<WatchResult> {
  // url → what depends on it
  const deps = new Map<string, { items: { id: string; title: string; kind: string; area: string; snapshotIds: string[] }[]; kb: { entryId: string; snapshotId: string | null }[] }>();
  const add = (url: string): { items: { id: string; title: string; kind: string; area: string; snapshotIds: string[] }[]; kb: { entryId: string; snapshotId: string | null }[] } => {
    let d = deps.get(url);
    if (!d) deps.set(url, (d = { items: [], kb: [] }));
    return d;
  };
  for (const item of ctx.repos.listActiveKnowledge(ctx.db)) {
    const snaps = item.provenance.filter((p) => p.kind === 'snapshot');
    const byUrl = new Map<string, string[]>();
    for (const p of snaps) if (p.kind === 'snapshot') byUrl.set(p.url, [...(byUrl.get(p.url) ?? []), p.snapshotId]);
    for (const [url, ids] of byUrl) add(url).items.push({ id: item.id, title: item.title, kind: item.kind, area: item.area, snapshotIds: ids });
  }
  for (const c of ctx.repos.listKbChecks(ctx.db)) {
    if (c.result !== 'source_verified' && c.result !== 'owner_confirmed') continue;
    const snap = c.snapshotId ? ctx.repos.getSourceSnapshot(ctx.db, c.snapshotId) : undefined;
    const url = snap?.url ?? c.sourceUrl;
    if (!url) continue;
    add(url).kb.push({ entryId: c.target.slice(3), snapshotId: c.snapshotId });
  }
  const result: WatchResult = { urls: deps.size, fetched: 0, changed: 0, refused: 0, gaps: [], stoppedEarly: false };
  for (const [url, d] of [...deps.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const before = ctx.repos.latestSourceSnapshot(ctx.db, url);
    const r = await fetchSource(ctx, { url, reason: 'weekly source watch', jobId: opts.jobId ?? null, createdBy: SUPERVISOR.userId }, opts);
    if (!r.ok) {
      result.refused += 1;
      if (r.code === 'BUDGET_DAY') {
        result.stoppedEarly = true;
        break;
      }
      continue;
    }
    result.fetched += 1;
    const newSha = r.snapshot.textSha256;
    const changedFrom = (snapshotId: string | null): boolean => {
      const old = snapshotId ? ctx.repos.getSourceSnapshot(ctx.db, snapshotId) : before;
      return Boolean(old && (old.textSha256 ?? old.sha256) !== newSha);
    };
    let anyChanged = false;
    for (const it of d.items) {
      if (!it.snapshotIds.some((id) => changedFrom(id))) continue;
      anyChanged = true;
      setHealth(ctx, it.id, 'source_changed', `the source changed (snapshot ${r.snapshot.id})`, SUPERVISOR);
      const g = reportGap(ctx, { kind: gapKindFor(it.kind, it.area), question: `The source page behind "${it.title.slice(0, 160)}" has changed. Does it still say the same?`, area: it.area as never, scope: { kind: 'global' }, origin: 'source_changed', originRef: `ki:${it.id}`, raisedBy: SUPERVISOR.userId, jobId: opts.jobId ?? null, context: `old snapshots ${it.snapshotIds.join(', ')}; new snapshot ${r.snapshot.id}` });
      result.gaps.push(g.gap.id);
    }
    for (const k of d.kb) {
      if (!changedFrom(k.snapshotId)) continue;
      anyChanged = true;
      const g = reportGap(ctx, { kind: 'kb_verification', question: `The source of KB entry ${k.entryId} has changed. Does the entry still hold?`, area: 'legal', scope: { kind: 'global' }, origin: 'source_changed', originRef: `kb:${k.entryId}`, raisedBy: SUPERVISOR.userId, jobId: opts.jobId ?? null, context: `old snapshot ${k.snapshotId ?? 'none'}; new snapshot ${r.snapshot.id}` });
      result.gaps.push(g.gap.id);
    }
    if (anyChanged) result.changed += 1;
  }
  return result;
}

/** Snapshot files no longer referenced by any item or check are pruned after this long (§5 Files). */
export const SNAPSHOT_PRUNE_DAYS = 180;

/**
 * Prune old, unreferenced snapshot files (§5): the row stays (append-only), the files go, `knowledge_changes` records
 * `knowledge.source.prune`, and source_get / the snapshot route then report "pruned". A file shared (same sha256) with
 * a referenced or recent snapshot is kept.
 */
export function pruneSnapshots(ctx: AppContext, opts: { jobId?: string | null } = {}): { pruned: string[] } {
  const cutoff = new Date(Date.parse(ctx.now()) - SNAPSHOT_PRUNE_DAYS * 86_400_000).toISOString();
  const referenced = new Set<string>();
  for (const r of ctx.handle.sqlite.prepare(`SELECT provenance FROM knowledge_items WHERE provenance LIKE '%snapshotId%'`).all() as Array<{ provenance: string }>) {
    for (const m of r.provenance.matchAll(/"snapshotId":"([^"]+)"/g)) referenced.add(m[1]!);
  }
  for (const r of ctx.handle.sqlite.prepare(`SELECT snapshot_id AS id FROM knowledge_checks WHERE snapshot_id IS NOT NULL`).all() as Array<{ id: string }>) referenced.add(r.id);
  const rows = ctx.handle.sqlite.prepare(`SELECT id, sha256, storage_path AS storagePath, text_path AS textPath, fetched_at AS fetchedAt FROM source_snapshots`).all() as Array<{ id: string; sha256: string; storagePath: string; textPath: string | null; fetchedAt: string }>;
  const keepSha = new Set(rows.filter((r) => referenced.has(r.id) || r.fetchedAt >= cutoff).map((r) => r.sha256));
  const pruned: string[] = [];
  const dir = knowledgeStoreDir(ctx);
  for (const r of rows) {
    if (r.fetchedAt >= cutoff || referenced.has(r.id) || keepSha.has(r.sha256)) continue;
    let removed = false;
    for (const rel of [r.storagePath, r.textPath]) {
      if (!rel) continue;
      const p = path.join(dir, rel);
      if (existsSync(p)) {
        rmSync(p, { force: true });
        removed = true;
      }
    }
    if (removed) pruned.push(r.id);
  }
  if (pruned.length) {
    const at = ctx.now();
    ctx.db.transaction((tx) => recordKnowledgeChange(ctx, tx, SUPERVISOR, at, { action: 'knowledge.source.prune', after: { snapshotIds: pruned.slice(0, 500), count: pruned.length }, reason: `unreferenced for ${SNAPSHOT_PRUNE_DAYS} days`, jobId: opts.jobId ?? null }));
  }
  return { pruned };
}
