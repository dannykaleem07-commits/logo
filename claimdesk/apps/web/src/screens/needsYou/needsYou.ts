// owned by runtime
/**
 * Pure helpers for the Needs-you inbox (docs/SUPREME-DESIGN.md §L.2): grouping (Urgent / Today / Later), keyboard
 * navigation, choosing the renderer for an item, and defensive readers for the prepared payloads other slices store
 * (email preview, document, field diff, offer analysis). Unit-tested in needsYou.test.ts.
 */
import type { NeedsYouKind, NeedsYouOption } from '@ccguk/domain';
import type { NeedsYouItem } from '../../api/needsYouApi';

export interface NeedsYouGroups {
  urgent: NeedsYouItem[];
  today: NeedsYouItem[];
  later: NeedsYouItem[];
}

const londonDay = (iso: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** Urgent (priority urgent, or due already) · Today (high priority, created or due today) · Later (everything else). */
export function groupNeedsYou(items: readonly NeedsYouItem[], nowIso: string): NeedsYouGroups {
  const today = londonDay(nowIso);
  const now = Date.parse(nowIso);
  const out: NeedsYouGroups = { urgent: [], today: [], later: [] };
  for (const i of items) {
    const due = i.dueAt ? Date.parse(i.dueAt) : NaN;
    if (i.priority === 'urgent' || (Number.isFinite(due) && due <= now)) out.urgent.push(i);
    else if (i.priority === 'high' || (i.dueAt && londonDay(i.dueAt) === today) || londonDay(i.createdAt) === today) out.today.push(i);
    else out.later.push(i);
  }
  return out;
}

/** The flat order the list shows (and j/k walks). */
export function orderedNeedsYou(g: NeedsYouGroups): NeedsYouItem[] {
  return [...g.urgent, ...g.today, ...g.later];
}

export type InboxKey = 'next' | 'prev' | 'approve' | 'edit' | 'reject';

/** j/k/a/e/r → action (ignored while typing in a field or with a modifier). */
export function inboxKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target?: unknown }): InboxKey | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = t?.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return undefined;
  return ({ j: 'next', k: 'prev', a: 'approve', e: 'edit', r: 'reject' } as Record<string, InboxKey>)[e.key];
}

/** Move the selection by `delta` within `ids` (clamped; nothing selected → first). */
export function moveSelection(ids: readonly string[], current: string | undefined, delta: number): string | undefined {
  if (!ids.length) return undefined;
  const i = current ? ids.indexOf(current) : -1;
  if (i < 0) return ids[0];
  return ids[Math.min(Math.max(i + delta, 0), ids.length - 1)];
}

