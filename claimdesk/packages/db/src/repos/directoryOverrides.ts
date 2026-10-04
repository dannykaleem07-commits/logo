import { eq } from 'drizzle-orm';
import type { Id, ISODate, ISODateTime, InsurerDirectoryEntry, Verification } from '@ccguk/domain';
import type { Db } from '../client.js';
import { VerificationError } from '../errors.js';
import { directoryOverrides, type DirectoryOverrideRow } from '../schema.js';
import { denull, nowIso } from '../util.js';
import { appendAudit, type Actor } from './audit.js';

/** Human edits layered over the read-only KB directory entry with the same id. */
export interface DirectoryOverride {
  id: string;
  verification?: Verification;
  lastUsedOk?: ISODate;
  lastFailed?: ISODate;
  notes?: string;
  updatedAt: ISODateTime;
  updatedBy: Id | 'system';
}

export type DirectoryOverridePatch = Partial<Pick<DirectoryOverride, 'verification' | 'lastUsedOk' | 'lastFailed' | 'notes'>>;

function toOverride(row: DirectoryOverrideRow): DirectoryOverride {
  return denull(row);
}

export function getDirectoryOverride(db: Db, id: string): DirectoryOverride | undefined {
  const row = db.select().from(directoryOverrides).where(eq(directoryOverrides.id, id)).get();
  return row ? toOverride(row) : undefined;
}

export function listDirectoryOverrides(db: Db): DirectoryOverride[] {
  return db.select().from(directoryOverrides).all().map(toOverride);
}

/**
 * Merge a patch onto the override for `id` (audited as `directory.override`). Code never upgrades verification
 * to 'verified' on its own: that path is `verifyDirectoryEntry`, which requires a human and a source URL.
 */
export function upsertDirectoryOverride(db: Db, id: string, patch: DirectoryOverridePatch, actor: Actor): DirectoryOverride {
  if (patch.verification?.status === 'verified' && (actor.userId === 'system' || !patch.verification.sourceUrl)) {
    throw new VerificationError('verification can only be set to verified by a human with a source URL (use verifyDirectoryEntry)');
  }
  return db.transaction((tx) => {
    const before = getDirectoryOverride(tx, id);
    const at = nowIso();
    const merged = {
      id,
      verification: patch.verification ?? before?.verification ?? null,
      lastUsedOk: patch.lastUsedOk ?? before?.lastUsedOk ?? null,
      lastFailed: patch.lastFailed ?? before?.lastFailed ?? null,
      notes: patch.notes ?? before?.notes ?? null,
      updatedAt: at,
      updatedBy: actor.userId,
    };
    tx.insert(directoryOverrides)
      .values(merged)
      .onConflictDoUpdate({ target: directoryOverrides.id, set: merged })
      .run();
    appendAudit(tx, { actor, action: 'directory.override', entity: 'directory_overrides', entityId: id, before: before ?? null, after: patch, at });
    return toOverride(merged);
  });
}

/** A human verified the entry against a source (ARCHITECTURE convention 6). */
export function verifyDirectoryEntry(db: Db, id: string, actor: Actor, source: { sourceUrl: string; sourceNote?: string; verifiedAt?: ISODate }): DirectoryOverride {
  if (actor.userId === 'system') throw new VerificationError('only a human can mark a directory entry verified');
  if (!source.sourceUrl?.trim()) throw new VerificationError('a source URL is required to mark a directory entry verified');
  const verifiedAt = source.verifiedAt ?? nowIso().slice(0, 10);
  return upsertDirectoryOverride(db, id, { verification: { status: 'verified', sourceUrl: source.sourceUrl, sourceNote: source.sourceNote, verifiedAt, verifiedBy: actor.userId } }, actor);
}

/** A number used on a live call failed: record it and turn the record red (BLUEPRINT §8 maintenance workflow). */
export function reportDirectoryFailed(db: Db, id: string, actor: Actor, note: string, failedOn: ISODate = nowIso().slice(0, 10)): DirectoryOverride {
  const before = getDirectoryOverride(db, id);
  return upsertDirectoryOverride(
    db,
    id,
    {
      lastFailed: failedOn,
      verification: { ...(before?.verification ?? { status: 'unverified' }), status: 'failed', sourceNote: note },
      notes: [before?.notes, `${failedOn}: failed — ${note}`].filter(Boolean).join('\n'),
    },
    actor,
  );
}

/** Record that a number/email worked on a live call. */
export function reportDirectoryUsedOk(db: Db, id: string, actor: Actor, usedOn: ISODate = nowIso().slice(0, 10)): DirectoryOverride {
  return upsertDirectoryOverride(db, id, { lastUsedOk: usedOn }, actor);
}

/** Apply stored overrides onto KB directory entries (pure). Entries without an override pass through unchanged. */
export function applyDirectoryOverrides(entries: InsurerDirectoryEntry[], overrides: DirectoryOverride[]): InsurerDirectoryEntry[] {
  const byId = new Map(overrides.map((o) => [o.id, o]));
  return entries.map((e) => {
    const o = byId.get(e.id);
    if (!o) return e;
    return {
      ...e,
      verification: o.verification ?? e.verification,
      lastUsedOk: o.lastUsedOk ?? e.lastUsedOk,
      lastFailed: o.lastFailed ?? e.lastFailed,
      notes: o.notes ? [e.notes, o.notes].filter(Boolean).join('\n') : e.notes,
    };
  });
}
