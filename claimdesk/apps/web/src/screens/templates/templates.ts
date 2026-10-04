/**
 * Document templates (Word .docx) — pure helpers for Settings → Document templates, the mapping editor and the
 * template picker in the claim's "Fill a CCGUK template" dialog (docs/TEMPLATES-VEHICLES-DESKTOP.md §C.9).
 *
 * Policy rule (§B.3): a mapping may make a field's fill policy stricter than the dictionary default, never laxer.
 * Strictness order: auto < auto-if-known < suggest < handler < post-event < never / signature.
 */
import type { Tone } from '../../lib/status';
import type {
  DocxConverterId,
  DocxConvertersResponse,
  DocxFieldDef,
  DocxOutlineItem,
  DocxSlot,
  DocxTemplateDetail,
  DocxTemplateMappingRow,
  DocxTemplateSummary,
  FillPolicy,
  FormatName,
  MappingEntry,
  MappingIssue,
  MappingOrigin,
  SaveMappingBody,
  SlotKind
} from '../../api/templatesApi';

export interface BadgeSpec {
  label: string;
  tone: Tone;
  title?: string;
}

// ---------------------------------------------------------------------------
// Fill policies
// ---------------------------------------------------------------------------

/** Every policy, laxest first. `never` and `signature` are equally strict. */
export const POLICY_ORDER: readonly FillPolicy[] = ['auto', 'auto-if-known', 'suggest', 'handler', 'post-event', 'never', 'signature'];

const POLICY_RANK: Record<FillPolicy, number> = { auto: 0, 'auto-if-known': 1, suggest: 2, handler: 3, 'post-event': 4, never: 5, signature: 5 };

export const POLICY_LABEL: Record<FillPolicy, string> = {
  auto: 'Fill from the claim',
  'auto-if-known': 'Fill when known',
  suggest: 'Suggest — handler confirms',
  handler: 'Handler enters',
  'post-event': 'Only after the event',
  never: 'Leave as printed',
  signature: 'Signed by hand'
};

export function policyRank(policy: FillPolicy): number {
  return POLICY_RANK[policy] ?? 0;
}

/** True when `policy` would fill more readily than the field's default (refused by the API as POLICY_LAXER). */
export function isPolicyLaxer(policy: FillPolicy, fieldDefault: FillPolicy | undefined): boolean {
  return fieldDefault !== undefined && policyRank(policy) < policyRank(fieldDefault);
}

/** The policies a mapping may choose for a field whose dictionary default is `fieldDefault` (never laxer). */
export function allowedPolicyOptions(fieldDefault: FillPolicy | undefined): FillPolicy[] {
  const floor = policyRank(fieldDefault ?? 'auto');
  return POLICY_ORDER.filter((p) => policyRank(p) >= floor);
}

/** The stricter of two policies (ties keep `a`). */
export function stricterPolicy(a: FillPolicy, b: FillPolicy): FillPolicy {
  return policyRank(b) > policyRank(a) ? b : a;
}

// ---------------------------------------------------------------------------
// Template list
// ---------------------------------------------------------------------------

export function sourceBadge(source: DocxTemplateSummary['source']): BadgeSpec {
  return source === 'builtin' ? { label: 'Built-in', tone: 'navy' } : { label: 'Uploaded', tone: 'blue' };
}

/** Slots that are handled: mapped to a field, handler free text, signature, or deliberately left as printed. */
export function handledSlots(t: Pick<DocxTemplateSummary, 'slotCount' | 'unmappedCount'>): number {
  return Math.max(0, t.slotCount - t.unmappedCount);
}

/** "Mapped x of y" cell: amber while any slot is not mapped. */
export function mappedBadge(t: Pick<DocxTemplateSummary, 'slotCount' | 'mappedCount' | 'ignoredCount' | 'unmappedCount'>): BadgeSpec {
  return {
    label: `${handledSlots(t)} of ${t.slotCount}`,
    tone: t.unmappedCount > 0 ? 'amber' : 'green',
    title: `${t.mappedCount} mapped · ${t.ignoredCount} left as printed · ${t.unmappedCount} not mapped`
  };
}

