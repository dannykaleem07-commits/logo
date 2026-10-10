// owned by ap-paperwork
/**
 * Stage packs (docs/SUPREME-AUTOPILOT.md §D.6) — data: which templates, variants, signer and when, for each paperwork
 * stage of a claim — and the pure helpers around them (item keys, conditional items, pack status, send targets).
 *
 * `when` names a predicate over the claim's facts. The Autopilot catalogue (autopilot/predicates.ts, ap-autopilot)
 * evaluates the same ids; until then the API evaluates them from the claim bundle (apps/api/src/signing/packs.ts).
 * Every id used here is listed in PACK_PREDICATE_IDS and the integrity test checks that.
 *
 * Template ids: Word templates (`*.ccguk_*`) are DOCX; everything else is an HTML template in the registry. The
 * integrity test in packages/documents (stagePacks.test.ts) checks every id is registered and every variant exists.
 */
import type { ISODateTime } from '../types.js';
import type { AutopilotStepId } from '../autopilot/types.js';
import type { DocumentPack, DocumentPackStatus, PackItemDef, PackItemStatus, PackStage } from './types.js';

/** Predicate ids the pack definitions use (evaluated over the claim facts). */
export const PACK_PREDICATE_IDS = [
  /** Recovery, storage or an engineer is needed (CCGUK-02 instruction). */
  'vehicle.recovery_storage_or_engineer_needed',
  /** The claim relies on impecuniosity (CCGUK-07 statement of means). */
  'means.impecuniosity_relied_on',
  /** Storage charges are claimed. */
  'storage.claimed',
  /** Recovery charges are claimed. */
  'recovery.claimed',
  /** An independent engineer was instructed. */
  'engineer.instructed',
] as const;
export type PackPredicateId = (typeof PACK_PREDICATE_IDS)[number];

/** The stage packs of §D.6. Order is the order documents are shown, signed and attached. */
export const STAGE_PACKS: Readonly<Record<PackStage, readonly PackItemDef[]>> = Object.freeze({
  signup: [
    { templateId: 'agreement.ccguk_01_customer_loa', format: 'docx', purpose: 'sign', signer: 'client' },
    { templateId: 'form.ccguk_09_accident_report', format: 'docx', purpose: 'sign', signer: 'client' },
    { templateId: 'agreement.ccguk_02_recovery_storage_engineering', variant: 'instruction', format: 'docx', purpose: 'sign', signer: 'client', when: 'vehicle.recovery_storage_or_engineer_needed' },
  ],
  hire_offer: [
    { templateId: 'form.statement_of_need', format: 'html', purpose: 'sign', signer: 'client' },
    { templateId: 'form.ccguk_07_statement_of_means', format: 'docx', purpose: 'sign', signer: 'client', when: 'means.impecuniosity_relied_on' },
    { templateId: 'form.ccguk_08_intervention_mitigation', format: 'docx', purpose: 'sign', signer: 'client' },
  ],
  hire_start: [
    { templateId: 'agreement.ccguk_03_credit_hire', variant: 'hirer', format: 'docx', purpose: 'sign', signer: 'hirer' },
    { templateId: 'agreement.ccguk_03_credit_hire', variant: 'office', format: 'docx', purpose: 'internal' },
    { templateId: 'form.cancellation_sch3', format: 'html', purpose: 'give', signer: 'hirer' },
    { templateId: 'form.express_request_to_start', format: 'html', purpose: 'sign', signer: 'hirer' },
    { templateId: 'form.ccguk_06_handover_condition', variant: 'release', format: 'docx', purpose: 'sign', signer: 'hirer' },
    { templateId: 'form.hire_cover_confirmation', format: 'html', purpose: 'give', signer: 'hirer' },
  ],
  off_hire: [
    { templateId: 'form.ccguk_06_handover_condition', variant: 'return', format: 'docx', purpose: 'sign', signer: 'hirer' },
    { templateId: 'letter.booking_confirmation', format: 'html', purpose: 'give', signer: 'client' },
  ],
  billing: [
    { templateId: 'invoice.hire', format: 'html', purpose: 'internal' },
    { templateId: 'invoice.storage', format: 'html', purpose: 'internal', when: 'storage.claimed' },
    { templateId: 'invoice.recovery', format: 'html', purpose: 'internal', when: 'recovery.claimed' },
    { templateId: 'invoice.engineer_fee', format: 'html', purpose: 'internal', when: 'engineer.instructed' },
    { templateId: 'form.hire_period_validation', format: 'html', purpose: 'sign', signer: 'hirer' },
    { templateId: 'form.ccguk_05_payment_direction', format: 'docx', purpose: 'sign', signer: 'client' },
  ],
  payment: [
    { templateId: 'letter.ccguk_letterhead_formal', format: 'docx', purpose: 'send_insurer' },
    { templateId: 'pack.gta_payment', format: 'html', purpose: 'send_insurer' },
    { templateId: 'schedule.loss', format: 'html', purpose: 'send_insurer' },
    { templateId: 'statement.ccguk_04_witness', format: 'docx', purpose: 'sign', signer: 'client' },
  ],
  closure: [{ templateId: 'letter.closure', format: 'html', purpose: 'give', signer: 'client' }],
});

