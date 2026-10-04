import { describe, expect, it } from 'vitest';
import type { EngineerReport, Vehicle } from '@ccguk/domain';
import { basisFormFrom, comparableBodyFrom, emptyComparableForm, estimateBodyFrom, lineErrors, newLine, predictorBodyFrom, reportBodyFrom, reportChecklist, reportFormFrom, subjectFormFrom, subjectFrom, unwrapReport } from './engineering';

const vehicle: Vehicle = {
  id: 'v1',
  registration: 'AB12CDE',
  make: 'VOLKSWAGEN',
  model: 'GOLF',
  yearOfManufacture: 2019,
  fuelType: 'petrol',
  transmission: 'manual',
  odometer: [{ source: 'mot', date: '2026-03-01', miles: 41_000 }],
  motHistory: [{ completedDate: '2026-03-01', result: 'PASSED', odometerMiles: 41_000, defects: [] }],
  ownership: 'client',
  lookups: [],
  createdAt: '2026-09-01T00:00:00Z'
};

describe('estimate editor', () => {
  it('validates lines by kind', () => {
    const labour = newLine('labour');
    expect(lineErrors(labour)).toEqual(['description', 'hours']);
    const part = { ...newLine('part'), description: 'Front bumper', unitPence: 24_000 };
    expect(lineErrors(part)).toEqual([]);
  });
  it('builds the body with rates in pence and VAT as a fraction', () => {
    const basis = { ...basisFormFrom(null), labourRatePence: 4_500, paintRatePence: 4_500, paintMaterialsPerHourPence: 2_200 };
    const lines = [{ ...newLine('labour'), description: 'Strip/refit bumper', hours: 1.5, confirmedByEngineer: true }];
    const r = estimateBodyFrom(null, 'v1', basis, lines);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toMatchObject({ vehicleId: 'v1', labourRatePence: 4_500, paintRatePence: 4_500, paintMaterialsMethod: 'per_hour', paintMaterialsPerHourPence: 2_200, vatRate: 0.2 });
    const bad = estimateBodyFrom(null, 'v1', { ...basis, labourRatePence: null }, [newLine('labour')]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors)).toEqual(['labourRatePence', 'line.0']);
  });
});

describe('PAV workbench', () => {
  it('derives the subject from the vehicle: latest reading, else MOT projection flagged', () => {
    const f = subjectFormFrom(null, vehicle, 'n1 1aa');
    expect(f.odometerAtLoss).toBe('41000');
    expect(f.odometerBasis).toBe('reading');
    expect(subjectFormFrom(null, { ...vehicle, odometer: [] }).odometerBasis).toBe('projected_from_mot');
    const r = subjectFrom({ ...f, conditionGrade: 'good', conditionAdjustmentPct: '2' }, vehicle);
    expect(r).toMatchObject({ ok: true, body: { vehicleId: 'v1', registration: 'AB12CDE', year: 2019, odometerAtLoss: 41_000, odometerBasis: 'reading', conditionGrade: 'good', conditionAdjustmentPct: 2, claimantPostcode: 'N1 1AA' } });
    expect(subjectFrom({ ...f, conditionGrade: 'good', conditionAdjustmentPct: '15' }, vehicle).ok).toBe(false);
  });
  it('a comparable is captured by hand with URL, time, source, price and the saved advert', () => {
    const now = '2026-10-04T12:00:00.000Z';
    const form = emptyComparableForm({ make: 'VOLKSWAGEN', model: 'GOLF', fuelType: 'petrol', transmission: 'manual' }, now);
    const missing = comparableBodyFrom(form);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(Object.keys(missing.errors).sort()).toEqual(['evidenceId', 'mileage', 'pricePence', 'source', 'url', 'year']);
    const ok = comparableBodyFrom({ ...form, url: 'https://www.autotrader.co.uk/car-details/2', source: 'Auto Trader', pricePence: 1_295_000, mileage: '38500', year: '2019', distanceMiles: '12', evidenceId: 'ev1', writeOffCategory: 'N' });
    expect(ok).toMatchObject({ ok: true, body: { url: 'https://www.autotrader.co.uk/car-details/2', source: 'Auto Trader', pricePence: 1_295_000, mileage: 38_500, year: 2019, make: 'VOLKSWAGEN', model: 'GOLF', fuelType: 'petrol', transmission: 'manual', seller: 'dealer', distanceMiles: 12, writeOffCategory: 'N', evidenceId: 'ev1' } });
    const poa = comparableBodyFrom({ ...form, url: 'https://x.test/1', source: 'Dealer', priceOnApplication: true, mileage: '1', year: '2019', evidenceId: 'ev1' });
    expect(poa).toMatchObject({ ok: true, body: { pricePence: 0, priceOnApplication: true } });
  });
});

