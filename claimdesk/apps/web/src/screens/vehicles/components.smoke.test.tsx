/**
 * Component smoke tests for the vehicles-web screens: render to a string under node with the catalogue, rates and
 * settings seeded in the query cache (no API, no DOM). Catches bad imports, hook misuse and crashes in the first render,
 * and checks the copy the design doc fixes (§E.2, §E.5, §F.1, §F.4).
 */
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GtaRate, OnFileMatch } from '@ccguk/domain';
import { ToastProvider } from '../../components/Toast';
import { todayISO } from '../../lib/dates';
import { qk } from '../../api/hooks';
import { vk, type CatalogueMakeSummary, type CatalogueModelSummary, type FeatureVocabulary, type GtaRateListItem, type GtaSegmentItem, type NormalisedModel } from '../../api/vehiclesApi';
import { VehiclePicker, MANUAL_MODE_NOTICE } from './VehiclePicker';
import { emptyPickerValue, setBody, setEngine, setGeneration, setMake, setModel, setTrim, setYear, parseBodyOption, type VehiclePickerValue } from './vehiclePicker';
import { StepVehicle } from '../claims/new/StepVehicle';
import { initialFnolState, type FnolState } from '../claims/new/fnol';
import { UnitDialog } from '../fleet/UnitDialog';
import { GtaRatesPage } from '../gta/GtaRatesPage';
import { TCC_LABEL, TCC_NOTE } from './TotalCarCheckPanel';
import { GTA_PANEL_CAVEAT } from '../fleet/gtaPanel';

const TODAY = todayISO();

const MAKES: CatalogueMakeSummary[] = [{ slug: 'ford', make: 'Ford', dvlaNames: ['FORD'], aliases: [], modelCount: 2, years: { from: 2000, to: null }, vehicleTypes: ['car'] }];
const MODELS: CatalogueModelSummary[] = [{ makeSlug: 'ford', slug: 'fiesta', name: 'Fiesta', vehicleType: 'car', segment: 'supermini', years: { from: 2008, to: 2023 }, bodies: ['hatchback'] }];
const FIESTA: NormalisedModel = {
  name: 'Fiesta',
  slug: 'fiesta',
  aliases: [],
  vehicleType: 'car',
  segment: 'supermini',
  years: { from: 2008, to: 2023 },
  makeSlug: 'ford',
  generations: [
    {
      id: 'ford-fiesta-mk8-2017-2023',
      name: 'Mk8 (2017–2023)',
      from: 2017,
      to: 2023,
      bodies: [{ body: 'hatchback', doors: [3, 5], seats: [5] }],
      trims: [{ id: 'zetec', name: 'Zetec', features: ['dab'] }],
      engines: [{ id: '1-0-ecoboost-100ps-petrol', label: '1.0 EcoBoost 100PS petrol', cc: 999, fuel: 'petrol', domainFuel: 'petrol', powerPs: 100 }],
      fuels: ['petrol'],
      transmissions: ['manual', 'automatic']
    }
  ]
};
const VOCAB: FeatureVocabulary = { schemaVersion: 1, categories: [{ id: 'accessibility', label: 'Accessibility', items: [{ id: 'hand_controls', label: 'Hand controls', kind: 'extra' }] }] };
const RATES: GtaRate[] = [{ group: 'M1', description: 'Small SUV', dailyRatePence: 6549, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } }];

function client(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  qc.setQueryData(vk.makes, MAKES);
  qc.setQueryData(vk.models('ford', 2019), MODELS);
  qc.setQueryData(vk.models('ford', undefined), MODELS);
  qc.setQueryData(vk.model('ford', 'fiesta'), FIESTA);
  qc.setQueryData(vk.features, VOCAB);
  qc.setQueryData(['settings'], { lookupMode: 'manual', apiKeys: { dvlaVes: false, dvsaMot: false, companiesHouse: false, gateway: false } });
  qc.setQueryData(qk.gtaRates(TODAY), RATES);
  qc.setQueryData(vk.policies, []);
  return qc;
}

