// owned by knowledge-research
/**
 * `knowledge.gap_scan` (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.1, 01:00 and every 4 hours): raises gaps from what
 * ClaimDesk already records, then queues research for the gaps that are due, within the day's research budget.
 *
 *   review_failure      reviews flagged UNVERIFIED_CITATION, FACT_UNSOURCED or KNOWLEDGE_*
 *   research_no_answer  research.ask runs with no answer or confidence < 0.5
 *   needs_you           open missing_info and question items
 *   directory_ageing    directory entries amber / red / failed
 *   kb_unverified       KB entries cited by playbook rules or used in drafts (knowledge_usage)
 *   intake_unknown      intake documents typed `other`
 *   triage_other        an insurer with ≥ 3 `other` intents in 30 days
 *   (source_changed gaps come from knowledge.watch)
 * Every question is scrubbed by reportGap; a question already settled is skipped, so the scan never loops. At most
 * 25 new gaps per scan. Also: the first-run source self-test, and the prepare-and-confirm card for blocking gaps still
 * unanswered after 24 h.
 */
import { directoryStatus } from '@ccguk/kb';
import type { GapKind, GapOrigin, KnowledgeArea, KnowledgeScope } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { EnqueueInput } from '../../agent/contracts.js';
import { londonDay, londonDayStart } from '../../agent/core.js';
import { loadDirectory } from '../../services/kb.js';
import { getKnowledgeSettings } from '../settings.js';
import { claimDictionaryFor } from './dictionary.js';
import { raiseGapCard, reportGap } from './gaps.js';
import { selftestDone } from './watch.js';

export const MAX_NEW_GAPS_PER_SCAN = 25;
const SUPERVISOR = 'agent:supervisor';

interface Candidate {
  kind: GapKind;
  question: string;
  area: KnowledgeArea;
  scope: KnowledgeScope;
  origin: GapOrigin;
  originRef: string;
  claimIds: string[];
}

function hasTable(ctx: AppContext, t: string): boolean {
  return Boolean(ctx.handle.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t));
}

