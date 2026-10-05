/**
 * Hire API for the hire screens (docs/V03-MANAGER-MODE-HIRE-PRICING.md §B.3, §C.3): the hire list with pricing,
 * corrections and late-entry marks, the pricing guide for a fleet car, starting a hire (optionally already ended),
 * correcting its dates / rate / groups, and ending it.
 *
 * The HTTP shapes are declared here (web code never imports API code). GTA figures are a benchmark only; their
 * verification status is shown as the server reports it.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Clock, FleetUnit, FleetUse, GtaSuggestion, HireAgreement, HireCalculation, HireEndTrigger, Id, ISODate, ISODateTime, Pence, Verification } from '@ccguk/domain';
import { londonDate } from '@ccguk/domain';
import { asList, request, seg } from './client';
import { qk, useInvalidateClaim } from './hooks';
import { vehiclesApi, type VehiclePatchResult } from './vehiclesApi';

// ---------------------------------------------------------------------------
// Shapes (copies of the API's §B.3 / §C.3 types)
// ---------------------------------------------------------------------------

export type ClientGroupSource = 'recorded' | 'manual' | 'suggested' | 'none';

export interface PricingGuideLine {
  group: string | null;
  dailyRatePence: Pence | null;
  period?: string;
  verification?: Verification['status'];
  /** Why there is no rate (no group, or no benchmark rate loaded for the group). */
  missingReason?: string;
}

export interface PricingSuggestion {
  id: 'fleet' | 'hire_guide' | 'like_for_like';
  label: string;
  dailyRatePence: Pence;
}

/** GET /claims/:id/hire/pricing-guide. */
export interface HirePricingGuideResponse {
  date: ISODate;
  fleetDailyRatePence: Pence;
  /** GTA guide for the car we give (the fleet car's group). */
  hireCar: PricingGuideLine;
  /** GTA guide for the client's accident-damaged car (like for like). */
  clientCar: PricingGuideLine & { source: ClientGroupSource };
  /** hireCar − clientCar guide, null when either is missing. */
  differencePerDayPence: Pence | null;
  /** The car we give has a higher benchmark rate than the client's car (rates compared, never codes). */
  higherGroup: boolean;
  fleetAboveLikeForLikePence: Pence | null;
  /** Plain-English sentences, most important first. */
  notices: string[];
  suggestions: PricingSuggestion[];
  /** The benchmark caveat (CCGUK is not a GTA subscriber). */
  note: string;
  fleetUnit: { id: Id; registration?: string; make?: string; model?: string; status: FleetUnit['status']; gtaGroup: string; dailyRatePence: Pence };
  clientVehicle: { id: Id; registration: string; make?: string; model?: string; gtaGroup?: string };
  /** The full suggestion behind clientCar (confidence, basis, reason). */
  clientSuggestion: GtaSuggestion;
  /** Groups with a rate in force on `date`, for the "change" select. */
  groupsOnDate: string[];
}

/** Read-only pricing figures on each hire card. */
export interface HirePricingSnapshot {
  /** false for hires recorded before 0.3: figures worked out now from the client car's current group. */
  snapshot: boolean;
  agreedDailyRatePence: Pence;
  fleetDailyRatePence: Pence | null;
  hireGroup: string;
  hireGtaDailyRatePence: Pence | null;
  clientGtaGroup: string | null;
  clientGtaDailyRatePence: Pence | null;
  differencePerDayPence: Pence | null;
  higherGroup: boolean;
  notices: string[];
  note: string;
}

export interface HireCorrection {
  at: ISODateTime;
  by: string;
  byName?: string;
  reason: string;
  changes: Record<string, { from: unknown; to: unknown }>;
}

/** GET /claims/:id/hire item. Older API builds answer bare agreements, so every 0.3 field is optional here. */
export type HireListItem = HireAgreement & {
  calculation?: HireCalculation;
  enforceabilityGaps?: string[];
  pricing?: HirePricingSnapshot;
  recordedAt?: ISODateTime;
  recordedBy?: string;
  recordedByName?: string;
  /** Started more than 24 hours before it was recorded. */
  backdated?: boolean;
  corrections?: HireCorrection[];
};

