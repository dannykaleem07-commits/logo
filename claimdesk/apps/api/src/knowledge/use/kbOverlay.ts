// owned by knowledge-use
/**
 * The KB verification overlay (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.5). `@ccguk/kb` stays pure and static (172 entries,
 * none verified); the owner's recorded checks on `kb:<id>` (knowledge_checks, human only — DB-enforced) are applied
 * API-side to every KB read:
 *
 *   - the latest human check wins (`source_verified` / `owner_confirmed` → verified, `failed` → failed = excluded,
 *     `unverified` → unverified);
 *   - a code-detected source change (knowledge.watch opened a `source_changed` gap for `kb:<id>` after the check, or the
 *     checked snapshot's URL has a newer copy with different text) shows a verified entry as `stale` (KR-2: display only).
 *
 * `installKbOverlay(ctx)` wraps `ctx.kb.entries` once, so kb_search / kb_entry / kb_advise, the KB screen, the reviewer's
 * citation checks (UNVERIFIED_CITATION) and gap scanning all see the overlay. services/kb.ts applies it to the ranked
 * search too (`setKbSearchOverlay`).
 */
import { kbOverlayStatus, type KbEntry, type KnowledgeCheck, type KnowledgeHealth } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { row, tableExists } from './sql.js';

const ORIGINAL = Symbol.for('claimdesk.knowledge.kbEntriesOriginal');
type Loaders = AppContext['kb'] & { [ORIGINAL]?: () => KbEntry[] };

/** The static KB entries (never overlaid). */
export function baseKbEntries(ctx: AppContext): KbEntry[] {
  const kb = ctx.kb as Loaders;
  return kb[ORIGINAL] ? kb[ORIGINAL]() : kb.entries();
}

export interface KbOverlayInfo {
  status: 'verified' | 'unverified' | 'failed' | 'stale';
  health: KnowledgeHealth;
  latest: KnowledgeCheck | null;
}

const isHuman = (c: KnowledgeCheck): boolean => c.checkedBy !== 'system' && !c.checkedBy.startsWith('agent:') && c.method !== 'downgrade';

function sourceChangedSince(ctx: AppContext, entryId: string, check: KnowledgeCheck): boolean {
  try {
    if (tableExists(ctx, 'knowledge_gaps')) {
      const g = row<{ id: string }>(ctx, `SELECT id FROM knowledge_gaps WHERE origin = 'source_changed' AND origin_ref = ? AND created_at >= ? AND status IN ('open','researching','answered_pending','needs_owner') LIMIT 1`, `kb:${entryId}`, check.checkedAt);
      if (g) return true;
    }
    if (check.snapshotId && tableExists(ctx, 'source_snapshots')) {
      const snap = row<{ url: string; text_sha256: string | null; sha256: string; fetched_at: string }>(ctx, `SELECT url, text_sha256, sha256, fetched_at FROM source_snapshots WHERE id = ?`, check.snapshotId);
      if (snap) {
        const newer = row<{ text_sha256: string | null; sha256: string }>(ctx, `SELECT text_sha256, sha256 FROM source_snapshots WHERE url = ? AND fetched_at > ? ORDER BY fetched_at DESC LIMIT 1`, snap.url, snap.fetched_at);
        if (newer && (newer.text_sha256 ?? newer.sha256) !== (snap.text_sha256 ?? snap.sha256)) return true;
      }
    }
  } catch (err) {
    ctx.logger.warn('kb overlay: could not check for source changes', { error: String(err) });
  }
  return false;
}

/** Overlay info for every KB entry that has at least one check. */
export function kbOverlay(ctx: AppContext): Map<string, KbOverlayInfo> {
  const out = new Map<string, KbOverlayInfo>();
  let checks: KnowledgeCheck[];
  try {
    checks = ctx.repos.listKbChecks(ctx.db);
  } catch {
    return out;
  }
  const byEntry = new Map<string, KnowledgeCheck[]>();
  for (const c of checks) {
    const id = c.target.slice(3);
    byEntry.set(id, [...(byEntry.get(id) ?? []), c]);
  }
  for (const [id, list] of byEntry) {
    const human = list.filter(isHuman).sort((a, b) => (a.checkedAt === b.checkedAt ? a.id.localeCompare(b.id) : a.checkedAt.localeCompare(b.checkedAt)));
    const latest = human[human.length - 1] ?? null;
    if (!latest) continue;
    const health: KnowledgeHealth = (latest.result === 'source_verified' || latest.result === 'owner_confirmed') && sourceChangedSince(ctx, id, latest) ? 'source_changed' : 'ok';
    out.set(id, { status: kbOverlayStatus('unverified', list, health), health, latest });
  }
  return out;
}

/** One entry with the overlay applied (a new object only when something changed). */
export function overlayKbEntry(entry: KbEntry, info: KbOverlayInfo | undefined): KbEntry {
  if (!info) return entry;
  const staticStatus = entry.verification?.status ?? 'unverified';
  const status = kbOverlayStatus(staticStatus, info.latest ? [info.latest] : [], info.health);
  if (status === staticStatus && !info.latest) return entry;
  const l = info.latest;
  return {
    ...entry,
    verification: {
      ...entry.verification,
      status,
      ...(l && (l.result === 'source_verified' || l.result === 'owner_confirmed') ? { verifiedAt: l.checkedAt.slice(0, 10), verifiedBy: l.checkedBy, ...(l.sourceUrl ? { sourceUrl: l.sourceUrl } : {}) } : {}),
      ...(l?.note ? { sourceNote: l.note } : {}),
    },
  };
}

export function applyKbOverlay(ctx: AppContext, entries: readonly KbEntry[]): KbEntry[] {
  const ov = kbOverlay(ctx);
  if (!ov.size) return [...entries];
  return entries.map((e) => overlayKbEntry(e, ov.get(e.id)));
}

/** Wrap `ctx.kb.entries` with the overlay (idempotent). */
export function installKbOverlay(ctx: AppContext): void {
  const kb = ctx.kb as Loaders;
  if (kb[ORIGINAL]) return;
  const original = kb.entries.bind(kb);
  kb[ORIGINAL] = original;
  kb.entries = () => applyKbOverlay(ctx, original());
}

/** All human checks on a KB entry (oldest first), for the routes. */
export function kbChecksFor(ctx: AppContext, entryId: string): KnowledgeCheck[] {
  return ctx.repos.listKnowledgeChecks(ctx.db, [`kb:${entryId}`]);
}

/** KB entries whose overlay says stale (for the drift / digest readers). */
export function staleKbEntries(ctx: AppContext): string[] {
  return [...kbOverlay(ctx).entries()].filter(([, v]) => v.status === 'stale').map(([k]) => k).sort();
}