/** Warnings cell: none → undefined; unacknowledged → amber "Needs review"; acknowledged → grey. */
export function warningsBadge(t: Pick<DocxTemplateSummary, 'warnings' | 'warningsAcknowledged'>): BadgeSpec | undefined {
  const n = t.warnings.length;
  if (n === 0) return undefined;
  if (!t.warningsAcknowledged) return { label: `${n} · Needs review`, tone: 'amber', title: t.warnings.map((w) => w.message).join('\n') };
  return { label: `${n} reviewed`, tone: 'grey', title: t.warnings.map((w) => w.message).join('\n') };
}

export type TemplateState = 'inactive' | 'needs-review' | 'not-fully-mapped' | 'ready';

export function templateState(t: Pick<DocxTemplateSummary, 'active' | 'warnings' | 'warningsAcknowledged' | 'unmappedCount'>): TemplateState {
  if (!t.active) return 'inactive';
  if (t.warnings.length > 0 && !t.warningsAcknowledged) return 'needs-review';
  if (t.unmappedCount > 0) return 'not-fully-mapped';
  return 'ready';
}

/** Overall status badge for a template row or header. */
export function templateStatusBadge(t: Pick<DocxTemplateSummary, 'active' | 'warnings' | 'warningsAcknowledged' | 'unmappedCount'>): BadgeSpec {
  switch (templateState(t)) {
    case 'inactive':
      return { label: 'Inactive', tone: 'grey', title: 'Not offered when filling a template' };
    case 'needs-review':
      return { label: 'Needs review', tone: 'amber', title: 'Documents cannot be made from it until someone reviews the wording' };
    case 'not-fully-mapped':
      return { label: 'Not fully mapped', tone: 'amber', title: 'Blanks that are not mapped are left as printed' };
    case 'ready':
      return { label: 'Ready', tone: 'green' };
  }
}

export interface TemplateCounts {
  total: number;
  active: number;
  builtin: number;
  uploaded: number;
  needsReview: number;
  notFullyMapped: number;
}

export function templateCounts(list: DocxTemplateSummary[]): TemplateCounts {
  const out: TemplateCounts = { total: 0, active: 0, builtin: 0, uploaded: 0, needsReview: 0, notFullyMapped: 0 };
  for (const t of list) {
    out.total += 1;
    if (t.active) out.active += 1;
    if (t.source === 'builtin') out.builtin += 1;
    else out.uploaded += 1;
    if (t.warnings.length > 0 && !t.warningsAcknowledged) out.needsReview += 1;
    if (t.unmappedCount > 0) out.notFullyMapped += 1;
  }
  return out;
}

/** Built-ins first in id order (CCGUK-01 … 09, then the letterhead), then uploads by title. */
export function sortTemplates(list: DocxTemplateSummary[]): DocxTemplateSummary[] {
  return [...list].sort((a, b) => (a.source === b.source ? (a.source === 'builtin' ? builtinOrder(a.id) - builtinOrder(b.id) || a.id.localeCompare(b.id) : a.title.localeCompare(b.title)) : a.source === 'builtin' ? -1 : 1));
}

function builtinOrder(id: string): number {
  const m = /ccguk_(\d+)/.exec(id);
  return m ? Number(m[1]) : 99;
}

export const TEMPLATE_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'letter', label: 'Letter' },
  { value: 'form', label: 'Form' },
  { value: 'agreement', label: 'Agreement' },
  { value: 'statement', label: 'Statement' },
  { value: 'report', label: 'Report' },
  { value: 'notice', label: 'Notice' }
];

export function templateKindName(kind: string): string {
  return TEMPLATE_KIND_OPTIONS.find((k) => k.value === kind)?.label ?? (kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : '—');
}

