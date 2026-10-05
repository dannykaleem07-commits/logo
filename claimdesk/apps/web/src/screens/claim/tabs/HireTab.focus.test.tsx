// @vitest-environment jsdom
/**
 * Typing guard for the Hire tab dialogs (docs/V03-MANAGER-MODE-HIRE-PRICING.md §D.3, §I.6): every keystroke keeps the
 * focus in the field and the value comes out exactly as typed — Start hire (odometer, agreed rate), Edit dates & rate
 * (reason, rate), End hire (note, odometer), Add storage (location) and Add recovery (from, to, miles). A fake server
 * behind `fetch` answers the hire, fleet, pricing-guide and rate queries so the dialogs re-render while typing.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimView } from '../claimFile';
import type { FleetUnitRow } from '../../../api/client';
import type { HireListItem, HirePricingGuideResponse } from '../../../api/hireApi';
import { renderWithProviders, typeAndExpectFocus } from '../../../test/harness';
import { HireTab } from './HireTab';

const CLAIM_ID = 'c1';
const NOTE = 'GTA terms are an industry benchmark only. CCGUK is not a GTA subscriber.';

const unit: FleetUnitRow = {
  id: 'u1',
  vehicleId: 'fv1',
  registration: 'FL33 EET',
  vehicle: { id: 'fv1', registration: 'FL33 EET', make: 'VW', model: 'Golf' } as FleetUnitRow['vehicle'],
  gtaGroup: 'S1',
  dailyRatePence: 4980,
  status: 'available',
  declaredUses: ['credit_hire']
} as FleetUnitRow;

const hire: HireListItem = {
  id: 'h1',
  claimId: CLAIM_ID,
  fleetUnitId: 'u2',
  agreementNumber: 'CCG-H-000001',
  startAt: '2026-09-01T09:00:00.000Z',
  dailyRatePence: 4232,
  vatRate: 0.2,
  gtaGroup: 'S1',
  excessPence: 0,
  additionalDrivers: [],
  enforceability: { cca60fCompliant: false },
  pricing: {
    snapshot: true,
    agreedDailyRatePence: 4232,
    fleetDailyRatePence: 4232,
    hireGroup: 'S1',
    hireGtaDailyRatePence: 4232,
    clientGtaGroup: 'S1',
    clientGtaDailyRatePence: 4232,
    differencePerDayPence: 0,
    higherGroup: false,
    notices: [],
    note: NOTE
  },
  recordedAt: '2026-10-05T09:00:00.000Z',
  recordedByName: 'Courtesy Cars',
  backdated: true,
  corrections: []
};

const guide: HirePricingGuideResponse = {
  date: '2026-10-05',
  fleetDailyRatePence: 4980,
  hireCar: { group: 'S1', dailyRatePence: 4232, period: '2026-27', verification: 'verified' },
  clientCar: { group: 'S1', dailyRatePence: 4232, period: '2026-27', verification: 'verified', source: 'recorded' },
  differencePerDayPence: 0,
  higherGroup: false,
  fleetAboveLikeForLikePence: 748,
  notices: ['Your fleet rate £49.80/day is £7.48/day above the like-for-like guide.'],
  suggestions: [
    { id: 'fleet', label: 'Fleet rate', dailyRatePence: 4980 },
    { id: 'hire_guide', label: 'Car we give — guide', dailyRatePence: 4232 },
    { id: 'like_for_like', label: "Client's car — guide (like for like)", dailyRatePence: 4232 }
  ],
  note: NOTE,
  fleetUnit: { id: 'u1', registration: 'FL33 EET', make: 'VW', model: 'Golf', status: 'available', gtaGroup: 'S1', dailyRatePence: 4980 },
  clientVehicle: { id: 'v1', registration: 'DK18 WRE', make: 'VAUXHALL', model: 'ASTRA', gtaGroup: 'S1' },
  clientSuggestion: { group: 'S1', confidence: 'high', basis: 'recorded', reason: 'Group recorded on the vehicle.', rate: null, note: '' },
  groupsOnDate: ['S1', 'S2', 'M']
};

const view = {
  claim: { id: CLAIM_ID, reference: 'CCG-2026-00001', status: 'hire_active', clientVehicleId: 'v1', accident: { occurredAt: '2026-08-30T08:00:00.000Z', location: 'A1', circumstances: 'Hit from behind' }, flags: [] },
  claimant: { id: 'p1', kind: 'person', name: 'Client' },
  vehicle: { id: 'v1', registration: 'DK18 WRE', make: 'VAUXHALL', model: 'ASTRA', gtaGroup: 'S1' },
  thirdParties: [],
  events: [],
  ledger: [],
  offers: [],
  hire: [hire],
  storage: [],
  recovery: [],
  evidence: [],
  documents: [],
  clocks: []
} as unknown as ClaimView;

/** A fake API: GETs answer from fixtures (a short delay, so answers land while typing); mutations answer 200. */
function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
  const path = url.pathname.replace(/^\/api/, '');
  let body: unknown = {};
  if (path === `/claims/${CLAIM_ID}/hire/pricing-guide`) body = guide;
  else if (path === `/claims/${CLAIM_ID}/hire`) body = { hire: [hire] };
  else if (path === `/claims/${CLAIM_ID}/storage`) body = { storage: [] };
  else if (path === `/claims/${CLAIM_ID}/recovery`) body = { recovery: [] };
  else if (path === `/claims/${CLAIM_ID}/clocks`) body = { clocks: [] };
  else if (path === '/fleet') body = { items: [unit] };
  else if (path === '/kb/gta-rates') body = { items: [] };
  const text = JSON.stringify(body);
  const res = {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text
  } as unknown as Response;
  return new Promise((resolve) => setTimeout(() => resolve(res), 5));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function dialog(name: RegExp) {
  return screen.getByRole('dialog', { name });
}

