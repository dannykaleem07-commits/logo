// owned by knowledge-core
/**
 * The daily log's "Knowledge" section (docs/SUPREME-KNOWLEDGE-BUILDER.md §9.4, KR-12): what was learned automatically
 * (each line with an Undo that retires the item), what waits for the owner, gaps opened and filled, sources fetched,
 * research runs and alarms. A deterministic query over `knowledge_changes` and the knowledge tables; tables owned by
 * other knowledge slices are read only when present (`hasTable`).
 */
import { effectiveBadges, type DigestLine, type KnowledgeDigest, type KnowledgeItem } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { londonDayBounds } from '../agent/dailyLog.js';
import { getKnowledgeSettings } from './settings.js';

const plural = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;

function hasTable(ctx: AppContext, t: string): boolean {
  return Boolean(ctx.handle.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t));
}

const count = (ctx: AppContext, sqlText: string, ...params: unknown[]): number => Number((ctx.handle.sqlite.prepare(sqlText).get(...params) as { c: number } | undefined)?.c ?? 0);

const itemLine = (i: KnowledgeItem, at: string, text: string, undo: boolean): DigestLine => ({
  at,
  text,
  badges: effectiveBadges(i),
  itemId: i.id,
  link: `/knowledge?tab=library&item=${encodeURIComponent(i.id)}`,
  ...(undo && i.status === 'active' ? { undoRoute: `/api/knowledge/items/${encodeURIComponent(i.id)}/retire` } : {}),
});

const kindLabel = (i: KnowledgeItem): string =>
  i.kind === 'insurer_profile' ? 'insurer statistics' : i.kind === 'template_snippet' ? 'wording' : i.kind === 'engineering_figure' ? 'repair figure' : i.kind.replace(/_/g, ' ');

/** Headline, e.g. "Learned 9 things automatically, 3 wait for you, 2 gaps filled". */
export function knowledgeHeadline(d: Pick<KnowledgeDigest, 'learningEnabled' | 'learnedAutomatically' | 'waitingForYou' | 'gaps' | 'alarms'>): string {
  const parts = [`Learned ${plural(d.learnedAutomatically.length, 'thing')} automatically`, `${d.waitingForYou.count} wait${d.waitingForYou.count === 1 ? 's' : ''} for you`];
  if (d.gaps.filled) parts.push(`${plural(d.gaps.filled, 'gap')} filled`);
  if (d.alarms.length) parts.push(plural(d.alarms.length, 'alarm'));
  return `${d.learningEnabled ? '' : 'Learning is paused. '}${parts.join(', ')}.`;
}