export const RECIPIENT_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'client', label: 'Client' },
  { value: 'at_fault_insurer', label: 'At-fault insurer' },
  { value: 'own_insurer', label: "Client's own insurer" },
  { value: 'court', label: 'Court' },
  { value: 'supplier', label: 'Supplier' },
  { value: 'other', label: 'Other' }
];

export function recipientRoleLabel(role: string | undefined): string {
  if (!role) return '—';
  return RECIPIENT_ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role.replace(/_/g, ' ');
}

export function shortSha(sha: string | undefined, n = 12): string {
  return sha ? sha.slice(0, n) : '—';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Template picker groups (claim → Documents → Fill a CCGUK template)
// ---------------------------------------------------------------------------

export interface PickerGroup {
  id: string;
  label: string;
  templates: DocxTemplateSummary[];
}

const PICKER_ORDER: Array<{ id: string; label: string }> = [
  { id: 'agreement', label: 'Agreements' },
  { id: 'form', label: 'Forms' },
  { id: 'statement', label: 'Statements' },
  { id: 'letter', label: 'Letters' },
  { id: 'report', label: 'Reports' },
  { id: 'notice', label: 'Notices' }
];

/** Active templates grouped Agreements / Forms / Statements / Letters / … / Your templates (uploads). */
export function pickerGroups(list: DocxTemplateSummary[]): PickerGroup[] {
  const active = sortTemplates(list.filter((t) => t.active));
  const groups: PickerGroup[] = [];
  for (const g of PICKER_ORDER) {
    const templates = active.filter((t) => t.source === 'builtin' && t.kind === g.id);
    if (templates.length) groups.push({ ...g, templates });
  }
  const otherBuiltins = active.filter((t) => t.source === 'builtin' && !PICKER_ORDER.some((g) => g.id === t.kind));
  if (otherBuiltins.length) groups.push({ id: 'other', label: 'Other', templates: otherBuiltins });
  const uploads = active.filter((t) => t.source !== 'builtin');
  if (uploads.length) groups.push({ id: 'uploaded', label: 'Your templates', templates: uploads });
  return groups;
}

/** The variant chosen when a template is picked: the one marked default, else the first, else none. */
export function defaultVariant(t: Pick<DocxTemplateSummary, 'variants'> | undefined): string | undefined {
  if (!t || !t.variants.length) return undefined;
  return (t.variants.find((v) => v.default) ?? t.variants[0])?.id;
}

// ---------------------------------------------------------------------------
// Slots grouped by section (mapping editor)
// ---------------------------------------------------------------------------

export interface SlotSection {
  key: string;
  title: string;
  slots: DocxSlot[];
}

const SECTION_TITLE: Record<string, string> = { header: 'Page header', footer: 'Page footer', title: 'Title block' };

function humaniseSlug(slug: string): string {
  const s = slug.replace(/^\d+-/, (m) => m.replace('-', ' ')).replace(/-/g, ' ').trim();
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : 'Document';
}

export function sectionTitleOf(slot: Pick<DocxSlot, 'sectionPath' | 'sectionTitles'>): string {
  if (slot.sectionPath.length === 1 && SECTION_TITLE[slot.sectionPath[0]!]) return SECTION_TITLE[slot.sectionPath[0]!]!;
  if (slot.sectionTitles.length) return slot.sectionTitles.join(' › ');
  if (slot.sectionPath.length) return slot.sectionPath.map((s) => SECTION_TITLE[s] ?? humaniseSlug(s)).join(' › ');
  return 'Document';
}

/**
 * Slots grouped by their full section path, groups in outline order: page header and title block first, then the
 * outline (the deepest outline entry the path reaches decides), sections not in the outline after it, page footer
 * last. Slots keep their scan (document) order inside a group.
 */
export function groupSlotsBySection(slots: DocxSlot[], outline: DocxOutlineItem[]): SlotSection[] {
  const outlineIndex = new Map<string, number>();
  outline.forEach((o, i) => {
    if (!outlineIndex.has(o.slug)) outlineIndex.set(o.slug, i);
  });
  const groups = new Map<string, { section: SlotSection; first: number }>();
  slots.forEach((slot, i) => {
    const key = slot.sectionPath.join('/');
    const g = groups.get(key);
    if (g) g.section.slots.push(slot);
    else groups.set(key, { section: { key, title: sectionTitleOf(slot), slots: [slot] }, first: i });
  });
  const rank = (key: string, first: number): number => {
    const path = key ? key.split('/') : [];
    const top = path[0] ?? '';
    if (top === 'header') return -2;
    if (top === 'title') return -1;
    if (top === 'footer') return 1_000_000;
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const idx = outlineIndex.get(path[i]!);
      if (idx !== undefined) return idx;
    }
    return 100_000 + first;
  };
  return [...groups.values()].sort((a, b) => rank(a.section.key, a.first) - rank(b.section.key, b.first) || a.first - b.first).map((g) => g.section);
}