const all = <T>(ctx: AppContext, sql: string, ...params: unknown[]): T[] => ctx.handle.sqlite.prepare(sql).all(...params) as T[];
const parse = (s: unknown): unknown => {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Walk JSON for objects carrying one of `codes`. */
function findCodes(v: unknown, codes: (c: string) => boolean, out: { code: string; message: string }[] = [], depth = 0): { code: string; message: string }[] {
  if (depth > 8 || v === null || typeof v !== 'object') return out;
  if (Array.isArray(v)) {
    for (const x of v) findCodes(x, codes, out, depth + 1);
    return out;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.code === 'string' && codes(o.code)) out.push({ code: o.code, message: typeof o.message === 'string' ? o.message : '' });
  for (const x of Object.values(o)) findCodes(x, codes, out, depth + 1);
  return out;
}

function candidates(ctx: AppContext): Candidate[] {
  const out: Candidate[] = [];
  const since30 = new Date(Date.parse(ctx.now()) - 30 * 86_400_000).toISOString();
  const try_ = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      ctx.logger.warn(`gap scan: ${label} failed`, { error: String(err) });
    }
  };

  try_('reviews', () => {
    for (const r of all<{ id: string; claim_id: string | null; rules: string }>(ctx, `SELECT id, claim_id, rules FROM reviews WHERE created_at >= ? AND (rules LIKE '%UNVERIFIED_CITATION%' OR rules LIKE '%FACT_UNSOURCED%' OR rules LIKE '%KNOWLEDGE_%') ORDER BY created_at DESC LIMIT 50`, since30)) {
      for (const f of findCodes(parse(r.rules), (c) => c === 'UNVERIFIED_CITATION' || c === 'FACT_UNSOURCED' || c.startsWith('KNOWLEDGE_')).slice(0, 3)) {
        const kb = /\bkb:([A-Za-z0-9._-]+)/.exec(f.message)?.[1];
        out.push({
          kind: f.code === 'UNVERIFIED_CITATION' ? 'kb_verification' : 'other',
          question: f.code === 'UNVERIFIED_CITATION' ? `Verify the authority flagged in a reviewed draft${kb ? ` (KB entry ${kb})` : ''}: ${f.message}` : `A reviewed draft relied on knowledge that could not be sourced: ${f.message}`,
          area: 'legal',
          scope: { kind: 'global' },
          origin: 'review_failure',
          originRef: `review:${r.id}`,
          claimIds: r.claim_id ? [r.claim_id] : [],
        });
      }
    }
  });

  try_('research.ask', () => {
    for (const r of all<{ id: string; claim_id: string | null; payload: string; result: string | null }>(
      ctx,
      `SELECT j.id, j.claim_id, j.payload, r.result FROM agent_jobs j JOIN agent_runs r ON r.job_id = j.id WHERE j.type = 'research.ask' AND r.started_at >= ? AND r.outcome = 'ok' ORDER BY r.started_at DESC LIMIT 50`,
      since30,
    )) {
      const res = parse(r.result) as { answer?: string; confidence?: number } | null;
      if (res && typeof res.confidence === 'number' && res.confidence >= 0.5 && res.answer) continue;
      const q = (parse(r.payload) as { question?: string } | null)?.question;
      if (!q) continue;
      out.push({ kind: 'other', question: q, area: 'legal', scope: { kind: 'global' }, origin: 'research_no_answer', originRef: `job:${r.id}`, claimIds: r.claim_id ? [r.claim_id] : [] });
    }
  });

  try_('needs_you', () => {
    for (const n of all<{ id: string; claim_id: string | null; title: string; summary: string; kind: string }>(ctx, `SELECT id, claim_id, title, summary, kind FROM needs_you WHERE kind IN ('missing_info','question') AND status IN ('open','snoozed') ORDER BY created_at DESC LIMIT 50`)) {
      out.push({ kind: n.kind === 'missing_info' ? 'unfamiliar_document' : 'other', question: `${n.title}${n.summary ? ` — ${n.summary.slice(0, 300)}` : ''}`, area: 'procedural', scope: { kind: 'global' }, origin: 'needs_you', originRef: `needs_you:${n.id}`, claimIds: n.claim_id ? [n.claim_id] : [] });
    }
  });

  try_('directory', () => {
    const today = londonDay(ctx.now());
    for (const e of loadDirectory(ctx)) {
      const st = directoryStatus(e, today);
      if (st === 'green') continue;
      out.push({ kind: 'missing_contact', question: `What are ${e.name}'s current third-party motor claims contact details (phone, email and portal)?`, area: 'contact', scope: { kind: 'insurer', slug: e.id }, origin: 'directory_ageing', originRef: `directory:${e.id}`, claimIds: [] });
    }
  });

  try_('kb', () => {
    const ids = new Set(ctx.kb.entries().map((e) => e.id));
    const cited = new Set<string>();
    const walk = (v: unknown, depth = 0): void => {
      if (depth > 8) return;
      if (typeof v === 'string') {
        if (ids.has(v)) cited.add(v);
        for (const m of v.matchAll(/kb:([A-Za-z0-9._-]+)/g)) if (ids.has(m[1]!)) cited.add(m[1]!);
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
      else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
    };
    walk(ctx.kb.playbookRules());
    if (hasTable(ctx, 'knowledge_usage')) for (const r of all<{ ref: string }>(ctx, `SELECT DISTINCT ref FROM knowledge_usage WHERE ref LIKE 'kb:%' LIMIT 500`)) if (ids.has(r.ref.slice(3))) cited.add(r.ref.slice(3));
    const verifiedByOwner = new Set(ctx.repos.listKbChecks(ctx.db).filter((c) => c.result === 'source_verified' || c.result === 'failed').map((c) => c.target.slice(3)));
    for (const e of ctx.kb.entries()) {
      if (!cited.has(e.id) || e.verification?.status === 'verified' || verifiedByOwner.has(e.id)) continue;
      out.push({ kind: 'kb_verification', question: `Check KB entry ${e.id} against its primary source: ${e.citation} — ${e.title}`, area: e.type === 'gta' ? 'procedural' : 'legal', scope: { kind: 'global' }, origin: 'kb_unverified', originRef: `kb:${e.id}`, claimIds: [] });
    }
  });

  try_('intake', () => {
    for (const r of all<{ id: string; claim_id: string | null; summary: string | null }>(ctx, `SELECT i.id, i.claim_id, (SELECT x.summary FROM intake_extractions x WHERE x.intake_item_id = i.id ORDER BY x.created_at DESC LIMIT 1) AS summary FROM intake_items i WHERE i.doc_type = 'other' AND i.created_at >= ? ORDER BY i.created_at DESC LIMIT 20`, since30)) {
      out.push({ kind: 'unfamiliar_document', question: `What is this kind of document and what should be done with it: ${(r.summary ?? 'an unclassified document').slice(0, 300)}`, area: 'procedural', scope: { kind: 'global' }, origin: 'intake_unknown', originRef: `intake:${r.id}`, claimIds: r.claim_id ? [r.claim_id] : [] });
    }
  });

  try_('triage', () => {
    if (!hasTable(ctx, 'insurer_links')) return;
    const rows = all<{ slug: string; n: number }>(
      ctx,
      `SELECT l.insurer_slug AS slug, count(*) AS n FROM mail_classifications c JOIN mail_messages m ON m.id = c.mail_message_id JOIN claims cl ON cl.id = m.claim_id JOIN insurer_links l ON l.party_id = cl.at_fault_insurer_id WHERE c.intent = 'other' AND c.created_at >= ? GROUP BY l.insurer_slug HAVING count(*) >= 3`,
      since30,
    );
    for (const r of rows) out.push({ kind: 'insurer_process', question: `${r.slug} keeps sending emails ClaimDesk cannot classify. What are this insurer's usual letters and processes for third-party credit hire claims?`, area: 'procedural', scope: { kind: 'insurer', slug: r.slug }, origin: 'triage_other', originRef: `insurer:${r.slug}`, claimIds: [] });
  });
  return out;
}

