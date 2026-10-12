// owned by intake-web
/**
 * Case bundle screen model (docs/SMART-INTAKE.md §11): labels, tones, ordering and small derivations. Pure; unit-tested.
 * Wording rule (§4.11, §15): nothing here describes a client or a document as untrue — risk signals are plain facts
 * with the innocent explanation, for the owner only.
 */
import type { Tone } from '../../../lib/status';
import type {
  Blocker,
  BundleDetail,
  BundleFileView,
  BundleGroup,
  BundleSummary,
  ChecklistItem,
  Conflict,
  ConflictOption,
  DraftField,
  DraftFieldStatus,
  DraftSection,
  FieldSource,
  FileStage,
  GroupAction,
  Readiness,
  RiskSignal,
  TimelineProposal,
  WaitingReason,
} from '../../../api/bundlesApi';

// ---------------------------------------------------------------------------
// Readiness, reasoning, stages
// ---------------------------------------------------------------------------

export const READINESS_LABEL: Record<Readiness, string> = {
  reading: 'Reading',
  needs_review: 'Needs review',
  ready_to_register: 'Ready to register',
  registered: 'Registered',
  attached: 'Attached',
  cancelled: 'Cancelled',
};

export const READINESS_TONE: Record<Readiness, Tone> = {
  reading: 'blue',
  needs_review: 'amber',
  ready_to_register: 'green',
  registered: 'navy',
  attached: 'navy',
  cancelled: 'grey',
};

/** "Reading 5/12" · "Needs review" · "Ready to register" · "Registered CCG-2026-00042" · "Attached" · "Cancelled". */
export function readinessText(s: Pick<BundleSummary, 'readiness' | 'fileCounts' | 'claim'>): string {
  if (s.readiness === 'reading') return `Reading ${s.fileCounts.read}/${s.fileCounts.total}`;
  if (s.readiness === 'registered' && s.claim) return `Registered ${s.claim.reference}`;
  if (s.readiness === 'attached' && s.claim) return `Attached to ${s.claim.reference}`;
  return READINESS_LABEL[s.readiness];
}

export const WAITING_TEXT: Record<WaitingReason, string> = {
  agents_off: 'agents are switched off',
  kill_switch: 'agents are stopped',
  usage: 'the AI usage limit is reached',
  sign_in: 'Claude needs signing in again',
};

export function waitingSentence(w: { reason: WaitingReason; until?: string } | null | undefined): string | null {
  if (!w) return null;
  const base = WAITING_TEXT[w.reason] ?? 'the agents are paused';
  if (w.reason === 'usage' && w.until) return `${base} (resets at ${clock(w.until)})`;
  return base;
}

/** The reasoning chip in the bundle header (§11.4). */
export function reasoningChip(r: BundleSummary['reasoning']): { label: string; tone: Tone; title: string } {
  switch (r.status) {
    case 'done':
      return { label: 'AI checked', tone: 'green', title: r.at ? `The AI read the files together at ${clock(r.at)}` : 'The AI read the files together' };
    case 'queued':
      return { label: 'AI check queued', tone: 'blue', title: 'The AI reads all the files together once they have all been read' };
    case 'waiting_ai':
      return { label: `AI check queued — ${waitingSentence(r.waiting) ?? 'agents are paused'}`, tone: 'amber', title: 'This draft is from the documents’ text; the AI will check it when the agents are back' };
    case 'failed':
      return { label: 'AI check did not finish', tone: 'red', title: 'The draft below is from the documents’ text only. Use Think again to retry.' };
    case 'skipped':
      return { label: 'Rules only', tone: 'grey', title: 'Read from the documents’ text without the AI' };
    default:
      return { label: 'Rules only', tone: 'grey', title: 'Read from the documents’ text without the AI (the AI check starts when every file is read)' };
  }
}

export const STAGE_TONE: Record<FileStage, Tone> = {
  stored: 'grey',
  reading: 'blue',
  splitting: 'blue',
  waiting_ai: 'amber',
  reading_ai: 'blue',
  read: 'green',
  read_rules_only: 'navy',
  unpacked: 'grey',
  skipped: 'grey',
  failed: 'red',
};

export const STAGE_FALLBACK_LABEL: Record<FileStage, string> = {
  stored: 'Stored',
  reading: 'Reading',
  splitting: 'Splitting',
  waiting_ai: 'Waiting for the AI',
  reading_ai: 'AI reading',
  read: 'Read',
  read_rules_only: 'Read without AI',
  unpacked: 'Unpacked',
  skipped: 'Not read',
  failed: 'Problem',
};