export const SLOT_KIND_LABEL: Record<SlotKind, string> = {
  cell: 'Cell',
  inline: 'Inline',
  line: 'Line',
  blank: 'Blank',
  bracket: '[Bracket]',
  token: '{{Token}}',
  control: 'Content control',
  mergefield: 'Merge field',
  checkbox: 'Tick box',
  choice: 'Choice',
  block: 'Box',
  table: 'Table',
  paragraphs: 'Paragraphs'
};

export function slotKindLabel(kind: SlotKind): string {
  return SLOT_KIND_LABEL[kind] ?? kind;
}

// ---------------------------------------------------------------------------
// Mapping editor draft
// ---------------------------------------------------------------------------

/** field = mapped to a dictionary key; handler = handler free text; ignore = left as printed; signature = signed by hand. */
export type MappingMode = 'field' | 'handler' | 'ignore' | 'signature' | 'none';

export interface MappingDraftRow {
  slotId: string;
  mode: MappingMode;
  key?: string;
  policy: FillPolicy;
  format?: FormatName;
  when?: string;
  required?: boolean;
  removeIfEmpty?: 'paragraph' | 'row';
  label?: string;
  origin: MappingOrigin;
  score?: number;
  changed?: boolean;
}

export type MappingDraft = Record<string, MappingDraftRow>;

/** Field select values that are not dictionary keys. */
export const FIELD_NONE = '';
export const FIELD_HANDLER = '__handler';
export const FIELD_IGNORE = '__ignore';

function modeOf(row: DocxTemplateMappingRow | undefined, slot: DocxSlot): MappingMode {
  if (slot.signature) return 'signature';
  if (!row) return 'none';
  if (row.ignored) return 'ignore';
  if (row.key) return 'field';
  if (row.origin === 'none') return 'none';
  if (row.policy === 'signature') return 'signature';
  if (row.policy === 'never') return 'ignore';
  return 'handler';
}

/** The editor's starting state from GET /docx-templates/:id (one row per slot, in scan order). */
export function mappingDraftFromDetail(detail: Pick<DocxTemplateDetail, 'slots' | 'mapping'>): MappingDraft {
  const bySlot = new Map(detail.mapping.map((m) => [m.slotId, m]));
  const out: MappingDraft = {};
  for (const slot of detail.slots) {
    const m = bySlot.get(slot.id);
    const mode = modeOf(m, slot);
    out[slot.id] = {
      slotId: slot.id,
      mode,
      key: mode === 'field' ? m?.key : undefined,
      policy: mode === 'signature' ? 'signature' : mode === 'ignore' ? 'never' : (m?.policy ?? 'handler'),
      format: m?.format,
      when: m?.when,
      required: m?.required,
      removeIfEmpty: m?.removeIfEmpty,
      label: m?.label,
      origin: m?.origin ?? 'none',
      score: m?.score
    };
  }
  return out;
}