export interface CreateHireBody {
  fleetUnitId: Id;
  startAt: ISODateTime;
  use: FleetUse;
  dailyRatePence: Pence;
  gtaGroup?: string;
  vatRate?: number;
  excessPence?: Pence;
  excessWaiverDailyPence?: Pence;
  deliveredAt?: ISODateTime;
  odometerOut?: number;
  signedAt?: ISODateTime;
  enforceability?: {
    cancellationInfoProvidedAt?: ISODateTime;
    schedule3FormProvidedAt?: ISODateTime;
    expressRequestToStartAt?: ISODateTime;
    cca60fCompliant?: boolean;
    notes?: string;
  };
  needStatementEvidenceId?: Id;
  /** A hire that has already ended (entered late): its end, what ended it and why. */
  endAt?: ISODateTime;
  endTrigger?: HireEndTrigger;
  endReason?: string;
  /** The client's car group chosen by hand on the pricing guide. */
  clientGtaGroup?: string;
}

export interface AllocationView {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

export interface CreateHireResponse {
  hire: HireAgreement;
  allocation?: AllocationView;
  enforceabilityGaps?: string[];
  pricing?: HirePricingGuideResponse;
  warnings?: string[];
}

export interface CorrectHireBody {
  startAt?: ISODateTime;
  /** null = re-open (still running). */
  endAt?: ISODateTime | null;
  endTrigger?: HireEndTrigger;
  dailyRatePence?: Pence;
  gtaGroup?: string;
  clientGtaGroup?: string | null;
  reason: string;
  ledger: 'auto' | 'skip';
}

export interface HireFigures {
  startAt: ISODateTime;
  endAt?: ISODateTime;
  dailyRatePence: Pence;
  days: number;
  netPence: Pence;
  grossPence: Pence;
}

export interface CorrectHireResponse {
  changed: boolean;
  hire: HireAgreement;
  calculation: HireCalculation;
  before: HireFigures;
  after: HireFigures;
  warnings: string[];
  ledger: { action: 'none' | 'superseded' | 'review' | 'invoiced'; entryId?: string; message: string };
  clocks: Clock[];
}

export interface EndHireBody {
  endAt: ISODateTime;
  endTrigger: HireEndTrigger;
  odometerIn?: number;
  collectedAt?: ISODateTime;
  reason?: string;
}

export interface EndHireResponse {
  hire: HireAgreement;
  calculation?: HireCalculation;
  clocks?: Clock[];
}

export interface PricingGuideQuery {
  fleetUnitId: Id;
  startAt?: ISODateTime;
  clientGroup?: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function hireOf(res: unknown): HireAgreement {
  const r = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
  return (r.hire && typeof r.hire === 'object' ? r.hire : r) as HireAgreement;
}

export const hireApi = {
  listHire: async (claimId: Id, signal?: AbortSignal): Promise<HireListItem[]> => asList<HireListItem>(await request<unknown>(`/claims/${seg(claimId)}/hire`, { method: 'GET', signal })),
  pricingGuide: (claimId: Id, q: PricingGuideQuery, signal?: AbortSignal) =>
    request<HirePricingGuideResponse>(`/claims/${seg(claimId)}/hire/pricing-guide`, {
      method: 'GET',
      query: { fleetUnitId: q.fleetUnitId, startAt: q.startAt || undefined, clientGroup: q.clientGroup || undefined },
      signal
    }),
  createHire: async (claimId: Id, body: CreateHireBody): Promise<CreateHireResponse> => {
    const res = await request<unknown>(`/claims/${seg(claimId)}/hire`, { method: 'POST', body });
    const r = (res && typeof res === 'object' ? res : {}) as Partial<CreateHireResponse>;
    return { ...r, hire: hireOf(res) };
  },
  correctHire: (claimId: Id, hireId: Id, body: CorrectHireBody) => request<CorrectHireResponse>(`/claims/${seg(claimId)}/hire/${seg(hireId)}`, { method: 'PATCH', body }),
  endHire: async (claimId: Id, hireId: Id, body: EndHireBody): Promise<EndHireResponse> => {
    const res = await request<unknown>(`/claims/${seg(claimId)}/hire/${seg(hireId)}/end`, { method: 'POST', body });
    const r = (res && typeof res === 'object' ? res : {}) as Partial<EndHireResponse>;
    return { ...r, hire: hireOf(res) };
  },
  /** Save the GTA group of the client's car (PATCH /vehicles/:id, entered by hand). */
  saveVehicleGroup: (vehicleId: Id, gtaGroup: string | null): Promise<VehiclePatchResult> => vehiclesApi.patchVehicle(vehicleId, { gtaGroup, source: { provider: 'manual', appliedFields: ['gtaGroup'] } })
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** London date of an instant, '' when it cannot be read (the pricing-guide key changes per day, not per minute). */
export function londonDay(iso: string | undefined | null): string {
  if (!iso) return '';
  try {
    return londonDate(iso);
  } catch {
    return '';
  }
}

export const hireQk = {
  list: (claimId: Id) => qk.hire(claimId),
  pricingGuide: (claimId: Id, fleetUnitId: Id, startAt: string | undefined, clientGroup: string | undefined) => ['claim', claimId, 'hire', 'pricing-guide', fleetUnitId, londonDay(startAt), clientGroup ?? ''] as const
};

/** After any hire change: the claim (bundle, hire list, clocks, events, ledger), the fleet list and the vehicles. */
function useInvalidateHire() {
  const qc = useQueryClient();
  const invalidateClaim = useInvalidateClaim();
  return (claimId: Id) => {
    invalidateClaim(claimId);
    void qc.invalidateQueries({ queryKey: ['fleet'] });
    void qc.invalidateQueries({ queryKey: ['vehicle'] });
    void qc.invalidateQueries({ queryKey: ['vehicles'] });
  };
}

export function useHireList(claimId: Id | undefined) {
  return useQuery({ queryKey: hireQk.list(claimId ?? ''), queryFn: ({ signal }) => hireApi.listHire(claimId!, signal), enabled: Boolean(claimId) });
}

/** The pricing guide for a fleet car; keyed on the London date of the start. Keeps the last answer while loading. */
export function useHirePricingGuide(claimId: Id, q: { fleetUnitId?: Id; startAt?: ISODateTime; clientGroup?: string }) {
  const fleetUnitId = q.fleetUnitId ?? '';
  const day = londonDay(q.startAt);
  return useQuery({
    queryKey: hireQk.pricingGuide(claimId, fleetUnitId, q.startAt, q.clientGroup),
    queryFn: ({ signal }) => hireApi.pricingGuide(claimId, { fleetUnitId, startAt: q.startAt, clientGroup: q.clientGroup }, signal),
    enabled: Boolean(claimId && fleetUnitId && day),
    placeholderData: keepPreviousData,
    staleTime: 60_000
  });
}

export function useCreateHire(claimId: Id) {
  const invalidate = useInvalidateHire();
  return useMutation({ mutationFn: (body: CreateHireBody) => hireApi.createHire(claimId, body), onSuccess: () => invalidate(claimId) });
}

export function useCorrectHire(claimId: Id) {
  const invalidate = useInvalidateHire();
  return useMutation({ mutationFn: ({ hireId, body }: { hireId: Id; body: CorrectHireBody }) => hireApi.correctHire(claimId, hireId, body), onSuccess: () => invalidate(claimId) });
}

export function useEndHireV2(claimId: Id) {
  const invalidate = useInvalidateHire();
  return useMutation({ mutationFn: ({ hireId, body }: { hireId: Id; body: EndHireBody }) => hireApi.endHire(claimId, hireId, body), onSuccess: () => invalidate(claimId) });
}

/** Save the client's car group from the pricing guide, then refetch the guide (it lives under the claim key). */
export function useSaveClientGroup(claimId: Id) {
  const invalidate = useInvalidateHire();
  return useMutation({ mutationFn: ({ vehicleId, gtaGroup }: { vehicleId: Id; gtaGroup: string | null }) => hireApi.saveVehicleGroup(vehicleId, gtaGroup), onSuccess: () => invalidate(claimId) });
}
