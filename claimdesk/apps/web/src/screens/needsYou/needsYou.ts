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
  /** Not ticked until the owner ticks it: personal details, below 90 % confidence, or from a document for another vehicle. */
  defaultOff?: true;
}

/** Rule ids that mean "check this one yourself" on an intake confirm card. */
const UNTICKED_RULES = ['intake_vehicle_mismatch', 'intake_vin_elsewhere'];

/** Is this row ticked (the owner's choice, else its default)? */
export function isTicked(row: Pick<FieldDiffRow, 'key' | 'defaultOff'>, ticked: Record<string, boolean>): boolean {
  return ticked[row.key] ?? !row.defaultOff;
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
    // intake's card: {id, target, label, currentValue, proposedValue, confidence, quote, page}
    const quote = str(obj(f.source)?.quote) ?? str(f.quote) ?? str(f.source) ?? str(f.sourceLabel);
    const page = typeof f.page === 'number' ? f.page : typeof obj(f.source)?.page === 'number' ? (obj(f.source)!.page as number) : undefined;
    const source = quote ? (page !== undefined ? `p.${page}: ${quote}` : quote) : page !== undefined ? `page ${page}` : undefined;
    const ruleIds = Array.isArray(f.ruleIds) ? f.ruleIds.filter((x): x is string => typeof x === 'string') : [];
    const defaultOff = f.sensitive === true || (confidence !== undefined && confidence < 0.9) || ruleIds.some((r) => UNTICKED_RULES.includes(r));
    out.push({
      key,
      label: str(f.label) ?? str(f.target) ?? str(f.field) ?? key,
      current: show(f.currentValue ?? f.current ?? f.before ?? f.existing),
      proposed: show(f.proposedValue ?? f.proposed ?? f.value ?? f.after),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(source ? { source } : {}),
      ...(defaultOff ? { defaultOff: true as const } : {}),
    });
  });
  return out;
}

/** Warnings a confirm card carries (values from the document that were refused, e.g. another vehicle's registration). */
export function cardWarnings(payload: unknown): string[] {
  return strList(obj(payload)?.warnings);
}

export interface OfferRow {
  label: string;
  value: string;
}

const gbp = (pence: number): string => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);

/** "12 Oct 2026, 15:58" in Europe/London (the raw ISO string when it does not parse). */
export function londonDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Offer analysis rows. casework's offer_decision card carries the offer at the top level (`head`, `amountPence`,
 * `perDay`, `recommended`, `figures[{label, pence}]`, `settlement{acceptNowPence, fightOnPence, walkAwayPence}`,
 * `gtaBenchmark{group, dailyRatePence}`, `assumptions.note`); the recorded-offer card has `head`/`amountPence`/`from`.
 * An older shape nests the figures in `payload.analysis` / `payload.offer` (keys ending in Pence are money).
 */
export function offerRows(payload: unknown): OfferRow[] {
  const p = obj(payload);
  if (!p) return [];
  if (str(p.head) || num(p.amountPence) !== undefined || Array.isArray(p.figures)) {
    const rows: OfferRow[] = [];
    const amount = num(p.amountPence);
    if (str(p.from)) rows.push({ label: 'From', value: str(p.from)! });
    if (str(p.head)) rows.push({ label: 'Head', value: str(p.head)! });
    const figureLabels = (Array.isArray(p.figures) ? p.figures : []).map((f) => str(obj(f)?.label) ?? '');
    const inFigures = (re: RegExp): boolean => figureLabels.some((l) => re.test(l));
    // The code-computed figures table is the source when present; the top-level fields only fill what it lacks.
    if (!inFigures(/^Offer/)) rows.push({ label: 'Offer', value: amount !== undefined ? `${gbp(amount)}${p.perDay === true ? ' a day' : ''}` : 'amount not stated' });
    const rec = obj(p.recommended);
    if (rec && str(rec.action)) {
      const counter = num(rec.counterPence);
      const conf = num(rec.confidence);
      rows.push({ label: 'Recommended', value: `${str(rec.action)}${counter !== undefined ? ` at ${gbp(counter)}` : ''}${conf !== undefined ? ` (confidence ${Math.round(conf * 100)} %)` : ''}` });
    }
    for (const raw of Array.isArray(p.figures) ? p.figures : []) {
      const f = obj(raw);
      const label = str(f?.label);
      if (!f || !label) continue;
      const pence = num(f.pence);
      rows.push({ label, value: pence !== undefined ? gbp(pence) : '—' });
    }
    const st = inFigures(/^(Accept now|Fight on|Walk-away)/) ? undefined : obj(p.settlement);
    if (st) {
      for (const [k, label] of [['acceptNowPence', 'Accept now (net)'], ['fightOnPence', 'Fight on (expected, net)'], ['walkAwayPence', 'Walk-away figure']] as const) {
        const v = num(st[k]);
        if (v !== undefined) rows.push({ label, value: gbp(v) });
      }
    }
    const gta = obj(p.gtaBenchmark);
    if (gta && num(gta.dailyRatePence) !== undefined && !inFigures(/^GTA benchmark/)) rows.push({ label: `GTA benchmark${str(gta.group) ? ` (group ${str(gta.group)})` : ''}`, value: `${gbp(num(gta.dailyRatePence)!)} a day — a benchmark only` });
    const note = str(obj(p.assumptions)?.note);
    if (note) rows.push({ label: 'Assumptions', value: note });
    if (str(p.replyDueAt)) rows.push({ label: 'Written reply due', value: londonDateTime(str(p.replyDueAt)!) });
    return rows;
  }
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

/** An in-app link a card carries (`payload.link`, e.g. the ledger form for a money card or Settings > AI). */
export function payloadLink(payload: unknown): string | undefined {
  const l = str(obj(payload)?.link);
  return l && l.startsWith('/') && !l.startsWith('//') ? l : undefined;
}

/** The edits a confirm_fields resolver expects: the ticked proposal ids and the values the owner changed. */
export function confirmFieldEdits(payload: unknown, ticked: Record<string, boolean>, values: Record<string, string>): { apply: string[]; values?: Record<string, string> } {
  const rows = fieldDiff(payload);
  const apply = rows.filter((r) => isTicked(r, ticked)).map((r) => r.key);
  const changed: Record<string, string> = {};
  for (const r of rows) {
    const v = values[r.key];
    if (v !== undefined && v.trim() && v !== (r.proposed === '—' ? '' : r.proposed)) changed[r.key] = v.trim();
  }
  return { apply, ...(Object.keys(changed).length ? { values: changed } : {}) };
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

/**
 * Can the owner edit this item before approving it? Only a prepared email or field values are editable; other items
 * (questions, suspicious-email warnings, offers, new claims) take a note instead of edits.
 */
export function canEditThenApprove(item: Pick<NeedsYouItem, 'kind' | 'payload'>): boolean {
  return ['approve_send', 'approve_document', 'missing_info', 'confirm_fields'].includes(item.kind) && initialEdits(item).mode !== 'json';
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
  // Autopilot (SUPREME-AUTOPILOT §H.3)
  choose_car: 'Choose a car',
  approve_pack: 'Approve paperwork',
  confirm_signed: 'Confirm signed',
  clash_review: 'Booking clash',
  eligibility_review: 'Eligibility review',
  autopilot_step: 'Autopilot step',
  knowledge_review: 'Knowledge to check',
};

export const SNOOZE_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 24 * 60, label: 'Tomorrow' },
  { minutes: 7 * 24 * 60, label: 'Next week' },
];