export function compileKnowledgeDigest(ctx: AppContext, day: string): KnowledgeDigest {
  const { start, end } = londonDayBounds(day);
  const settings = getKnowledgeSettings(ctx);
  const state = ctx.repos.getKnowledgePackState(ctx.db);

  // learned automatically: auto-apply changes of the day (one line per item, newest version wins)
  const autos = ctx.repos.listKnowledgeChanges(ctx.db, { since: start, until: end, action: 'knowledge.item.auto_apply', order: 'asc', limit: 2000 });
  const items = new Map(ctx.repos.getKnowledgeItems(ctx.db, [...new Set(autos.map((c) => c.itemId).filter((x): x is string => Boolean(x)))]).map((i) => [i.id, i] as const));
  const seen = new Set<string>();
  const learnedAutomatically: DigestLine[] = [];
  for (const c of autos) {
    const i = c.itemId ? items.get(c.itemId) : undefined;
    if (!i || seen.has(i.itemKey)) continue;
    seen.add(i.itemKey);
    learnedAutomatically.push(itemLine(i, c.at, `Learned ${kindLabel(i)}: ${i.title}${i.status !== 'active' ? ` (now ${i.status})` : ''}`, true));
  }

  // waiting for the owner: proposed and not held, as of the end of the day
  const waiting = ctx.repos.listKnowledgeItems(ctx.db, { status: 'proposed', limit: 50 }).items.filter((i) => i.autonomy.outcome !== 'hold' && i.createdAt < end);
  const waitingCount = count(ctx, `SELECT count(*) AS c FROM knowledge_items WHERE status = 'proposed' AND json_extract(autonomy, '$.outcome') <> 'hold' AND created_at < ?`, end);
  const waitingLines = waiting.slice(0, 10).map((i) => itemLine(i, i.createdAt, `Waiting: ${i.title}`, false));

  // gaps (knowledge-research's table)
  const gaps: KnowledgeDigest['gaps'] = { opened: 0, filled: 0, open: 0, lines: [] };
  if (hasTable(ctx, 'knowledge_gaps')) {
    gaps.opened = count(ctx, `SELECT count(*) AS c FROM knowledge_gaps WHERE created_at >= ? AND created_at < ?`, start, end);
    gaps.filled = count(ctx, `SELECT count(*) AS c FROM knowledge_gaps WHERE status = 'answered' AND closed_at >= ? AND closed_at < ?`, start, end);
    gaps.open = count(ctx, `SELECT count(*) AS c FROM knowledge_gaps WHERE status IN ('open','researching','answered_pending','needs_owner')`);
    const rows = ctx.handle.sqlite
      .prepare(`SELECT id, question, status, created_at, closed_at FROM knowledge_gaps WHERE (created_at >= ? AND created_at < ?) OR (closed_at >= ? AND closed_at < ?) ORDER BY coalesce(closed_at, created_at) LIMIT 20`)
      .all(start, end, start, end) as Array<{ id: string; question: string; status: string; created_at: string; closed_at: string | null }>;
    gaps.lines = rows.map((g) => ({ at: g.closed_at ?? g.created_at, text: `${g.status === 'answered' ? 'Filled' : 'Gap'}: ${g.question.slice(0, 160)}`, badges: [], gapId: g.id, link: `/knowledge?tab=gaps&gap=${encodeURIComponent(g.id)}` }));
  }

  // sources (knowledge-research's table)
  const sources: KnowledgeDigest['sources'] = { fetched: 0, changed: 0, refused: 0 };
  if (hasTable(ctx, 'source_snapshots')) {
    sources.fetched = count(ctx, `SELECT count(*) AS c FROM source_snapshots WHERE fetched_at >= ? AND fetched_at < ?`, start, end);
    sources.changed = count(ctx, `SELECT count(*) AS c FROM source_snapshots WHERE changed = 1 AND fetched_at >= ? AND fetched_at < ?`, start, end);
  }
  sources.refused = count(ctx, `SELECT count(*) AS c FROM knowledge_changes WHERE action = 'knowledge.source.refused' AND at >= ? AND at < ?`, start, end);

  // research
  const research: KnowledgeDigest['research'] = {
    runs: count(ctx, `SELECT count(*) AS c FROM agent_runs WHERE job_type IN ('knowledge.research','knowledge.research_web') AND started_at >= ? AND started_at < ?`, start, end),
    proposals: count(ctx, `SELECT count(*) AS c FROM knowledge_changes c JOIN knowledge_items i ON i.id = c.item_id WHERE c.action = 'knowledge.item.propose' AND i.origin = 'researched' AND c.at >= ? AND c.at < ?`, start, end),
    ownerRejected: count(ctx, `SELECT count(*) AS c FROM knowledge_changes c JOIN knowledge_items i ON i.id = c.item_id WHERE c.action = 'knowledge.item.reject' AND i.origin = 'researched' AND c.actor <> 'system' AND c.actor NOT LIKE 'agent:%' AND c.at >= ? AND c.at < ?`, start, end),
  };

  // alarms (knowledge-use's table)
  const alarms: DigestLine[] = [];
  if (hasTable(ctx, 'knowledge_alarms')) {
    const rows = ctx.handle.sqlite.prepare(`SELECT id, metric, severity, status, raised_at FROM knowledge_alarms WHERE raised_at >= ? AND raised_at < ? ORDER BY raised_at LIMIT 20`).all(start, end) as Array<{ id: string; metric: string; severity: string; status: string; raised_at: string }>;
    for (const a of rows) alarms.push({ at: a.raised_at, text: `${a.severity === 'severe' ? 'Severe alarm' : 'Alarm'}: ${a.metric.replace(/_/g, ' ')} (${a.status})`, badges: [], link: `/knowledge?tab=safety&alarm=${encodeURIComponent(a.id)}` });
  }

  const publishedToday = ctx.repos
    .listKnowledgePackVersions(ctx.db)
    .filter((v) => v.createdAt >= start && v.createdAt < end)
    .map((v) => v.version)
    .sort((a, b) => a - b);

  const digest: Omit<KnowledgeDigest, 'headline'> = {
    day,
    learningEnabled: settings.learningEnabled,
    activeVersion: state.activeVersion,
    publishedToday,
    learnedAutomatically,
    waitingForYou: { count: waitingCount, lines: waitingLines },
    gaps,
    sources,
    research,
    alarms,
  };
  return { ...digest, headline: knowledgeHeadline(digest) };
}

/** Seven days ending `end` (inclusive). */
export function compileKnowledgeWeek(ctx: AppContext, end: string): { start: string; end: string; days: KnowledgeDigest[]; learnedAutomatically: number; waitingForYou: number; gapsFilled: number; headline: string } {
  const [y, m, d] = end.split('-').map(Number) as [number, number, number];
  const days: KnowledgeDigest[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    days.push(compileKnowledgeDigest(ctx, dt.toISOString().slice(0, 10)));
  }
  const learned = days.reduce((n, x) => n + x.learnedAutomatically.length, 0);
  const waiting = days[days.length - 1]?.waitingForYou.count ?? 0;
  const filled = days.reduce((n, x) => n + x.gaps.filled, 0);
  return {
    start: days[0]!.day,
    end,
    days,
    learnedAutomatically: learned,
    waitingForYou: waiting,
    gapsFilled: filled,
    headline: `This week: learned ${plural(learned, 'thing')} automatically, ${waiting} wait${waiting === 1 ? 's' : ''} for you, ${plural(filled, 'gap')} filled.`,
  };
}

/** The daily log's optional `knowledge` section (§9.4); absent before the migration or on any failure. */
export function knowledgeDailyLogSection(ctx: AppContext, day: string): { knowledge?: KnowledgeDigest } {
  try {
    if (!hasTable(ctx, 'knowledge_items')) return {};
    return { knowledge: compileKnowledgeDigest(ctx, day) };
  } catch (err) {
    ctx.logger.warn('knowledge digest failed', { error: String(err) });
    return {};
  }
}
