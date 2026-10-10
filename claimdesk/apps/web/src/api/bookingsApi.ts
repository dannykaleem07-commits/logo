// owned by ap-booking
/**
 * Fleet booking client (docs/SUPREME-AUTOPILOT.md §B, §H.4). Web code never imports API code, so the HTTP shapes of
 * apps/api/src/routes/bookings.ts are declared here.
 *
 *   POST /fleet/availability                       { claimId, startAt?, expectedEndAt?, use?, limit? } → AvailabilityView
 *   GET  /fleet/calendar?from&to&unitIds&group&use → CalendarView
 *   GET  /claims/:id/bookings                      → { reservations, movements }
 *   POST /claims/:id/bookings                      hold (or book now with confirm: true)
 *   GET/PATCH /bookings/:id; POST /bookings/:id/confirm|release|handover|return|movements
 *   PATCH /movements/:id; GET /fleet/movements?day&range
 *   GET/POST /fleet/:id/readiness; PATCH /fleet/readiness/:taskId; POST /fleet/:id/damage; PATCH /fleet/damage/:id
 *   GET/POST /fleet/locations; PATCH /fleet/locations/:id
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Address,
  AvailabilityResult,
  ClashFinding,
  DamageSeverity,
  FleetDamage,
  FleetLocation,
  FleetUse,
  HireAgreement,
  HireEndTrigger,
  HireNeeds,
  Movement,
  MovementKind,
  MovementStatus,
  ReadinessKind,
  ReadinessTask,
  Reservation,
  ReservationEvent,
  ReservationStatus,
  UnitReadiness,
} from '@ccguk/domain';
import { request, seg } from './client';

export interface ProjectionView {
  startAt: string;
  expectedEndAt: string;
  startBasis: string;
  endBasis: string;
  why: string[];
}

export type AvailabilityView = AvailabilityResult & { projection: ProjectionView | null; needs: HireNeeds; claimId: string };
export type ReservationView = Reservation & { registration: string; label: string; occupied: { startAt: string; endAt: string | null } };
export type BookingDetail = ReservationView & { events: ReservationEvent[]; movements: Movement[]; signedPack: { signed: boolean; missing: string[] } };
export interface BookingWrite {
  reservation: ReservationView;
  warnings: ClashFinding[];
}

export interface CalendarBar {
  id: string;
  status: ReservationStatus;
  startAt: string;
  endAt: string | null;
  holdExpiresAt?: string;
  claimId?: string;
  claimReference?: string;
  clientName?: string;
  agreementNumber?: string;
  label: string;
  clash: boolean;
}
export interface CalendarRow {
  fleetUnitId: string;
  registration: string;
  label: string;
  group: string;
  status: string;
  declaredUses: FleetUse[];
  location: string | null;
  bookings: CalendarBar[];
  readiness: Array<{ id: string; kind: ReadinessKind; from: string; to: string | null; blocksHire: boolean }>;
  markers: Array<{ kind: 'mot' | 'tax' | 'policy' | 'service' | 'phv_licence'; date: string; insideBooking: boolean }>;
  movements: Array<{ id: string; kind: MovementKind; windowStart: string; windowEnd: string; status: MovementStatus }>;
}
export interface CalendarView {
  from: string;
  to: string;
  rows: CalendarRow[];
}

export type MovementBoardRow = Movement & { registration: string; label: string; claimReference: string; clientName: string | null; clientPhone: string | null; slot: string; reservationStatus: ReservationStatus | null };

export interface ReadinessView {
  fleetUnitId: string;
  readiness: UnitReadiness;
  tasks: ReadinessTask[];
  damage: FleetDamage[];
  bookings: Array<{ id: string | null; claimId: string | null; status: string; startAt: string; expectedEndAt: string | null; endAt: string | null; agreementNumber: string | null }>;
}

export interface HoldBody {
  fleetUnitId: string;
  use: FleetUse;
  startAt: string;
  expectedEndAt: string;
  substitutionReason?: string | null;
  replaceReservationId?: string | null;
  confirm?: boolean;
}

export interface HandoverBody {
  at: string;
  odometerOut: number;
  fuelEighths: number;
  conditionDocumentId?: string | null;
  licenceEvidenceId?: string | null;
  dvlaCheck: { checkedAt: string; summary: string; evidenceId?: string | null } | null;
  keys: number;
  notes?: string | null;
  excessPence?: number | null;
}

export interface ReturnBody {
  collectedAt: string;
  endAt: string;
  endTrigger: HireEndTrigger;
  odometerIn: number;
  fuelEighths: number;
  conditionDocumentId?: string | null;
  damage: Array<{ panel: string; description: string; severity: DamageSeverity; evidenceIds: string[] }>;
  notes?: string | null;
}

export interface MovementBody {
  kind: MovementKind;
  windowStart: string;
  windowEnd: string;
  address: 'client_home' | 'delivery_address' | Address | null;
  notes?: string | null;
}

export const bookingsApi = {
  availability: (body: { claimId: string; startAt?: string | null; expectedEndAt?: string | null; use?: FleetUse | null; limit?: number | null }) => request<AvailabilityView>('/fleet/availability', { method: 'POST', body }),
  calendar: (q: { from: string; to: string; unitIds?: string; group?: string; use?: FleetUse | ''; locationId?: string }) => request<CalendarView>('/fleet/calendar', { query: { ...q, use: q.use || undefined } }),
  claimBookings: (claimId: string) => request<{ reservations: ReservationView[]; movements: Movement[] }>(`/claims/${seg(claimId)}/bookings`),
  hold: (claimId: string, body: HoldBody) => request<BookingWrite>(`/claims/${seg(claimId)}/bookings`, { method: 'POST', body }),
  get: (id: string) => request<BookingDetail>(`/bookings/${seg(id)}`),
  patch: (id: string, body: { startAt?: string | null; expectedEndAt?: string | null; reason: string; substitutionReason?: string | null }) => request<BookingWrite>(`/bookings/${seg(id)}`, { method: 'PATCH', body }),
  confirm: (id: string, hireOfferId?: string | null) => request<BookingWrite & { reheld: boolean }>(`/bookings/${seg(id)}/confirm`, { method: 'POST', body: { hireOfferId: hireOfferId ?? null } }),
  release: (id: string, reason: string) => request<{ reservation: ReservationView }>(`/bookings/${seg(id)}/release`, { method: 'POST', body: { reason } }),
  handover: (id: string, body: HandoverBody) => request<{ reservation: ReservationView; hire: HireAgreement; enforceabilityGaps: string[]; warnings: string[] }>(`/bookings/${seg(id)}/handover`, { method: 'POST', body }),
  returnCar: (id: string, body: ReturnBody) => request<{ reservation: ReservationView; hire: HireAgreement; warnings: ClashFinding[]; readiness: Array<{ id: string; kind: ReadinessKind }> }>(`/bookings/${seg(id)}/return`, { method: 'POST', body }),
  scheduleMovement: (reservationId: string, body: MovementBody) => request<{ movement: Movement; warnings: ClashFinding[] }>(`/bookings/${seg(reservationId)}/movements`, { method: 'POST', body }),
  patchMovement: (id: string, body: { status?: Exclude<MovementStatus, 'done'>; windowStart?: string; windowEnd?: string; assignedTo?: string | null; notes?: string | null; reason?: string | null }) => request<{ movement: Movement }>(`/movements/${seg(id)}`, { method: 'PATCH', body }),
  movements: (q: { day?: string; range?: 'day' | 'tomorrow' | 'week' }) => request<{ from: string; to: string; items: MovementBoardRow[] }>('/fleet/movements', { query: q }),
  readiness: (unitId: string) => request<ReadinessView>(`/fleet/${seg(unitId)}/readiness`),
  addReadiness: (unitId: string, body: { kind: ReadinessKind; blocksHire?: boolean; dueAt?: string | null; readyByAt?: string | null; note?: string | null }) => request<ReadinessTask>(`/fleet/${seg(unitId)}/readiness`, { method: 'POST', body }),
  patchReadiness: (taskId: string, body: { status?: ReadinessTask['status']; readyByAt?: string | null; note?: string | null }) => request<ReadinessTask>(`/fleet/readiness/${seg(taskId)}`, { method: 'PATCH', body }),
  addDamage: (unitId: string, body: { panel: string; description: string; severity: DamageSeverity; evidenceIds?: string[] }) => request<{ damage: FleetDamage; repairTask: ReadinessTask | null }>(`/fleet/${seg(unitId)}/damage`, { method: 'POST', body }),
  locations: () => request<{ items: FleetLocation[] }>('/fleet/locations'),
  addLocation: (body: { name: string; postcode?: string | null; address?: Address | null; lat?: number | null; lon?: number | null; isDefault?: boolean }) => request<FleetLocation>('/fleet/locations', { method: 'POST', body }),
  patchLocation: (id: string, body: Partial<{ name: string; postcode: string | null; lat: number | null; lon: number | null; isDefault: boolean }>) => request<FleetLocation>(`/fleet/locations/${seg(id)}`, { method: 'PATCH', body }),
};

export const bookingQk = {
  all: ['bookings'] as const,
  claim: (claimId: string) => ['bookings', 'claim', claimId] as const,
  detail: (id: string) => ['bookings', 'detail', id] as const,
  availability: (b: object) => ['bookings', 'availability', b] as const,
  calendar: (q: object) => ['bookings', 'calendar', q] as const,
  movements: (q: object) => ['bookings', 'movements', q] as const,
  readiness: (unitId: string) => ['bookings', 'readiness', unitId] as const,
  locations: ['bookings', 'locations'] as const,
};

export function useClaimBookings(claimId: string | undefined) {
  return useQuery({ queryKey: bookingQk.claim(claimId ?? ''), queryFn: () => bookingsApi.claimBookings(claimId!), enabled: Boolean(claimId) });
}

export function useAvailability(body: { claimId: string; startAt?: string | null; expectedEndAt?: string | null; use?: FleetUse | null } | null) {
  return useQuery({ queryKey: bookingQk.availability(body ?? {}), queryFn: () => bookingsApi.availability(body!), enabled: Boolean(body?.claimId), placeholderData: keepPreviousData });
}

export function useCalendar(q: { from: string; to: string; group?: string; use?: FleetUse | ''; locationId?: string }) {
  return useQuery({ queryKey: bookingQk.calendar(q), queryFn: () => bookingsApi.calendar(q), refetchInterval: 60_000 });
}

export function useMovementBoard(q: { day?: string; range?: 'day' | 'tomorrow' | 'week' }) {
  return useQuery({ queryKey: bookingQk.movements(q), queryFn: () => bookingsApi.movements(q), refetchInterval: 60_000 });
}

export function useBooking(id: string | undefined) {
  return useQuery({ queryKey: bookingQk.detail(id ?? ''), queryFn: () => bookingsApi.get(id!), enabled: Boolean(id) });
}

export function useLocations() {
  return useQuery({ queryKey: bookingQk.locations, queryFn: () => bookingsApi.locations() });
}

/** Any booking write: refresh the diary, the fleet list, the claim (events, hire) and clash findings. */
export function useBookingMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      for (const key of [['bookings'], ['fleet'], ['claim'], ['claims'], ['clashes'], ['hire']]) void qc.invalidateQueries({ queryKey: key });
    },
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export const STATUS_TEXT: Record<ReservationStatus, string> = { held: 'Held', confirmed: 'Confirmed', on_hire: 'On hire', returned: 'Returned', cancelled: 'Cancelled', expired: 'Hold expired' };
export const FACTOR_TEXT: Record<string, string> = { likeForLike: 'Like for like', needsFit: 'Needs', readiness: 'Ready', compliance: 'Cover', cost: '£/day', location: 'Distance' };
export const READINESS_TEXT: Record<ReadinessKind, string> = { valet: 'Valet', inspection: 'Inspection', service: 'Service', damage_repair: 'Repair', mot: 'MOT', tax: 'Tax', tyres: 'Tyres', keys: 'Keys', phv_licence: 'PHV licence', other: 'Other' };
export const MARKER_SYMBOL: Record<CalendarRow['markers'][number]['kind'], string> = { mot: '▲', tax: '■', policy: '│', service: '●', phv_licence: '◆' };

