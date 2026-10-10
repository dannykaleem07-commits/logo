// owned by ap-booking
/**
 * booking tools (docs/SUPREME-AUTOPILOT.md §H.2). Registered by agent/tools/index.ts. Every tool calls a booking route
 * as the agent (dispatcher → decide() → perimeter → route), so claim scope, the overlap refusal without other claims'
 * references and the human-only handover/return all hold for agents exactly as for the routes.
 *
 *   read      fleet_search · fleet_unit_get · fleet_calendar · bookings_list
 *   internal  booking_hold · booking_release · booking_confirm · booking_update_period · movement_schedule · readiness_task_create
 */
import { z } from 'zod/v4';
import type { ActionDescriptor } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { RunContext, ToolDef } from '../contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../contracts.js';
import { toolInputSchema } from '../../ai/strictSchema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyTool = ToolDef<any, any>;

const id = () => z.string().min(1).max(128);
const isoDate = () => z.string().min(10).max(40).describe('ISO 8601 date-time');
const USES = ['credit_hire', 'self_drive', 'pco'] as const;
const enc = encodeURIComponent;

function tool<S extends z.ZodType>(def: Omit<AnyTool, 'input' | 'strictSchema' | 'maxOutputChars'> & { input: S; maxOutputChars?: number }): AnyTool {
  return { ...def, strictSchema: toolInputSchema(def.input), maxOutputChars: def.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS } as AnyTool;
}

