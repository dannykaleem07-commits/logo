// owned by claimai-server
/**
 * Who may do what (docs/CLAIM-AI-INPUT.md §3.4, §6.1): the tier of every action is assigned by code from a fixed
 * table, never by the model. Money, offers / settlements and legal steps never apply directly; a call / voice note
 * (other people's words) never produces more than a `confirm` line, and only facts.
 */
import type { ActionClass } from '../agents/types.js';
import { ACCUSATION_WORDS, CLAIM_AI_DEFAULTS, CLAIM_AI_FORBIDDEN_STATUSES, type ActionFrom, type ActionParams, type ActionTier, type ActionType } from './types.js';

export const ACTION_CLASS: Readonly<Record<ActionType, ActionClass | 'none'>> = {
  event: 'internal',
  note: 'internal',
  field_update: 'internal',
  liability_position: 'internal',
  hire_end: 'internal',
  hire_correct: 'internal',
  hire_start: 'internal',
  task: 'draft',
  instruction: 'internal',
  pause_agents: 'internal',
  resume_agents: 'internal',
  run_job: 'draft',
  money: 'money',
  offer_received: 'settlement',
  offer_decision: 'settlement',
  legal: 'legal',
  status_change: 'internal',
  close_or_decline: 'legal',
  private_note: 'none',
  unsupported: 'none',
  file_evidence: 'internal',
  record_correspondence: 'internal',
};

export const DEFAULT_TIER: Readonly<Record<ActionType, ActionTier>> = {
  event: 'apply',
  note: 'apply',
  field_update: 'apply',
  liability_position: 'confirm',
  hire_end: 'apply',
  hire_correct: 'confirm',
  hire_start: 'open_screen',
  task: 'apply',
  instruction: 'apply',
  pause_agents: 'apply',
  resume_agents: 'apply',
  run_job: 'apply',
  money: 'needs_you',
  offer_received: 'confirm',
  offer_decision: 'needs_you',
  legal: 'needs_you',
  status_change: 'confirm',
  close_or_decline: 'needs_you',
  private_note: 'private',
  unsupported: 'refused',
  file_evidence: 'apply',
  record_correspondence: 'apply',
};

/** Types a call / voice note may produce (facts only). */
export const TRANSCRIPT_TYPES: ReadonlySet<ActionType> = new Set<ActionType>(['event', 'note', 'field_update', 'private_note']);

export const TIER_LABEL: Readonly<Record<ActionTier, string>> = {
  apply: 'Will do',
  confirm: 'Needs your tick',
  needs_you: 'Goes to Needs-you',
  open_screen: 'Open the screen',
  refused: "Won't do",
  private: 'Private note',
};

export interface TierContext {
  overwrites: boolean;
  sensitive: boolean;
  validatorOk: boolean;
  /** null = not checked (rules lines quote the owner's own clause). */
  quoteVerified: boolean | null;
  from: ActionFrom;
  confidence: number;
  openHires: number;
  datedInFuture: boolean;
  /** The text of an active hold that blocks this job, or null. */
  holdBlocks: string | null;
  killSwitch: boolean;
}

export const DEFAULT_TIER_CONTEXT: TierContext = {
  overwrites: false,
  sensitive: false,
  validatorOk: true,
  quoteVerified: null,
  from: 'owner_text',
  confidence: 1,
  openHires: 1,
  datedInFuture: false,
  holdBlocks: null,
  killSwitch: false,
};

export interface TierResult {
  tier: ActionTier;
  why: string | null;
  ticked: boolean;
  tickable: boolean;
}

const RANK: Record<ActionTier, number> = { refused: 0, private: 0, open_screen: 1, needs_you: 2, confirm: 3, apply: 4 };

function result(tier: ActionTier, why: string | null): TierResult {
  return { tier, why, ticked: tier === 'apply' || tier === 'needs_you', tickable: tier === 'apply' || tier === 'confirm' || tier === 'needs_you' };
}

