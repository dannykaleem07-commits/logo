// owned by claimai-web
/**
 * AI input screen model (docs/CLAIM-AI-INPUT.md §14): labels, tones, line grouping and ordering, default ticks, the
 * Do-it count and body, catch-up direction/date labels, What-changed grouping, the draft store and layout helpers.
 * Pure (the draft store wraps localStorage in try/catch); unit-tested.
 *
 * Wording rule (§15): nothing here describes a client or a document as untrue, and nothing advises on an offer.
 */
import type { Tone } from '../../../lib/status';
import type {
  ActionEdits,
  ActionState,
  ActionTier,
  AgentScope,
  AiAction,
  AiInputCounts,
  AiInputKind,
  AiInputStatus,
  AiInputSummary,
  AiQuestion,
  AiWaiting,
  ApplyChoice,
  CatchUpDateSource,
  CatchUpDirection,
  CatchUpFile,
  ContactRole,
  EditableField,
  WaitingReason,
  WhatChanged,
  WhatChangedKind,
} from '../../../api/claimAiApi';

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** Display order of the tier groups in the preview. */
export const TIER_ORDER: readonly ActionTier[] = ['apply', 'confirm', 'needs_you', 'open_screen', 'private', 'refused'];

export const TIER_LABEL: Record<ActionTier, string> = {
  apply: 'Will do',
  confirm: 'Needs your tick',
  needs_you: 'Goes to Needs-you',
  open_screen: 'Open the screen',
  refused: "Won't do",
  private: 'Private note',
};

export const TIER_TONE: Record<ActionTier, Tone> = {
  apply: 'green',
  confirm: 'amber',
  needs_you: 'blue',
  open_screen: 'navy',
  refused: 'grey',
  private: 'grey',
};

/** One sentence under each tier heading. */
export const TIER_HINT: Record<ActionTier, string> = {
  apply: 'Done as soon as you press Do it.',
  confirm: 'Only done if you tick it.',
  needs_you: 'A card goes to Needs-you; you decide there. Nothing else changes.',
  open_screen: 'Needs a screen of its own — use the link.',
  refused: 'ClaimDesk will not do these.',
  private: 'Kept on this note for you only. Agents never act on it.',
};

export function tierLabel(a: Pick<AiAction, 'tier' | 'tierLabel'>): string {
  return a.tierLabel || TIER_LABEL[a.tier] || a.tier;
}

export interface TierGroup {
  tier: ActionTier;
  label: string;
  hint: string;
  actions: AiAction[];
}

function keyRank(key: string): [string, number] {
  const m = /^([a-z]*)(\d+)$/i.exec(key);
  return m ? [m[1]!, Number(m[2])] : [key, 0];
}

/** Stable action order: key prefix, then the number in the key (a2 before a10). */
export function compareKeys(a: string, b: string): number {
  const [pa, na] = keyRank(a);
  const [pb, nb] = keyRank(b);
  return pa.localeCompare(pb) || na - nb || a.localeCompare(b);
}

/** Lines grouped by tier in TIER_ORDER (empty groups left out), each group in key order. */
export function groupActions(actions: readonly AiAction[]): TierGroup[] {
  return TIER_ORDER.map((tier) => ({
    tier,
    label: TIER_LABEL[tier],
    hint: TIER_HINT[tier],
    actions: actions.filter((a) => a.tier === tier).sort((x, y) => compareKeys(x.key, y.key)),
  })).filter((g) => g.actions.length > 0);
}

// ---------------------------------------------------------------------------
// Ticks, edits and the Do-it body
// ---------------------------------------------------------------------------

export type Ticks = Record<string, boolean>;
export type Edits = Record<string, ActionEdits>;

/** The server's default ticks; a line that cannot be ticked is never ticked (confirm lines arrive unticked). */
export function defaultTicks(actions: readonly AiAction[]): Ticks {
  const out: Ticks = {};
  for (const a of actions) out[a.key] = a.tickable ? Boolean(a.ticked) : false;
  return out;
}

