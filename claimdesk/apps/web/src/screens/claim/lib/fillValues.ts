/**
 * "Fill a CCGUK template" — pure state and helpers for the values step (docs/TEMPLATES-VEHICLES-DESKTOP.md §B.9, §C.9).
 *
 * The API plans every blank of the Word template (`PlanRow`). The handler may type into editable rows, tick
 * "confirm" on suggested rows, and nothing else: signature boxes stay blank and printed wording stays as printed.
 * Generation sends only what the handler changed or entered, plus the confirmed suggestions.
 *
 * Inputs are normalised to the API's raw shapes: dates `YYYY-MM-DD`, date-times ISO 8601, money integer pence,
 * choices arrays of option values, rows arrays of column records, paragraphs arrays of strings, null = leave blank.
 */
import type { ClaimBundle } from '@ccguk/domain';
import { poundsTextToPence } from '../../../lib/money';
import { cleanSubject, type ClaimTemplateValues, type DocxSubject, type DocxTemplateSummary, type FillPlanIssue, type GenerateDocxBody, type PlanOrigin, type PlanRow, type SlotInput, type SubjectKind } from '../../../api/templatesApi';

/** Shown on every values row that carries a GTA figure (§B.5 rule 8). */
export const GTA_BENCHMARK_CAVEAT = 'GTA rates are an industry benchmark only. Courtesy Cars Group UK Ltd is not a GTA subscriber.';

// ---------------------------------------------------------------------------
// Rows and groups
// ---------------------------------------------------------------------------

export interface RowGroup {
  section: string;
  title: string;
  rows: PlanRow[];
}

/** Rows grouped by section in the order the sections first appear (the API's plan order is document order). */
export function groupRows(rows: PlanRow[]): RowGroup[] {
  const map = new Map<string, RowGroup>();
  for (const row of rows) {
    const g = map.get(row.section);
    if (g) g.rows.push(row);
    else map.set(row.section, { section: row.section, title: row.sectionTitle || row.section || 'Document', rows: [row] });
  }
  return [...map.values()];
}

/** All rows of a values response, in order (accepts a response with `groups` or a bare `rows` list). */
export function rowsOf(values: Pick<ClaimTemplateValues, 'groups'> | { rows?: PlanRow[] } | undefined): PlanRow[] {
  if (!values) return [];
  const v = values as { groups?: ClaimTemplateValues['groups']; rows?: PlanRow[] };
  if (Array.isArray(v.groups)) return v.groups.flatMap((g) => g.rows ?? []);
  return Array.isArray(v.rows) ? v.rows : [];
}

/** Groups for display: the API's own groups when present (titles kept), else grouped from the rows. */
export function groupsOf(values: ClaimTemplateValues | undefined): RowGroup[] {
  if (!values) return [];
  if (Array.isArray(values.groups) && values.groups.length) return values.groups.map((g) => ({ section: g.section, title: g.title || g.rows[0]?.sectionTitle || g.section, rows: g.rows }));
  return groupRows(rowsOf(values));
}

/** Signature boxes and printed wording: never typed into, never sent. */
export function isLocked(row: Pick<PlanRow, 'editable' | 'policy'>): boolean {
  return !row.editable || row.policy === 'signature' || row.policy === 'never';
}

export function isGtaRow(row: Pick<PlanRow, 'key' | 'sourcePath' | 'label'>): boolean {
  return /gta/i.test(row.key ?? '') || /gta/i.test(row.sourcePath ?? '') || /\bGTA\b/.test(row.label);
}

