// owned by intake-server
/**
 * The daily log's intake section (docs/SMART-INTAKE.md §12): one line per bundle per event — files read and cases
 * found, a bundle ready for the owner, a claim registered (by the owner or automatically), files attached, a request
 * for missing documents prepared, archives unpacked and packs split, and an AI check waiting for more than a day.
 * Built from the audit trail, the Needs-you list and the bundles; never from page text. Absent when empty.
 */
import { BANNED_INTAKE_WORDS, type BundleComputed } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { LogLine } from '../../agent/dailyLog.js';
import { aiWaiting } from './recompute.js';

interface Row {
  at: string;
  user_id: string;
  action: string;
  entity_id: string;
  after: string | null;
}

const parse = <T>(s: string | null): T => {
  try {
    return (s ? JSON.parse(s) : {}) as T;
  } catch {
    return {} as T;
  }
};
const plural = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;
const WAITING_TEXT: Record<string, string> = { agents_off: 'agents are paused', kill_switch: 'the kill switch is on', usage: 'the AI usage limit is reached', sign_in: 'the AI sign-in needs fixing' };

export function intakeDailyLogSection(ctx: AppContext, _day: string, bounds: { start: string; end: string }): { intake?: LogLine[] } {
  const sqlite = ctx.handle.sqlite;
  const rows = sqlite
    .prepare(`SELECT at, user_id, action, entity_id, after FROM audit_log WHERE at >= ? AND at < ? AND (action LIKE 'intake.bundle.%' OR action IN ('intake.unpack', 'intake.split_pack')) ORDER BY at, rowid`)
    .all(bounds.start, bounds.end) as Row[];
  const lines: LogLine[] = [];
  const bundleName = (id: string) => ctx.repos.getIntakeBundle(ctx.db, id)?.name ?? 'a bundle';
  const ref = (claimId: string | undefined) => (claimId ? ctx.repos.getClaim(ctx.db, claimId)?.reference : undefined);
  const push = (l: Omit<LogLine, 'agent'> & { claimId?: string }) => {
    const reference = ref(l.claimId);
    lines.push({ agent: 'intake', ...l, ...(reference ? { reference } : {}) });
  };

  // files read / cases found: the last reconcile of the day per bundle
  const lastReconcile = new Map<string, Row>();
  for (const r of rows) if (r.action === 'intake.bundle.reconcile') lastReconcile.set(r.entity_id, r);
  for (const [bundleId, r] of lastReconcile) {
    const b = ctx.repos.getIntakeBundle(ctx.db, bundleId);
    if (!b) continue;
    const c = b.computed as BundleComputed | undefined;
    const files = parse<{ files?: number }>(r.after).files ?? 0;
    const cases = c ? c.groups.filter((g) => g.kind === 'main' || g.kind === 'new_case').length : 1;
    const claimBits = (c?.groups ?? []).filter((g) => g.kind === 'existing_claim').map((g) => `${plural(g.fileIds.length, 'file')} belong${g.fileIds.length === 1 ? 's' : ''} to ${g.claim?.reference ?? 'another claim'}`);
    push({ at: r.at, text: `Read ${plural(files, 'file')} for bundle '${b.name}': ${plural(cases, 'case')} found${claimBits.length ? `, ${claimBits.join(', ')}` : ''}.`, link: `/intake/bundles/${bundleId}` });
  }

  // ready for the owner (bundle new_claim cards opened today)
  const cards = sqlite
    .prepare(`SELECT id, created_at AS at, payload FROM needs_you WHERE kind = 'new_claim' AND created_at >= ? AND created_at < ? AND json_extract(payload, '$.bundleId') IS NOT NULL ORDER BY created_at`)
    .all(bounds.start, bounds.end) as Array<{ id: string; at: string; payload: string }>;
  for (const card of cards) {
    const p = parse<{ bundleId: string; name?: string; counts?: { conflicts?: number; missing?: number } }>(card.payload);
    const bits = [p.counts?.conflicts ? `${plural(p.counts.conflicts, 'detail')} conflict` : null, p.counts?.missing ? `${plural(p.counts.missing, 'document')} missing` : null].filter(Boolean);
    push({ at: card.at, text: `Bundle '${p.name ?? bundleName(p.bundleId)}' is ready for you${bits.length ? `: ${bits.join(', ')}` : ''}.`, why: 'Opening a claim is your decision', link: `/intake/bundles/${p.bundleId}` });
  }

  for (const r of rows) {
    const a = parse<Record<string, unknown>>(r.after);
    switch (r.action) {
      case 'intake.bundle.register':
      case 'intake.bundle.register_retry': {
        const claimId = String(a.claimId ?? '');
        const parts = [`${plural(Number(a.filed ?? 0), 'document')} filed`, Number(a.duplicatesSkipped ?? 0) ? `${plural(Number(a.duplicatesSkipped), 'copy', 'copies')} not filed twice` : null, `${plural(Number(a.events ?? 0), 'chronology entry', 'chronology entries')}`].filter(Boolean);
        push({ at: r.at, claimId, text: `Registered ${String(a.reference ?? '')} from '${bundleName(r.entity_id)}' (${parts.join(', ')}).${a.error ? ' A later step needs a retry.' : ''}`, why: a.mode === 'auto' ? 'registered automatically (Settings > Intake)' : 'you pressed Register', link: `/claims/${claimId}` });
        break;
      }
      case 'intake.bundle.attach':
        push({ at: r.at, claimId: String(a.claimId ?? ''), text: `Attached ${plural(Number(a.files ?? 0), 'file')} to ${String(a.reference ?? 'the claim')}.`, link: `/claims/${String(a.claimId ?? '')}` });
        break;
      case 'intake.bundle.request_docs': {
        const items = Array.isArray(a.items) ? a.items.length : 0;
        const claimId = String(a.claimId ?? '');
        push({ at: r.at, claimId, text: `Prepared a request for ${plural(items, 'missing document')} on ${ref(claimId) ?? 'the claim'} — ${a.outboxId ? 'waiting for your approval' : 'the text is on your Needs-you list (no email could be prepared)'}.`, why: 'Nothing is sent to a client without you', link: `/claims/${claimId}` });
        break;
      }
      case 'intake.unpack': {
        const skipped = Array.isArray(a.skipped) ? a.skipped.length : 0;
        push({ at: r.at, text: `Unpacked ${String(a.filename ?? 'an archive')} (${plural(Number(a.entries ?? 0), 'file')}${skipped ? `, ${skipped} skipped` : ''}).`, link: '/intake' });
        break;
      }
      case 'intake.split_pack': {
        const n = Array.isArray(a.segments) ? a.segments.length : 0;
        const item = ctx.repos.getIntakeItem(ctx.db, r.entity_id);
        const name = item ? ctx.repos.getEvidence(ctx.db, item.evidenceId)?.filename : undefined;
        push({ at: r.at, text: `Split ${name ?? 'a scanned pack'} into ${plural(n, 'document')}.`, link: '/intake' });
        break;
      }
      default:
        break;
    }
  }

  // AI check waiting for more than a day
  const waiting = aiWaiting(ctx);
  if (waiting) {
    const dayAgo = new Date(Date.parse(bounds.end) - 24 * 3_600_000).toISOString();
    for (const b of ctx.repos.listIntakeBundles(ctx.db, { status: ['ready', 'needs_you', 'reconciling', 'reading', 'open'], limit: 200 })) {
      if ((b.reasoningStatus === 'queued' || b.reasoningStatus === 'waiting_ai') && b.updatedAt < dayAgo) push({ at: bounds.end > ctx.now() ? ctx.now() : bounds.end, text: `AI check of '${b.name}' waiting: ${WAITING_TEXT[waiting.reason] ?? 'the AI is paused'}.`, why: 'The draft is from the documents’ text until the AI is back', link: `/intake/bundles/${b.id}` });
    }
  }
  const clean = lines.filter((l) => !BANNED_INTAKE_WORDS.test(l.text)).sort((x, y) => x.at.localeCompare(y.at));
  return clean.length ? { intake: clean } : {};
}
