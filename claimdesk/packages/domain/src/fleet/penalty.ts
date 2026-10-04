/**
 * PCN / NIP workflow state machine (BLUEPRINT §3.12; playbooks.md §6–§8).
 *
 *   received ── identify_hirer ──▶ hirer_identified ── transfer_liability ──▶ liability_transferred
 *      │                               │                                            │
 *      ├── represent ──▶ representations ── appeal ──▶ appeal                        ├── cancel ──▶ cancelled (transfer accepted)
 *      ├── pay ──▶ paid                 │                 │                          ├── represent ──▶ representations (transfer rejected)
 *      ├── cancel ──▶ cancelled         ├── cancel/pay/escalate                      └── pay / escalate
 *      └── escalate ──▶ escalated ── represent (TE7/TE9 or witness statement, on true facts only) / pay / cancel
 *
 * An appeal to the tribunal (London Tribunals / Traffic Penalty Tribunal; POPLA / IAS for private parking)
 * lies only against a rejection of representations, so 'appeal' is refused before 'representations'.
 * For a NIP / s.172 notice, 'transfer_liability' means naming the driver: it is allowed only when the
 * hire records establish who was driving (perimeter.md — never a nomination of someone who was not driving).
 */
import type { ISODateTime, PenaltyNotice } from '../types.js';
import { londonDate } from '../calendar/index.js';

export type PenaltyStage = PenaltyNotice['stage'];
export type PenaltyAction = 'identify_hirer' | 'transfer_liability' | 'represent' | 'appeal' | 'pay' | 'cancel' | 'escalate';

export interface PenaltyTransitionContext {
  now?: ISODateTime;
  /** The hire agreement that puts a hirer in the vehicle at the time (overrides notice.hireAgreementId). */
  hireAgreementId?: string;
  /** For nip_s172 only: the hire records (agreement, additional drivers, key log) establish who was driving. */
  driverConfirmedByRecords?: boolean;
  /** For 'appeal': a notice of rejection of representations has been received (default assumed true). */
  rejectionReceived?: boolean;
}

export interface PenaltyTransitionResult {
  from: PenaltyStage;
  next: PenaltyStage;
  allowed: boolean;
  reason?: string;
  warnings: string[];
  basis: string[];
}

const TERMINAL: ReadonlySet<PenaltyStage> = new Set(['paid', 'cancelled']);

const TABLE: Record<PenaltyStage, Partial<Record<PenaltyAction, PenaltyStage>>> = {
  received: { identify_hirer: 'hirer_identified', represent: 'representations', pay: 'paid', cancel: 'cancelled', escalate: 'escalated' },
  hirer_identified: { transfer_liability: 'liability_transferred', represent: 'representations', pay: 'paid', cancel: 'cancelled', escalate: 'escalated' },
  liability_transferred: { cancel: 'cancelled', represent: 'representations', pay: 'paid', escalate: 'escalated' },
  representations: { appeal: 'appeal', cancel: 'cancelled', pay: 'paid', escalate: 'escalated' },
  appeal: { cancel: 'cancelled', pay: 'paid', escalate: 'escalated' },
  escalated: { represent: 'representations', pay: 'paid', cancel: 'cancelled' },
  paid: {},
  cancelled: {},
};

export const PENALTY_BASIS: Record<PenaltyAction, string[]> = {
  identify_hirer: ['Hire register / hire agreement — who had the vehicle at the time of the contravention'],
  transfer_liability: ['Road Traffic (Owner Liability) Regulations 2000 Sch 2 — particulars of the hirer and signed statement of liability', 'Protection of Freedoms Act 2012 Sch 4 paras 13–14 (private parking)', 'RTA 1988 s.172(2)(a) (NIP: identify the driver from records only)'],
  represent: ['Traffic Management Act 2004 — representations within 28 days of the Notice to Owner / PCN; grounds: contravention did not occur, signage/lines non-compliant (TSRGD), PCN defective, vehicle hired out, procedural failure', 'Private parking: BPA/IPC Code — appeal to the operator within 28 days'],
  appeal: ['Traffic Management Act 2004 — appeal to London Tribunals / the Traffic Penalty Tribunal within 28 days of the notice of rejection', 'Private parking: POPLA (BPA) / IAS (IPC) after the operator rejects'],
  pay: ['Discount period (usually 14 days) then full charge; charge certificate adds 50% after the representations window'],
  cancel: ['Issuer cancels the notice (transfer accepted, representations accepted or appeal allowed)'],
  escalate: ['Charge certificate → order for recovery (TEC) → warrant; out-of-time relief only by TE7/TE9 or PE2/PE3 on true facts (Perjury Act 1911 s.5)'],
};

