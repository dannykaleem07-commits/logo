// owned by knowledge-ui
/**
 * Pure helpers for the Knowledge screen (docs/SUPREME-KNOWLEDGE-BUILDER.md §11): tabs in the URL, badge text and tone
 * (text badges, no emoji), labels, provenance chips, quote highlighting against a stored source copy, word diffs, the
 * settings rows of the Safety tab, local snooze for the Approve tab and the CSV export of the knowledge audit history.
 * Unit-tested in knowledgeView.test.ts.
 */
import {
  BADGE_LABEL,
  tokenDiff,
  type DigestLine,
  type GapKind,
  type GapStatus,
  type KnowledgeArea,
  type KnowledgeBadge,
  type KnowledgeChange,
  type KnowledgeConflict,
  type KnowledgeItemView,
  type KnowledgeKind,
  type KnowledgeProvenance,
  type KnowledgeReviewPayload,
  type KnowledgeScope,
  type KnowledgeSettings,
  type KnowledgeStatus,
  type KnowledgeVersionDiff,
  type KnowledgeWeekDigest,
} from '@ccguk/domain';
import type { Tone } from '../../lib/status';

// ---------------------------------------------------------------------------
// Tabs (the URL keeps the tab: /knowledge?tab=approve)
// ---------------------------------------------------------------------------

export const KNOWLEDGE_TABS = [
  { id: 'week', label: 'This week' },
  { id: 'approve', label: 'Approve' },
  { id: 'gaps', label: 'Gaps' },
  { id: 'insurers', label: 'Insurers' },
  { id: 'library', label: 'Library' },
  { id: 'sources', label: 'Sources' },
  { id: 'versions', label: 'Versions' },
  { id: 'safety', label: 'Safety' },
] as const;
export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number]['id'];

export function parseTab(value: string | null | undefined): KnowledgeTab {
  return (KNOWLEDGE_TABS.find((t) => t.id === value)?.id ?? 'week') as KnowledgeTab;
}

