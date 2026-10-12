// owned by intake-server
/**
 * Split a group off into its own bundle (docs/SMART-INTAKE.md §6, §6.7 step 9): the group's files join a new bundle
 * (`source:'split'`, `parentBundleId`, `splitFromGroup`) and leave this one by a `split_off` decision (they stay listed
 * here as moved). Nothing is lost; the new bundle is read and reconciled like any other.
 */
import type { Actor, IntakeBundleRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { badRequest, notFound } from '../../errors.js';
import { touchBundle } from './hooks.js';
import { computeBundle, recomputeBundle, type BundleState } from './recompute.js';
import { createBundle, decide, requireOpenBundle } from './service.js';

export function splitOffGroup(ctx: AppContext, bundleId: string, groupKey: string, name: string | undefined, actor: Actor, opts: { internal?: boolean } = {}): { bundle: IntakeBundleRecord; source: BundleState } {
  if (!opts.internal) requireOpenBundle(ctx, bundleId);
  const state = computeBundle(ctx, bundleId);
  const group = state.computed.groups.find((g) => g.key === groupKey);
  if (!group) throw notFound('group', groupKey);
  if (group.kind === 'main' || group.kind === 'excluded') throw badRequest(group.kind === 'main' ? 'This case stays in the bundle — split off the other groups' : 'Excluded files are not split off');
  // the group's files plus their duplicates and children
  const ids = new Set(group.fileIds);
  for (const f of state.files) {
    const c = state.computed.files[f.id];
    if (c?.duplicate && ids.has(c.duplicate.of) && !c.excluded) ids.add(f.id);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of state.files) if (f.parentFileId && ids.has(f.parentFileId) && !ids.has(f.id) && !state.computed.files[f.id]?.excluded) {
      ids.add(f.id);
      grew = true;
    }
  }
  const files = state.files.filter((f) => ids.has(f.id)).sort((a, b) => a.position - b.position);
  if (!files.length) throw badRequest('That group has no files');
  const newName = (name?.trim() || group.suggestedName || `${state.bundle.name} — ${group.label}`).slice(0, 120);
  const child = createBundle(ctx, { name: newName, source: 'split', parentBundleId: state.bundle.id, splitFromGroup: groupKey }, actor);
  const mapped = new Map<string, string>();
  const now = ctx.now();
  for (const f of files) {
    const r = ctx.repos.addBundleFile(ctx.db, {
      bundleId: child.id,
      intakeItemId: f.intakeItemId,
      evidenceId: f.evidenceId,
      ...(f.parentFileId && mapped.has(f.parentFileId) ? { parentFileId: mapped.get(f.parentFileId)! } : {}),
      role: f.role,
      ...(f.pageFrom ? { pageFrom: f.pageFrom } : {}),
      ...(f.pageTo ? { pageTo: f.pageTo } : {}),
      addedBy: actor.userId,
      now,
    });
    mapped.set(f.id, r.file.id);
    if (r.created && (f.phash || f.facts)) ctx.repos.updateBundleFile(ctx.db, r.file.id, { ...(f.phash ? { phash: f.phash } : {}), ...(f.facts ? { facts: f.facts } : {}) }, now);
  }
  const revision = touchBundle(ctx, ctx.repos.requireIntakeBundle(ctx.db, child.id), { delaySeconds: 0 });
  ctx.repos.appendBundleDecision(ctx.db, { bundleId: child.id, revision, kind: 'add_files', after: { fileIds: [...mapped.values()], fromBundleId: state.bundle.id, groupKey }, actor: actor.userId, at: now });
  recomputeBundle(ctx, child.id);
  const source = decide(ctx, bundleId, { kind: 'split_off', subject: groupKey, after: { fileIds: files.map((f) => f.id), bundleId: child.id, name: newName }, audit: { newBundleId: child.id, files: files.length, groupKey } }, actor, { allowClosed: Boolean(opts.internal) });
  return { bundle: ctx.repos.requireIntakeBundle(ctx.db, child.id), source };
}
