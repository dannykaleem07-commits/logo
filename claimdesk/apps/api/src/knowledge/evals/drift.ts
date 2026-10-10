// owned by knowledge-use
/**
 * Drift alarms (docs/SUPREME-KNOWLEDGE-BUILDER.md §12.2), `knowledge.drift` daily at 05:00.
 *
 * Window: the days since the active learned version was activated (at most `windowDays`, 14) against the
 * `baselineDays` (28) before it, n ≥ `minN` (10). Metrics: approval-without-edit rate per action kind, reviewer
 * first-pass rate, median correction size, median working days to pay, reduction rate, owner rejection rate of research
 * items, learned-contact failure rate and the KNOWLEDGE_* block rate. A drop of `dropPctPoints` (15) or more raises a
 * `knowledge_alarms` row and a Needs-you `knowledge_review` card (variant `alarm`) offering a one-click rollback to the
 * previous version.
 *
 * Severe alarms are tied to the perimeter: a reviewer block on a perimeter code in a draft that cited a learned item.
 * With `autoQuarantineOnPerimeter` (default on) the implicated items are quarantined at once — the safe direction,
 * because learned items only add restrictions — logged, and shown with Undo (the owner can re-approve).
 */
import { describeDrift, detectDrift, type DriftFinding, type DriftSample, type NeedsYouPriority } from '@ccguk/domain';
import type { Actor, KnowledgeAlarmRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { conflict, notFound } from '../../errors.js';
import { recordKnowledgeChange } from '../changes.js';
import { getKnowledgeSettings } from '../settings.js';
import { raiseKnowledgeReview } from '../needsYou.js';
import { quarantineKnowledge } from '../store.js';
import { parseJson, rows, tableExists } from '../use/sql.js';

const SUPERVISOR: Actor = { userId: 'agent:supervisor' };
const DAY = 86_400_000;

/** Codes that tie a reviewer block to the perimeter (KR-3, KR-4, red lines, banned phrases). */
export const PERIMETER_CODES: ReadonlySet<string> = new Set(['GTA_CITED_AS_LAW', 'FORUM_NOT_OPEN', 'BANNED_PHRASE', 'RED_LINE', 'RED_LINE_ESCALATE', 'REGULATED_STATUS', 'KNOWLEDGE_NOT_CITABLE']);

export interface DriftWindow {
  version: number;
  activatedAt: string;
  current: { from: string; to: string };
  baseline: { from: string; to: string };
}

export function driftWindow(ctx: AppContext): DriftWindow | null {
  const state = ctx.repos.getKnowledgePackState(ctx.db);
  if (state.activeVersion === null) return null;
  const s = getKnowledgeSettings(ctx).drift;
  const now = ctx.now();
  const activatedAt = state.activatedAt ?? ctx.repos.getKnowledgePackVersion(ctx.db, state.activeVersion)?.createdAt ?? now;
  const from = new Date(Math.max(Date.parse(activatedAt), Date.parse(now) - s.windowDays * DAY)).toISOString();
  return { version: state.activeVersion, activatedAt, current: { from, to: now }, baseline: { from: new Date(Date.parse(activatedAt) - s.baselineDays * DAY).toISOString(), to: activatedAt } };
}

type Range = { from: string; to: string };
const pct = (num: number, den: number): number | null => (den ? Math.round((num / den) * 1000) / 10 : null);
const median = (v: number[]): number | null => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length / 2) - 1)]!;
};

interface IssueLike {
  code?: string;
  severity?: string;
}
const issuesOf = (j: unknown): IssueLike[] => {
  const o = parseJson<{ issues?: IssueLike[] }>(j);
  return Array.isArray(o?.issues) ? o!.issues : [];
};

