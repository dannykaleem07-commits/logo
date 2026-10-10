// owned by ap-autopilot
/** Pure helpers for the Autopilot tab and panels (docs/SUPREME-AUTOPILOT.md §I.1): labels, icons, grouping, countdowns. */
import type { AutopilotLogEntry, AutopilotPlan, StepMode, StepState, StepStatus } from '@ccguk/domain';
import type { Tone } from '../../../lib/status';
import type { CatalogueEntry } from '../../../api/autopilotApi';

export const STAGES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'enquiry', label: 'Enquiry' },
  { id: 'intake', label: 'Intake' },
  { id: 'qualification', label: 'Qualify' },
  { id: 'sign_up', label: 'Sign-up' },
  { id: 'vehicle_secured', label: 'Vehicle' },
  { id: 'hire_search', label: 'Find a car' },
  { id: 'hire_offer', label: 'Offer' },
  { id: 'hire_booked', label: 'Booked' },
  { id: 'handover', label: 'Handover' },
  { id: 'on_hire', label: 'On hire' },
  { id: 'off_hire', label: 'Off hire' },
  { id: 'billing', label: 'Billing' },
  { id: 'recovery', label: 'Recovery' },
  { id: 'closure', label: 'Closure' },
];

export const TERMINAL_LABEL: Record<string, string> = { declined: 'Declined', closed: 'Closed', legal: 'With the legal team' };

export const TRACKS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'intake', label: 'Intake' },
  { id: 'qualify', label: 'Qualify' },
  { id: 'signup', label: 'Sign-up' },
  { id: 'notify', label: 'Notify' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'hire', label: 'Hire' },
  { id: 'money', label: 'Money' },
  { id: 'close', label: 'Close' },
];

export const MODE_LABEL: Record<StepMode, string> = { auto: 'Auto', confirm: 'Ask me', owner: 'I do it' };
export const MODE_TONE: Record<StepMode, Tone> = { auto: 'green', confirm: 'amber', owner: 'navy' };

export const STATUS_ICON: Record<StepStatus, string> = {
  done: '✓',
  due: '●',
  waiting: '◷',
  blocked: '⛔',
  paused: '⏸',
  not_applicable: '–',
  upcoming: '○',
  in_progress: '…',
  skipped: '↷',
  failed: '✕',
};

export const STATUS_LABEL: Record<StepStatus, string> = {
  done: 'Done',
  due: 'Due',
  waiting: 'Waiting',
  blocked: 'Blocked',
  paused: 'Paused',
  not_applicable: 'Not needed',
  upcoming: 'Later',
  in_progress: 'In progress',
  skipped: 'Skipped',
  failed: 'Failed',
};

export const WAITING_LABEL: Record<string, string> = { client: 'client', insurer: 'insurer', engineer: 'engineer', repairer: 'repairer', supplier: 'supplier', owner: 'you', handler: 'handler', time: 'the right time', agent: 'an agent' };

/** Index of the current stage in the 14-stage bar (−1 for a terminal stage). */
export function stageIndex(stage: string): number {
  return STAGES.findIndex((s) => s.id === stage);
}

export function stageLabel(stage: string): string {
  return STAGES.find((s) => s.id === stage)?.label ?? TERMINAL_LABEL[stage] ?? stage;
}

export interface TimelineRow {
  state: StepState;
  def: CatalogueEntry | undefined;
}

export interface TrackGroup {
  id: string;
  label: string;
  open: TimelineRow[];
  done: TimelineRow[];
}

/** Steps grouped per track: open ones (not done / skipped / not needed) and done ones (collapsed in the UI). */
export function groupByTrack(plan: AutopilotPlan, catalogue: readonly CatalogueEntry[]): TrackGroup[] {
  const defs = new Map(catalogue.map((c) => [c.id, c]));
  return TRACKS.map((t) => {
    const rows = plan.steps.map((state) => ({ state, def: defs.get(state.id) })).filter((r) => r.def?.track === t.id);
    return {
      id: t.id,
      label: t.label,
      open: rows.filter((r) => !['done', 'skipped', 'not_applicable'].includes(r.state.status)),
      done: rows.filter((r) => r.state.status === 'done' || r.state.status === 'skipped'),
    };
  }).filter((g) => g.open.length || g.done.length);
}

/** "in 3 h", "in 2 days", "45 min overdue" — relative to `now`. */
export function countdown(dueAt: string | undefined, now: number): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const ms = Date.parse(dueAt) - now;
  if (!Number.isFinite(ms)) return null;
  const abs = Math.abs(ms);
  const unit = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))} min` : abs < 48 * 3_600_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} days`;
  return ms >= 0 ? { text: `in ${unit}`, overdue: false } : { text: `${unit} overdue`, overdue: true };
}

/** The Next card: the first due step (or the first waiting one), with its plain sentence. */
export function nextCard(plan: AutopilotPlan, catalogue: readonly CatalogueEntry[]): { stepId: string; title: string; text: string; mode: StepMode } | null {
  const id = plan.due[0] ?? plan.steps.find((s) => s.status === 'paused')?.id;
  const st = id ? plan.steps.find((s) => s.id === id) : undefined;
  if (!st) return null;
  // The plan's sentence already starts with "Next:" — the card prints its own label.
  return { stepId: st.id, title: catalogue.find((c) => c.id === st.id)?.title ?? st.id, text: st.next.replace(/^Next:\s*/i, ''), mode: st.mode };
}

/** Waiting-on chips: who we wait for and since when (the log row that put the step into `waiting`). */
export function waitingChips(plan: AutopilotPlan, log: readonly AutopilotLogEntry[]): Array<{ who: string; since: string | null; stepId: string }> {
  const out: Array<{ who: string; since: string | null; stepId: string }> = [];
  for (const s of plan.steps.filter((x) => x.status === 'waiting' && x.waitingOn)) {
    const since = log.filter((e) => e.stepId === s.id && e.toStatus === 'waiting').map((e) => e.at).sort().pop() ?? null;
    const label = WAITING_LABEL[s.waitingOn!] ?? s.waitingOn!;
    if (!out.some((o) => o.who === label)) out.push({ who: label, since, stepId: s.id });
  }
  return out;
}

/** How long ago, in owner words ("2 h", "3 days"). */
export function ago(iso: string | null, now: number): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} days`;
}

/** Who did a done step and when (latest log row taking it to done). */
export function doneBy(stepId: string, log: readonly AutopilotLogEntry[]): { at: string; actor: string } | null {
  const e = log.filter((x) => x.stepId === stepId && (x.toStatus === 'done' || x.action)).sort((a, b) => b.at.localeCompare(a.at))[0];
  return e ? { at: e.at, actor: e.actor === 'agent:autopilot' ? 'Autopilot' : e.actor } : null;
}