describe('total-loss predictor', () => {
  it('needs age, PAV band, zones, airbags and driveability', () => {
    const r = predictorBodyFrom({ vehicleAgeYears: '7', pavBandPence: 650_000, roughRepairPence: null, damageZones: ['front'], airbagsDeployed: true, structuralIndicators: [], driveable: false, fluidLeaks: undefined, isEvOrHybrid: false });
    expect(r).toEqual({ ok: true, body: { vehicleAgeYears: 7, pavBandPence: 650_000, roughRepairPence: undefined, damageZones: ['front'], airbagsDeployed: true, structuralIndicators: ['none'], driveable: false, fluidLeaks: undefined, isEvOrHybrid: false } });
    expect(predictorBodyFrom({ vehicleAgeYears: '', pavBandPence: null, roughRepairPence: null, damageZones: [], airbagsDeployed: undefined, structuralIndicators: [], driveable: undefined, fluidLeaks: undefined, isEvOrHybrid: false }).ok).toBe(false);
  });
});

describe("engineer's report", () => {
  const report: EngineerReport = {
    id: 'r1',
    claimId: 'c1',
    vehicleId: 'v1',
    engineerPartyId: 'p9',
    engineerQualifications: 'IAEA',
    instructedBy: 'CCGUK',
    instructedAt: '2026-09-02T09:00:00Z',
    inspectionAt: '2026-09-03T09:00:00Z',
    inspectionPlace: 'Yard',
    inspectionBasis: 'physical',
    preAccidentCondition: 'Good',
    damageDescription: 'Rear quarter',
    consistentWithCircumstances: true,
    roadworthy: false,
    roadworthyReason: 'Rear light cluster broken',
    photoEvidenceIds: [],
    forCourt: false,
    feePence: 28_500
  };
  it('round-trips the form and insists on the §4.6 essentials', () => {
    const form = reportFormFrom(report);
    expect(form.feePence).toBe(28_500);
    const r = reportBodyFrom(form, { vehicleId: 'v1', estimateId: 'e1' });
    expect(r).toMatchObject({ ok: true, body: { engineerPartyId: 'p9', roadworthy: false, roadworthyReason: 'Rear light cluster broken', estimateId: 'e1', feePence: 28_500, diagnosticFaultCodes: [] } });
    const bad = reportBodyFrom({ ...form, roadworthy: undefined, roadworthyReason: '', consistentWithCircumstances: false }, { vehicleId: 'v1' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['consistencyNote', 'roadworthy', 'roadworthyReason']);
  });
  it('uses the API checklist when present, else the domain checklist', () => {
    expect(reportChecklist(report, { missing: ['Photos'], notes: [], ok: false, courtItemsChecked: [] }, {})?.missing).toEqual(['Photos']);
    const local = reportChecklist(report, undefined, { vehicle });
    expect(local).toBeDefined();
    expect(local?.missing.some((m) => /photo/i.test(m))).toBe(true);
    expect(reportChecklist(null, undefined, {})).toBeUndefined();
    expect(unwrapReport({ report, checklist: { missing: [] } }).report?.id).toBe('r1');
    expect(unwrapReport(report).report?.id).toBe('r1');
    expect(unwrapReport(null).report).toBeNull();
  });
});
