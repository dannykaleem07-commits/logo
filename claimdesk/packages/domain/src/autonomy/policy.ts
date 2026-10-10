/**
 * The autonomy policy engine (docs/SUPREME-DESIGN.md §D.2): pure, ordered rules; the first match decides. Every rule id
 * reaches the `agent.policy` audit row and the daily log, so ids never change.
 */
import type { ActionClass, EmailKind, RecipientRole } from '../agents/types.js';
import type { CommitmentContext, StepContext } from '../autopilot/types.js';
import { isAlwaysAskEmailKind, isAlwaysAskTemplate, type AutonomySettings } from './settings.js';

export interface ReviewTouches {
  money: boolean;
  liability: boolean;
  settlement: boolean;
  legal: boolean;
  newCommitment: boolean;
}

export interface ActionDescriptor {
  class: ActionClass;
  /** e.g. 'email.chaser', 'document.letter.chaser_7', 'field.vehicle.vin'. */
  kind: string;
  claimId?: string;
  templateId?: string;
  emailKind?: EmailKind;
  recipient?: { address: string; role: RecipientRole; verified: boolean; firstContact: boolean; onClaim: boolean };
  /** 0..1 from the agent result. */
  confidence: number;
  review?: { verdict: 'pass' | 'repair' | 'escalate'; touches: ReviewTouches };
  consistencyBlocked?: boolean;
  missingInfo?: boolean;
  sensitive?: boolean;
  overwrites?: boolean;
  injectionSuspected?: boolean;
  spoofSuspected?: boolean;
  attachmentsAllowed?: boolean;
  /**
   * Autopilot (SUPREME-AUTOPILOT §0.6, §A.6): the step this action is taken for, with its effective mode and whether it
   * is green. Set by code only (dispatcher from `RunContext.step`, outbox decision path) — never from model input.
   */
  step?: StepContext;
  /** A hire offer / delivery slot commitment verified by code (§D.3). Set by code only. */
  commitment?: CommitmentContext;
}

export interface AutonomyState {
  killSwitch: boolean;
  agentPaused: boolean;
  claimPaused: boolean;
  sends: { claimToday: number; lastHour: number; today: number };
  /** HH:MM Europe/London. */
  nowLocal: string;
}

export type DecisionOutcome = 'auto' | 'auto_held' | 'ask' | 'deny';

export interface Decision {
  outcome: DecisionOutcome;
  holdMinutes?: number;
  holdUntilLocal?: string;
  reasons: string[];
  ruleIds: string[];
}

export type AutonomyRuleId =
  | 'destructive'
  | 'kill_switch'
  | 'paused'
  | 'untrusted_source'
  | 'step_owner_only'
  | 'step_confirm'
  | 'always_ask_classes'
  | 'shadow'
  | 'internal_sensitive'
  | 'internal_confidence'
  | 'internal_ok'
  | 'not_reviewed'
  | 'consistency_blocked'
  | 'missing_info'
  | 'touches'
  | 'recipient'
  | 'attachments'
  | 'allowlist'
  | 'external_confidence'
  | 'rate_limits'
  | 'quiet_hours'
  | 'external_ok'
  | 'read_draft';

/** The rules in evaluation order: SD §D.2's 21 plus Autopilot's 4a/4b (SUPREME-AUTOPILOT §A.6) after untrusted_source. */
export const AUTONOMY_RULE_IDS: readonly AutonomyRuleId[] = [
  'destructive',
  'kill_switch',
  'paused',
  'untrusted_source',
  'step_owner_only',
  'step_confirm',
  'always_ask_classes',
  'shadow',
  'internal_sensitive',
  'internal_confidence',
  'internal_ok',
  'not_reviewed',
  'consistency_blocked',
  'missing_info',
  'touches',
  'recipient',
  'attachments',
  'allowlist',
  'external_confidence',
  'rate_limits',
  'quiet_hours',
  'external_ok',
  'read_draft',
];