/** Lines still to do in this preview (proposed / not applied / failed): the ones Do it acts on. */
export function isPending(a: Pick<AiAction, 'state'>): boolean {
  return a.state === 'proposed' || a.state === 'not_applied' || a.state === 'failed';
}

/** Lines a partial apply left for the owner (never applied, not failed): the "Still waiting for you" list. */
export function isStillOpen(a: Pick<AiAction, 'state' | 'tickable'>): boolean {
  return a.tickable && (a.state === 'proposed' || a.state === 'not_applied');
}

export function isTicked(a: AiAction, ticks: Ticks): boolean {
  if (!a.tickable) return false;
  return ticks[a.key] ?? Boolean(a.ticked);
}

/** How many lines Do it will act on. */
export function doItCount(actions: readonly AiAction[], ticks: Ticks): number {
  return actions.filter((a) => isPending(a) && isTicked(a, ticks)).length;
}

export function doItLabel(n: number, verb = 'Do it'): string {
  return n > 0 ? `${verb} (${n})` : verb;
}

/** The apply body: every pending tickable line with its tick, plus the owner's edits (only for ticked lines). */
export function buildApplyChoices(actions: readonly AiAction[], ticks: Ticks, edits: Edits = {}): ApplyChoice[] {
  return actions
    .filter((a) => a.tickable && isPending(a))
    .sort((x, y) => compareKeys(x.key, y.key))
    .map((a) => {
      const ticked = isTicked(a, ticks);
      const e = cleanEdits(edits[a.key]);
      return ticked && e ? { key: a.key, ticked, edits: e } : { key: a.key, ticked };
    });
}

function cleanEdits(e: ActionEdits | undefined): ActionEdits | undefined {
  if (!e) return undefined;
  const out: ActionEdits = {};
  if (e.at) out.at = e.at;
  if (e.dueAt) out.dueAt = e.dueAt;
  if (e.value !== undefined && e.value !== '') out.value = e.value;
  if (e.text !== undefined && e.text.trim() !== '') out.text = e.text.trim();
  if (e.until !== undefined) out.until = e.until;
  if (e.appliesTo && e.appliesTo.length) out.appliesTo = e.appliesTo;
  return Object.keys(out).length ? out : undefined;
}

/** Validation of one inline edit (the server re-validates; this only catches what the owner can fix at once). */
export function validateEdit(field: EditableField, value: unknown, now: Date = new Date()): string | null {
  switch (field) {
    case 'at': {
      if (typeof value !== 'string' || !value) return 'Give the date';
      const t = Date.parse(value.length === 10 ? `${value}T12:00:00` : value);
      if (Number.isNaN(t)) return 'Not a date';
      if (t > now.getTime() + 60 * 60_000) return 'This already happened — it cannot be in the future';
      return null;
    }
    case 'dueAt': {
      if (typeof value !== 'string' || !value) return 'Give the date';
      return Number.isNaN(Date.parse(value)) ? 'Not a date' : null;
    }
    case 'until': {
      if (value === null || value === '') return null;
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return 'Not a date';
      return Date.parse(value.length === 10 ? `${value}T00:00:00` : value) <= now.getTime() ? 'Pick a day after today' : null;
    }
    case 'text':
    case 'value':
      return typeof value === 'string' && value.trim().length > 0 ? null : 'Cannot be empty';
    case 'appliesTo':
      return Array.isArray(value) && value.length > 0 ? null : 'Pick at least one';
    default:
      return null;
  }
}