/** "This box is about 2 cm wide — keep it short" for narrow cells holding typed text (1 cm = 567 twips). */
export function narrowCellHint(row: Pick<PlanRow, 'widthTwips' | 'inputType'>): string | undefined {
  if (!row.widthTwips || row.widthTwips <= 0 || row.widthTwips >= 1700) return undefined;
  if (!['text', 'multiline', 'int', 'money'].includes(row.inputType)) return undefined;
  const cm = Math.max(1, Math.round(row.widthTwips / 567));
  return `This box is about ${cm} cm wide — keep it short`;
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

export function isEmptyInput(v: SlotInput | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return Number.isNaN(v);
  if (typeof v === 'boolean') return false;
  if (Array.isArray(v)) {
    if (v.length === 0) return true;
    return (v as unknown[]).every((item) => (typeof item === 'string' ? item.trim() === '' : item && typeof item === 'object' ? Object.values(item as Record<string, string>).every((c) => String(c ?? '').trim() === '') : true));
  }
  return false;
}

/** "04/10/2026", "4/10/2026", "2026-10-04" → "2026-10-04"; anything else → null. */
export function toIsoDate(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const uk = /^(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4})$/.exec(t);
  const [y, m, d] = iso ? [iso[1]!, iso[2]!, iso[3]!] : uk ? [uk[3]!, uk[2]!.padStart(2, '0'), uk[1]!.padStart(2, '0')] : [];
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

/** An ISO date-time string (UTC, with Z) or null. */
export function toIsoDateTime(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "9:30", "09:30", "0930" → "09:30" (24-hour); anything else → null. */
export function toTime(text: string): string | null {
  const m = /^(\d{1,2})\s*[:.]?\s*(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function toText(v: SlotInput | undefined): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return (v as unknown[]).map((x) => (typeof x === 'string' ? x : '')).join('\n');
  return String(v);
}

/** One raw value from the form or the API → the shape the API expects for this row's input type. */
export function normaliseInput(row: Pick<PlanRow, 'inputType' | 'multiple' | 'columns'>, raw: SlotInput | undefined): SlotInput {
  if (raw === undefined || raw === null) return null;
  switch (row.inputType) {
    case 'date':
      return typeof raw === 'string' ? toIsoDate(raw) : null;
    case 'datetime':
      return typeof raw === 'string' ? toIsoDateTime(raw) : null;
    case 'time':
      return typeof raw === 'string' ? toTime(raw) : null;
    case 'money': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
      if (typeof raw === 'string') return poundsTextToPence(raw);
      return null;
    }
    case 'int': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
      if (typeof raw === 'string') {
        const t = raw.replace(/[,\s]/g, '');
        return /^-?\d+$/.test(t) ? Number(t) : null;
      }
      return null;
    }
    case 'checkbox':
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'string') return raw === 'true' ? true : raw === 'false' ? false : null;
      return null;
    case 'choice': {
      const list = Array.isArray(raw) ? (raw as unknown[]).filter((x): x is string => typeof x === 'string') : typeof raw === 'string' ? [raw] : [];
      const clean = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
      const out = row.multiple ? clean : clean.slice(0, 1);
      return out.length ? out : null;
    }
    case 'rows': {
      if (!Array.isArray(raw)) return null;
      const cols = row.columns?.map((c) => c.id);
      const rows = (raw as unknown[])
        .filter((r): r is Record<string, string> => Boolean(r) && typeof r === 'object' && !Array.isArray(r))
        .map((r) => {
          const out: Record<string, string> = {};
          for (const k of cols ?? Object.keys(r)) {
            const v = String(r[k] ?? '').trim();
            if (v) out[k] = v;
          }
          return out;
        })
        .filter((r) => Object.keys(r).length > 0);
      return rows.length ? rows : null;
    }
    case 'paragraphs': {
      const items = Array.isArray(raw) ? (raw as unknown[]).map((x) => (typeof x === 'string' ? x.trim() : '')) : typeof raw === 'string' ? raw.split(/\n{2,}/).map((s) => s.trim()) : [];
      const kept = items.filter(Boolean);
      return kept.length ? kept : null;
    }
    case 'multiline': {
      const t = toText(raw).replace(/\r\n/g, '\n').replace(/\s+$/, '').replace(/^\s*\n/, '');
      return t.trim() ? t : null;
    }
    case 'text':
    default: {
      const t = toText(raw).trim();
      return t ? t : null;
    }
  }
}

/** Deep equality for normalised inputs. */
export function sameInput(a: SlotInput | undefined, b: SlotInput | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---------------------------------------------------------------------------
// Dialog state
// ---------------------------------------------------------------------------

export type FillStep = 'choose' | 'check';

export interface FillState {
  step: FillStep;
  templateId: string;
  variant?: string;
  subject: DocxSubject;
  /** slotId → what the handler typed (kept raw-normalised; unchanged values are dropped when the body is built). */
  edits: Record<string, SlotInput>;
  /** Suggested rows the handler ticked. */
  confirmed: string[];
  /** Collapsed section keys. */
  collapsed: string[];
}

export type FillAction =
  | { type: 'chooseTemplate'; template: Pick<DocxTemplateSummary, 'id' | 'variants'> }
  | { type: 'setVariant'; variant: string | undefined }
  | { type: 'setSubject'; subject: Partial<DocxSubject> }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'edit'; slotId: string; value: SlotInput }
  | { type: 'revert'; slotId: string }
  | { type: 'confirm'; slotId: string; confirmed: boolean }
  | { type: 'toggleSection'; section: string };