export function fieldSelectValue(row: MappingDraftRow): string {
  switch (row.mode) {
    case 'field':
      return row.key ?? FIELD_NONE;
    case 'handler':
      return FIELD_HANDLER;
    case 'ignore':
      return FIELD_IGNORE;
    default:
      return FIELD_NONE;
  }
}

/** Apply the Field select. A new key starts at its dictionary default policy (never laxer). Signature slots stay locked. */
export function applyFieldSelection(row: MappingDraftRow, value: string, fields: DocxFieldDef[], slot?: Pick<DocxSlot, 'signature'>): MappingDraftRow {
  if (slot?.signature || row.mode === 'signature') return row;
  if (value === FIELD_HANDLER) return { ...row, mode: 'handler', key: undefined, policy: policyRank(row.policy) >= policyRank('handler') && row.mode === 'handler' ? row.policy : 'handler', when: undefined, changed: true };
  if (value === FIELD_IGNORE) return { ...row, mode: 'ignore', key: undefined, policy: 'never', required: undefined, changed: true };
  if (value === FIELD_NONE) return { ...row, mode: 'none', key: undefined, policy: 'handler', changed: true };
  const def = fields.find((f) => f.key === value);
  return { ...row, mode: 'field', key: value, policy: def?.policy ?? 'handler', changed: true };
}

/** Apply the Policy select; a laxer choice than the field default is refused (row returned unchanged). */
export function applyPolicy(row: MappingDraftRow, policy: FillPolicy, fields: DocxFieldDef[]): MappingDraftRow {
  if (row.mode === 'signature' || row.mode === 'ignore' || row.mode === 'none') return row;
  const floor = row.mode === 'field' ? fields.find((f) => f.key === row.key)?.policy : 'handler';
  if (isPolicyLaxer(policy, floor)) return row;
  return { ...row, policy, changed: true };
}

/** The default policy the Policy select is bounded by. */
export function policyFloor(row: MappingDraftRow, fields: DocxFieldDef[]): FillPolicy | undefined {
  if (row.mode === 'field') return fields.find((f) => f.key === row.key)?.policy;
  if (row.mode === 'handler') return 'handler';
  return undefined;
}

/**
 * Body for PUT /docx-templates/:id/mapping: entries and ignore list keyed by the exact slot ids of the scan (selectors
 * are for built-in JSON only). Slots left "Not mapped" are omitted; signature slots are always written as signature.
 */
export function buildMappingPutBody(slots: DocxSlot[], draft: MappingDraft): SaveMappingBody {
  const entries: MappingEntry[] = [];
  const ignore: string[] = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    if (seen.has(slot.id)) continue;
    seen.add(slot.id);
    const row = draft[slot.id];
    if (slot.signature || row?.mode === 'signature') {
      entries.push({ slot: slot.id, policy: 'signature' });
      continue;
    }
    if (!row || row.mode === 'none') continue;
    if (row.mode === 'ignore') {
      ignore.push(slot.id);
      continue;
    }
    const entry: MappingEntry = { slot: slot.id };
    if (row.mode === 'field' && row.key) entry.key = row.key;
    entry.policy = row.mode === 'handler' ? stricterPolicy('handler', row.policy) : row.policy;
    if (row.format && row.format !== 'auto') entry.format = row.format;
    if (row.when) entry.when = row.when;
    if (row.required) entry.required = true;
    if (row.removeIfEmpty) entry.removeIfEmpty = row.removeIfEmpty;
    if (row.label?.trim()) entry.label = row.label.trim();
    entries.push(entry);
  }
  return { entries, ignore };
}

export interface MappingDraftCounts {
  mapped: number;
  handler: number;
  ignored: number;
  signature: number;
  unmapped: number;
  changed: number;
}

export function mappingDraftCounts(slots: DocxSlot[], draft: MappingDraft): MappingDraftCounts {
  const out: MappingDraftCounts = { mapped: 0, handler: 0, ignored: 0, signature: 0, unmapped: 0, changed: 0 };
  for (const slot of slots) {
    const row = draft[slot.id];
    if (row?.changed) out.changed += 1;
    const mode = slot.signature ? 'signature' : (row?.mode ?? 'none');
    if (mode === 'field') out.mapped += 1;
    else if (mode === 'handler') out.handler += 1;
    else if (mode === 'ignore') out.ignored += 1;
    else if (mode === 'signature') out.signature += 1;
    else out.unmapped += 1;
  }
  return out;
}