/** `/knowledge?tab=…&…` (other keys dropped unless given). */
export function knowledgeHref(tab: KnowledgeTab, extra: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return `/knowledge?${p.toString()}`;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export const BADGE_TONE: Readonly<Record<KnowledgeBadge, Tone>> = {
  source_verified: 'green',
  owner_confirmed: 'green',
  unverified: 'amber',
  computed: 'blue',
  benchmark_only: 'navy',
  stale: 'amber',
  source_changed: 'amber',
  conflicted: 'red',
  external: 'grey',
};

/** Badge text (§11): COMPUTED carries its sample size, e.g. `COMPUTED n=14`. */
export function badgeText(b: KnowledgeBadge, supportN?: number | null): string {
  if (b === 'computed' && typeof supportN === 'number' && supportN > 0) return `COMPUTED n=${supportN}`;
  return BADGE_LABEL[b] ?? String(b).toUpperCase();
}

const BADGE_HINT: Readonly<Record<KnowledgeBadge, string>> = {
  source_verified: 'You checked it against the stored copy of an official source.',
  owner_confirmed: 'You confirmed it.',
  unverified: 'Nobody has checked it yet. Agents may reason with it; legal and quantum points never reach a letter until checked.',
  computed: 'Worked out by code from your own claims. Internal only: never stated in a letter.',
  benchmark_only: 'GTA rates are a benchmark only, never law.',
  stale: 'Older than its review date, or past its end date.',
  source_changed: 'The source page changed since it was checked.',
  conflicted: 'It disagrees with something else ClaimDesk knows. Resolve the conflict in Approve.',
  external: 'Comes from an outside web page.',
};
export const badgeHint = (b: KnowledgeBadge): string => BADGE_HINT[b] ?? '';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const KIND_LABEL: Readonly<Record<KnowledgeKind, string>> = {
  fact: 'Fact',
  rule: 'Rule',
  strategy: 'Strategy',
  contact: 'Contact',
  insurer_profile: 'Insurer statistics',
  template_snippet: 'Wording',
  engineering_figure: 'Engineering figure',
  precedent: 'Legal precedent',
  procedure: 'Procedure',
};
export const AREA_LABEL: Readonly<Record<KnowledgeArea, string>> = {
  legal: 'Legal',
  quantum: 'Quantum',
  procedural: 'Procedure',
  contact: 'Contacts',
  statistics: 'Statistics',
  style: 'Style',
  engineering: 'Engineering',
  strategy: 'Strategy',
};
export const STATUS_LABEL: Readonly<Record<KnowledgeStatus, string>> = {
  proposed: 'Waiting for you',
  active: 'In use',
  rejected: 'Rejected',
  superseded: 'Replaced',
  retired: 'Retired',
  quarantined: 'Quarantined',
};
export const STATUS_TONE: Readonly<Record<KnowledgeStatus, Tone>> = { proposed: 'amber', active: 'green', rejected: 'grey', superseded: 'grey', retired: 'grey', quarantined: 'red' };

export const GAP_KIND_LABEL: Readonly<Record<GapKind, string>> = {
  insurer_process: 'Insurer process',
  legal_point: 'Legal point',
  quantum_point: 'Quantum point',
  missing_contact: 'Missing contact',
  unfamiliar_document: 'Unfamiliar document',
  procedure: 'Procedure',
  engineering: 'Engineering',
  kb_verification: 'KB check',
  other: 'Other',
};
export const GAP_STATUS_LABEL: Readonly<Record<GapStatus, string>> = {
  open: 'Open',
  researching: 'Researching',
  answered_pending: 'Answer waits for you',
  answered: 'Answered',
  needs_owner: 'Needs you',
  no_answer: 'No answer found',
  out_of_scope: 'Out of scope',
  dismissed: 'Dismissed',
};
export const GAP_STATUS_TONE: Readonly<Record<GapStatus, Tone>> = {
  open: 'blue',
  researching: 'blue',
  answered_pending: 'amber',
  answered: 'green',
  needs_owner: 'amber',
  no_answer: 'grey',
  out_of_scope: 'grey',
  dismissed: 'grey',
};

export function scopeLabel(scope: KnowledgeScope | null | undefined): string {
  if (!scope || scope.kind === 'global') return 'All claims';
  if (scope.kind === 'insurer') return `Insurer: ${scope.slug}`;
  return `Claim type: ${scope.tag.replace(/_/g, ' ')}`;
}

export const humanise = (s: string): string => s.replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Provenance, quotes, snapshots
// ---------------------------------------------------------------------------

export interface ProvenanceChip {
  label: string;
  title: string;
  href?: string;
  snapshotId?: string;
}

/** One chip per provenance entry (claims never named: only counts and ids). */
export function provenanceChips(provenance: readonly KnowledgeProvenance[]): ProvenanceChip[] {
  return provenance.map((p): ProvenanceChip => {
    switch (p.kind) {
      case 'claim_stats':
        return { label: `${p.n} claims`, title: `Computed from ${p.n} of your claims (${p.method})` };
      case 'email':
        return { label: `Email from ${p.fromDomain}`, title: `DMARC ${p.dmarc} · seen ${p.observedAt}` };
      case 'document':
        return { label: p.page !== null ? `Document p.${p.page}` : 'Document', title: p.quote ? `“${p.quote}”` : 'From a document on file' };
      case 'correction':
        return { label: `${p.correctionIds.length} of your edits`, title: 'Learned from changes you made to drafts' };
      case 'snapshot':
        return { label: `Source: ${hostOf(p.url)}`, title: `${p.url} · fetched ${p.fetchedAt} · quote ${p.quoteMatch}`, href: p.url, snapshotId: p.snapshotId };
      case 'url':
        return { label: `Web: ${hostOf(p.url)}`, title: `${p.url} · not stored yet: cannot be approved until a copy is kept`, href: p.url };
      case 'kb':
        return { label: `KB ${p.entryId}`, title: 'Knowledge base entry' };
      case 'pack':
        return { label: `Pack ${p.packId}`, title: `${p.packId} v${p.version} · ${p.entryId}` };
      case 'owner':
        return { label: 'You', title: p.note ? `Your note: ${p.note}` : 'Added by you' };
      case 'engineering':
        return { label: `${p.n} ${p.source.replace(/_/g, ' ')}s`, title: 'Engineer-confirmed figures' };
      default:
        return { label: 'Source', title: '' };
    }
  });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Approve as source-verified is enabled only when every stored quote was found exactly in our own copy (§11). */
export function allQuotesMatched(item: Pick<KnowledgeItemView, 'provenance'>): boolean {
  const snaps = item.provenance.filter((p) => p.kind === 'snapshot');
  return snaps.length > 0 && snaps.every((p) => p.kind === 'snapshot' && p.quoteMatch === 'exact');
}

export function firstSnapshot(item: Pick<KnowledgeItemView, 'provenance'>): { snapshotId: string; url: string; quote: string } | null {
  const s = item.provenance.find((p) => p.kind === 'snapshot');
  return s && s.kind === 'snapshot' ? { snapshotId: s.snapshotId, url: s.url, quote: s.quote } : null;
}

export interface Segment {
  text: string;
  hit: boolean;
}

/**
 * Split `text` so the quote is marked: an exact match first, then a whitespace- and case-insensitive one. Returns a
 * single unmarked segment when the quote is not there (the screen then says so).
 */
export function highlightQuote(text: string, quote: string | null | undefined): { segments: Segment[]; found: boolean } {
  const q = (quote ?? '').trim();
  if (!q || !text) return { segments: [{ text, hit: false }], found: false };
  let start = text.indexOf(q);
  let end = start + q.length;
  if (start < 0) {
    const words = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const m = new RegExp(words.join('\\s+'), 'i').exec(text);
    if (!m) return { segments: [{ text, hit: false }], found: false };
    start = m.index;
    end = m.index + m[0].length;
  }
  const segments: Segment[] = [];
  if (start > 0) segments.push({ text: text.slice(0, start), hit: false });
  segments.push({ text: text.slice(start, end), hit: true });
  if (end < text.length) segments.push({ text: text.slice(end), hit: false });
  return { segments, found: true };
}

/** A window of the source text around the quote, so a long page shows the relevant part first. */
export function aroundQuote(text: string, quote: string | null | undefined, radius = 600): string {
  const r = highlightQuote(text, quote);
  if (!r.found) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const before = r.segments[0]?.hit ? '' : r.segments[0]!.text;
  const hitIdx = r.segments.findIndex((s) => s.hit);
  const hit = r.segments[hitIdx]!.text;
  const after = r.segments[hitIdx + 1]?.text ?? '';
  return `${before.length > radius ? `…${before.slice(-radius)}` : before}${hit}${after.length > radius ? `${after.slice(0, radius)}…` : after}`;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export type DiffPiece = { op: 'eq' | 'ins' | 'del'; text: string };

/** Word diff (domain tokenDiff); identical texts give one `eq` piece. */
export function wordDiff(before: string, after: string): DiffPiece[] {
  if (before === after) return before ? [{ op: 'eq', text: before }] : [];
  return tokenDiff(before, after);
}

/** The current active version of the same item key (what a proposal would replace), if any. */
export function currentVersionOf(item: Pick<KnowledgeItemView, 'id' | 'supersedesId'>, versions: readonly KnowledgeItemView[]): KnowledgeItemView | null {
  return versions.find((v) => v.id !== item.id && v.status === 'active') ?? (item.supersedesId ? (versions.find((v) => v.id === item.supersedesId) ?? null) : null);
}

/** Short summary of a learned-pack diff: `+3 −1 ~2`. */
export function diffCounts(d: Partial<KnowledgeVersionDiff> | null | undefined): string {
  const a = d?.added?.length ?? 0;
  const r = d?.removed?.length ?? 0;
  const c = d?.changed?.length ?? 0;
  return `+${a} −${r} ~${c}`;
}

// ---------------------------------------------------------------------------
// Item data as readable rows
// ---------------------------------------------------------------------------

export interface DataRow {
  label: string;
  value: string;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
};

const DATA_LABEL: Record<string, string> = {
  insurerSlug: 'Insurer',
  team: 'Team',
  name: 'Name',
  role: 'Role',
  phone: 'Phone',
  phoneKind: 'Phone type',
  email: 'Email',
  ivr: 'Phone menu path',
  hours: 'Hours',
  observations: 'Seen in emails',
  independentThreads: 'Separate threads',
  lastSeenAt: 'Last seen',
  statement: 'Statement',
  benchmarkOnly: 'Benchmark only',
  steps: 'Steps',
  forWhom: 'For',
  channel: 'Channel',
  why: 'Why',
  severity: 'Severity',
  then: 'Effect',
  when: 'When',
  citation: 'Citation',
  neutralCitation: 'Neutral citation',
  court: 'Court',
  year: 'Year',
  principle: 'Principle',
  url: 'Link',
  licence: 'Licence',
  purpose: 'Purpose',
  text: 'Wording',
  situation: 'Situation',
  goal: 'Goal',
  leverage: 'Leverage',
  counterArguments: 'Counter-arguments',
  evidenceNeeded: 'Evidence needed',
  appliesTo: 'Applies to',
  panel: 'Panel',
  operation: 'Operation',
  metric: 'Measure',
  median: 'Median',
  n: 'Sample size',
};

const SKIP_DATA = new Set(['stat', 'kbCheck', 'figure', 'asOf', 'tokens', 'heads', 'objections', 'docsRequested', 'gta', 'responseHours', 'chasersBeforePay', 'daysToPay', 'minN', 'computedAt', 'window']);

/** Readable rows of an item's kind-specific data (unknown and nested statistics fields are skipped). */
export function dataRows(data: unknown): DataRow[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out: DataRow[] = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (SKIP_DATA.has(k) || v === null || v === undefined || v === '') continue;
    const value = k === 'then' && Array.isArray(v) ? v.map((e) => (e && typeof e === 'object' ? humanise(String((e as Record<string, unknown>).kind ?? '')) + describeEffect(e as Record<string, unknown>) : String(e))).join('; ') : show(v);
    out.push({ label: DATA_LABEL[k] ?? humanise(k).replace(/^./, (c) => c.toUpperCase()), value });
  }
  return out;
}

function describeEffect(e: Record<string, unknown>): string {
  const bits = ['doc', 'beforeStep', 'reason', 'message', 'phrase', 'actionCode', 'note', 'afterWorkingDays'].filter((k) => e[k] !== undefined && e[k] !== null).map((k) => String(e[k]));
  return bits.length ? `: ${bits.join(' · ')}` : '';
}

// ---------------------------------------------------------------------------
// This week
// ---------------------------------------------------------------------------

/** Learned-automatically lines of the week, newest first. */
export function weekLearned(week: Pick<KnowledgeWeekDigest, 'days'> | null | undefined): DigestLine[] {
  return (week?.days ?? []).flatMap((d) => d.learnedAutomatically).sort((a, b) => b.at.localeCompare(a.at));
}

export function weekTotals(week: Pick<KnowledgeWeekDigest, 'days'> | null | undefined): { gapsOpened: number; gapsFilled: number; fetched: number; changed: number; refused: number; researchRuns: number; proposals: number; alarms: DigestLine[] } {
  const days = week?.days ?? [];
  return {
    gapsOpened: days.reduce((n, d) => n + d.gaps.opened, 0),
    gapsFilled: days.reduce((n, d) => n + d.gaps.filled, 0),
    fetched: days.reduce((n, d) => n + d.sources.fetched, 0),
    changed: days.reduce((n, d) => n + d.sources.changed, 0),
    refused: days.reduce((n, d) => n + d.sources.refused, 0),
    researchRuns: days.reduce((n, d) => n + d.research.runs, 0),
    proposals: days.reduce((n, d) => n + d.research.proposals, 0),
    alarms: days.flatMap((d) => d.alarms),
  };
}

/** The item id an Undo line retires: its `itemId`, else the id inside the `undoRoute`. */
export function undoItemId(line: Pick<DigestLine, 'itemId' | 'undoRoute'>): string | undefined {
  if (line.itemId) return line.itemId;
  const m = /\/knowledge\/items\/([^/]+)\/retire$/.exec(line.undoRoute ?? '');
  return m ? decodeURIComponent(m[1]!) : undefined;
}

/** In-app link of a digest line (only `/…` paths; an API path never becomes a link). */
export function safeLink(link: string | undefined): string | undefined {
  return link && link.startsWith('/') && !link.startsWith('//') && !link.startsWith('/api/') ? link : undefined;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export const CONFLICT_KIND_LABEL: Readonly<Record<KnowledgeConflict['kind'], string>> = {
  contradicts: 'Contradicts',
  duplicate: 'Duplicate',
  directory_mismatch: 'Differs from the insurer directory',
  red_line: 'Against your red lines',
  perimeter: 'Would loosen a safety limit',
  kb_contradiction: 'Contradicts the knowledge base',
  stats_vs_note: 'Statistics disagree with a note',
};

export const conflictTone = (c: Pick<KnowledgeConflict, 'kind'>): Tone => (c.kind === 'red_line' || c.kind === 'perimeter' ? 'red' : 'amber');

/** `ki:<id>` → the item id; any other ref (kb:, pack:, directory) → null. */
export function itemIdOfRef(ref: string): string | null {
  return ref.startsWith('ki:') ? ref.slice(3) : null;
}

// ---------------------------------------------------------------------------
// Needs-you knowledge_review payloads (§9.3)
// ---------------------------------------------------------------------------

/** Read a `knowledge_review` payload defensively (unknown shapes give undefined). */
export function reviewPayload(payload: unknown): KnowledgeReviewPayload | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  if (p.variant === 'items' && Array.isArray(p.itemIds)) return { variant: 'items', groupTitle: String(p.groupTitle ?? ''), itemIds: p.itemIds.filter((x): x is string => typeof x === 'string'), replayRunId: typeof p.replayRunId === 'string' ? p.replayRunId : null };
  if (p.variant === 'conflict' && typeof p.conflictId === 'string') return { variant: 'conflict', conflictId: p.conflictId };
  if (p.variant === 'alarm' && typeof p.alarmId === 'string') return { variant: 'alarm', alarmId: p.alarmId, suggestedRollbackTo: typeof p.suggestedRollbackTo === 'number' ? p.suggestedRollbackTo : null };
  if (p.variant === 'gap' && typeof p.gapId === 'string')
    return {
      variant: 'gap',
      gapId: p.gapId,
      question: String(p.question ?? ''),
      preparedItemId: typeof p.preparedItemId === 'string' ? p.preparedItemId : null,
      looked: Array.isArray(p.looked) ? p.looked.filter((l): l is { domain: string; url: string | null } => Boolean(l && typeof l === 'object' && typeof (l as { domain?: unknown }).domain === 'string')) : [],
    };
  return undefined;
}

/** Edits the `items` resolver expects for Edit then approve: `{itemId, title, body, data, scope}`. */
export function editApproveEdits(item: Pick<KnowledgeItemView, 'id' | 'scope'>, form: { title: string; body: string; dataJson: string }): { ok: true; edits: { itemId: string; title: string; body: string; data: Record<string, unknown>; scope: KnowledgeScope } } | { ok: false; error: string } {
  if (!form.title.trim()) return { ok: false, error: 'Give it a title.' };
  let data: unknown;
  try {
    data = JSON.parse(form.dataJson || '{}');
  } catch {
    return { ok: false, error: 'The details are not valid JSON.' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'The details must be a JSON object.' };
  return { ok: true, edits: { itemId: item.id, title: form.title.trim(), body: form.body, data: data as Record<string, unknown>, scope: item.scope } };
}

// ---------------------------------------------------------------------------
// Safety tab
// ---------------------------------------------------------------------------

export const AUTO_APPLY_LABEL: Readonly<Record<keyof KnowledgeSettings['autoApply'], string>> = {
  statistics: 'Insurer statistics and letter effectiveness (internal only)',
  contacts: 'Handler contacts seen in two or more genuine emails',
  procedures: 'Low-risk procedural notes (portal quirks, phone menus, form steps)',
  engineering: 'Engineer-confirmed figures (suggestions only)',
  snippets: 'Wording from your own letters',
  curatedStyle: 'Style you repeated three or more times',
};

/** Categories that always wait for you (or are refused): shown disabled with the reason (§9.2). */
export const ALWAYS_QUEUE: ReadonlyArray<{ label: string; reason: string }> = [
  { label: 'Rules and strategies', reason: 'Always wait for you, with a replay result attached.' },
  { label: 'Legal points, precedents and quantum points', reason: 'Always wait; reach a letter only after you confirm or source-verify them.' },
  { label: 'Anything that conflicts with the knowledge base, your red lines or the directory', reason: 'Always waits as a high-priority conflict.' },
  { label: 'Anything that would loosen a safety limit, offers, money or human-only steps', reason: 'Refused automatically and logged.' },
  { label: 'Verification upgrades', reason: 'Only you can confirm or source-verify; the database enforces it.' },
  { label: 'Web-research findings', reason: 'Always wait; quotes are re-checked against our own stored copy.' },
  { label: 'Offers', reason: 'Always ask: knowledge only informs the analysis.' },
];

export interface NumberSetting {
  group: 'thresholds' | 'budgets' | 'replay' | 'drift';
  key: string;
  label: string;
  step?: number;
  min?: number;
  max?: number;
}

export const NUMBER_SETTINGS: readonly NumberSetting[] = [
  { group: 'thresholds', key: 'autoApplyConfidence', label: 'Confidence needed to apply automatically', step: 0.05, min: 0.5, max: 1 },
  { group: 'thresholds', key: 'contactObservations', label: 'Emails before a contact is learned', min: 2, max: 20 },
  { group: 'thresholds', key: 'engineeringMinN', label: 'Engineer figures needed (n)', min: 3, max: 1000 },
  { group: 'thresholds', key: 'statsMinN', label: 'Claims before statistics show (n)', min: 3, max: 1000 },
  { group: 'thresholds', key: 'styleSupport', label: 'Repeats before style is learned', min: 3, max: 100 },
  { group: 'budgets', key: 'researchRunsPerDay', label: 'Research runs a day', min: 0, max: 50 },
  { group: 'budgets', key: 'curateRunsPerDay', label: 'Curator runs a day', min: 0, max: 20 },
  { group: 'budgets', key: 'webRunsPerDay', label: 'Web research runs a day', min: 0, max: 10 },
  { group: 'budgets', key: 'replayDraftsPerWeek', label: 'Replay draft runs a week', min: 0, max: 7 },
  { group: 'budgets', key: 'fetchesPerDay', label: 'Source fetches a day', min: 0, max: 2000 },
  { group: 'budgets', key: 'perDomainPerMinute', label: 'Fetches per site per minute', min: 1, max: 60 },
  { group: 'budgets', key: 'gapMaxAttempts', label: 'Research attempts per gap', min: 1, max: 10 },
  { group: 'budgets', key: 'apiUsdPerDay', label: 'API spend a day (US$)', step: 0.5, min: 0, max: 50 },
  { group: 'replay', key: 'worseTolerancePct', label: 'Replay: tolerance before "worse" (%)', min: 0, max: 50 },
  { group: 'replay', key: 'minCases', label: 'Replay: minimum past cases', min: 3, max: 1000 },
  { group: 'drift', key: 'windowDays', label: 'Drift: window (days)', min: 3, max: 90 },
  { group: 'drift', key: 'baselineDays', label: 'Drift: baseline (days)', min: 7, max: 365 },
  { group: 'drift', key: 'minN', label: 'Drift: minimum sample', min: 3, max: 1000 },
  { group: 'drift', key: 'dropPctPoints', label: 'Drift: alarm on a drop of (points)', min: 1, max: 100 },
];

export function readNumberSetting(s: KnowledgeSettings, n: NumberSetting): number {
  const g = s[n.group] as unknown as Record<string, number>;
  return Number(g?.[n.key] ?? 0);
}

// ---------------------------------------------------------------------------
// Approve tab: local snooze (a per-viewer convenience; the queue itself is server state)
// ---------------------------------------------------------------------------

const SNOOZE_KEY = 'claimdesk.knowledge.snoozed';

export function loadSnoozed(now: number = Date.now()): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(SNOOZE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    return Object.fromEntries(Object.entries(parsed).filter(([, until]) => typeof until === 'number' && until > now));
  } catch {
    return {};
  }
}

export function saveSnoozed(map: Record<string, number>): void {
  try {
    globalThis.localStorage?.setItem(SNOOZE_KEY, JSON.stringify(map));
  } catch {
    /* storage blocked: the snooze lasts for this visit only */
  }
}

// ---------------------------------------------------------------------------
// Audit export
// ---------------------------------------------------------------------------

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** CSV of knowledge changes (formula-safe). */
export function changesCsv(changes: readonly KnowledgeChange[]): string {
  const head = ['at', 'actor', 'action', 'itemKey', 'itemId', 'gapId', 'packVersion', 'reason', 'ruleIds', 'runId', 'jobId', 'needsYouId'];
  const rows = changes.map((c) => [c.at, c.actor, c.action, c.itemKey, c.itemId, c.gapId, c.packVersion, c.reason, c.ruleIds.join(' '), c.runId, c.jobId, c.needsYouId].map(csvCell).join(','));
  return [head.join(','), ...rows].join('\r\n');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const pct = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)} %` : '—');
export const num1 = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : '—');

export function londonToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function whenText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
}

/** Actor text: `agent:researcher` → `researcher`, `system` → `ClaimDesk`. */
export function actorText(actor: string | null | undefined): string {
  if (!actor) return '—';
  if (actor === 'system') return 'ClaimDesk';
  return actor.replace(/^agent:/, '');
}

// ---------------------------------------------------------------------------
// Gaps: the owner's answer as an item (mirrors research's ownerAnswerItem)
// ---------------------------------------------------------------------------

/** The owner item an answer to a gap becomes: a procedure for process gaps, otherwise a fact in the gap's area. */
export function gapAnswerItem(gap: { kind: GapKind; question: string; scope: KnowledgeScope }, answer: string, title?: string): { kind: KnowledgeKind; area: KnowledgeArea; title: string; body: string; data: Record<string, unknown>; scope: KnowledgeScope } {
  const t = (title?.trim() || gap.question).slice(0, 200);
  const insurerSlug = gap.scope.kind === 'insurer' ? gap.scope.slug : null;
  if (gap.kind === 'insurer_process' || gap.kind === 'procedure') {
    const steps = answer
      .split(/\n+/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 30);
    return { kind: 'procedure', area: 'procedural', title: t, body: answer, data: { steps: steps.length ? steps : [answer.slice(0, 500)], forWhom: insurerSlug ? 'insurer' : 'other', channel: null, insurerSlug }, scope: gap.scope };
  }
  const area: KnowledgeArea = gap.kind === 'legal_point' || gap.kind === 'kb_verification' ? 'legal' : gap.kind === 'quantum_point' ? 'quantum' : gap.kind === 'engineering' ? 'engineering' : 'procedural';
  return { kind: 'fact', area, title: t, body: answer, data: { statement: answer.slice(0, 2000), figure: null, asOf: null, benchmarkOnly: false, kbCheck: null, stat: null }, scope: gap.scope };
}

export const GAP_KINDS_FOR_FORM: { value: GapKind; label: string }[] = (Object.keys(GAP_KIND_LABEL) as GapKind[]).map((k) => ({ value: k, label: GAP_KIND_LABEL[k] }));
