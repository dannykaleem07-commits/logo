// owned by intake-server
/**
 * Pipeline → bundle hooks (docs/SMART-INTAKE.md §5.5). The per-file pipeline calls these; they never change a claim.
 *
 *   childrenAdded   EML attachments, ZIP entries and pack segments join every open bundle their parent is in (role
 *                   attachment / document / segment, parent file id, page range); a split pack becomes role `pack`.
 *   itemSettled     a file finished a step (rules reading, AI reading, waiting for the AI, failed, skipped): every open
 *                   bundle holding it moves to `reading` / `reconciling` and gets a debounced `intake.bundle_reconcile`
 *                   for its new revision (each event re-keys; a stale job exits early).
 */
import type { IntakeBundleFileRecord, IntakeBundleRecord, IntakeItemRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { enqueueJob } from '../../agent/core.js';

export const BUNDLE_AGENT = 'agent:intake';
export const CLOSED_STATUSES: ReadonlySet<string> = new Set(['registered', 'attached', 'cancelled']);
/** Statuses the hooks move between (a bundle being registered is left alone). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['open', 'reading', 'reconciling', 'ready', 'needs_you']);

/** Open bundles holding the item. */
export function bundlesOfItem(ctx: AppContext, itemId: string): IntakeBundleRecord[] {
  const out: IntakeBundleRecord[] = [];
  for (const f of ctx.repos.bundleFilesByItem(ctx.db, itemId)) {
    const b = ctx.repos.getIntakeBundle(ctx.db, f.bundleId);
    if (b && !CLOSED_STATUSES.has(b.status) && !out.some((x) => x.id === b.id)) out.push(b);
  }
  return out;
}

export function inOpenBundle(ctx: AppContext, itemId: string): boolean {
  return bundlesOfItem(ctx, itemId).length > 0;
}

/** Items still being read (queued / normalising, or a pending split): the bundle cannot be registered yet. */
export function filesInProgress(ctx: AppContext, files: IntakeBundleFileRecord[]): string[] {
  const pendingSplit = new Set(
    ctx.repos
      .listAgentJobs(ctx.db, { type: 'intake.split', status: ['queued', 'leased', 'waiting_usage'], limit: 2000 })
      .map((j) => (j.payload as { itemId?: string } | undefined)?.itemId)
      .filter((x): x is string => Boolean(x)),
  );
  const out: string[] = [];
  for (const f of files) {
    const item = ctx.repos.getIntakeItem(ctx.db, f.intakeItemId);
    if (!item) continue;
    if (item.status === 'queued' || item.status === 'normalising' || pendingSplit.has(item.id)) out.push(f.id);
  }
  return out;
}

/** Queue the debounced reconcile for a bundle's revision. */
export function scheduleReconcile(ctx: AppContext, bundleId: string, revision: number, opts: { delaySeconds?: number; createdBy?: string } = {}): void {
  const delay = opts.delaySeconds ?? ctx.repos.getAgentSettings(ctx.db).intake.bundles.quietSeconds;
  const runAfter = new Date(Date.parse(ctx.now()) + Math.max(0, delay) * 1000).toISOString();
  enqueueJob(ctx, {
    type: 'intake.bundle_reconcile',
    payload: { bundleId, revision },
    idempotencyKey: `intake.bundle_reconcile:${bundleId}:r${revision}`,
    runAfter,
    createdBy: opts.createdBy ?? BUNDLE_AGENT,
  });
}

/** Revision + 1, status reading / reconciling, reconcile queued. */
export function touchBundle(ctx: AppContext, bundle: IntakeBundleRecord, opts: { delaySeconds?: number } = {}): number {
  const now = ctx.now();
  const revision = ctx.repos.bumpBundleRevision(ctx.db, bundle.id, now);
  const fresh = ctx.repos.requireIntakeBundle(ctx.db, bundle.id);
  if (LIVE_STATUSES.has(fresh.status)) {
    const busy = filesInProgress(ctx, ctx.repos.listBundleFiles(ctx.db, bundle.id)).length > 0;
    const status = busy ? 'reading' : 'reconciling';
    if (fresh.status !== status) ctx.repos.updateIntakeBundle(ctx.db, bundle.id, { status }, now);
  }
  scheduleReconcile(ctx, bundle.id, revision, opts);
  return revision;
}

export interface ChildFile {
  itemId: string;
  evidenceId: string;
  role: 'attachment' | 'document' | 'segment';
  pageFrom?: number;
  pageTo?: number;
}

/** Children of an item join every open bundle the item is in. */
export function childrenAdded(ctx: AppContext, parent: IntakeItemRecord, children: ChildFile[]): void {
  if (!children.length) return;
  const now = ctx.now();
  for (const pf of ctx.repos.bundleFilesByItem(ctx.db, parent.id)) {
    const bundle = ctx.repos.getIntakeBundle(ctx.db, pf.bundleId);
    if (!bundle || CLOSED_STATUSES.has(bundle.status)) continue;
    let added = 0;
    for (const c of children) {
      const r = ctx.repos.addBundleFile(ctx.db, {
        bundleId: bundle.id,
        intakeItemId: c.itemId,
        evidenceId: c.evidenceId,
        parentFileId: pf.id,
        role: c.role,
        ...(c.pageFrom !== undefined ? { pageFrom: c.pageFrom } : {}),
        ...(c.pageTo !== undefined ? { pageTo: c.pageTo } : {}),
        addedBy: BUNDLE_AGENT,
        now,
      });
      if (r.created) added += 1;
    }
    if (children.some((c) => c.role === 'segment') && pf.role !== 'pack') ctx.repos.updateBundleFile(ctx.db, pf.id, { role: 'pack' }, now);
    if (added) touchBundle(ctx, bundle);
  }
}

/** A file of the item settled a step: its bundles recompute. */
export function itemSettled(ctx: AppContext, itemId: string): void {
  for (const b of bundlesOfItem(ctx, itemId)) touchBundle(ctx, b);
}

/** The item's facts for its bundle files (pHash, pixels): written on every bundle file of the item. */
export function recordFileFacts(ctx: AppContext, itemId: string, facts: { phash?: string | null; pixels?: number | null }): void {
  for (const f of ctx.repos.bundleFilesByItem(ctx.db, itemId)) {
    const prev = (f.facts ?? {}) as Record<string, unknown>;
    ctx.repos.updateBundleFile(ctx.db, f.id, { ...(facts.phash ? { phash: facts.phash } : {}), facts: { ...prev, ...(facts.pixels ? { pixels: facts.pixels } : {}) } }, ctx.now());
  }
}