function qs(params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const claimOf = (ctx: AppContext, reservationId: string): string | undefined => ctx.repos.getReservation(ctx.db, reservationId)?.claimId;

const read = (kind: string) => (i: { claimId?: string | null }, rc: RunContext): ActionDescriptor => ({ class: 'read', kind: `read.${kind}`, ...((i.claimId ?? rc.claimScope) ? { claimId: (i.claimId ?? rc.claimScope)! } : {}), confidence: 1 });

const internal = (kind: string, claimId: string | undefined): ActionDescriptor => ({ class: 'internal', kind, ...(claimId ? { claimId } : {}), confidence: 1 });

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const fleetSearch = tool({
  name: 'fleet_search',
  title: 'Search available fleet cars',
  description:
    'Rank the fleet cars that are free, legal, insured and ready for this claim for the WHOLE expected hire, with every reason a car is excluded. Period and use default to the projected hire. Like for like compares GTA benchmark rates (a benchmark only — CCGUK is not a GTA subscriber). Other claims are never named: a busy car is "held or booked for another claim".',
  class: 'read',
  input: z.strictObject({ claimId: id(), startAt: isoDate().nullable(), expectedEndAt: isoDate().nullable(), use: z.enum(USES).nullable(), limit: z.int().min(1).max(20).nullable() }),
  http: (i: { claimId: string; startAt: string | null; expectedEndAt: string | null; use: string | null; limit: number | null }) => ({ method: 'POST', url: '/fleet/availability', body: { claimId: i.claimId, startAt: i.startAt, expectedEndAt: i.expectedEndAt, use: i.use, limit: i.limit } }),
  httpRoute: { method: 'POST', pattern: '/fleet/availability' },
  describe: read('fleet_search'),
  maxOutputChars: 40_000,
});

const fleetUnitGet = tool({
  name: 'fleet_unit_get',
  title: 'Fleet car readiness and bookings',
  description: 'One fleet car: whether it is ready (open valet/inspection/repair/MOT tasks, unrepaired damage) and its bookings. Bookings of other claims show only as "booked".',
  class: 'read',
  input: z.strictObject({ fleetUnitId: id() }),
  http: (i: { fleetUnitId: string }) => ({ method: 'GET', url: `/fleet/${enc(i.fleetUnitId)}/readiness` }),
  httpRoute: { method: 'GET', pattern: '/fleet/:id/readiness' },
  describe: (_i: unknown, rc: RunContext) => read('fleet_unit_get')({}, rc),
});

const fleetCalendar = tool({
  name: 'fleet_calendar',
  title: 'Fleet calendar',
  description: 'The fleet diary between two dates: bookings (other claims only as "booked"), readiness work, MOT/tax/policy/service dates and movements, per car.',
  class: 'read',
  input: z.strictObject({ fleetUnitId: id().nullable(), from: isoDate(), to: isoDate() }),
  http: (i: { fleetUnitId: string | null; from: string; to: string }, rc: RunContext) => ({ method: 'GET', url: `/fleet/calendar${qs({ from: i.from, to: i.to, unitIds: i.fleetUnitId, claimId: rc.claimScope })}` }),
  httpRoute: { method: 'GET', pattern: '/fleet/calendar' },
  describe: (_i: unknown, rc: RunContext) => read('fleet_calendar')({}, rc),
  maxOutputChars: 40_000,
});

const bookingsList = tool({
  name: 'bookings_list',
  title: 'Bookings on the claim',
  description: "The claim's fleet bookings (held, confirmed, on hire, returned, cancelled, expired) with their periods, agreement numbers and movements (deliveries, collections).",
  class: 'read',
  input: z.strictObject({ claimId: id() }),
  http: (i: { claimId: string }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}/bookings` }),
  httpRoute: { method: 'GET', pattern: '/claims/:id/bookings' },
  describe: read('bookings_list'),
});

// ---------------------------------------------------------------------------
// Internal (bookings)
// ---------------------------------------------------------------------------

interface HoldInput {
  claimId: string;
  fleetUnitId: string;
  use: (typeof USES)[number];
  startAt: string;
  expectedEndAt: string;
  rankingRef: string | null;
}

const bookingHold = tool({
  name: 'booking_hold',
  title: 'Hold a fleet car',
  description:
    'Hold a car for this claim for the expected period (24 hours by default) after fleet_search ranked it. Refused with RESERVATION_OVERLAP if the car was taken a moment ago — search again without it. A held car is not yet booked: it is confirmed only after the client accepts the offer.',
  class: 'internal',
  input: z.strictObject({ claimId: id(), fleetUnitId: id(), use: z.enum(USES), startAt: isoDate(), expectedEndAt: isoDate(), rankingRef: z.string().max(200).nullable() }),
  http: (i: HoldInput) => ({ method: 'POST', url: `/claims/${enc(i.claimId)}/bookings`, body: { fleetUnitId: i.fleetUnitId, use: i.use, startAt: i.startAt, expectedEndAt: i.expectedEndAt, rankingRef: i.rankingRef } }),
  httpRoute: { method: 'POST', pattern: '/claims/:id/bookings' },
  describe: (i: HoldInput) => internal('booking.hold', i.claimId),
});

const bookingRelease = tool({
  name: 'booking_release',
  title: 'Release a held or booked car',
  description: 'Release the claim’s held or confirmed car with a reason (offer declined or expired, the client took another car). A car on hire is never released here — a person records the return.',
  class: 'internal',
  input: z.strictObject({ reservationId: id(), reason: z.string().min(3).max(1000) }),
  http: (i: { reservationId: string; reason: string }) => ({ method: 'POST', url: `/bookings/${enc(i.reservationId)}/release`, body: { reason: i.reason } }),
  httpRoute: { method: 'POST', pattern: '/bookings/:id/release' },
  describe: (i: { reservationId: string }, _rc: RunContext, ctx: AppContext) => internal('booking.release', claimOf(ctx, i.reservationId)),
});

const bookingConfirm = tool({
  name: 'booking_confirm',
  title: 'Confirm a held car',
  description: 'Confirm the held car after the client accepted the offer (hireOfferId of the accepted offer). Allocates the agreement number. Refused when no accepted offer exists, or when the hold expired and the car was taken since.',
  class: 'internal',
  input: z.strictObject({ reservationId: id(), hireOfferId: id().nullable() }),
  http: (i: { reservationId: string; hireOfferId: string | null }) => ({ method: 'POST', url: `/bookings/${enc(i.reservationId)}/confirm`, body: { hireOfferId: i.hireOfferId } }),
  httpRoute: { method: 'POST', pattern: '/bookings/:id/confirm' },
  describe: (i: { reservationId: string }, _rc: RunContext, ctx: AppContext) => internal('booking.confirm', claimOf(ctx, i.reservationId)),
});

const bookingUpdatePeriod = tool({
  name: 'booking_update_period',
  title: 'Move the expected end of a booking',
  description: 'Move the expected end of a held, confirmed or on-hire booking when the repair estimate, repair booking or off-hire trigger changes it. Clashes are re-checked; an extension that runs into another booking is reported, never hidden.',
  class: 'internal',
  input: z.strictObject({ reservationId: id(), expectedEndAt: isoDate(), reason: z.string().min(3).max(1000) }),
  http: (i: { reservationId: string; expectedEndAt: string; reason: string }) => ({ method: 'PATCH', url: `/bookings/${enc(i.reservationId)}`, body: { expectedEndAt: i.expectedEndAt, reason: i.reason } }),
  httpRoute: { method: 'PATCH', pattern: '/bookings/:id' },
  describe: (i: { reservationId: string }, _rc: RunContext, ctx: AppContext) => internal('booking.update_period', claimOf(ctx, i.reservationId)),
});

const movementSchedule = tool({
  name: 'movement_schedule',
  title: 'Schedule a delivery or collection',
  description: 'Plan a delivery or collection window for a booking (one of the slots code proposed). The address is the client’s home or the delivery address on the hire needs. Refused when the car is not ready by the window.',
  class: 'internal',
  input: z.strictObject({ reservationId: id(), kind: z.enum(['delivery', 'collection', 'swap_out', 'swap_in', 'transfer']), windowStart: isoDate(), windowEnd: isoDate(), address: z.enum(['client_home', 'delivery_address']) }),
  http: (i: { reservationId: string; kind: string; windowStart: string; windowEnd: string; address: string }) => ({ method: 'POST', url: `/bookings/${enc(i.reservationId)}/movements`, body: { kind: i.kind, windowStart: i.windowStart, windowEnd: i.windowEnd, address: i.address } }),
  httpRoute: { method: 'POST', pattern: '/bookings/:id/movements' },
  describe: (i: { reservationId: string; kind: string }, _rc: RunContext, ctx: AppContext) => internal(`movement.${i.kind}`, claimOf(ctx, i.reservationId)),
});

const readinessTaskCreate = tool({
  name: 'readiness_task_create',
  title: 'Create a fleet readiness task',
  description: 'Add a readiness task to a fleet car (valet, inspection, service, damage repair, MOT, tax, tyres, keys, PHV licence). MOT, tax, PHV licence and major repairs block hire until done.',
  class: 'internal',
  input: z.strictObject({ fleetUnitId: id(), kind: z.enum(['valet', 'inspection', 'service', 'damage_repair', 'mot', 'tax', 'tyres', 'keys', 'phv_licence', 'other']), dueAt: isoDate().nullable(), note: z.string().min(3).max(1000) }),
  http: (i: { fleetUnitId: string; kind: string; dueAt: string | null; note: string }) => ({ method: 'POST', url: `/fleet/${enc(i.fleetUnitId)}/readiness`, body: { kind: i.kind, dueAt: i.dueAt, note: i.note } }),
  httpRoute: { method: 'POST', pattern: '/fleet/:id/readiness' },
  describe: (i: { kind: string }, rc: RunContext) => internal(`fleet.readiness.${i.kind}`, rc.claimScope),
});

export const bookingTools: AnyTool[] = [fleetSearch, fleetUnitGet, fleetCalendar, bookingsList, bookingHold, bookingRelease, bookingConfirm, bookingUpdatePeriod, movementSchedule, readinessTaskCreate];