/** Things a person checks for the hire-start pack that are not documents (§D.6). */
export const STAGE_CHECKLISTS: Readonly<Partial<Record<PackStage, readonly { id: string; label: string }[]>>> = Object.freeze({
  hire_start: [
    { id: 'licence_evidence', label: 'Driving licence seen and captured as evidence' },
    { id: 'dvla_check', label: 'DVLA licence check dated within the last 14 days' },
    { id: 'proof_of_address', label: 'Proof of address on file' },
  ],
});

/** The Autopilot step that prepares each pack (§A.3); the pack's Needs-you card and log lines carry it. */
export const PACK_STAGE_STEP: Readonly<Record<PackStage, AutopilotStepId>> = Object.freeze({
  signup: 'signup.pack',
  hire_offer: 'hire.offer',
  hire_start: 'hire.pack',
  off_hire: 'hire.offhire',
  billing: 'money.invoices',
  payment: 'money.payment_pack',
  closure: 'close.readiness',
});

export const PACK_STAGE_LABELS: Readonly<Record<PackStage, string>> = Object.freeze({
  signup: 'Sign-up pack',
  hire_offer: 'Hire offer pack',
  hire_start: 'Hire-start pack',
  off_hire: 'Off-hire pack',
  billing: 'Billing pack',
  payment: 'Payment pack',
  closure: 'Closure',
});

/** Stable key of an item inside a pack (a template may appear twice with different variants). */
export function packItemKey(item: Pick<PackItemDef, 'templateId' | 'variant'>): string {
  return `${item.templateId}:${item.variant ?? '-'}`;
}

/** Word (DOCX) template ids carry `ccguk_` after the kind. */
export function isDocxTemplateId(templateId: string): boolean {
  return /^[a-z]+\.ccguk_/.test(templateId);
}

export type PackItem = DocumentPack['items'][number];

/**
 * The items of a stage for one claim: every definition, with `not_needed` where its `when` predicate is false.
 * Unknown predicates count as true (prepare rather than silently drop a document).
 */
export function resolvePackItems(stage: PackStage, holds: (predicate: string) => boolean | undefined): PackItem[] {
  return STAGE_PACKS[stage].map((def) => {
    const needed = def.when ? holds(def.when) !== false : true;
    return { ...def, status: needed ? 'pending' : 'not_needed' };
  });
}

/** Items that are part of the pack (not `not_needed`). */
export const activePackItems = (items: readonly PackItem[]): PackItem[] => items.filter((i) => i.status !== 'not_needed');

const ITEM_RANK: Record<PackItemStatus, number> = { pending: 0, drafted: 1, reviewed: 2, approved: 3, sent: 4, signed: 5, not_needed: 99 };

/**
 * Pack status derived from its items (pure; never moves a superseded or cancelled pack):
 * any item pending → preparing; any drafted → reviewing; all reviewed → awaiting_approval; all approved → approved;
 * every document to sign signed (and the rest at least sent or approved) → signed; else sent when anything was sent.
 */