/** One metric over a range: the value and n. */
function measure(ctx: AppContext, metric: DriftSample['metric'], key: string | null, r: Range): { value: number | null; n: number } {
  switch (metric) {
    case 'approval_without_edit_rate': {
      if (!tableExists(ctx, 'needs_you')) return { value: null, n: 0 };
      const list = rows<{ id: string; resolution: string | null }>(ctx, `SELECT id, resolution FROM needs_you WHERE kind = ? AND status = 'resolved' AND resolved_at >= ? AND resolved_at < ?`, key, r.from, r.to);
      const edited = new Set<string>();
      if (list.length && tableExists(ctx, 'corrections')) for (const c of rows<{ needs_you_id: string | null }>(ctx, `SELECT needs_you_id FROM corrections WHERE needs_you_id IS NOT NULL AND captured_at >= ?`, r.from)) if (c.needs_you_id) edited.add(c.needs_you_id);
      let clean = 0;
      for (const n of list) {
        const res = parseJson<{ optionId?: string; edits?: unknown }>(n.resolution) ?? {};
        if (res.optionId && /reject|void|discard/i.test(res.optionId)) continue;
        if (res.edits !== undefined && res.edits !== null) continue;
        if (edited.has(n.id)) continue;
        clean += 1;
      }
      return { value: pct(clean, list.length), n: list.length };
    }
    case 'reviewer_first_pass_rate': {
      if (!tableExists(ctx, 'reviews')) return { value: null, n: 0 };
      const list = rows<{ verdict: string }>(ctx, `SELECT verdict FROM reviews WHERE loop = 0 AND created_at >= ? AND created_at < ?`, r.from, r.to);
      return { value: pct(list.filter((x) => x.verdict === 'pass').length, list.length), n: list.length };
    }
    case 'median_correction_size': {
      if (!tableExists(ctx, 'corrections')) return { value: null, n: 0 };
      const v = rows<{ stats: string }>(ctx, `SELECT stats FROM corrections WHERE captured_at >= ? AND captured_at < ?`, r.from, r.to)
        .map((x) => Number(parseJson<{ changedRatio?: number }>(x.stats)?.changedRatio))
        .filter((x) => Number.isFinite(x))
        .map((x) => Math.round(x * 1000) / 10);
      return { value: median(v), n: v.length };
    }
    case 'median_working_days_to_pay': {
      if (!tableExists(ctx, 'claim_outcomes')) return { value: null, n: 0 };
      const v = rows<{ d: number }>(ctx, `SELECT working_days_to_pay AS d FROM claim_outcomes WHERE working_days_to_pay IS NOT NULL AND fully_paid_at >= ? AND fully_paid_at < ?`, r.from, r.to).map((x) => x.d);
      return { value: median(v), n: v.length };
    }
    case 'reduction_rate': {
      if (!tableExists(ctx, 'claim_outcomes')) return { value: null, n: 0 };
      const v = rows<{ reduced: number }>(ctx, `SELECT reduced_pence AS reduced FROM claim_outcomes WHERE fully_paid_at >= ? AND fully_paid_at < ?`, r.from, r.to);
      return { value: pct(v.filter((x) => x.reduced > 0).length, v.length), n: v.length };
    }
    case 'research_rejection_rate': {
      const v = rows<{ status: string }>(ctx, `SELECT status FROM knowledge_items WHERE origin = 'researched' AND decided_at >= ? AND decided_at < ? AND decided_by IS NOT NULL AND decided_by NOT IN ('policy','system') AND decided_by NOT LIKE 'agent:%'`, r.from, r.to);
      return { value: pct(v.filter((x) => x.status === 'rejected').length, v.length), n: v.length };
    }
    case 'learned_contact_failure_rate': {
      const contacts = rows<{ scope_value: string | null }>(ctx, `SELECT scope_value FROM knowledge_items WHERE kind = 'contact' AND origin = 'observed' AND status = 'active'`);
      const slugs = new Set(contacts.map((c) => c.scope_value).filter((x): x is string => Boolean(x)));
      if (!slugs.size) return { value: null, n: 0 };
      const failed = new Set(rows<{ entity_id: string }>(ctx, `SELECT entity_id FROM audit_log WHERE action LIKE 'directory.%fail%' AND at >= ? AND at < ?`, r.from, r.to).map((x) => x.entity_id).filter((s) => slugs.has(s)));
      return { value: pct(failed.size, slugs.size), n: contacts.length };
    }
    case 'knowledge_block_rate': {
      if (!tableExists(ctx, 'reviews')) return { value: null, n: 0 };
      const list = rows<{ rules: string }>(ctx, `SELECT rules FROM reviews WHERE created_at >= ? AND created_at < ?`, r.from, r.to);
      return { value: pct(list.filter((x) => issuesOf(x.rules).some((i) => i.severity === 'block' && i.code?.startsWith('KNOWLEDGE_'))).length, list.length), n: list.length };
    }
  }
}