describe('Hire tab dialogs keep the focus while typing', () => {
  it('Start hire: odometer out and agreed rate', async () => {
    const { user } = renderWithProviders(<HireTab view={view} />, { route: `/claims/${CLAIM_ID}/hire` });
    await user.click(screen.getAllByRole('button', { name: 'Start hire' })[0]!);
    const d = dialog(/Start hire/);
    const car = await within(d).findByRole('option', { name: /FL33 EET · VW Golf · S1 · £49\.80\/day/ });
    await user.selectOptions(within(d).getByLabelText(/Fleet car/), car);
    await within(d).findByText(/Pricing guide \(hire starting/);
    await user.click(within(d).getByText('Handover (optional)'));
    await typeAndExpectFocus(user, within(d).getByLabelText(/Odometer out/) as HTMLInputElement, '12345');
    const rate = within(d).getByLabelText(/Agreed daily rate/) as HTMLInputElement;
    expect(rate.value).toBe('49.80'); // defaults to the fleet rate
    await user.clear(rate);
    await typeAndExpectFocus(user, rate, '49.99');
    await user.click(within(d).getByRole('button', { name: /Client's car — guide £42\.32 \(like for like\)/ }));
    expect(rate.value).toBe('42.32');
  });

  it('Edit dates & rate: reason and rate', async () => {
    const { user } = renderWithProviders(<HireTab view={view} />, { route: `/claims/${CLAIM_ID}/hire` });
    await user.click(screen.getByRole('button', { name: 'Edit dates & rate' }));
    const d = dialog(/Edit dates & rate/);
    await typeAndExpectFocus(user, within(d).getByLabelText(/Reason/) as HTMLTextAreaElement, 'agent forgot to upload');
    const rate = within(d).getByLabelText(/Agreed daily rate/) as HTMLInputElement;
    await user.clear(rate);
    await typeAndExpectFocus(user, rate, '49.99');
    expect(within(d).getByText(/^Now \d+ days? · £[\d,.]+ net → after \d+ days? · £[\d,.]+ net/)).toBeTruthy();
  });

  it('End hire: note and odometer in', async () => {
    const { user } = renderWithProviders(<HireTab view={view} />, { route: `/claims/${CLAIM_ID}/hire` });
    await user.click(screen.getByRole('button', { name: 'End hire' }));
    const d = dialog(/End hire/);
    await typeAndExpectFocus(user, within(d).getByLabelText(/Note for the chronology/) as HTMLTextAreaElement, 'Client returned the keys at the yard');
    await typeAndExpectFocus(user, within(d).getByLabelText(/Odometer in/) as HTMLInputElement, '12345');
  });

  it('Add storage: location', async () => {
    const { user } = renderWithProviders(<HireTab view={view} />, { route: `/claims/${CLAIM_ID}/hire` });
    await user.click(screen.getByRole('button', { name: 'Add storage' }));
    const d = dialog(/Add storage/);
    await typeAndExpectFocus(user, within(d).getByLabelText(/Location/) as HTMLInputElement, 'Ab1 9.5x Yard, LS1 4AP');
  });

  it('Add recovery: from, to and loaded miles', async () => {
    const { user } = renderWithProviders(<HireTab view={view} />, { route: `/claims/${CLAIM_ID}/hire` });
    await user.click(screen.getByRole('button', { name: 'Add recovery' }));
    const d = dialog(/Add recovery/);
    await typeAndExpectFocus(user, within(d).getByLabelText(/^From/) as HTMLInputElement, 'M62 junction 27');
    await typeAndExpectFocus(user, within(d).getByLabelText(/^To/) as HTMLInputElement, 'Leeds yard');
    await typeAndExpectFocus(user, within(d).getByLabelText(/Loaded miles/) as HTMLInputElement, '12.5');
  });
});