export function stageLabel(f: { stage: FileStage; stageLabel?: string | null }): string {
  return f.stageLabel || STAGE_FALLBACK_LABEL[f.stage] || f.stage;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const GROUP_ORDER: Record<BundleGroup['kind'], number> = { main: 0, new_case: 1, existing_claim: 2, unsure: 3, excluded: 4 };

/** Columns in board order: This case · New case B … · existing claims · Not sure · Excluded. */
export function orderGroups(groups: BundleGroup[]): BundleGroup[] {
  return [...groups].sort((a, b) => GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind] || a.key.localeCompare(b.key));
}

/** "2 cases + 1 existing claim + 3 not sure" from the groups (excluded files are not counted). */
export function groupsText(groups: BundleGroup[]): string {
  const cases = groups.filter((g) => g.kind === 'main' || g.kind === 'new_case').length;
  const claims = groups.filter((g) => g.kind === 'existing_claim').length;
  const unsure = groups.find((g) => g.kind === 'unsure')?.fileIds.length ?? 0;
  const parts: string[] = [];
  if (cases) parts.push(cases === 1 ? '1 case' : `${cases} cases`);
  if (claims) parts.push(claims === 1 ? '1 existing claim' : `${claims} existing claims`);
  if (unsure) parts.push(`${unsure} not sure`);
  return parts.join(' + ') || 'No files yet';
}

/** List row text from the summary alone (it only carries the count). */
export function groupCountText(n: number): string {
  if (n <= 0) return '—';
  return n === 1 ? 'One case' : `${n} groups`;
}

/** Where a file can be moved: every other group, plus "a new case". */
export function moveTargets(groups: BundleGroup[], current: string): Array<{ value: string; label: string }> {
  const out = orderGroups(groups)
    .filter((g) => g.key !== current && g.kind !== 'excluded')
    .map((g) => ({ value: g.key, label: g.label }));
  out.push({ value: 'new', label: 'A new case' });
  return out;
}

/** What the Register dialog does with each other group by default. */
export function defaultGroupActions(groups: BundleGroup[]): Record<string, GroupAction> {
  const out: Record<string, GroupAction> = {};
  for (const g of groups) {
    if (g.kind === 'main' || g.kind === 'excluded' || !g.fileIds.length) continue;
    if (g.defaultAction === 'attach' && g.kind === 'existing_claim') out[g.key] = 'attach';
    else if (g.defaultAction === 'exclude') out[g.key] = 'exclude';
    else out[g.key] = 'split_off';
  }
  return out;
}

export const GROUP_ACTION_LABEL: Record<GroupAction, string> = {
  split_off: 'Make it a separate bundle',
  attach: 'File them on that claim',
  exclude: 'Leave them out',
};

export interface FileNode {
  file: BundleFileView;
  /** Duplicates (shown collapsed under their primary) and segments of a pack. */
  copies: BundleFileView[];
  segments: BundleFileView[];
}

/**
 * The cards of one column: top-level files with their duplicates and pack segments nested. A child whose parent is in
 * another column is shown on its own (with its badge) so nothing disappears.
 */
export function fileNodes(files: BundleFileView[], groupKey: string): FileNode[] {
  const inGroup = files.filter((f) => f.groupKey === groupKey).sort((a, b) => a.position - b.position);
  const ids = new Set(inGroup.map((f) => f.id));
  const nodes = new Map<string, FileNode>();
  const order: string[] = [];
  const nestedUnder = (f: BundleFileView): string | null => {
    if (f.duplicate && ids.has(f.duplicate.of) && f.duplicate.of !== f.id) return f.duplicate.of;
    if (f.role === 'segment' && f.parentFileId && ids.has(f.parentFileId)) return f.parentFileId;
    return null;
  };
  for (const f of inGroup) {
    if (nestedUnder(f) === null) {
      nodes.set(f.id, { file: f, copies: [], segments: [] });
      order.push(f.id);
    }
  }
  for (const f of inGroup) {
    const parent = nestedUnder(f);
    if (parent === null) continue;
    const node = nodes.get(parent);
    if (!node) {
      nodes.set(f.id, { file: f, copies: [], segments: [] });
      order.push(f.id);
    } else if (f.duplicate) node.copies.push(f);
    else node.segments.push(f);
  }
  return order.map((id) => nodes.get(id)!);
}

export const DUPLICATE_TEXT: Record<NonNullable<BundleFileView['duplicate']>['kind'], string> = {
  same_file: 'exact copy',
  same_text: 'same letter again',
  near_photo: 'same photo, resized',
  near_text: 'almost the same text',
};