/** Perimeter blocks in the current window on drafts that cited learned items; returns the implicated item ids. */
export function perimeterBlocks(ctx: AppContext, r: Range): { reviews: number; blocked: number; itemIds: string[] } {
  if (!tableExists(ctx, 'reviews')) return { reviews: 0, blocked: 0, itemIds: [] };
  const list = rows<{ target_kind: string; target_id: string; rules: string; facts: string }>(ctx, `SELECT target_kind, target_id, rules, facts FROM reviews WHERE created_at >= ? AND created_at < ?`, r.from, r.to);
  const items = new Set<string>();
  let blocked = 0;
  for (const rv of list) {
    const blocks = [...issuesOf(rv.rules), ...issuesOf(rv.facts)].filter((i) => i.severity === 'block' && i.code && PERIMETER_CODES.has(i.code));
    if (!blocks.length) continue;
    const cited = ctx.repos.listKnowledgeUsage(ctx.db, { targetKind: rv.target_kind, targetId: rv.target_id, cited: true, limit: 100 }).filter((u) => u.ref.startsWith('ki:'));
    if (!cited.length) continue;
    blocked += 1;
    for (const u of cited) items.add(u.ref.slice(3));
  }
  return { reviews: list.length, blocked, itemIds: [...items].sort() };
}

/** Every drift sample for the window (perimeter sample included). */
export function driftSamples(ctx: AppContext, w: DriftWindow): { samples: DriftSample[]; implicated: string[] } {
  const samples: DriftSample[] = [];
  const keyed: Array<[DriftSample['metric'], string | null]> = [
    ['approval_without_edit_rate', 'approve_send'],
    ['approval_without_edit_rate', 'approve_document'],
    ['reviewer_first_pass_rate', null],
    ['median_correction_size', null],
    ['median_working_days_to_pay', null],
    ['reduction_rate', null],
    ['research_rejection_rate', null],
    ['learned_contact_failure_rate', null],
    ['knowledge_block_rate', null],
  ];
  for (const [metric, key] of keyed) {
    const cur = measure(ctx, metric, key, w.current);
    const base = measure(ctx, metric, key, w.baseline);
    samples.push({ metric, key, baseline: base.n >= getKnowledgeSettings(ctx).drift.minN ? base.value : null, current: cur.value, n: cur.n, perimeter: false });
  }
  const p = perimeterBlocks(ctx, w.current);
  samples.push({ metric: 'knowledge_block_rate', key: 'perimeter', baseline: null, current: p.blocked, n: p.blocked, perimeter: true });
  return { samples, implicated: p.itemIds };
}

const metricKey = (f: Pick<DriftFinding, 'metric' | 'key'>): string => (f.key ? `${f.metric}:${f.key}` : f.metric);