function defaultVariantOf(t: Pick<DocxTemplateSummary, 'variants'>): string | undefined {
  return (t.variants.find((v) => v.default) ?? t.variants[0])?.id;
}

export function initialFillState(init: Partial<FillState> = {}): FillState {
  return { step: 'choose', templateId: '', subject: {}, edits: {}, confirmed: [], collapsed: [], ...init };
}

export function fillReducer(state: FillState, action: FillAction): FillState {
  switch (action.type) {
    case 'chooseTemplate':
      if (action.template.id === state.templateId) return state;
      return { ...state, templateId: action.template.id, variant: defaultVariantOf(action.template), subject: {}, edits: {}, confirmed: [], collapsed: [] };
    case 'setVariant':
      return { ...state, variant: action.variant || undefined };
    case 'setSubject':
      return { ...state, subject: { ...state.subject, ...action.subject } };
    case 'next':
      return state.templateId ? { ...state, step: 'check' } : state;
    case 'back':
      return { ...state, step: 'choose' };
    case 'edit':
      return { ...state, edits: { ...state.edits, [action.slotId]: action.value } };
    case 'revert': {
      if (!Object.prototype.hasOwnProperty.call(state.edits, action.slotId)) return state;
      const edits = { ...state.edits };
      delete edits[action.slotId];
      return { ...state, edits };
    }
    case 'confirm': {
      const has = state.confirmed.includes(action.slotId);
      if (action.confirmed === has) return state;
      return { ...state, confirmed: action.confirmed ? [...state.confirmed, action.slotId] : state.confirmed.filter((id) => id !== action.slotId) };
    }
    case 'toggleSection':
      return { ...state, collapsed: state.collapsed.includes(action.section) ? state.collapsed.filter((s) => s !== action.section) : [...state.collapsed, action.section] };
  }
}

export function hasEdit(state: Pick<FillState, 'edits'>, slotId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.edits, slotId);
}

/** What the row will hold if generated now: the handler's edit, else the planned value. */
export function effectiveInput(row: PlanRow, state: Pick<FillState, 'edits'>): SlotInput {
  return hasEdit(state, row.slotId) ? (state.edits[row.slotId] ?? null) : row.value;
}

function changedValue(row: PlanRow, state: Pick<FillState, 'edits'>): { changed: boolean; value: SlotInput } {
  if (isLocked(row) || !hasEdit(state, row.slotId)) return { changed: false, value: row.value };
  const value = normaliseInput(row, state.edits[row.slotId]);
  const original = normaliseInput(row, row.value);
  // an unticked box is the box as printed: ticking and unticking again is no change
  const comparable = (v: SlotInput) => (row.inputType === 'checkbox' && v === null ? false : v);
  return { changed: !sameInput(comparable(value), comparable(original)), value: isEmptyInput(value) ? null : value };
}

/** True when the row prints a value: a changed/entered value, or a planned value that needs no (or has its) confirmation. */
export function rowWillPrint(row: PlanRow, state: Pick<FillState, 'edits' | 'confirmed'>): boolean {
  if (isLocked(row)) return false;
  const c = changedValue(row, state);
  if (c.changed) return !isEmptyInput(c.value);
  if (isEmptyInput(row.value)) return false;
  if (row.needsConfirmation) return row.confirmed || state.confirmed.includes(row.slotId);
  return true;
}

/** Required rows that would print nothing. */
export function missingRequired(rows: PlanRow[], state: Pick<FillState, 'edits' | 'confirmed'>): PlanRow[] {
  return rows.filter((r) => r.required && !isLocked(r) && !rowWillPrint(r, state));
}

/**
 * Body for POST /claims/:id/docx-documents: `values` holds only rows the handler changed or entered (null when a
 * planned value was cleared); `confirm` holds the suggested rows the handler ticked and did not overwrite.
 */
export function buildGenerateBody(state: Pick<FillState, 'templateId' | 'variant' | 'subject' | 'edits' | 'confirmed'>, rows: PlanRow[]): GenerateDocxBody {
  const values: Record<string, SlotInput> = {};
  for (const row of rows) {
    const c = changedValue(row, state);
    if (c.changed) values[row.slotId] = c.value;
  }
  const confirm = rows.filter((r) => r.needsConfirmation && !isLocked(r) && state.confirmed.includes(r.slotId) && !(r.slotId in values)).map((r) => r.slotId);
  const body: GenerateDocxBody = { templateId: state.templateId };
  if (state.variant) body.variant = state.variant;
  const subject = cleanSubject(state.subject);
  if (subject) body.subject = subject;
  body.values = values;
  body.confirm = confirm;
  return body;
}