/** "copy of IMG_2041.png" */
export function duplicateBadge(f: BundleFileView, files: BundleFileView[]): string | null {
  if (!f.duplicate) return null;
  const of = files.find((x) => x.id === f.duplicate!.of);
  return `copy of ${of?.filename ?? 'another file'}`;
}

/** "pages 1–2" */
export function pagesText(seg: { fromPage: number; toPage: number } | null): string | null {
  if (!seg) return null;
  return seg.fromPage === seg.toPage ? `page ${seg.fromPage}` : `pages ${seg.fromPage}–${seg.toPage}`;
}

export function fileIcon(f: Pick<BundleFileView, 'mime' | 'role' | 'filename'>): string {
  if (f.role === 'archive') return 'ZIP';
  if (f.role === 'email' || /\.eml$/i.test(f.filename)) return 'EML';
  if (f.mime.startsWith('image/')) return 'IMG';
  if (f.mime === 'application/pdf') return 'PDF';
  if (/word|docx?$/i.test(f.mime) || /\.docx?$/i.test(f.filename)) return 'DOC';
  return 'FILE';
}

export const isImage = (f: Pick<BundleFileView, 'mime'>): boolean => /^image\/(jpeg|png|gif|webp)$/i.test(f.mime);

// ---------------------------------------------------------------------------
// Draft fields, provenance, conflicts
// ---------------------------------------------------------------------------

export const SECTION_ORDER: DraftSection[] = ['client', 'driver', 'vehicle', 'third_party', 'accident', 'insurers', 'hire_repair'];

export const SECTION_LABEL: Record<DraftSection, string> = {
  client: 'Client',
  driver: 'Driver',
  vehicle: 'Client’s car',
  third_party: 'Other side',
  accident: 'Accident',
  insurers: 'Insurers',
  hire_repair: 'Hire & repair',
};

export function fieldsBySection(fields: DraftField[]): Array<{ section: DraftSection; label: string; fields: DraftField[] }> {
  return SECTION_ORDER.map((section) => ({ section, label: SECTION_LABEL[section], fields: fields.filter((f) => f.section === section) })).filter((s) => s.fields.length > 0);
}

export const FIELD_STATUS_LABEL: Record<DraftFieldStatus, string> = {
  ok: 'OK',
  low_confidence: 'Low confidence',
  conflict: 'Conflict',
  missing: 'Missing',
  owner_set: 'Set by you',
  invalid: 'Invalid',
};

export const FIELD_STATUS_TONE: Record<DraftFieldStatus, Tone> = {
  ok: 'green',
  low_confidence: 'amber',
  conflict: 'red',
  missing: 'grey',
  owner_set: 'navy',
  invalid: 'red',
};

export const ENGINE_LABEL: Record<FieldSource['engine'], string> = {
  ai: 'AI',
  rules: 'read without AI',
  exif: 'photo data',
  plate: 'number plate in a photo',
  owner: 'you',
  name_hint: 'bundle name',
  ai_reasoning: 'AI (all files together)',
};

/** "V5C · p1" for the source chip. */
export function provenanceLabel(s: Pick<FieldSource, 'docTypeLabel' | 'filename' | 'page' | 'engine' | 'label'>): string {
  if (s.engine === 'owner') return 'You';
  if (s.engine === 'name_hint') return 'Bundle name';
  const what = s.docTypeLabel ?? s.filename;
  return s.page ? `${what} · p${s.page}` : what;
}

/** Options in display order: the preselected (best source) first, then by source rank. */
export function orderedOptions(c: Conflict): ConflictOption[] {
  return [...c.options].sort((a, b) => Number(b.preselected) - Number(a.preselected) || b.rank - a.rank || a.display.localeCompare(b.display));
}

/** "best source: V5C" */
export function bestSourceText(o: ConflictOption): string | null {
  const top = [...o.sources].sort((a, b) => b.rank - a.rank)[0];
  if (!top) return null;
  return `best source: ${top.docTypeLabel ?? top.filename}`;
}

export const openConflicts = (d: Pick<BundleDetail, 'conflicts'>): Conflict[] => d.conflicts.filter((c) => c.status === 'open');

/** Every reading of a field across files (the value shown plus the alternatives), for the provenance drawer. */
export function readingsOf(field: DraftField): Array<{ value: string; source: FieldSource }> {
  const out: Array<{ value: string; source: FieldSource }> = [];
  if (field.source && field.display !== null) out.push({ value: field.display ?? field.value ?? '', source: field.source });
  for (const a of field.alternatives) for (const s of a.sources) out.push({ value: a.display, source: s });
  return out;
}