export function mappingStatusBadge(row: MappingDraftRow | undefined, slot: Pick<DocxSlot, 'signature'>): BadgeSpec {
  if (slot.signature || row?.mode === 'signature') return { label: 'Signed by hand', tone: 'grey', title: 'Signature, initials and date-signed boxes are never filled' };
  if (!row) return { label: 'Not mapped', tone: 'amber' };
  if (row.changed) return { label: 'Changed', tone: 'blue', title: 'Not saved yet' };
  if (row.mode === 'none' || row.origin === 'none') return { label: 'Not mapped', tone: 'amber', title: 'Left as printed until mapped' };
  switch (row.origin) {
    case 'builtin':
      return { label: 'Built-in', tone: 'navy' };
    case 'saved':
      return { label: 'Saved', tone: 'blue' };
    case 'suggested':
      return { label: `Suggested ${typeof row.score === 'number' ? row.score.toFixed(2) : ''}`.trim(), tone: 'amber', title: 'Suggested from the label; check it and save' };
  }
  return { label: 'Not mapped', tone: 'amber' };
}

export interface OptionGroupSpec {
  label: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}

/** Field select: "Handler fills" and "Leave as printed" first, then the dictionary by group (dictionary order). */
export function fieldSelectGroups(fields: DocxFieldDef[]): OptionGroupSpec[] {
  const groups: OptionGroupSpec[] = [
    {
      label: 'Not from the claim',
      options: [
        { value: FIELD_HANDLER, label: 'Handler fills' },
        { value: FIELD_IGNORE, label: 'Leave as printed' }
      ]
    }
  ];
  const byGroup = new Map<string, OptionGroupSpec>();
  for (const f of fields) {
    let g = byGroup.get(f.group);
    if (!g) {
      g = { label: f.group, options: [] };
      byGroup.set(f.group, g);
      groups.push(g);
    }
    g.options.push({ value: f.key, label: f.label });
  }
  return groups;
}

export const FORMAT_OPTIONS: Array<{ value: FormatName; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'date-compact', label: 'Date 04/10/2026' },
  { value: 'date-long', label: 'Date 4 October 2026' },
  { value: 'date-boxes', label: 'Date boxes 04 / 10 / 2026' },
  { value: 'datetime-compact', label: 'Date and time 04/10/2026 09:30' },
  { value: 'datetime-boxes', label: 'Date and time boxes' },
  { value: 'time', label: 'Time 09 : 30' },
  { value: 'month-year-boxes', label: 'Month and year boxes' },
  { value: 'money', label: 'Money £1,234.56' },
  { value: 'money-digits', label: 'Money digits 1,234.56' },
  { value: 'reg', label: 'Registration AB12 CDE' },
  { value: 'upper', label: 'UPPER CASE' },
  { value: 'title', label: 'Title Case' },
  { value: 'ordinal', label: 'Ordinal (1st, 2nd)' },
  { value: 'miles', label: 'Miles 45,210' },
  { value: 'int', label: 'Whole number' },
  { value: 'lines', label: 'One item per line' },
  { value: 'inline', label: 'On one line' }
];

export const MAPPING_ISSUE_LABEL: Record<MappingIssue['code'], string> = {
  SELECTOR_NO_MATCH: 'A mapping points at a blank that is no longer in the file',
  SELECTOR_AMBIGUOUS: 'A mapping matches more than one blank',
  UNKNOWN_KEY: 'A mapping uses a field that does not exist',
  KIND_MISMATCH: 'A field does not suit the kind of blank',
  POLICY_LAXER: 'A mapping fills more readily than the field allows',
  DUPLICATE_SLOT: 'Two mappings for the same blank'
};