/** Raise the alarm rows, cards and (severe) quarantines for the findings; returns the alarms raised. */
export function raiseAlarms(ctx: AppContext, w: DriftWindow, findings: readonly DriftFinding[], implicated: readonly string[], opts: { jobId?: string | null } = {}): KnowledgeAlarmRecord[] {
  const s = getKnowledgeSettings(ctx);
  const raised: KnowledgeAlarmRecord[] = [];
  const prev = ctx.repos.getKnowledgePackVersion(ctx.db, w.version);
  const suggestedRollbackTo = prev?.basedOnVersion ?? (w.version > 1 ? w.version - 1 : null);
  for (const f of findings) {
    const metric = metricKey(f);
    if (ctx.repos.listKnowledgeAlarms(ctx.db, { status: 'open', metric, packVersion: w.version, limit: 1 }).length) continue;
    const now = ctx.now();
    let actionTaken: string | null = null;
    const quarantined: string[] = [];
    if (f.severity === 'severe' && s.drift.autoQuarantineOnPerimeter) {
      for (const id of implicated) {
        const item = ctx.repos.getKnowledgeItem(ctx.db, id);
        if (!item || item.status !== 'active') continue;
        try {
          quarantineKnowledge(ctx, id, `perimeter alarm: ${describeDrift(f)}`, SUPERVISOR);
          quarantined.push(id);
        } catch (err) {
          ctx.logger.warn('could not quarantine an implicated item', { id, error: String(err) });
        }
      }
      if (quarantined.length) actionTaken = `quarantined ${quarantined.map((i) => `ki:${i}`).join(', ')}`;
    }
    const alarm = ctx.db.transaction((tx) => {
      const a = ctx.repos.insertKnowledgeAlarm(tx, { metric, packVersion: w.version, baseline: f.baseline, current: f.current, n: f.n, threshold: f.severity === 'severe' ? 0 : s.drift.dropPctPoints, severity: f.severity, raisedAt: now, actionTaken });
      recordKnowledgeChange(ctx, tx, SUPERVISOR, now, { action: 'knowledge.alarm.raise', packVersion: w.version, after: { alarmId: a.id, metric, severity: f.severity, baseline: f.baseline, current: f.current, n: f.n, quarantined }, reason: describeDrift(f), jobId: opts.jobId ?? null });
      return a;
    });
    const priority: NeedsYouPriority = f.severity === 'severe' ? 'high' : 'normal';
    const card = raiseKnowledgeReview(ctx, {
      payload: { variant: 'alarm', alarmId: alarm.id, suggestedRollbackTo },
      title: f.severity === 'severe' ? 'Learned knowledge touched the perimeter' : `Something got worse since learned version v${w.version}`,
      summary: `${describeDrift(f)}${actionTaken ? ` ClaimDesk ${actionTaken} (the safe direction; you can re-approve them).` : ''}${suggestedRollbackTo !== null ? ` You can roll back to v${suggestedRollbackTo} in one click.` : ''}`.trim(),
      priority,
      dedupeKey: `knowledge_review:alarm:${alarm.id}`,
      createdBy: SUPERVISOR.userId,
      bypassCap: f.severity === 'severe',
    });
    raised.push(card ? ctx.repos.updateKnowledgeAlarm(ctx.db, alarm.id, { needsYouId: card.id }) : alarm);
  }
  return raised;
}

/** knowledge.drift: compute the samples, detect drift, raise alarms. */
export function runDrift(ctx: AppContext, opts: { jobId?: string | null } = {}): { result: string; window: DriftWindow | null; samples: DriftSample[]; findings: DriftFinding[]; alarms: string[] } {
  const w = driftWindow(ctx);
  if (!w) return { result: 'no_active_version', window: null, samples: [], findings: [], alarms: [] };
  const s = getKnowledgeSettings(ctx).drift;
  const { samples, implicated } = driftSamples(ctx, w);
  const findings = detectDrift(samples, { minN: s.minN, dropPctPoints: s.dropPctPoints });
  const alarms = raiseAlarms(ctx, w, findings, implicated, opts);
  return { result: findings.length ? 'alarms' : 'ok', window: w, samples, findings, alarms: alarms.map((a) => a.id) };
}

/** The owner acknowledges an alarm (route / card). */
export function acknowledgeAlarm(ctx: AppContext, id: string, actor: Actor, note: string | null, opts: { rolledBackTo?: number | null; needsYouId?: string | null } = {}): KnowledgeAlarmRecord {
  const a = ctx.repos.getKnowledgeAlarm(ctx.db, id);
  if (!a) throw notFound('knowledge alarm', id);
  if (a.status === 'resolved') throw conflict('ALARM_RESOLVED', 'This alarm is already resolved');
  const now = ctx.now();
  const status = opts.rolledBackTo !== undefined && opts.rolledBackTo !== null ? 'resolved' : 'acknowledged';
  return ctx.db.transaction((tx) => {
    const updated = ctx.repos.updateKnowledgeAlarm(tx, id, { status, resolvedBy: actor.userId, resolvedAt: now, ...(status === 'resolved' ? { actionTaken: `${a.actionTaken ? `${a.actionTaken}; ` : ''}rolled back to v${opts.rolledBackTo}` } : {}) });
    recordKnowledgeChange(ctx, tx, actor, now, { action: status === 'resolved' ? 'knowledge.alarm.resolve' : 'knowledge.alarm.ack', packVersion: a.packVersion, before: { alarmId: id, status: a.status }, after: { alarmId: id, status }, reason: note ?? (status === 'resolved' ? `rolled back to v${opts.rolledBackTo}` : 'acknowledged'), needsYouId: opts.needsYouId ?? null });
    return updated;
  });
}