function render(node: ReactNode, qc: QueryClient = client()): string {
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function picked(): VehiclePickerValue {
  let v = emptyPickerValue('AB12CDE');
  v = setMake(v, 'Ford');
  v = setYear(v, 2019);
  v = setModel(v, MODELS[0]!, 'ford');
  v = setGeneration(v, 'ford-fiesta-mk8-2017-2023', FIESTA);
  v = setBody(v, parseBodyOption('hatchback|5'), FIESTA);
  v = setEngine(v, '1-0-ecoboost-100ps-petrol', FIESTA);
  v = setTrim(v, 'zetec', FIESTA);
  return v;
}

describe('VehiclePicker', () => {
  it('renders the cascade from the catalogue with "Not listed — type it", details and the two feature tabs', () => {
    const html = render(<VehiclePicker value={picked()} onChange={() => undefined} mode="fleet" lookupMode="manual" />);
    for (const text of ['Registration', 'Search', 'Make', 'Model', 'Generation', 'Mk8 (2017–2023)', 'Hatchback, 5 doors', '1.0 EcoBoost 100PS petrol', 'Zetec', 'Not listed — type it', 'First registered (month)', 'MOT expiry', 'Standard on this vehicle', 'Added extras', 'Accessibility']) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain(MANUAL_MODE_NOTICE);
    // registration shown → Total Car Check + paste panel
    expect(html).toContain(TCC_LABEL);
    expect(html).toContain(TCC_NOTE);
    expect(html).toContain('href="https://totalcarcheck.co.uk/FreeCheck?regno=AB12CDE"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('class="btn btn-secondary"');
    expect(html).toContain('Read pasted details');
  });
  it('edit mode without the registration hides the search and the paste panel (the host shows them)', () => {
    const html = render(<VehiclePicker value={picked()} onChange={() => undefined} mode="edit" showRegistration={false} lookupMode="live" />);
    expect(html).not.toContain(TCC_LABEL);
    expect(html).toContain('Trim');
  });
  it('a typed vehicle with no catalogue detail renders free inputs and the segment choice', () => {
    const v = { ...emptyPickerValue('AB12CDE'), make: 'Lada', model: 'Niva' };
    const html = render(<VehiclePicker value={v} onChange={() => undefined} mode="claim" showRegistration={false} lookupMode="manual" />);
    expect(html).toContain('Not in the catalogue — kept as typed.');
    expect(html).toContain('Segment');
    expect(html).toContain('Engine size (cc)');
    expect(html).toContain('Add “Lada” to the catalogue');
  });
});

describe('New claim → Vehicle in manual mode', () => {
  it('button reads "Search", the notice explains, on-file matches offer "Use this vehicle", then TCC, paste and the picker', () => {
    const s: FnolState = initialFnolState();
    const match: OnFileMatch = { vehicleId: 'veh-1', registration: 'AB12CDE', match: 'exact', make: 'FORD', model: 'FIESTA', ownership: 'client', claims: [{ id: 'c1', reference: 'CCG-2026-00001', openedAt: '2026-09-01T00:00:00Z' }], lookups: [] };
    s.vehicle = { ...s.vehicle, registration: 'AB12CDE', lookupState: 'manual', useManual: true, lookup: { status: 'manual_required', registration: 'AB12CDE', lookupMode: 'manual', onFile: [match], externalLinks: [] }, picker: { ...emptyPickerValue('AB12CDE') } };
    const html = render(<StepVehicle state={s} update={() => undefined} errors={{}} />);
    expect(html).toContain('>Search<');
    expect(html).toContain('No DVLA/DVSA keys are set up, so ClaimDesk searches its own records. Use Total Car Check to read the details, then copy them in.');
    expect(html).toContain('Use this vehicle');
    expect(html).toContain('CCG-2026-00001');
    expect(html).toContain(TCC_LABEL);
    expect(html).toContain('Read pasted details');
    expect(html).toContain('Odometer (miles)');
  });
  it('after "Use this vehicle" shows a read-only summary with "Change details"', () => {
    const s: FnolState = initialFnolState();
    const match: OnFileMatch = { vehicleId: 'veh-1', registration: 'AB12CDE', match: 'exact', make: 'FORD', model: 'FIESTA', ownership: 'client', claims: [], lookups: [] };
    s.vehicle = { ...s.vehicle, registration: 'AB12CDE', lookupState: 'manual', lookup: { status: 'manual_required', registration: 'AB12CDE', lookupMode: 'manual', onFile: [match] }, onFile: match };
    const html = render(<StepVehicle state={s} update={() => undefined} errors={{}} />);
    expect(html).toContain('Using the vehicle on file');
    expect(html).toContain('Change details');
    expect(html).not.toContain('Read pasted details');
  });
});

describe('Fleet unit dialog', () => {
  it('uses the picker in fleet mode, the GTA panel with the caveat, and a policy Select with "Add policy…"', () => {
    const html = render(<UnitDialog open unit={null} onClose={() => undefined} />);
    expect(html).toContain('Add fleet unit');
    expect(html).toContain('GTA group and daily rate');
    expect(html).toContain(GTA_PANEL_CAVEAT);
    expect(html).toContain('Choose the make and model above');
    expect(html).toContain('M1 — Small SUV');
    expect(html).toContain('Other…');
    expect(html).toContain('Add policy…');
    expect(html).toContain('Standard on this vehicle');
  });
});

describe('Settings → GTA benchmark rates', () => {
  it('shows the banner, origin and verification badges, actions and the segment defaults', () => {
    const qc = client();
    const items: GtaRateListItem[] = [
      { group: 'S1', dailyRatePence: 4232, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' }, origin: 'kb' },
      { group: 'M', dailyRatePence: 6000, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'verified', sourceUrl: 'https://example.org/r.pdf', verifiedBy: 'u1', verifiedAt: '2026-09-01' }, origin: 'manual', id: 'r1', overridesKb: true, kbRate: { group: 'M', dailyRatePence: 5666, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } } }
    ];
    const segments: GtaSegmentItem[] = [{ segment: 'city', label: 'City car', group: 'S1', origin: 'kb' }];
    qc.setQueryData(vk.gtaRateSettings, { items, note: 'GTA terms are an industry benchmark only.' });
    qc.setQueryData(vk.gtaSegments, segments);
    qc.setQueryData(['users'], [{ id: 'u1', name: 'Sam Smith' }]);
    const html = render(<GtaRatesPage />, qc);
    for (const text of ['GTA benchmark rates', 'Industry benchmark only.', 'Knowledge base', 'Overrides knowledge base', 'Verified by Sam Smith on 2026-09-01', 'Hide', 'Delete', 'Add a rate', 'Segment defaults', 'City car', 'no 2026-27 rows']) {
      expect(html, text).toContain(text);
    }
  });
});
