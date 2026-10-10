// owned by ap-autopilot
/**
 * The facts the planner reads (docs/SUPREME-AUTOPILOT.md §A.4). Assembled by the API (`loadAutopilotFacts`,
 * apps/api/src/autopilot/facts.ts) from the claim bundle and the Autopilot tables; pure from here on.
 *
 * Additions beyond the design text (all derived by code, never by a model): `recordedAcceptance` (the acceptance row
 * the clash detector also reads), `fnol`, `clientEmail`, `autoOffersToday`, `lastPersonStatusAt`, `lastRun` (when the
 * runner last executed each step, from autopilot_log) and `ownerChosenReservationIds` (holds a person placed, so the
 * offer is owner-authorised).
 */
import type { JobStatus, MailIntent, NeedsYouKind } from '../agents/types.js';
import type { AvailabilityResult, HireNeeds, Movement, Reservation } from '../booking/types.js';
import type { ClashFinding } from '../clash/types.js';
import type { EligibilitySummary } from '../eligibility/types.js';
import type { DocumentPack, PackStage, SignatureRequest } from '../signing/types.js';
import type { CaseAcceptance, ClaimBundle, EventType, GateResult, ISODateTime, Id, PlaybookAction, SettlementOffer } from '../types.js';
import type { AutopilotSettings } from './settings.js';
import type { AutopilotOverride, AutopilotStepId, ClaimAutopilotMode, HireOffer } from './types.js';

export interface AutopilotOutboxFact {
  id: Id;
  kind: string;
  status: string;
  autopilotStepId: string | null;
  createdAt: ISODateTime;
  sentAt: ISODateTime | null;
}

export interface AutopilotFacts {
  now: ISODateTime;
  bundle: ClaimBundle;
  /** assessAcceptance(bundle, { gates, now }) — computed now. */
  acceptance: CaseAcceptance | null;
  /** The acceptance decision recorded on the claim (eligibility_assessments kind 'acceptance'). */
  recordedAcceptance: { decision: string; conditions: string[]; at: ISODateTime } | null;
  gates: GateResult[];
  playbook: PlaybookAction[];
  needs: HireNeeds | null;
  eligibility: EligibilitySummary | null;
  reservations: Reservation[];
  hireOffers: HireOffer[];
  movements: Movement[];
  packs: DocumentPack[];
  signatures: SignatureRequest[];
  /** Open (unresolved, not overridden, not acknowledged) findings for this claim and its reservations. */
  clashes: ClashFinding[];
  /** Computed by the API only when hire.search / hire.choose could be due. */
  availability: AvailabilityResult | null;
  outbox: AutopilotOutboxFact[];
  openNeedsYou: Array<{ id: Id; kind: NeedsYouKind; dedupeKey: string | null }>;
  openJobs: Array<{ id: Id; type: string; idempotencyKey: string | null; status: JobStatus }>;
  settlementOffers: SettlementOffer[];
  lastInbound: { at: ISODateTime; intent: MailIntent | string; messageId: Id } | null;
  claimAutopilot: { mode: ClaimAutopilotMode; overrides: Partial<Record<AutopilotStepId, AutopilotOverride>> };
  /** SD claim_agent_state.paused. */
  agentPaused: boolean;
  settings: AutopilotSettings;
  // --- additions (see header) ---
  fnol: { valid: boolean; missing: string[] };
  clientEmail: { onFile: boolean; bounced: boolean };
  autoOffersToday: number;
  lastPersonStatusAt: ISODateTime | null;
  lastRun: Partial<Record<AutopilotStepId, ISODateTime>>;
  ownerChosenReservationIds: Id[];
  /** "Run now" (§A.8): a step the tick treats as due. */
  forceStepId?: AutopilotStepId;
}

// ---------------------------------------------------------------------------
// Accessors shared by predicates, the planner and the runner
// ---------------------------------------------------------------------------

const LIVE: ReadonlyArray<Reservation['status']> = ['held', 'confirmed', 'on_hire'];
const RES_RANK: Record<Reservation['status'], number> = { on_hire: 5, confirmed: 4, held: 3, returned: 2, expired: 1, cancelled: 0 };

/** The claim's reservation that matters now: on hire > confirmed > held > the latest returned. */
export function activeReservation(f: Pick<AutopilotFacts, 'reservations'>): Reservation | undefined {
  const sorted = [...f.reservations].sort((a, b) => RES_RANK[b.status] - RES_RANK[a.status] || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const top = sorted[0];
  return top && (LIVE.includes(top.status) || top.status === 'returned') ? top : undefined;
}

/** A live (held / confirmed / on hire) reservation of the claim. */
export function liveReservation(f: Pick<AutopilotFacts, 'reservations'>): Reservation | undefined {
  const r = activeReservation(f);
  return r && LIVE.includes(r.status) ? r : undefined;
}

/** The newest offer bound to a reservation (any status). */
export function offerFor(f: Pick<AutopilotFacts, 'hireOffers'>, reservationId: Id | undefined): HireOffer | undefined {
  if (!reservationId) return undefined;
  return [...f.hireOffers].filter((o) => o.reservationId === reservationId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
}

/**
 * The offer that matters now: the newest offer of the active reservation; with no live reservation, the newest offer
 * when it is still sent, accepted or expired (a late "yes" after the hold ran out re-holds the car, §D.4).
 */
export function currentOffer(f: Pick<AutopilotFacts, 'hireOffers' | 'reservations'>): HireOffer | undefined {
  const r = activeReservation(f);
  const own = offerFor(f, r?.id);
  if (own || r) return own;
  const latest = [...f.hireOffers].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
  return latest && (latest.status === 'sent' || latest.status === 'accepted' || latest.status === 'expired') ? latest : undefined;
}

/** First event of a type (chronology order), or undefined. */
export function firstEvent(f: Pick<AutopilotFacts, 'bundle'>, type: EventType): ClaimBundle['events'][number] | undefined {
  return [...f.bundle.events].filter((e) => e.type === type).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0];
}

/** Latest event of a type. */
export function lastEvent(f: Pick<AutopilotFacts, 'bundle'>, type: EventType): ClaimBundle['events'][number] | undefined {
  return [...f.bundle.events].filter((e) => e.type === type).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
}

/** The pack of a stage that counts (not superseded / cancelled), newest first. */
export function packOf(f: Pick<AutopilotFacts, 'packs'>, stage: PackStage, reservationId?: Id): DocumentPack | undefined {
  return [...f.packs]
    .filter((p) => p.stage === stage && p.status !== 'superseded' && p.status !== 'cancelled' && (!reservationId || !p.reservationId || p.reservationId === reservationId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
}

/** The open hire record (or the latest one). */
export function currentHire(f: Pick<AutopilotFacts, 'bundle'>): ClaimBundle['hire'][number] | undefined {
  const hires = [...f.bundle.hire].sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  return hires.filter((h) => !h.endAt).pop() ?? hires[hires.length - 1];
}

export const movementsOf = (f: Pick<AutopilotFacts, 'movements'>, reservationId: Id | undefined, kind: Movement['kind']): Movement[] =>
  f.movements.filter((m) => m.reservationId === reservationId && m.kind === kind && m.status !== 'cancelled' && m.status !== 'failed');

export const msOf = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : NaN);