const DAY = 86_400_000;

/** Midnight (UTC ISO) of the London day of `iso`. Uses the browser's Intl for Europe/London. */
export function londonDayStart(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get('year');
  const m = get('month');
  const day = get('day');
  // London is UTC+0 or UTC+1: try both offsets and keep the one that is London midnight
  for (const off of [0, 1]) {
    const cand = new Date(Date.UTC(y, m - 1, day, -off));
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(cand));
    if (h === 0) return cand.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, day)).toISOString();
}

/** `n` London days from `fromIso` (each a {start, end, label}). */
export function calendarDays(fromIso: string, n: number): Array<{ start: string; end: string; label: string; weekday: string; isWeekend: boolean }> {
  const out: Array<{ start: string; end: string; label: string; weekday: string; isWeekend: boolean }> = [];
  let start = londonDayStart(fromIso);
  for (let i = 0; i < n; i += 1) {
    const end = londonDayStart(new Date(Date.parse(start) + DAY + 3 * 3_600_000).toISOString());
    const d = new Date(Date.parse(start) + 12 * 3_600_000);
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(d);
    out.push({ start, end, label: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' }).format(d), weekday, isWeekend: weekday === 'Sat' || weekday === 'Sun' });
    start = end;
  }
  return out;
}

/** Bar position in a grid of `days` (fractions 0..1 of the range; null end runs to the edge). */
export function barSpan(bar: { startAt: string; endAt: string | null }, from: string, to: string): { left: number; width: number } | null {
  const f = Date.parse(from);
  const t = Date.parse(to);
  const s = Math.max(Date.parse(bar.startAt), f);
  const e = Math.min(bar.endAt ? Date.parse(bar.endAt) : t, t);
  if (e <= f || s >= t || e <= s) return null;
  return { left: (s - f) / (t - f), width: (e - s) / (t - f) };
}

/** True when the car has no booking overlapping [from, to). */
export function freeBetween(row: Pick<CalendarRow, 'bookings'>, from: string, to: string): boolean {
  const f = Date.parse(from);
  const t = Date.parse(to);
  return !row.bookings.some((b) => Date.parse(b.startAt) < t && (b.endAt === null || Date.parse(b.endAt) > f));
}

/** "Like for like 0.9" style chip text for a factor. */
export function factorChip(key: string, f: { score: number; note: string }): string {
  if (key === 'likeForLike') return `Like for like ${f.score.toFixed(2)}`;
  if (key === 'readiness') return f.note;
  if (key === 'compliance') return f.note;
  if (key === 'cost') return f.note;
  if (key === 'location') return f.note;
  return `${FACTOR_TEXT[key] ?? key} ${f.score >= 1 ? '✓' : f.score.toFixed(2)}`;
}
