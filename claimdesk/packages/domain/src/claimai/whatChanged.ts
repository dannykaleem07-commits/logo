// owned by claimai-server
/**
 * The "What changed" summary after an AI input is applied (docs/CLAIM-AI-INPUT.md §3.9, §11.1): one line per applied /
 * Needs-you / skipped / failed action, a line for every clock whose status, start or due date changed, and the
 * Autopilot's first steps after the re-plan. Pure.
 */
import type { Clock } from '../types.js';
import { fmtDayShort } from './dates.js';
import type { ActionState, ActionType, PlannedAction } from './types.js';

export type WhatChangedKind = 'filed' | 'recorded' | 'event' | 'field' | 'hire' | 'task' | 'instruction' | 'agents' | 'job' | 'needs_you' | 'clock' | 'autopilot' | 'not_done';

export interface WhatChanged {
  lines: Array<{ kind: WhatChangedKind; text: string; link: string | null }>;
  clocks: Array<{ label: string; before: string | null; after: string; status: string }>;
  autopilot: { stopped: string | null; firstSteps: Array<{ id: string; title: string; status: string; sentence: string }> } | null;
}

export type ClockView = Pick<Clock, 'kind' | 'label' | 'status' | 'startsAt' | 'dueAt'> & { metAt?: string; basis?: string };

export interface AppliedLine {
  action: PlannedAction;
  refs: Record<string, string>;
  state: ActionState;
  message?: string | null;
}

const KIND_OF: Readonly<Record<ActionType, WhatChangedKind>> = {
  event: 'event',
  note: 'event',
  field_update: 'field',
  liability_position: 'field',
  hire_end: 'hire',
  hire_correct: 'hire',
  hire_start: 'hire',
  task: 'task',
  instruction: 'instruction',
  pause_agents: 'agents',
  resume_agents: 'agents',
  run_job: 'job',
  money: 'needs_you',
  offer_received: 'recorded',
  offer_decision: 'needs_you',
  legal: 'needs_you',
  status_change: 'field',
  close_or_decline: 'needs_you',
  private_note: 'not_done',
  unsupported: 'not_done',
  file_evidence: 'filed',
  record_correspondence: 'recorded',
};

const STATUS_WORD: Record<string, string> = { running: 'running', met: 'met', breached: 'missed', stopped: 'stopped', not_applicable: 'not needed' };

/** "Handling reference (GTA 4.2): started 2 Oct, met 6 Oct" */
export function clockSentence(c: ClockView): string {
  const started = `started ${fmtDayShort(c.startsAt)}`;
  if (c.status === 'met') return `${c.label}: ${started}, met${c.metAt ? ` ${fmtDayShort(c.metAt)}` : ''}`;
  if (c.status === 'breached') return `${c.label}: ${started}, due ${fmtDayShort(c.dueAt)} — missed${c.metAt ? ` (done late, ${fmtDayShort(c.metAt)})` : ''}`;
  if (c.status === 'running') return `${c.label}: ${started}, due ${fmtDayShort(c.dueAt)}`;
  return `${c.label}: ${STATUS_WORD[c.status] ?? c.status}`;
}

function clockKey(c: ClockView): string {
  return `${c.kind}`;
}

export function clockChanges(before: ClockView[], after: ClockView[]): WhatChanged['clocks'] {
  const prev = new Map(before.map((c) => [clockKey(c), c]));
  const out: WhatChanged['clocks'] = [];
  for (const c of after) {
    const b = prev.get(clockKey(c));
    if (b && b.status === c.status && b.startsAt === c.startsAt && b.dueAt === c.dueAt && (b.metAt ?? null) === (c.metAt ?? null)) continue;
    out.push({ label: c.label, before: b ? clockSentence(b) : null, after: clockSentence(c), status: c.status });
  }
  return out;
}

function lineText(l: AppliedLine): string {
  const t = l.action.title.replace(/^Add to chronology: /, 'Chronology: ');
  switch (l.state) {
    case 'applied':
      return l.action.type === 'record_correspondence' ? t.replace(/^Record: /, 'Recorded: ') : l.action.type === 'file_evidence' ? t.replace(/^File /, 'Filed ') : t;
    case 'needs_you':
      return `Sent to Needs-you: ${t}`;
    case 'failed':
      return `Not done: ${t}${l.message ? ` — ${l.message}` : ''}`;
    case 'skipped':
    case 'not_applied':
      return `Not done: ${t}${l.message ? ` — ${l.message}` : ' (not ticked)'}`;
    case 'undone':
      return `Undone: ${t}`;
    default:
      return t;
  }
}

export function whatChangedLines(
  applied: AppliedLine[],
  clocksBefore: ClockView[],
  clocksAfter: ClockView[],
  plan?: { stopped: string | null; firstSteps: Array<{ id: string; title: string; status: string; sentence: string }> } | null,
  links?: (l: AppliedLine) => string | null,
): WhatChanged {
  const lines: WhatChanged['lines'] = [];
  for (const l of applied) {
    if (l.action.type === 'private_note') continue; // private: never in the summary
    const kind: WhatChangedKind = l.state === 'applied' ? KIND_OF[l.action.type] : l.state === 'needs_you' ? 'needs_you' : 'not_done';
    lines.push({ kind, text: lineText(l), link: links ? links(l) : null });
  }
  const clocks = clockChanges(clocksBefore, clocksAfter);
  for (const c of clocks) lines.push({ kind: 'clock', text: c.after, link: null });
  if (plan) for (const s of plan.firstSteps.slice(0, 3)) lines.push({ kind: 'autopilot', text: s.sentence, link: null });
  return { lines, clocks, autopilot: plan ? { stopped: plan.stopped, firstSteps: plan.firstSteps.slice(0, 5) } : null };
}