// ---------------------------------------------------------------------------
// Summary, badges and issues
// ---------------------------------------------------------------------------

export interface FillSummary {
  fromClaim: number;
  toConfirm: number;
  toEnter: number;
  entered: number;
  leftForSigning: number;
  leftAsPrinted: number;
}

/** Live counts for the summary line (they move as the handler types and ticks). */
export function computeSummary(rows: PlanRow[], state: Pick<FillState, 'edits' | 'confirmed'>): FillSummary {
  const s: FillSummary = { fromClaim: 0, toConfirm: 0, toEnter: 0, entered: 0, leftForSigning: 0, leftAsPrinted: 0 };
  for (const row of rows) {
    if (row.policy === 'signature') s.leftForSigning += 1;
    else if (isLocked(row)) s.leftAsPrinted += 1;
    else if (changedValue(row, state).changed) {
      if (rowWillPrint(row, state)) s.entered += 1;
      else s.toEnter += 1;
    } else if (row.needsConfirmation && !isEmptyInput(row.value) && !(row.confirmed || state.confirmed.includes(row.slotId))) s.toConfirm += 1;
    else if (rowWillPrint(row, state)) {
      if (row.origin === 'handler') s.entered += 1;
      else s.fromClaim += 1;
    } else s.toEnter += 1;
  }
  return s;
}

/** "18 filled from the claim · 4 to confirm · 6 to enter · 9 left for signing" (+ entered / left as printed when any). */
export function summaryLine(s: FillSummary): string {
  const parts = [`${s.fromClaim} filled from the claim`, `${s.toConfirm} to confirm`, `${s.toEnter} to enter`, `${s.leftForSigning} left for signing`];
  if (s.entered > 0) parts.push(`${s.entered} entered by you`);
  if (s.leftAsPrinted > 0) parts.push(`${s.leftAsPrinted} left as printed`);
  return parts.join(' · ');
}

export interface RowBadge {
  label: string;
  tone: 'green' | 'amber' | 'grey' | 'blue';
  /** The row cannot be typed into. */
  locked: boolean;
  /** Show the "confirm" tick box next to the badge. */
  confirm: boolean;
}

export function rowBadge(row: PlanRow, state: Pick<FillState, 'edits' | 'confirmed'>): RowBadge {
  if (row.policy === 'signature') return { label: 'Signed by hand — left blank', tone: 'grey', locked: true, confirm: false };
  if (isLocked(row)) return { label: 'Left as printed', tone: 'grey', locked: true, confirm: false };
  if (changedValue(row, state).changed) return { label: 'Entered by you', tone: 'blue', locked: false, confirm: false };
  if (row.needsConfirmation && !isEmptyInput(row.value)) return { label: 'Suggested — tick to confirm', tone: 'amber', locked: false, confirm: true };
  if (!isEmptyInput(row.value) && (row.origin === 'claim' || row.origin === 'derived')) return { label: 'From claim', tone: 'green', locked: false, confirm: false };
  if (!isEmptyInput(row.value) && row.origin === 'settings') return { label: 'From settings', tone: 'green', locked: false, confirm: false };
  if (!isEmptyInput(row.value) && row.origin === 'handler') return { label: 'Entered', tone: 'blue', locked: false, confirm: false };
  return { label: 'Enter', tone: 'grey', locked: false, confirm: false };
}

export const ORIGIN_LABEL: Record<PlanOrigin, string> = {
  claim: 'From claim',
  settings: 'From settings',
  derived: 'Worked out from the claim',
  suggested: 'Suggested and confirmed',
  handler: 'Entered by the handler',
  none: 'Left blank'
};

export function originLabel(origin: string | undefined): string {
  return (ORIGIN_LABEL as Record<string, string>)[origin ?? 'none'] ?? origin ?? '—';
}

/**
 * Block issues that stand only while one row is blank: they go away as soon as the handler fills that row
 * (the API re-checks them on Generate).
 */
const CLEARED_BY_FILLING: Record<string, string | undefined> = {
  VALUES_REQUIRED: undefined,
  WITNESS_RELATIONSHIP_REQUIRED: 'witness.relationshipToClaimant'
};