const minutesOf = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Is `nowLocal` inside the quiet-hours window [start, end)? Windows may cross midnight. */
export function inQuietHours(quiet: AutonomySettings['quietHours'], nowLocal: string): boolean {
  if (!quiet) return false;
  const s = minutesOf(quiet.start);
  const e = minutesOf(quiet.end);
  const n = minutesOf(nowLocal);
  if (![s, e, n].every(Number.isFinite) || s === e) return false;
  return s < e ? n >= s && n < e : n >= s || n < e;
}

/** Minutes from `nowLocal` to `until` (HH:MM, wrapping past midnight). */
export function minutesUntil(nowLocal: string, until: string): number {
  const d = minutesOf(until) - minutesOf(nowLocal);
  return d >= 0 ? d : d + 24 * 60;
}

const isReadOrDraft = (c: ActionClass): boolean => c === 'read' || c === 'draft';

type RuleResult = Omit<Decision, 'ruleIds'> | undefined;
type Rule = (a: ActionDescriptor, s: AutonomySettings, st: AutonomyState) => RuleResult;

const ask = (reason: string): RuleResult => ({ outcome: 'ask', reasons: [reason] });
const deny = (reason: string): RuleResult => ({ outcome: 'deny', reasons: [reason] });

const RULES: ReadonlyArray<readonly [AutonomyRuleId, Rule]> = [
  ['destructive', (a) => (a.class === 'destructive' ? deny('Destructive actions are never taken by an agent') : undefined)],
  ['kill_switch', (a, s, st) => ((st.killSwitch || s.killSwitch) && !isReadOrDraft(a.class) ? deny('Agents stopped (kill switch is on)') : undefined)],
  ['paused', (a, _s, st) => ((st.agentPaused || st.claimPaused) && !isReadOrDraft(a.class) ? ask(st.claimPaused ? 'Agents are paused on this claim' : 'This agent is paused') : undefined)],
  [
    'untrusted_source',
    (a) =>
      (a.injectionSuspected || a.spoofSuspected) && !isReadOrDraft(a.class)
        ? ask(a.spoofSuspected ? 'The source message may be spoofed' : 'The source message may contain instructions aimed at the agent')
        : undefined,
  ],
  // 4a / 4b (SUPREME-AUTOPILOT §A.6): an `owner` step is never attempted by an agent; a `confirm` step never acts alone.
  ['step_owner_only', (a) => (a.step?.mode === 'owner' && !isReadOrDraft(a.class) ? deny('A person does this step') : undefined)],
  ['step_confirm', (a) => (a.step?.mode === 'confirm' && !isReadOrDraft(a.class) ? ask('This step is set to ask you first') : undefined)],
  [
    'always_ask_classes',
    (a) => (a.class === 'money' || a.class === 'settlement' || a.class === 'legal' ? ask(`${a.class === 'money' ? 'Money' : a.class === 'settlement' ? 'Offers and settlements' : 'Legal matters'} always need the owner`) : undefined),
  ],
  ['shadow', (a, s) => (s.mode === 'shadow' && (a.class === 'internal' || a.class === 'external_send') ? ask('Shadow mode: the owner approves every action') : undefined)],
  ['internal_sensitive', (a) => (a.class === 'internal' && (a.sensitive || a.overwrites) ? ask(a.overwrites ? 'Would overwrite an existing value' : 'Sensitive field or record') : undefined)],
  [
    'internal_confidence',
    (a, s) => (a.class === 'internal' && !(a.confidence >= s.thresholds.internal) ? ask(`Confidence ${fmt(a.confidence)} is below ${fmt(s.thresholds.internal)}`) : undefined),
  ],
  ['internal_ok', (a) => (a.class === 'internal' ? { outcome: 'auto', reasons: ['Routine internal update'] } : undefined)],
  ['not_reviewed', (a) => (a.class === 'external_send' && a.review?.verdict !== 'pass' ? deny('The reviewer has not passed this draft') : undefined)],
  ['consistency_blocked', (a) => (a.class === 'external_send' && a.consistencyBlocked ? deny('The consistency check blocks this draft') : undefined)],
  ['missing_info', (a) => (a.class === 'external_send' && a.missingInfo ? ask('Information is missing: a prepared draft waits for the owner') : undefined)],
  [
    'touches',
    (a) => {
      if (a.class !== 'external_send' || !a.review) return undefined;
      // Refined (SUPREME-AUTOPILOT §A.6, §D.3): a commitment verified by code on an `auto` step is not a new commitment.
      const verifiedCommitment = a.commitment?.verified === true && a.step?.mode === 'auto';
      const hit = (Object.keys(a.review.touches) as Array<keyof ReviewTouches>).filter((k) => a.review!.touches[k] && !(k === 'newCommitment' && verifiedCommitment));
      return hit.length ? ask(`The draft touches ${hit.join(', ')}`) : undefined;
    },
  ],
  [
    'recipient',
    (a) => {
      if (a.class !== 'external_send') return undefined;
      const r = a.recipient;
      if (!r) return ask('No recipient to check');
      if (!r.onClaim) return ask(`${r.address} is not on the claim`);
      if (!r.verified) return ask(`${r.address} is not verified`);
      if (r.firstContact) return ask(`First contact with ${r.address}`);
      return undefined;
    },
  ],
  ['attachments', (a) => (a.class === 'external_send' && a.attachmentsAllowed === false ? ask('An attachment is not allowed for this recipient') : undefined)],
  [
    'allowlist',
    (a, s) => {
      if (a.class !== 'external_send') return undefined;
      if (!a.emailKind && !a.templateId) return ask('Neither an email kind nor a template to check against the allow-list');
      if (a.emailKind && (isAlwaysAskEmailKind(a.emailKind) || !s.autoSendEmailKinds.includes(a.emailKind))) return ask(`Email kind ${a.emailKind} is not sent automatically`);
      if (a.templateId && (isAlwaysAskTemplate(a.templateId) || !s.autoSendTemplates.includes(a.templateId))) return ask(`Template ${a.templateId} is not sent automatically`);
      return undefined;
    },
  ],
  [
    'external_confidence',
    (a, s) => (a.class === 'external_send' && !(a.confidence >= s.thresholds.external) ? ask(`Confidence ${fmt(a.confidence)} is below ${fmt(s.thresholds.external)}`) : undefined),
  ],
  [
    'rate_limits',
    (a, s, st) => {
      if (a.class !== 'external_send') return undefined;
      if (st.sends.claimToday >= s.limits.perClaimPerDay) return ask(`${st.sends.claimToday} automatic sends on this claim today (limit ${s.limits.perClaimPerDay})`);
      if (st.sends.lastHour >= s.limits.perHour) return ask(`${st.sends.lastHour} automatic sends in the last hour (limit ${s.limits.perHour})`);
      if (st.sends.today >= s.limits.perDay) return ask(`${st.sends.today} automatic sends today (limit ${s.limits.perDay})`);
      return undefined;
    },
  ],
  [
    'quiet_hours',
    (a, s, st) => {
      if (a.class !== 'external_send' || !s.quietHours || !inQuietHours(s.quietHours, st.nowLocal)) return undefined;
      const toEnd = minutesUntil(st.nowLocal, s.quietHours.end);
      return { outcome: 'auto_held', holdMinutes: Math.max(s.holdMinutes, toEnd), holdUntilLocal: s.quietHours.end, reasons: [`Quiet hours: held until ${s.quietHours.end}`] };
    },
  ],
  ['external_ok', (a, s) => (a.class === 'external_send' ? { outcome: 'auto_held', holdMinutes: s.holdMinutes, reasons: [`Allowed: held ${s.holdMinutes} minutes for Undo`] } : undefined)],
  ['read_draft', (a) => (isReadOrDraft(a.class) ? { outcome: 'auto', reasons: [a.class === 'read' ? 'Read only' : 'Draft only — nothing leaves the PC'] } : undefined)],
];

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

/** Decide what may happen with an agent action. Rules run in order; the first match decides (§D.2). */
export function decide(a: ActionDescriptor, s: AutonomySettings, st: AutonomyState): Decision {
  for (const [id, rule] of RULES) {
    const r = rule(a, s, st);
    if (r) return { ...r, ruleIds: [id] };
  }
  // Unreachable for a valid ActionClass; fail safe.
  return { outcome: 'ask', reasons: [`Unknown action class ${String(a.class)}`], ruleIds: ['unknown_class'] };
}
