/**
 * Documents helpers (pure). Draft → consistency check → approve (human) → send; a block flag stops approval
 * until a person clears it with a reason (ARCHITECTURE convention 5).
 */
import type { ConsistencyFlag, ConsistencyReport, GeneratedDocument } from '@ccguk/domain';
import type { SupersedeDocumentBody, TemplateMeta } from '../../../api/client';

export const TEMPLATE_KIND_ORDER = ['letter', 'invoice', 'form', 'agreement', 'statement', 'report', 'schedule', 'pack', 'bundle', 'notice', 'certificate'] as const;

export const TEMPLATE_KIND_LABEL: Record<string, string> = {
  letter: 'Letters',
  invoice: 'Invoices',
  form: 'Forms',
  agreement: 'Agreements',
  statement: 'Statements',
  report: 'Reports',
  schedule: 'Schedules',
  pack: 'Packs',
  bundle: 'Bundles',
  notice: 'Notices',
  certificate: 'Certificates'
};

export function templateKindLabel(kind: string): string {
  return TEMPLATE_KIND_LABEL[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}s`;
}

export interface TemplateGroup {
  kind: string;
  label: string;
  templates: TemplateMeta[];
}

/** Templates grouped by kind in the picker order, each group sorted by title. Unknown kinds go last. */
export function groupTemplates(templates: TemplateMeta[]): TemplateGroup[] {
  const byKind = new Map<string, TemplateMeta[]>();
  for (const t of templates) {
    const list = byKind.get(t.kind) ?? [];
    list.push(t);
    byKind.set(t.kind, list);
  }
  const order = (k: string) => {
    const i = (TEMPLATE_KIND_ORDER as readonly string[]).indexOf(k);
    return i === -1 ? 99 : i;
  };
  return [...byKind.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([kind, list]) => ({ kind, label: templateKindLabel(kind), templates: [...list].sort((a, b) => a.title.localeCompare(b.title)) }));
}

/**
 * Roots of the data snapshot the API assembles from the file (ledger, events, offers, clocks, settings, parties).
 * A required key under one of these is never typed by hand (convention 4); anything else is an "extra" field.
 */
export const SNAPSHOT_ROOTS: ReadonlySet<string> = new Set([
  'settings',
  'claim',
  'claimant',
  'driver',
  'recipient',
  'insurer',
  'vehicle',
  'hire',
  'storage',
  'recovery',
  'ledger',
  'offers',
  'offer',
  'clocks',
  'events',
  'chronology',
  'heads',
  'invoice',
  'report',
  'engineer',
  'instructions',
  'inspection',
  'pav',
  'estimate',
  'handler',
  'signature',
  'certificate',
  'company',
  'date',
  'documents',
  'evidence'
]);

export type ExtraFieldKind = 'text' | 'date' | 'amount' | 'supplied';

export interface ExtraField {
  key: string;
  label: string;
  kind: ExtraFieldKind;
}

/** Amounts and dates the ledger knows are never free-typed: they are flagged 'supplied' and shown read-only. */
export function extraDataFields(requiredData: string[]): ExtraField[] {
  return requiredData.map((key) => {
    const root = key.split('.')[0] ?? key;
    const leaf = key.split('.').pop() ?? key;
    if (SNAPSHOT_ROOTS.has(root)) return { key, label: humanise(key), kind: 'supplied' };
    if (/Pence$/.test(leaf) || /(amount|total|balance)/i.test(leaf)) return { key, label: humanise(key), kind: 'supplied' };
    if (/(At|Date|Deadline|From|To|Start|End|Window(Start|End)?)$/.test(leaf) && !/^(deliverTo|sentTo)$/.test(leaf)) return { key, label: humanise(key), kind: 'date' };
    return { key, label: humanise(key), kind: 'text' };
  });
}

export function humanise(key: string): string {
  return key
    .split('.')
    .map((seg) => seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase())
    .join(' › ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Build the `data` body from typed extras, dropping blanks. */
export function extraDataBody(fields: ExtraField[], values: Record<string, string>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === 'supplied') continue;
    const v = (values[f.key] ?? '').trim();
    if (v) setPath(out, f.key, v);
  }
  return Object.keys(out).length ? out : undefined;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) cur[p] = value;
    else {
      const next = (cur[p] as Record<string, unknown> | undefined) ?? {};
      cur[p] = next;
      cur = next;
    }
  });
}

export interface FlagCounts {
  block: number;
  warn: number;
  info: number;
  /** Uncleared block flags: the number that stops approval. */
  blocking: number;
  cleared: number;
  total: number;
}

export function flagCounts(report: ConsistencyReport | undefined): FlagCounts {
  const out: FlagCounts = { block: 0, warn: 0, info: 0, blocking: 0, cleared: 0, total: 0 };
  for (const f of report?.flags ?? []) {
    out.total += 1;
    out[f.severity] += 1;
    if (f.clearedAt) out.cleared += 1;
    else if (f.severity === 'block') out.blocking += 1;
  }
  return out;
}

export function isFlagCleared(f: ConsistencyFlag): boolean {
  return Boolean(f.clearedAt);
}

export function isBlocked(doc: Pick<GeneratedDocument, 'status' | 'consistency'>): boolean {
  return doc.status === 'blocked' || Boolean(doc.consistency?.blocked) || flagCounts(doc.consistency).blocking > 0;
}

/** Why the Approve button is disabled, or undefined when approval is open. */
export function approvalBlocker(doc: Pick<GeneratedDocument, 'status' | 'consistency'>): string | undefined {
  if (doc.status === 'approved' || doc.status === 'sent' || doc.status === 'signed') return 'Already approved.';
  if (doc.status === 'superseded' || doc.status === 'void') return `This version is ${doc.status}; work on the current version.`;
  const counts = flagCounts(doc.consistency);
  if (isBlocked(doc)) return `${counts.blocking} block flag${counts.blocking === 1 ? '' : 's'} must be cleared with a reason before a person can approve.`;
  if (!doc.consistency) return 'Waiting for the consistency check.';
  return undefined;
}

export function canSend(doc: Pick<GeneratedDocument, 'status'>): boolean {
  return doc.status === 'approved' || doc.status === 'signed';
}

export function canSign(doc: Pick<GeneratedDocument, 'status' | 'signature' | 'templateId'>): boolean {
  if (doc.signature) return false;
  if (!(doc.status === 'approved' || doc.status === 'sent')) return false;
  return /^(agreement|form|statement)\./.test(doc.templateId) || doc.templateId === 'report.engineer';
}

export const SEND_VIA_OPTIONS: Array<{ value: NonNullable<GeneratedDocument['sentVia']>; label: string }> = [
  { value: 'email', label: 'Email' },
  { value: 'post', label: 'Post' },
  { value: 'portal', label: 'Insurer portal' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'hand', label: 'By hand' }
];

export const CONSISTENCY_CODE_LABEL: Record<string, string> = {
  AMOUNT_PAID_MISMATCH: 'Amount paid differs from the ledger',
  AMOUNT_CLAIMED_MISMATCH: 'Amount claimed differs from the ledger',
  DEADLINE_TOO_EARLY: 'Deadline earlier than the computed clock',
  DEADLINE_MISMATCH: 'Deadline differs from the clock',
  OFFER_DENIED_BUT_LOGGED: 'Draft denies an offer the register holds',
  STORAGE_END_MISMATCH: 'Storage end differs from the record',
  HIRE_PERIOD_MISMATCH: 'Hire period differs from the agreement',
  PAYEE_MISMATCH: 'Payee or supplier differs from the source',
  DATE_BEFORE_CREATION: 'Date earlier than the document creation',
  DUPLICATE_SIGNATURE_DATE: 'Duplicate signature date on this file',
  CONTRADICTS_PRIOR_LETTER: 'Contradicts a prior outgoing letter',
  LEGACY_DETAIL: 'Legacy name, number or address',
  BANNED_PHRASE: 'Banned phrase',
  REGULATED_STATUS_IMPLIED: 'Implies regulated status',
  UNVERIFIED_CITATION: 'Unverified citation',
  FORUM_NOT_OPEN: 'Names a forum that is not open',
  GTA_CITED_AS_LAW: 'GTA cited as law (benchmark only)',
  UNKNOWN_REFERENCE: 'Unknown reference'
};

export function consistencyCodeLabel(code: string): string {
  return CONSISTENCY_CODE_LABEL[code] ?? code.replace(/_/g, ' ');
}

/** Current (non-superseded, non-void) documents first, newest first. */
export function sortDocuments(docs: GeneratedDocument[]): GeneratedDocument[] {
  const rank = (d: GeneratedDocument) => (d.status === 'superseded' || d.status === 'void' ? 1 : 0);
  return [...docs].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
}

export interface SupersedeForm {
  reExecutedOn: string;
  reason: string;
}

/**
 * Body for POST /documents/:id/supersede (apps/api `supersedeDocumentBody`: reason, reExecutedOn, data?). The API
 * links the new version to this one and renders the "re-executed on [date], supersedes version [n]" line itself;
 * the date is never earlier than today and the API also refuses dates before creation (lesson b).
 */
export function supersedeBodyFrom(form: SupersedeForm, today: string): { ok: true; body: SupersedeDocumentBody } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (form.reason.trim().length < 3) errors.reason = 'Why is this version being re-executed?';
  if (form.reExecutedOn && form.reExecutedOn > today) errors.reExecutedOn = 'The re-execution date cannot be in the future';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { reason: form.reason.trim(), reExecutedOn: form.reExecutedOn || today } };
}