/** Default options when an item carries none. */
export const DEFAULT_OPTIONS: NeedsYouOption[] = [
  { id: 'acknowledge', label: 'Done', tone: 'primary' },
  { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
];

export function optionsOf(item: Pick<NeedsYouItem, 'options'>): NeedsYouOption[] {
  return item.options?.length ? item.options : DEFAULT_OPTIONS;
}

/** The option a key press means: a → the primary (not requiring edits), e → one requiring edits, r → the danger one. */
export function optionForKey(item: Pick<NeedsYouItem, 'options'>, key: 'approve' | 'edit' | 'reject'): NeedsYouOption | undefined {
  const opts = optionsOf(item);
  if (key === 'approve') return opts.find((o) => o.tone === 'primary' && !o.requiresEdit) ?? opts.find((o) => !o.requiresEdit && o.tone !== 'danger');
  if (key === 'edit') return opts.find((o) => o.requiresEdit);
  return opts.find((o) => o.tone === 'danger');
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export type RendererKind = 'email' | 'document' | 'fields' | 'offer' | 'generic';

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

export interface EmailPreview {
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  attachments: string[];
  outboxId?: string;
}

/** Read an email preview from `payload.email`, `payload.outbox`, `payload.draft` or the payload itself. */
export function emailPreview(payload: unknown): EmailPreview | undefined {
  const p = obj(payload);
  if (!p) return undefined;
  for (const src of [obj(p.email), obj(p.outbox), obj(p.draft), p]) {
    if (!src) continue;
    const subject = str(src.subject);
    const body = str(src.bodyText) ?? str(src.body_text) ?? str(src.body);
    if (subject === undefined && body === undefined) continue;
    const attachments = (Array.isArray(src.attachments) ? src.attachments : []).map((a) => (typeof a === 'string' ? a : (str(obj(a)?.filename) ?? str(obj(a)?.name) ?? str(obj(a)?.label) ?? 'attachment')));
    return { to: strList(src.to), cc: strList(src.cc), subject: subject ?? '(no subject)', bodyText: body ?? '', attachments, ...(str(src.id) ?? str(p.outboxId) ? { outboxId: (str(src.id) ?? str(p.outboxId))! } : {}) };
  }
  return undefined;
}

/** Document id from `payload.documentId` or a `draftRefs` entry of kind document. */
export function documentRef(payload: unknown): string | undefined {
  const p = obj(payload);
  if (!p) return undefined;
  const direct = str(p.documentId);
  if (direct) return direct;
  const refs = Array.isArray(p.draftRefs) ? p.draftRefs : [];
  for (const r of refs) {
    const o = obj(r);
    if (o && o.kind === 'document' && str(o.id)) return str(o.id);
  }
  return undefined;
}

export interface FieldDiffRow {
  key: string;
  label: string;
  current: string;
  proposed: string;
  confidence?: number;
  source?: string;
}

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Field diff rows from `payload.fields` / `payload.proposals` (intake's confirm_fields). */
export function fieldDiff(payload: unknown): FieldDiffRow[] {
  const p = obj(payload);
  const list = (p && (Array.isArray(p.fields) ? p.fields : Array.isArray(p.proposals) ? p.proposals : undefined)) ?? [];
  const out: FieldDiffRow[] = [];
  list.forEach((raw, i) => {
    const f = obj(raw);
    if (!f) return;
    const key = str(f.id) ?? str(f.target) ?? str(f.field) ?? String(i);
    const confidence = typeof f.confidence === 'number' ? f.confidence : undefined;
    const source = str(obj(f.source)?.quote) ?? str(f.source) ?? str(f.sourceLabel);
    out.push({ key, label: str(f.label) ?? str(f.target) ?? str(f.field) ?? key, current: show(f.current ?? f.before ?? f.existing), proposed: show(f.proposed ?? f.value ?? f.after), ...(confidence !== undefined ? { confidence } : {}), ...(source ? { source } : {}) });
  });
  return out;
}

export interface OfferRow {
  label: string;
  value: string;
}

const gbp = (pence: number): string => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);

/** Offer analysis rows from `payload.analysis` / `payload.offer` (casework's offer_decision). Keys ending in Pence are money. */
export function offerRows(payload: unknown): OfferRow[] {
  const p = obj(payload);
  if (!p) return [];
  const src = obj(p.analysis) ?? obj(p.offer) ?? undefined;
  if (!src) return [];
  const rows: OfferRow[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    const label = k.replace(/Pence$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    rows.push({ label, value: typeof v === 'number' && /Pence$/.test(k) ? gbp(v) : typeof v === 'number' && /confidence|probability|ratio/i.test(k) ? `${Math.round(v * 100)} %` : String(v) });
  }
  return rows;
}

/** Which renderer shows the prepared item. */
export function rendererFor(kind: NeedsYouKind, payload: unknown): RendererKind {
  if (kind === 'confirm_fields' && fieldDiff(payload).length) return 'fields';
  if (kind === 'offer_decision' && offerRows(payload).length) return 'offer';
  if ((kind === 'approve_send' || kind === 'missing_info' || kind === 'spoof_warning' || kind === 'which_claim') && emailPreview(payload)) return 'email';
  if (documentRef(payload)) return 'document';
  if (emailPreview(payload)) return 'email';
  if (fieldDiff(payload).length) return 'fields';
  return 'generic';
}

/** Initial edit text for "Edit then approve": the email body, the proposed field values, or the payload JSON. */
export function initialEdits(item: Pick<NeedsYouItem, 'kind' | 'payload'>): { mode: 'email' | 'fields' | 'json'; text: string; fields?: Record<string, string> } {
  const r = rendererFor(item.kind, item.payload);
  if (r === 'email') {
    const e = emailPreview(item.payload)!;
    return { mode: 'email', text: e.bodyText };
  }
  if (r === 'fields') {
    const fields: Record<string, string> = {};
    for (const f of fieldDiff(item.payload)) fields[f.key] = f.proposed === '—' ? '' : f.proposed;
    return { mode: 'fields', text: '', fields };
  }
  return { mode: 'json', text: JSON.stringify(item.payload ?? {}, null, 2) };
}

export const KIND_LABEL: Record<NeedsYouKind, string> = {
  approve_send: 'Approve email',
  approve_document: 'Approve document',
  missing_info: 'Missing information',
  confirm_fields: 'Confirm details',
  offer_decision: 'Offer decision',
  money: 'Payment',
  legal_review: 'Legal review',
  which_claim: 'Which claim?',
  new_claim: 'New claim?',
  override_needed: 'Override needed',
  question: 'Question',
  spoof_warning: 'Suspicious email',
  ai_paused: 'AI paused',
  setup: 'Setup',
  failure: 'Problem',
};

export const SNOOZE_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 24 * 60, label: 'Tomorrow' },
  { minutes: 7 * 24 * 60, label: 'Next week' },
];