export function mappingIssueLabel(code: string): string {
  return (MAPPING_ISSUE_LABEL as Record<string, string>)[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

export const WARNING_CODE_LABEL: Record<string, string> = {
  LEGACY_DETAIL: 'Old company detail in the wording',
  BANNED_PHRASE: 'Phrase ClaimDesk does not allow',
  REGULATED_STATUS: 'Wording that may imply regulated status',
  BRAND_CLAIM_IMAGE: 'Accreditation image in the footer',
  TRACKED_CHANGES: 'Tracked changes',
  COMMENTS: 'Comments',
  LEGACY_FORM_FIELDS: 'Old-style form fields',
  EXTERNAL_IMAGE: 'Image linked from outside the file',
  EMBEDDED_OBJECT: 'Embedded object',
  UNMAPPED_SLOTS: 'Blanks that are not mapped'
};

export function warningCodeLabel(code: string): string {
  return WARNING_CODE_LABEL[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export const MAX_TEMPLATE_BYTES = 15 * 1024 * 1024;

export interface UploadForm {
  file: { name: string; size: number } | null;
  title: string;
  kind: string;
  description: string;
  recipientRole: string;
}

export function emptyUploadForm(): UploadForm {
  return { file: null, title: '', kind: 'letter', description: '', recipientRole: '' };
}

export function validateUpload(form: UploadForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.file) errors.file = 'Choose a Word file (.docx or .dotx)';
  else if (!/\.(docx|dotx)$/i.test(form.file.name)) errors.file = 'Only Word .docx or .dotx files can be used as templates';
  else if (form.file.size > MAX_TEMPLATE_BYTES) errors.file = 'The file is larger than 15 MB';
  else if (form.file.size === 0) errors.file = 'The file is empty';
  if (!form.title.trim()) errors.title = 'Give the template a title';
  else if (form.title.trim().length > 200) errors.title = 'Keep the title under 200 characters';
  if (!TEMPLATE_KIND_OPTIONS.some((k) => k.value === form.kind)) errors.kind = 'Choose what kind of document this is';
  return errors;
}

/** A starting title from the file name: "Client-Update_Letter v2.docx" → "Client Update Letter v2". */
export function titleFromFileName(name: string): string {
  return name
    .replace(/\.(docx|dotx)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// PDF converters
// ---------------------------------------------------------------------------

export const CONVERTER_NAME: Record<DocxConverterId, string> = { word: 'Microsoft Word', libreoffice: 'LibreOffice', browser: 'built-in browser' };

export interface ConverterLine {
  id: DocxConverterId;
  name: string;
  state: string;
  ok: boolean;
  detail?: string;
  preferred: boolean;
}

/** One line per converter in the order they are tried; the browser is always there unless detection says otherwise. */
export function converterLines(res: DocxConvertersResponse | undefined): ConverterLine[] {
  const order: DocxConverterId[] = res?.order?.length ? res.order : ['word', 'libreoffice', 'browser'];
  const firstOk = order.find((id) => (id === 'browser' ? res?.available?.browser?.ok !== false : Boolean(res?.available?.[id]?.ok)));
  return order.map((id) => {
    const status = res?.available?.[id];
    const ok = id === 'browser' ? status?.ok !== false : Boolean(status?.ok);
    const state = !res ? 'checking…' : id === 'browser' ? (ok ? 'always available' : 'not available') : ok ? 'found' : 'not found';
    return { id, name: CONVERTER_NAME[id], state, ok, detail: status?.detail ?? status?.path, preferred: Boolean(res) && id === firstOk };
  });
}

/** "PDFs are produced with: Microsoft Word (found) / LibreOffice (not found) / built-in browser (always available)". */
export function converterSentence(res: DocxConvertersResponse | undefined): string {
  return `PDFs are produced with: ${converterLines(res)
    .map((l) => `${l.name} (${l.state})`)
    .join(' / ')}`;
}