function refuse(from: PenaltyStage, reason: string, action: PenaltyAction, warnings: string[] = []): PenaltyTransitionResult {
  return { from, next: from, allowed: false, reason, warnings, basis: PENALTY_BASIS[action] };
}

export function penaltyTransition(notice: PenaltyNotice, action: PenaltyAction, ctx: PenaltyTransitionContext = {}): PenaltyTransitionResult {
  const from = notice.stage;
  const warnings: string[] = [];
  if (TERMINAL.has(from)) return refuse(from, `Notice ${notice.noticeNumber} is ${from}: no further action is possible.`, action);

  const next = TABLE[from][action];
  if (!next) {
    if (action === 'appeal') {
      return refuse(from, `An appeal to the tribunal lies only against a notice of rejection of formal representations: make representations first (current stage "${from}").`, action);
    }
    if (action === 'identify_hirer') return refuse(from, `The hirer is identified from the "received" stage only (current stage "${from}").`, action);
    if (action === 'transfer_liability') return refuse(from, `Liability is transferred after the hirer is identified (current stage "${from}").`, action);
    return refuse(from, `Action "${action}" is not available from stage "${from}".`, action);
  }

  if (action === 'identify_hirer' && !(ctx.hireAgreementId ?? notice.hireAgreementId)) {
    return refuse(from, 'No hire agreement identifies who had the vehicle at the time of the contravention: check the hire register, key log and tracker before anything else.', action);
  }

  if (action === 'transfer_liability' && notice.kind === 'nip_s172' && ctx.driverConfirmedByRecords !== true) {
    return refuse(
      from,
      'A s.172 response must name the person the hire records show was actually driving. Where the records cannot establish the driver, respond within 28 days setting out the reasonable-diligence position (s.172(4)) — never a nomination of someone who was not driving (perverting the course of justice; perimeter.md).',
      action,
    );
  }

  if (action === 'appeal' && ctx.rejectionReceived === false) {
    return refuse(from, 'The appeal window opens when the notice of rejection of representations is received; await it (28 days from the rejection).', action);
  }

  if (ctx.now && (action === 'represent' || action === 'appeal' || action === 'transfer_liability') && londonDate(ctx.now) > notice.responseDeadline) {
    warnings.push(`The response deadline ${notice.responseDeadline} has passed: an out-of-time step needs an honest explanation (defective service, wrong address on the DVLA record) — never a false statutory declaration (Perjury Act 1911 s.5).`);
  }
  if (action === 'represent' && from === 'escalated') {
    warnings.push('From the escalated stage, representations run through TE7/TE9 (TEC) or PE2/PE3 — statements of truth on true facts only.');
  }
  if (action === 'pay' && notice.discountDeadline && ctx.now && londonDate(ctx.now) > notice.discountDeadline) {
    warnings.push(`The discount period ended ${notice.discountDeadline}: the full amount is now payable.`);
  }

  return { from, next, allowed: true, warnings, basis: PENALTY_BASIS[action] };
}

/** Every action allowed from the notice's current stage, for the UI. */
export function allowedPenaltyActions(notice: PenaltyNotice, ctx: PenaltyTransitionContext = {}): PenaltyAction[] {
  const actions: PenaltyAction[] = ['identify_hirer', 'transfer_liability', 'represent', 'appeal', 'pay', 'cancel', 'escalate'];
  return actions.filter((a) => penaltyTransition(notice, a, ctx).allowed);
}