/** Text an action would carry into chronology, instructions or prompts. */
function carriedText(p: ActionParams): string {
  return [p.text, p.summary, p.note, p.value, p.purpose].filter((x): x is string => typeof x === 'string').join(' ');
}

export function tierFor(type: ActionType, params: ActionParams, c: TierContext): TierResult {
  if (type === 'unsupported') return result('refused', params.reason ?? 'ClaimDesk cannot do this from an update');
  if (type === 'private_note') return result('private', 'Kept as your private note — agents never act on it');
  // Accusations never become an instruction, event, note or prompt text (owner rule: signals only).
  if (ACCUSATION_WORDS.test(carriedText(params)) && type !== 'money' && type !== 'offer_received') {
    return result('private', 'Kept as your private note — agents never act on it and never decline a claim');
  }
  if (c.from === 'transcript' && !TRANSCRIPT_TYPES.has(type)) return result('refused', 'From the call note — type it yourself if you want it done');
  if (type === 'status_change' && params.status && CLAIM_AI_FORBIDDEN_STATUSES.has(params.status)) {
    return result('needs_you', 'Closing, settling, declining and legal stages are yours to set from the status menu, with a reason');
  }
  if (type === 'run_job' && c.holdBlocks) return result('refused', `You asked: ${c.holdBlocks}`);
  if (type === 'hire_end' && c.openHires === 0) return result('refused', 'There is no running hire on this claim');

  const cls = ACTION_CLASS[type];
  let tier = DEFAULT_TIER[type];
  let why: string | null = null;
  if (cls === 'money' || cls === 'settlement' || cls === 'legal') {
    tier = type === 'offer_received' ? 'confirm' : 'needs_you';
    why = type === 'offer_received' ? 'Recording what the insurer offered — the decision stays with you' : cls === 'money' ? 'Money always goes to you' : cls === 'settlement' ? 'Offers and settlements are decided by you' : 'Legal steps always go to you';
  }
  const cap = (to: ActionTier, reason: string) => {
    if (RANK[tier] > RANK[to] && tier !== 'needs_you') {
      tier = to;
      why = why ?? reason;
    }
  };
  if (c.from === 'transcript') {
    cap('confirm', 'From the call note (other people’s words) — tick it if it is right');
  }
  if (c.quoteVerified === false) cap('confirm', 'The AI’s words are not in your note — check it');
  if (c.confidence < CLAIM_AI_DEFAULTS.lowConfidence) cap('confirm', 'Not sure I read this right — tick it if it is');
  if (type === 'field_update') {
    if (!c.validatorOk) cap('confirm', 'This value does not look valid — check it');
    else if (c.overwrites) cap('confirm', params.current ? `On file: ${params.current} — tick to replace` : 'Would replace the value on file');
    else if (c.sensitive) cap('confirm', 'A sensitive detail — tick to save it');
  }
  if (type === 'liability_position' || type === 'status_change' || type === 'hire_correct') {
    tier = RANK[tier] > RANK.confirm ? 'confirm' : tier;
    why = why ?? (type === 'liability_position' ? 'Liability changes need your tick' : type === 'status_change' ? 'Status changes need your tick' : 'Hire date corrections change the bill — tick to apply');
  }
  if (type === 'event' && params.eventType === 'total_loss_confirmed') cap('confirm', 'A write-off changes the hire and storage — tick to record it');
  if (type === 'hire_end' && params.endAt && params.startAt && Date.parse(params.endAt) < Date.parse(params.startAt)) cap('confirm', 'The end date is before the hire started — check it');
  if (c.datedInFuture && (type === 'event' || type === 'note' || type === 'hire_end')) cap('confirm', 'This date is in the future — check it');
  if (type === 'run_job' && c.killSwitch && params.jobKind !== 'review_now' && params.jobKind !== 'replan') why = why ?? 'Agents are stopped: the draft waits until they are back on';
  return result(tier, why);
}