export interface GapScanResult {
  scanned: number;
  recorded: number;
  merged: number;
  skipped: number;
  researchQueued: number;
  cards: number;
  selftest: boolean;
}

export function runGapScan(ctx: AppContext, opts: { jobId?: string | null } = {}): { result: GapScanResult; followUps: EnqueueInput[] } {
  const settings = getKnowledgeSettings(ctx);
  const dict = claimDictionaryFor(ctx);
  const result: GapScanResult = { scanned: 0, recorded: 0, merged: 0, skipped: 0, researchQueued: 0, cards: 0, selftest: false };
  for (const c of candidates(ctx)) {
    result.scanned += 1;
    if (result.recorded >= MAX_NEW_GAPS_PER_SCAN) break;
    try {
      const r = reportGap(ctx, { ...c, raisedBy: SUPERVISOR, jobId: opts.jobId ?? null, skipIfSettled: true }, { dict });
      if (r.status === 'recorded') result.recorded += 1;
      else if (r.status === 'merged') result.merged += 1;
      else result.skipped += 1;
    } catch {
      result.skipped += 1; // a question that scrubs to nothing is not a gap
    }
  }

  const now = ctx.now();
  // Prepare-and-confirm: blocking gaps still unanswered after 24 h.
  const dayAgo = new Date(Date.parse(now) - 86_400_000).toISOString();
  for (const g of ctx.repos.listKnowledgeGaps(ctx.db, { status: 'open_any', limit: 500 }).gaps) {
    if (!g.blocking || g.needsYouId || g.createdAt > dayAgo || g.status === 'answered_pending') continue;
    if (raiseGapCard(ctx, g, { createdBy: 'agent:researcher' })) result.cards += 1;
  }

  const followUps: EnqueueInput[] = [];
  if (settings.learningEnabled && settings.researchEnabled) {
    const queuedToday = Number((ctx.handle.sqlite.prepare(`SELECT count(*) AS c FROM agent_jobs WHERE type = 'knowledge.research' AND created_at >= ?`).get(londonDayStart(now)) as { c: number } | undefined)?.c ?? 0);
    const room = Math.max(0, settings.budgets.researchRunsPerDay - queuedToday);
    for (const g of ctx.repos.dueKnowledgeGaps(ctx.db, now, room)) {
      const attempt = g.attempts + 1;
      followUps.push({ type: 'knowledge.research', payload: { gapId: g.id, attempt }, priority: g.blocking ? 4 : 6, idempotencyKey: `knowledge.research:${g.id}:${attempt}`, createdBy: SUPERVISOR });
    }
    result.researchQueued = followUps.length;
  }
  if (settings.learningEnabled && settings.sourceFetchEnabled && !selftestDone(ctx)) {
    followUps.push({ type: 'knowledge.fetch', payload: { selftest: true, reason: 'first-run source self-test' }, idempotencyKey: `knowledge.fetch:selftest:${londonDay(now)}`, createdBy: SUPERVISOR });
    result.selftest = true;
  }
  return { result, followUps };
}