export function derivePackStatus(current: DocumentPackStatus, items: readonly PackItem[]): DocumentPackStatus {
  if (current === 'superseded' || current === 'cancelled') return current;
  const active = activePackItems(items);
  if (active.length === 0) return current === 'preparing' ? 'awaiting_approval' : current;
  const min = Math.min(...active.map((i) => ITEM_RANK[i.status]));
  if (min === ITEM_RANK.pending) return 'preparing';
  if (min === ITEM_RANK.drafted) return 'reviewing';
  if (min === ITEM_RANK.reviewed) return 'awaiting_approval';
  const toSign = active.filter((i) => i.purpose === 'sign');
  if (toSign.length > 0 && toSign.every((i) => i.status === 'signed')) return 'signed';
  if (active.some((i) => i.status === 'sent' || i.status === 'signed')) return 'sent';
  return 'approved';
}

export type PackSendTarget = 'client' | 'at_fault_insurer';

/** Which recipients "Approve and send" emails, and which items go to each. Internal items are never sent. */
export function packSendGroups(items: readonly PackItem[]): Array<{ target: PackSendTarget; items: PackItem[] }> {
  const active = activePackItems(items);
  const client = active.filter((i) => i.purpose === 'sign' || i.purpose === 'give');
  const insurer = active.filter((i) => i.purpose === 'send_insurer');
  const out: Array<{ target: PackSendTarget; items: PackItem[] }> = [];
  if (client.length > 0) out.push({ target: 'client', items: client });
  if (insurer.length > 0) out.push({ target: 'at_fault_insurer', items: insurer });
  return out;
}

// ---------------------------------------------------------------------------
// Wet-signature chase schedule (§E.4): chase after 2 and 5 days, call after 7 (Settings > Autopilot > Signing)
// ---------------------------------------------------------------------------

export interface ChaseSchedule {
  chaseAfterDays: readonly number[];
  callAfterDays: number;
}

export const DEFAULT_CHASE_SCHEDULE: ChaseSchedule = { chaseAfterDays: [2, 5], callAfterDays: 7 };

const DAY_MS = 86_400_000;

function addDays(iso: ISODateTime, days: number): ISODateTime {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

/** When the next chase (or the call) is due after `chaseCount` chases, or undefined when nothing more is due. */
export function nextChaseAt(sentAt: ISODateTime, chaseCount: number, schedule: ChaseSchedule = DEFAULT_CHASE_SCHEDULE): ISODateTime | undefined {
  const days = [...schedule.chaseAfterDays].sort((a, b) => a - b);
  if (chaseCount < days.length) return addDays(sentAt, days[chaseCount]!);
  if (chaseCount === days.length) return addDays(sentAt, schedule.callAfterDays);
  return undefined;
}

export type ChaseAction = { action: 'chase'; chaseNumber: number } | { action: 'call' } | { action: 'wait'; until: ISODateTime } | { action: 'none' };

/**
 * What `signing.chase` does for one open request at `now`: send chase N (after 2 and 5 days), raise the call (after 7
 * days, once), wait, or nothing (signed / returned / declined / cancelled / call already raised).
 */
export function chaseAction(
  req: { status: string; sentAt?: ISODateTime | null; chaseCount: number },
  now: ISODateTime,
  schedule: ChaseSchedule = DEFAULT_CHASE_SCHEDULE,
): ChaseAction {
  if (!req.sentAt || (req.status !== 'sent' && req.status !== 'chased')) return { action: 'none' };
  const due = nextChaseAt(req.sentAt, req.chaseCount, schedule);
  if (!due) return { action: 'none' };
  if (Date.parse(now) < Date.parse(due)) return { action: 'wait', until: due };
  const chases = schedule.chaseAfterDays.length;
  if (req.chaseCount < chases) {
    // One chase per run: when several chase days have passed (the PC was off), the next run sends the next one.
    return { action: 'chase', chaseNumber: req.chaseCount + 1 };
  }
  return { action: 'call' };
}