/** "Client's own words — accident report form, page 2" / "From the police report — not the client's account: please confirm". */
export function circumstancesNote(d: BundleDetail): { text: string; tone: Tone } | null {
  const field = d.draft.fields.find((f) => f.key === 'accident.circumstances');
  const a = d.draft.circumstances.attribution;
  if (!field || !field.value || !a) return null;
  const src = field.source ? `${field.source.docTypeLabel ?? field.source.filename}${field.source.page ? `, page ${field.source.page}` : ''}` : null;
  if (a === 'client') return { text: `Client’s own words${src ? ` — ${src}` : ''}`, tone: 'green' };
  if (a === 'owner') return { text: 'Written by you', tone: 'navy' };
  const from = a === 'police' ? 'the police report' : a === 'insurer' ? 'an insurer’s letter' : a === 'witness' ? 'a witness statement' : src ?? 'another document';
  return { text: `From ${from} — not the client’s account: please confirm`, tone: 'amber' };
}

// ---------------------------------------------------------------------------
// Blockers, register
// ---------------------------------------------------------------------------

export function ownerBlockers(blockers: Blocker[]): Blocker[] {
  return blockers.filter((b) => b.for === 'owner');
}

/** The first owner blocker's text (the Register button tooltip), or null when the owner can register. */
export function firstBlockerText(blockers: Blocker[]): string | null {
  return ownerBlockers(blockers)[0]?.text ?? null;
}

/** Where a blocker's "fix it" link points on the bundle page. */
export const BLOCKER_ANCHOR: Record<string, string> = {
  OPEN_CONFLICTS: '#bundle-conflicts',
  MISSING_REQUIRED: '#bundle-draft',
  FNOL_INCOMPLETE: '#bundle-draft',
  MATCHES_EXISTING_CLAIM: '#bundle-match',
  FILES_IN_PROGRESS: '#bundle-files',
};

/** The `willDo` lines (server) or, when absent, a plain derivation from the detail. */
export function willDoLines(d: BundleDetail): string[] {
  if (d.register.willDo.length) return d.register.willDo;
  const main = d.groups.find((g) => g.kind === 'main');
  const mainFiles = d.files.filter((f) => main?.fileIds.includes(f.id));
  const copies = mainFiles.filter((f) => f.duplicate).length;
  const filled = d.draft.fields.filter((f) => f.value).length;
  const ticked = d.timeline.filter((t) => t.ticked && t.class !== 'owner_only').length;
  const zones = new Set(mainFiles.flatMap((f) => f.photo?.zones.map((z) => z.zoneId) ?? [])).size;
  const missing = d.checklist.items.filter((i) => i.status === 'missing' || i.status === 'partial').length;
  const lines = [`Creates the claim with ${filled} details`, `Files ${mainFiles.length - copies} documents${copies ? ` (${copies} ${copies === 1 ? 'copy' : 'copies'} not filed twice)` : ''}`];
  if (ticked) lines.push(`Adds ${ticked} chronology ${ticked === 1 ? 'entry' : 'entries'}`);
  if (zones) lines.push(`Records damage on ${zones} ${zones === 1 ? 'part' : 'parts'}`);
  if (missing) lines.push(`Prepares a request for ${missing} ${missing === 1 ? 'document' : 'documents'} (you approve it before it is sent)`);
  for (const g of d.groups) {
    if (g.kind === 'new_case' || g.kind === 'unsure') lines.push(`${g.label} becomes its own bundle`);
    if (g.kind === 'existing_claim' && g.claim) lines.push(`${g.fileIds.length} ${g.fileIds.length === 1 ? 'file goes' : 'files go'} to ${g.claim.reference}`);
  }
  return lines;
}

/** "Register claim for Jane Doe" */
export function registerTitle(d: BundleDetail): string {
  const name = d.draft.fields.find((f) => f.key === 'client.name')?.display;
  return name ? `Register claim for ${name}` : 'Register claim';
}

