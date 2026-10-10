// @vitest-environment jsdom
// owned by ap-booking — booking dialog, calendar, movements board (docs/SUPREME-AUTOPILOT.md §I.2–I.4)
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { barSpan, calendarDays, freeBetween, londonDayStart } from '../../api/bookingsApi';
import { BookingDialog } from '../claim/booking/BookingDialog';
import { CalendarTab } from './CalendarTab';
import { MovementsTab } from './MovementsTab';
import { renderWithProviders } from '../../test/harness';

describe('calendar helpers', () => {
  it('London day boundaries, across the end of BST', () => {
    expect(londonDayStart('2026-10-12T15:00:00Z')).toBe('2026-10-11T23:00:00.000Z');
    expect(londonDayStart('2026-12-01T15:00:00Z')).toBe('2026-12-01T00:00:00.000Z');
    const days = calendarDays('2026-10-24T12:00:00Z', 3);
    expect(days.map((d) => d.start)).toEqual(['2026-10-23T23:00:00.000Z', '2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z']);
    expect(days[1]!.weekday).toBe('Sun');
    expect(days[1]!.isWeekend).toBe(true);
  });
  it('bar spans clip to the range; an open end runs to the edge', () => {
    expect(barSpan({ startAt: '2026-10-02T00:00:00Z', endAt: '2026-10-03T00:00:00Z' }, '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z')).toEqual({ left: 0.25, width: 0.25 });
    expect(barSpan({ startAt: '2026-09-01T00:00:00Z', endAt: null }, '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z')).toEqual({ left: 0, width: 1 });
    expect(barSpan({ startAt: '2026-11-01T00:00:00Z', endAt: null }, '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z')).toBeNull();
  });
  it('free between dates', () => {
    const row = { bookings: [{ startAt: '2026-10-05T00:00:00Z', endAt: '2026-10-07T00:00:00Z' }] } as never;
    expect(freeBetween(row, '2026-10-07T00:00:00Z', '2026-10-09T00:00:00Z')).toBe(true);
    expect(freeBetween(row, '2026-10-06T00:00:00Z', '2026-10-09T00:00:00Z')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rendering with a fake API
// ---------------------------------------------------------------------------

const CLAIM = 'claim-1';
const candidate = (id: string, reg: string, score: number, relation = 'same') => ({
  fleetUnitId: id,
  registration: reg,
  label: 'Ford Focus auto, 5 seats, petrol (S1)',
  score,
  factors: {
    likeForLike: { score: 1, weight: 35, note: 'Same hire group as your own car (S1).' },
    needsFit: { score: 1, weight: 15, note: 'No preferences recorded' },
    readiness: { score: 1, weight: 15, note: 'Ready now' },
    compliance: { score: 1, weight: 10, note: 'Cover +62 days after the expected end' },
    cost: { score: 1, weight: 20, note: 'At or below the like-for-like guide' },
    location: { score: 0.5, weight: 5, note: 'Distance not known' },
  },
  likeForLike: { score: 1, group: { client: 'S1', car: 'S1', relation, clientRatePence: 4232, carRatePence: 4232 }, parts: {}, sentence: 'Same hire group.' },
  pricing: { fleetDailyRatePence: 4000, clientCar: { dailyRatePence: 4232 } },
  readyBy: '2026-10-12T08:00:00.000Z',
  marginDays: 62,
  lapses: [],
  warnings: [],
  driverOutcome: 'eligible',
});
const availability = {
  period: { startAt: '2026-10-12T11:00:00.000Z', expectedEndAt: '2026-10-26T11:00:00.000Z' },
  use: 'credit_hire',
  ranked: [candidate('u-a', 'AA26 AAA', 97.5), candidate('u-c', 'CC26 CCC', 70)],
  excluded: [{ fleetUnitId: 'u-b', registration: 'BB26 BBB', reasons: [{ code: 'NEED_AUTOMATIC', message: "manual gearbox; the driver's licence is automatic-only (code 78)" }] }],
  clearWinner: true,
  green: true,
  explanation: ['AA26 AAA is the best match.'],
  projection: { startAt: '2026-10-12T11:00:00.000Z', expectedEndAt: '2026-10-26T11:00:00.000Z', startBasis: 'next_slot', endBasis: 'default', why: ['No repair estimate yet: the usual 14 days is assumed.'] },
  needs: { automaticOnly: true, automaticPreferred: false, towbar: false, wheelchairAccessible: false, handControls: false, largeBoot: false, isofixCount: 0, seatsMin: null, evOk: null },
  claimId: CLAIM,
};
const calendar = {
  from: '2026-10-11T23:00:00.000Z',
  to: '2026-11-08T00:00:00.000Z',
  rows: [
    {
      fleetUnitId: 'u-a',
      registration: 'AA26 AAA',
      label: 'Ford Focus auto (S1)',
      group: 'S1',
      status: 'available',
      declaredUses: ['credit_hire'],
      location: 'Isleworth',
      bookings: [{ id: 'r1', status: 'confirmed', startAt: '2026-10-13T09:00:00.000Z', endAt: '2026-10-20T09:00:00.000Z', claimId: CLAIM, claimReference: 'CCG-2026-00001', label: 'Confirmed · CCG-2026-00001', clash: false }],
      readiness: [{ id: 't1', kind: 'valet', from: '2026-10-21T09:00:00.000Z', to: '2026-10-21T11:00:00.000Z', blocksHire: false }],
      markers: [{ kind: 'mot', date: '2026-10-18', insideBooking: true }],
      movements: [{ id: 'm1', kind: 'delivery', windowStart: '2026-10-13T09:00:00.000Z', windowEnd: '2026-10-13T11:00:00.000Z', status: 'planned' }],
    },
  ],
};
const board = {
  from: '2026-10-11T23:00:00.000Z',
  to: '2026-10-12T23:00:00.000Z',
  items: [{ id: 'm1', reservationId: 'r1', claimId: CLAIM, fleetUnitId: 'u-a', kind: 'delivery', windowStart: '2026-10-12T09:00:00.000Z', windowEnd: '2026-10-12T11:00:00.000Z', address: { line1: '12 High Street', town: 'Reading', postcode: 'RG1 1AA' }, postcode: 'RG1 1AA', assignedTo: null, status: 'planned', evidenceIds: [], registration: 'AA26 AAA', label: 'Ford Focus', claimReference: 'CCG-2026-00001', clientName: 'Amina Yusuf', clientPhone: '07700900123', slot: 'Mon 12 Oct, 10:00–12:00', reservationStatus: 'confirmed' }],
};

const calls: Array<{ method: string; path: string; body: unknown }> = [];
function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const path = url.pathname.replace(/^\/api/, '');
  const method = init?.method ?? 'GET';
  calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  let body: unknown = {};
  let status = 200;
  if (path === '/fleet/availability') body = availability;
  else if (path === `/claims/${CLAIM}/bookings` && method === 'GET') body = { reservations: [], movements: [] };
  else if (path === `/claims/${CLAIM}/bookings` && method === 'POST') {
    status = 201;
    body = { reservation: { id: 'r9', status: 'confirmed', registration: 'AA26 AAA', agreementNumber: 'CCG-H-000009' }, warnings: [] };
  } else if (path === '/clashes/check') body = { findings: [], blocks: [], greenBlocking: [] };
  else if (path === '/fleet/calendar') body = calendar;
  else if (path === '/fleet/movements') body = board;
  const text = JSON.stringify(body);
  const res = { ok: status < 400, status, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => JSON.parse(text) as unknown, text: async () => text } as unknown as Response;
  return Promise.resolve(res);
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BookingDialog', () => {
  it('shows the ranked cars, the not-available list with reasons, and books now', async () => {
    const onClose = vi.fn();
    const { user } = renderWithProviders(<BookingDialog open claimId={CLAIM} onClose={onClose} />);
    expect(await screen.findByText('AA26 AAA')).toBeTruthy();
    expect(await screen.findByText('CC26 CCC')).toBeTruthy();
    expect(screen.getByText('Not available (1)')).toBeTruthy();
    expect(screen.getByText(/manual gearbox; the driver's licence is automatic-only \(code 78\)/)).toBeTruthy();
    expect(screen.getByText('Best match')).toBeTruthy();
    expect((screen.getByRole('radio', { name: /AA26 AAA/ }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect((screen.getByRole('button', { name: /Book now/ }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: /Book now/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST' && c.path === `/claims/${CLAIM}/bookings`)!;
    expect(post.body).toMatchObject({ fleetUnitId: 'u-a', use: 'credit_hire', startAt: availability.period.startAt, expectedEndAt: availability.period.expectedEndAt, confirm: true });
  });
});

describe('CalendarTab and MovementsTab', () => {
  it('renders bars, markers and movements; the table view lists the booking', async () => {
    const { user } = renderWithProviders(<CalendarTab />);
    expect(await screen.findByRole('button', { name: /AA26 AAA: Confirmed · CCG-2026-00001/ })).toBeTruthy();
    expect(screen.getByTitle(/MOT due 2026-10-18 — inside a booking/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Table view' }));
    expect(screen.getByRole('button', { name: /Confirmed · CCG-2026-00001/ })).toBeTruthy();
  });

  it("lists today's movements with the client, slot and actions", async () => {
    renderWithProviders(<MovementsTab />);
    expect(await screen.findByText('Mon 12 Oct, 10:00–12:00')).toBeTruthy();
    expect(screen.getByText('Amina Yusuf')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Done → Handover/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Print run sheet' })).toBeTruthy();
  });
});