/** Blocking issues still standing: a "fill this row" issue goes away once the handler fills that row. */
export function openBlockingIssues(issues: FillPlanIssue[], rows: PlanRow[], state: Pick<FillState, 'edits' | 'confirmed'>): FillPlanIssue[] {
  const byId = new Map(rows.map((r) => [r.slotId, r]));
  return issues.filter((i) => {
    if (i.severity !== 'block') return false;
    if (Object.prototype.hasOwnProperty.call(CLEARED_BY_FILLING, i.code)) {
      const key = CLEARED_BY_FILLING[i.code];
      const row = (i.slotId ? byId.get(i.slotId) : undefined) ?? (key ? rows.find((r) => r.key === key && !isLocked(r)) : undefined);
      if (row && rowWillPrint(row, state)) return false;
    }
    return true;
  });
}

export function warningIssues(issues: FillPlanIssue[]): FillPlanIssue[] {
  return issues.filter((i) => i.severity === 'warn');
}

/** Why Generate is disabled, or undefined when it is enabled. */
export function generateBlocker(values: ClaimTemplateValues | undefined, state: FillState): string | undefined {
  if (!state.templateId) return 'Choose a template first.';
  if (!values) return 'Waiting for the values from the claim.';
  const rows = rowsOf(values);
  const blocking = openBlockingIssues(values.issues ?? [], rows, state);
  if (blocking.length) return `${blocking.length} blocking issue${blocking.length === 1 ? '' : 's'} must be resolved first.`;
  const missing = missingRequired(rows, state);
  if (missing.length) return `${missing.length} required value${missing.length === 1 ? ' is' : 's are'} missing: ${missing.map((r) => r.label).slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}.`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Subjects (witness, offer, hire, recipient, exhibits)
// ---------------------------------------------------------------------------

export interface SubjectOptions {
  witnesses: Array<{ value: string; label: string }>;
  offers: Array<{ value: string; label: string }>;
  hires: Array<{ value: string; label: string }>;
  recipients: Array<{ value: string; label: string }>;
  exhibits: Array<{ value: string; label: string }>;
}

type SubjectSource = Pick<ClaimBundle, 'claimant' | 'driver' | 'thirdParties' | 'atFaultInsurer' | 'offers' | 'hire' | 'evidence'>;

/** Subject choices: the API's lists when the values response carries them, else built from the claim file. */
export function subjectOptions(values: ClaimTemplateValues | undefined, view: SubjectSource): SubjectOptions {
  const s = values?.subjects ?? {};
  const parties = [view.atFaultInsurer, view.claimant, view.driver, ...view.thirdParties].filter((p): p is NonNullable<typeof p> => Boolean(p));
  const uniqueParties = parties.filter((p, i) => parties.findIndex((q) => q.id === p.id) === i);
  return {
    witnesses: s.witnesses?.map((w) => ({ value: w.id, label: w.name })) ?? view.thirdParties.filter((p) => p.roles.includes('witness')).map((p) => ({ value: p.id, label: p.name })),
    offers: s.offers?.map((o) => ({ value: o.id, label: o.label })) ?? view.offers.map((o) => ({ value: o.id, label: `${o.offerorName} — ${o.receivedAt.slice(0, 10)}${o.vehicleClassOffered ? ` · ${o.vehicleClassOffered}` : ''}` })),
    hires: s.hires?.map((h) => ({ value: h.id, label: h.label })) ?? [...view.hire].sort((a, b) => b.startAt.localeCompare(a.startAt)).map((h) => ({ value: h.id, label: `${h.agreementNumber} — from ${h.startAt.slice(0, 10)}${h.endAt ? ` to ${h.endAt.slice(0, 10)}` : ' (open)'}` })),
    recipients: s.recipients?.filter((r) => r.partyId).map((r) => ({ value: r.partyId!, label: r.label })) ?? uniqueParties.map((p) => ({ value: p.id, label: `${p.name}${p.roles.length ? ` (${p.roles.join(', ').replace(/_/g, ' ')})` : ''}` })),
    exhibits: s.exhibits?.map((e) => ({ value: e.id, label: e.label })) ?? view.evidence.map((e) => ({ value: e.id, label: `${e.filename}${e.description ? ` — ${e.description}` : ''}` }))
  };
}

/** Subjects that must be chosen before the values can be checked (a witness statement needs its witness). */
export function subjectBlocker(subjects: SubjectKind[] | undefined, subject: DocxSubject): string | undefined {
  if (subjects?.includes('witness') && !subject.witnessPartyId) return 'Choose the witness.';
  return undefined;
}