/** Errors for every edited, ticked line (key → message). */
export function editErrors(actions: readonly AiAction[], ticks: Ticks, edits: Edits, now: Date = new Date()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of actions) {
    const e = edits[a.key];
    if (!e || !isTicked(a, ticks)) continue;
    for (const f of a.editable) {
      if (!(f in e)) continue;
      const msg = validateEdit(f, (e as Record<string, unknown>)[f], now);
      if (msg) {
        out[a.key] = msg;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line labels
// ---------------------------------------------------------------------------

export const SOURCE_LABEL: Record<AiAction['source'], string> = { rules: 'Read without AI', ai: 'AI', catch_up: 'From the documents' };
export const FROM_LABEL: Record<AiAction['from'], string> = { owner_text: 'your words', transcript: 'the call note', document: 'the document' };

export const STATE_LABEL: Record<ActionState, string> = {
  proposed: 'Not done yet',
  applied: 'Done',
  not_applied: 'Not done',
  skipped: 'Skipped',
  failed: 'Failed',
  needs_you: 'In Needs-you',
  undone: 'Undone',
};

export const STATE_TONE: Record<ActionState, Tone> = {
  proposed: 'grey',
  applied: 'green',
  not_applied: 'grey',
  skipped: 'grey',
  failed: 'red',
  needs_you: 'blue',
  undone: 'amber',
};

/** "Low confidence" note for lines the reader was unsure about. */
export function confidenceNote(a: Pick<AiAction, 'confidence' | 'source'>): string | null {
  if (a.source === 'rules') return null;
  return a.confidence < 0.7 ? `Not sure (${Math.round(a.confidence * 100)}%) — check it` : null;
}

export function canUndoLine(a: Pick<AiAction, 'state' | 'undo'>): boolean {
  return a.state === 'applied' && a.undo.available;
}

export function canRetryLine(a: Pick<AiAction, 'state' | 'tickable'>): boolean {
  return a.state === 'failed' && a.tickable;
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<AiInputStatus, string> = {
  interpreting: 'Reading',
  waiting_ai: 'Waiting for the AI',
  clarify: 'Question for you',
  preview: 'Ready to check',
  reading: 'Reading files',
  applying: 'Doing it',
  applied: 'Done',
  partly_applied: 'Partly done',
  nothing_to_do: 'Nothing to do',
  cancelled: 'Cancelled',
  failed: 'Could not read',
  undone: 'Undone',
};

export const STATUS_TONE: Record<AiInputStatus, Tone> = {
  interpreting: 'blue',
  waiting_ai: 'amber',
  clarify: 'amber',
  preview: 'amber',
  reading: 'blue',
  applying: 'blue',
  applied: 'green',
  partly_applied: 'amber',
  nothing_to_do: 'grey',
  cancelled: 'grey',
  failed: 'red',
  undone: 'grey',
};

export function statusLabel(s: Pick<AiInputSummary, 'status' | 'statusLabel'>): string {
  return s.statusLabel || STATUS_LABEL[s.status] || s.status;
}

/** Statuses where the owner still has something to do (or the server is still working). */
export const OPEN_STATUSES: ReadonlySet<AiInputStatus> = new Set(['interpreting', 'waiting_ai', 'clarify', 'preview', 'reading', 'applying', 'partly_applied']);
/** Statuses where the preview (ticks, Do it) is shown. */
export const PREVIEW_STATUSES: ReadonlySet<AiInputStatus> = new Set(['preview', 'clarify', 'waiting_ai']);
/** Statuses where the What-changed summary is shown. */
export const RESULT_STATUSES: ReadonlySet<AiInputStatus> = new Set(['applied', 'partly_applied', 'undone']);

export const KIND_LABEL: Record<AiInputKind, string> = { update: 'Update', catch_up: 'Catch-up' };

/** Fallback headline from the counts when the server sends none: "3 done · 1 for Needs-you · 2 need your tick". */
export function countsHeadline(c: AiInputCounts): string {
  const parts: string[] = [];
  if (c.applied) parts.push(`${c.applied} done`);
  if (c.needsYou) parts.push(`${c.needsYou} for Needs-you`);
  if (c.waitingTick) parts.push(`${c.waitingTick} need${c.waitingTick === 1 ? 's' : ''} your tick`);
  if (c.questions) parts.push(`${c.questions} question${c.questions === 1 ? '' : 's'}`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.undone) parts.push(`${c.undone} undone`);
  if (!parts.length && c.actions) parts.push(`${c.actions} line${c.actions === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function headlineOf(s: Pick<AiInputSummary, 'headline' | 'counts'>): string {
  return s.headline || countsHeadline(s.counts);
}

const WAITING_TEXT: Record<WaitingReason, string> = {
  agents_off: 'agents are switched off',
  kill_switch: 'agents are stopped',
  usage: 'the AI usage limit is reached',
  sign_in: 'Claude needs signing in again',
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(d);
}

/** "agents are switched off" · "the AI usage limit is reached (resets at 14:30)". */
export function waitingText(w: AiWaiting | null | undefined): string | null {
  if (!w) return null;
  const base = WAITING_TEXT[w.reason] ?? 'the agents are paused';
  return w.reason === 'usage' && w.until ? `${base} (resets at ${hhmm(w.until)})` : base;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "Sun 11 Oct 2026" (date) or "Sun 11 Oct 2026, 14:00" (datetime), London time. */
export function whenText(iso: string | null | undefined, precision: 'date' | 'datetime' | null = 'date'): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Built from parts: ICU versions differ on the comma after the weekday.
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(d);
  const part = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${part('weekday')} ${part('day')} ${part('month')} ${part('year')}`;
  if (precision !== 'datetime') return date;
  return `${date}, ${hhmm(iso)}`;
}

/** London calendar date (YYYY-MM-DD) of an instant, for date inputs. */
export function londonDate(iso: string | null | undefined): string {
  if (!iso) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// ---------------------------------------------------------------------------
// Catch-up files
// ---------------------------------------------------------------------------

export const DIRECTION_LABEL: Record<CatchUpDirection, string> = { out: 'Sent by us', in: 'Received', none: 'For the file', unknown: 'Who sent it?' };
export const DIRECTION_TONE: Record<CatchUpDirection, Tone> = { out: 'navy', in: 'blue', none: 'grey', unknown: 'amber' };
/** Options of the per-file direction select (an override; "Who sent it?" is not a choice). */
export const DIRECTION_OPTIONS: Array<{ value: 'out' | 'in' | 'none'; label: string }> = [
  { value: 'out', label: 'Sent by us' },
  { value: 'in', label: 'Received' },
  { value: 'none', label: 'For the file (not a letter)' },
];

export const DATE_SOURCE_LABEL: Record<CatchUpDateSource, string> = { document: 'from the letter', email_header: 'email date', owner: 'set by you', file_metadata: 'file date (check it)' };

export function dateSourceLabel(s: CatchUpDateSource | null): string {
  return s ? DATE_SOURCE_LABEL[s] : 'no date found';
}

export const PLAN_TONE: Record<CatchUpFile['plan'], Tone> = { file_and_record: 'green', file_only: 'navy', already_on_file: 'grey', other_claim: 'amber', excluded: 'grey', ask: 'amber' };

/** "pages 2–3" for a split segment. */
export function segmentText(s: CatchUpFile['segment']): string | null {
  if (!s) return null;
  return s.fromPage === s.toPage ? `page ${s.fromPage}` : `pages ${s.fromPage}–${s.toPage}`;
}

/** Files in display order: things that need the owner first ("Who sent it?", flagged dates), then by real date. */
export function orderCatchUpFiles(files: readonly CatchUpFile[]): CatchUpFile[] {
  const rank = (f: CatchUpFile) => (f.plan === 'ask' || f.direction === 'unknown' ? 0 : f.dateFlag ? 1 : f.plan === 'other_claim' ? 3 : 2);
  return [...files].sort((a, b) => rank(a) - rank(b) || (a.realDate ?? '9999').localeCompare(b.realDate ?? '9999') || a.filename.localeCompare(b.filename));
}

export function isImageFile(f: Pick<CatchUpFile, 'mime' | 'filename'>): boolean {
  return /^image\//.test(f.mime) || /\.(png|jpe?g|gif|webp|heic)$/i.test(f.filename);
}

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

export const WHAT_CHANGED_LABEL: Record<WhatChangedKind, string> = {
  filed: 'Filed',
  recorded: 'Recorded',
  event: 'Chronology',
  field: 'Details',
  hire: 'Hire',
  task: 'Reminders',
  instruction: 'Standing instructions',
  agents: 'Agents',
  job: 'Jobs',
  needs_you: 'Sent to Needs-you',
  clock: 'Clocks',
  autopilot: 'Autopilot',
  not_done: 'Not done',
};

const WHAT_CHANGED_ORDER: readonly WhatChangedKind[] = ['filed', 'recorded', 'event', 'field', 'hire', 'task', 'instruction', 'agents', 'job', 'needs_you', 'clock', 'autopilot', 'not_done'];

export interface WhatChangedGroup {
  kind: WhatChangedKind;
  label: string;
  lines: WhatChanged['lines'];
}

/** The summary's lines grouped by kind, in a fixed reading order (unknown kinds last, as "Other"). */
export function groupWhatChanged(w: WhatChanged | null | undefined): WhatChangedGroup[] {
  if (!w) return [];
  // Clock and Autopilot lines have their own sections when the structured parts are present — never shown twice.
  const lines = w.lines.filter(
    (l) => !(l.kind === 'clock' && w.clocks.length > 0) && !(l.kind === 'autopilot' && w.autopilot && (w.autopilot.stopped || w.autopilot.firstSteps.length > 0)),
  );
  const known = WHAT_CHANGED_ORDER.map((kind) => ({ kind, label: WHAT_CHANGED_LABEL[kind], lines: lines.filter((l) => l.kind === kind) })).filter((g) => g.lines.length);
  const other = lines.filter((l) => !WHAT_CHANGED_ORDER.includes(l.kind));
  return other.length ? [...known, { kind: 'not_done' as WhatChangedKind, label: 'Other', lines: other }] : known;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** "Label: started 2 Oct, met 6 Oct" → "started 2 Oct, met 6 Oct" (the label is shown once, beside it). */
export function withoutLabel(text: string | null, label: string): string | null {
  if (text == null) return null;
  return text.startsWith(`${label}: `) ? text.slice(label.length + 2) : text;
}

export function openQuestions(qs: readonly AiQuestion[]): AiQuestion[] {
  return qs.filter((q) => !q.answer);
}

// ---------------------------------------------------------------------------
// Standing instructions
// ---------------------------------------------------------------------------

export const AGENT_SCOPE_LABEL: Record<AgentScope, string> = {
  all: 'All agents',
  autopilot: 'Autopilot',
  case_manager: 'Case manager',
  mail: 'Mail',
  drafter: 'Drafter',
  intake: 'Intake',
};

export const AGENT_SCOPES: readonly AgentScope[] = ['all', 'autopilot', 'case_manager', 'mail', 'drafter', 'intake'];

export const CONTACT_LABEL: Record<ContactRole, string> = {
  client: 'the client',
  at_fault_insurer: 'the at-fault insurer',
  engineer: 'the engineer',
  repairer: 'the repairer',
  supplier: 'suppliers',
  solicitor: 'the solicitor',
  anyone: 'anyone',
};

/** Toggling a scope chip: "All agents" is exclusive; removing the last chip falls back to all. */
export function toggleScope(current: readonly AgentScope[], scope: AgentScope): AgentScope[] {
  if (scope === 'all') return ['all'];
  const without = current.filter((s) => s !== 'all');
  const next = without.includes(scope) ? without.filter((s) => s !== scope) : [...without, scope];
  return next.length ? next : ['all'];
}

// ---------------------------------------------------------------------------
// Update box: examples and the draft store
// ---------------------------------------------------------------------------

export const EXAMPLE_CHIPS: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'Client called…', text: 'Client called today: ' },
  { label: 'Hire ended…', text: 'Hire ended yesterday, car repaired. ' },
  { label: "Don't chase…", text: "Don't chase the client until Monday. " },
  { label: 'Insurer ref…', text: 'Their reference is ' },
  { label: 'Send a document…', text: 'Send the engineer report to the insurer. ' },
  { label: 'Remind me…', text: 'Remind me to call the insurer tomorrow. ' },
];

/** Insert an example at the end of the text (one space between). */
export function insertExample(text: string, example: string): string {
  if (!text.trim()) return example;
  return `${text.replace(/\s+$/, '')} ${example}`;
}

export const DRAFT_PREFIX = 'claimdesk.aiInput.draft.';
export const draftKey = (claimId: string) => `${DRAFT_PREFIX}${claimId}`;

export interface UpdateDraft {
  text: string;
  extra: string;
  channel: 'call_note' | 'voice_note';
}

export const EMPTY_DRAFT: UpdateDraft = { text: '', extra: '', channel: 'call_note' };

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadDraft(claimId: string, store: StorageLike | null = storage()): UpdateDraft {
  try {
    const raw = store?.getItem(draftKey(claimId));
    if (!raw) return { ...EMPTY_DRAFT };
    const v = JSON.parse(raw) as Partial<UpdateDraft> | string;
    if (typeof v === 'string') return { ...EMPTY_DRAFT, text: v };
    return { text: typeof v.text === 'string' ? v.text : '', extra: typeof v.extra === 'string' ? v.extra : '', channel: v.channel === 'voice_note' ? 'voice_note' : 'call_note' };
  } catch {
    return { ...EMPTY_DRAFT };
  }
}

export function saveDraft(claimId: string, d: UpdateDraft, store: StorageLike | null = storage()): void {
  try {
    if (!d.text && !d.extra) store?.removeItem(draftKey(claimId));
    else store?.setItem(draftKey(claimId), JSON.stringify(d));
  } catch {
    /* storage full or blocked: the draft lives in the component only */
  }
}

export function clearDraft(claimId: string, store: StorageLike | null = storage()): void {
  try {
    store?.removeItem(draftKey(claimId));
  } catch {
    /* ignore */
  }
}

export const MAX_TEXT_CHARS = 8000;
export const MAX_EXTRA_CHARS = 20_000;

/** Why Read it is not possible yet (null = it is). */
export function updateProblem(d: Pick<UpdateDraft, 'text' | 'extra'>): string | null {
  if (!d.text.trim() && !d.extra.trim()) return 'Type what happened, or paste a call note';
  if (d.text.length > MAX_TEXT_CHARS) return `Keep it under ${MAX_TEXT_CHARS} characters`;
  if (d.extra.length > MAX_EXTRA_CHARS) return `The call note is over ${MAX_EXTRA_CHARS} characters`;
  return null;
}

// ---------------------------------------------------------------------------
// Layout (§14.2): ≥ 960 px two columns; below, one column; ≤ 600 px phone details
// ---------------------------------------------------------------------------

export const TWO_COLUMN_MIN_PX = 960;
export const PHONE_MAX_PX = 600;

export function columnsFor(width: number): 1 | 2 {
  return width >= TWO_COLUMN_MIN_PX ? 2 : 1;
}

export function isPhoneWidth(width: number): boolean {
  return width <= PHONE_MAX_PX;
}

/** Statuses of a claim where AI input is not offered (closed files take no updates). */
export const CLOSED_CLAIM_STATUSES: ReadonlySet<string> = new Set(['closed', 'settled', 'declined']);