/** Main group matched to an existing claim (banner "This looks like CCG-…"). */
export function mainClaimMatch(d: BundleDetail): { claimId: string; reference: string; reasons: string[] } | null {
  const main = d.groups.find((g) => g.key === 'main');
  const blocked = d.register.blockers.some((b) => b.code === 'MATCHES_EXISTING_CLAIM');
  if (!main) return null;
  if (main.kind === 'existing_claim' && main.claim) return { claimId: main.claim.id, reference: main.claim.reference, reasons: main.reasons.map((r) => r.text) };
  if (blocked) {
    const r = main.reasons.find((x) => x.code === 'possible_claim_match' || x.code === 'matches_claim');
    const ref = r?.text.match(/CCG-\d{4}-\d{5}/)?.[0];
    if (ref) return { claimId: '', reference: ref, reasons: main.reasons.map((x) => x.text) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checklist, timeline, signals, photos
// ---------------------------------------------------------------------------

export const CHECK_LABEL: Record<ChecklistItem['status'], string> = { have: 'Have it', partial: 'Partly', missing: 'Missing', not_needed: 'Not needed' };
export const CHECK_TONE: Record<ChecklistItem['status'], Tone> = { have: 'green', partial: 'amber', missing: 'red', not_needed: 'grey' };

/** "3 missing · 1 partly there" (or "Nothing missing"). */
export function checklistSummary(items: ChecklistItem[]): string {
  const missing = items.filter((i) => i.status === 'missing').length;
  const partial = items.filter((i) => i.status === 'partial').length;
  if (!missing && !partial) return 'Nothing missing';
  return [missing ? `${missing} missing` : '', partial ? `${partial} partly there` : ''].filter(Boolean).join(' · ');
}

export const TIMELINE_CLASS_LABEL: Record<TimelineProposal['class'], string> = {
  record: 'Record',
  clock: 'Starts a deadline',
  owner_only: 'You record this yourself',
};
export const TIMELINE_CLASS_TONE: Record<TimelineProposal['class'], Tone> = { record: 'grey', clock: 'blue', owner_only: 'amber' };

export function sortTimeline(items: TimelineProposal[]): TimelineProposal[] {
  return [...items].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export const SIGNAL_SEVERITY_LABEL: Record<RiskSignal['severity'], string> = { warn: 'Worth checking', info: 'For information' };
export const SIGNAL_SEVERITY_TONE: Record<RiskSignal['severity'], Tone> = { warn: 'amber', info: 'grey' };

/** Unacknowledged first, warnings before information. */
export function sortSignals(s: RiskSignal[]): RiskSignal[] {
  return [...s].sort((a, b) => Number(!!a.acknowledged) - Number(!!b.acknowledged) || (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1) || a.title.localeCompare(b.title));
}

/** True when a photo was taken before the accident (a signal names it, or its time is before the accident time). */
export function photoBeforeAccident(f: BundleFileView, signals: RiskSignal[], accidentAt: string | null): boolean {
  if (signals.some((s) => s.code === 'PHOTO_BEFORE_ACCIDENT' && s.fileIds.includes(f.id))) return true;
  if (!f.photo?.takenAt || !accidentAt) return false;
  const t = Date.parse(f.photo.takenAt);
  const a = Date.parse(accidentAt);
  return Number.isFinite(t) && Number.isFinite(a) && t < a - 2 * 3600_000;
}

export const PLATE_MATCH_LABEL: Record<'client' | 'third_party' | 'none', string> = { client: 'client’s car', third_party: 'other side', none: 'not on this case' };

export const SEVERITY_LABEL: Record<1 | 2 | 3, string> = { 1: 'light', 2: 'replace', 3: 'heavy' };

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(d);
}

/** "7 Oct 2026" or "7 Oct 2026, 14:20" (London). */
export function whenText(iso: string | null | undefined, precision: 'date' | 'datetime' = 'datetime'): string {
  if (!iso) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  if (precision === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return date;
  return `${date}, ${clock(iso)}`;
}

export const pct = (c: number): string => `${Math.round(Math.max(0, Math.min(1, c)) * 100)}%`;

/** ≥ 90 % green, ≥ 75 % amber, else red (the bundle's low-confidence line is 0.75). */
export function confidenceTone(c: number): Tone {
  return c >= 0.9 ? 'green' : c >= 0.75 ? 'amber' : 'red';
}

/** "1 thing worth a look" / "3 things worth a look". */
export function signalsText(s: { warn: number; info: number }): string | null {
  const n = s.warn + s.info;
  if (!n) return null;
  return `${n} ${n === 1 ? 'thing' : 'things'} worth a look`;
}

/** Highlight a quote inside a page text: returns [before, match, after] or null when not found (case/space-insensitive). */
export function splitOnQuote(text: string, quote: string | null): [string, string, string] | null {
  if (!quote) return null;
  const q = quote.trim();
  if (!q) return null;
  const exact = text.indexOf(q);
  if (exact >= 0) return [text.slice(0, exact), text.slice(exact, exact + q.length), text.slice(exact + q.length)];
  // whitespace- and case-tolerant search
  const words = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(words.join('\\s+'), 'i');
  const m = re.exec(text);
  if (!m) return null;
  return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)];
}
