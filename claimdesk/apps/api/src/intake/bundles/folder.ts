// owned by intake-server
/**
 * Folder bundles (docs/SMART-INTAKE.md §6.11): a subfolder of `inbox\intake\` that is not a claim reference becomes
 * an intake bundle named after the folder (names compared ignoring case, as Windows does). A folder reused after its
 * bundle closed starts a new bundle "<folder> (2)". The files are read and reconciled like an upload; the quiet period
 * means the bundle is reasoned once the drop has settled.
 */
import type { Actor, IntakeBundleRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { StagedImport } from '../../services/imports.js';
import { consumeStagedImport } from '../items.js';
import { touchBundle } from './hooks.js';
import { addItemToBundle, createBundle } from './service.js';

export const FOLDER_ACTOR: Actor = { userId: 'agent:intake' };

/** The open bundle for an inbox folder, or a new one. */
export function bundleForFolder(ctx: AppContext, folder: string): IntakeBundleRecord {
  const key = folder.trim().slice(0, 120);
  const open = ctx.repos.findOpenBundleByFolder(ctx.db, key);
  if (open) return open;
  const before = ctx.repos.listBundlesByFolder(ctx.db, key).length;
  return createBundle(ctx, { name: before ? `${key} (${before + 1})` : key, source: 'folder', folderKey: key }, FOLDER_ACTOR);
}

/** A staged import from an inbox folder → its intake item → the folder's bundle. */
export async function consumeFolderImport(ctx: AppContext, imp: StagedImport): Promise<{ bundleId: string; created: boolean }> {
  const bundle = bundleForFolder(ctx, imp.bundleFolder!);
  const { item, created } = await consumeStagedImport(ctx, imp.id, { actor: FOLDER_ACTOR });
  const added = addItemToBundle(ctx, bundle, ctx.repos.requireIntakeItem(ctx.db, item.id), FOLDER_ACTOR);
  if (added.outcome === 'added') {
    const revision = touchBundle(ctx, ctx.repos.requireIntakeBundle(ctx.db, bundle.id));
    ctx.repos.appendBundleDecision(ctx.db, { bundleId: bundle.id, revision, kind: 'add_files', after: { fileIds: [added.fileId], filenames: [added.filename], folder: imp.bundleFolder }, actor: FOLDER_ACTOR.userId, at: ctx.now() });
    ctx.repos.appendAudit(ctx.db, { actor: FOLDER_ACTOR, action: 'intake.bundle.add_files', entity: 'intake_bundles', entityId: bundle.id, after: { added: 1, files: [{ fileId: added.fileId, itemId: added.itemId, filename: added.filename, outcome: added.outcome }], folder: imp.bundleFolder }, at: ctx.now() });
  }
  return { bundleId: bundle.id, created };
}
