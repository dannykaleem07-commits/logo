import { describe, it, expect } from 'vitest';
import type { Claim, FleetUnit, MotTest, OdometerReading, Vehicle } from '../types.js';
import {
  normaliseRegistration,
  isValidUkRegistration,
  registrationFormat,
  formatRegistration,
  mileageConflicts,
  projectOdometer,
  crossFileRegistrationCheck,
  mapDvlaVes,
  dvlaVesExtras,
  mapDvsaMotHistory,
  kmToMiles,
  mapVesFuelType
} from './index.js';
import { daysBetween } from './mileage.js';

describe('registration normalisation and validation', () => {
  it('normalises case and whitespace', () => {
    expect(normaliseRegistration('ab12 cde')).toBe('AB12CDE');
    expect(normaliseRegistration(' ab12-cde ')).toBe('AB12CDE');
    expect(normaliseRegistration('')).toBe('');
  });

  it('recognises every UK format', () => {
    expect(registrationFormat('AB12 CDE')).toBe('current'); // 2001+
    expect(registrationFormat('A123 BCD')).toBe('prefix'); // 1983–2001
    expect(registrationFormat('ABC 123D')).toBe('suffix'); // 1963–1983
    expect(registrationFormat('ABC 1234')).toBe('dateless');
    expect(registrationFormat('1234 ABC')).toBe('dateless');
    expect(registrationFormat('A 1')).toBe('dateless');
    expect(registrationFormat('AIZ 1234')).toBe('northern_ireland');
    expect(registrationFormat('KIG 123')).toBe('northern_ireland');
  });

  it('rejects malformed marks', () => {
    expect(isValidUkRegistration('AB12 CDE')).toBe(true);
    expect(isValidUkRegistration('IB12 CDE')).toBe(false); // I never used in area code
    expect(isValidUkRegistration('AB12 CDI')).toBe(false); // I never used in random letters
    expect(isValidUkRegistration('ABCDEFGH')).toBe(false);
    expect(isValidUkRegistration('12345678')).toBe(false);
    expect(isValidUkRegistration('')).toBe(false);
    expect(isValidUkRegistration('A')).toBe(false);
  });

  it('formats with the conventional space', () => {
    expect(formatRegistration('AB12CDE')).toBe('AB12 CDE');
    expect(formatRegistration('ab12cde')).toBe('AB12 CDE');
    expect(formatRegistration('A123BCD')).toBe('A123 BCD');
    expect(formatRegistration('A1BCD')).toBe('A1 BCD');
    expect(formatRegistration('ABC123D')).toBe('ABC 123D');
    expect(formatRegistration('ABC1234')).toBe('ABC 1234');
    expect(formatRegistration('1234ABC')).toBe('1234 ABC');
    expect(formatRegistration('AIZ1234')).toBe('AIZ 1234');
    expect(formatRegistration('???')).toBe('');
  });
});

describe('mileageConflicts', () => {
  const mot: OdometerReading = { source: 'mot', date: '2026-03-01', miles: 61_200 };
  const engineer: OdometerReading = { source: 'engineer', date: '2026-09-20', miles: 58_900 };

  it('flags the live-file non-monotonic pair: MOT 61,200 on 1 Mar 2026 then engineer 58,900 on 20 Sep 2026', () => {
    const conflicts = mileageConflicts([engineer, mot]); // deliberately out of order
    const nm = conflicts.filter((c) => c.code === 'NON_MONOTONIC');
    expect(nm).toHaveLength(1);
    expect(nm[0]!.a.miles).toBe(61_200);
    expect(nm[0]!.b.miles).toBe(58_900);
    expect(nm[0]!.message).toContain('58,900 miles on 20 September 2026');
    expect(nm[0]!.message).toContain('61,200 miles on 1 March 2026');
    expect(nm[0]!.message).toContain('2,300 miles lower'); // 61,200 − 58,900
    // 203 days apart, not within the 14-day variance window; ratio 1.039, not a unit mix
    expect(conflicts.some((c) => c.code === 'VARIANCE')).toBe(false);
    expect(conflicts.some((c) => c.code === 'UNIT_SUSPECT')).toBe(false);
  });

  it('does not flag a plausible increasing sequence', () => {
    const readings: OdometerReading[] = [
      { source: 'mot', date: '2025-03-01', miles: 54_000 },
      { source: 'mot', date: '2026-03-01', miles: 61_200 },
      { source: 'accident_report', date: '2026-09-20', miles: 65_300 },
      { source: 'engineer', date: '2026-09-24', miles: 65_310 }
    ];
    expect(mileageConflicts(readings)).toEqual([]);
  });

  it('flags VARIANCE when readings within 14 days differ by more than max(250, 2%)', () => {
    // 2% of 60,000 = 1,200 > 250, so tolerance = 1,200; difference 1,500 → flagged
    const a: OdometerReading = { source: 'accident_report', date: '2026-09-20', miles: 60_000 };
    const b: OdometerReading = { source: 'engineer', date: '2026-09-27', miles: 61_500 };
    const out = mileageConflicts([a, b]);
    expect(out.map((c) => c.code)).toEqual(['VARIANCE']);
    expect(out[0]!.message).toContain('7 days apart');
    expect(out[0]!.message).toContain('1,500 miles');
    expect(out[0]!.message).toContain('tolerance 1,200');
    // difference 1,100 is within the 1,200 tolerance → nothing
    expect(mileageConflicts([a, { ...b, miles: 61_100 }])).toEqual([]);
    // small odometers use the absolute 250-mile floor: 2% of 5,000 = 100, so tolerance = 250; 300 → flagged
    const small = mileageConflicts([
      { source: 'handover', date: '2026-09-20', miles: 5_000 },
      { source: 'collection', date: '2026-09-21', miles: 5_300 }
    ]);
    expect(small.map((c) => c.code)).toEqual(['VARIANCE']);
    expect(small[0]!.message).toContain('tolerance 250');
    // custom tolerance
    expect(mileageConflicts([a, b], { toleranceMiles: 2_000 })).toEqual([]);
  });

  it('flags UNIT_SUSPECT when one reading ≈ 1.609 × another (km recorded as miles)', () => {
    // 58,900 miles × 1.609344 = 94,790 → a reading of 94,790 three days later cannot be genuine
    const out = mileageConflicts([
      { source: 'engineer', date: '2026-09-20', miles: 58_900 },
      { source: 'photo', date: '2026-09-23', miles: 94_790 }
    ]);
    const codes = out.map((c) => c.code).sort();
    expect(codes).toEqual(['UNIT_SUSPECT', 'VARIANCE']);
    const unit = out.find((c) => c.code === 'UNIT_SUSPECT')!;
    expect(unit.message).toContain('58,900 miles ≈ 94,790 km');
    expect(unit.message).toContain('kilometres recorded as miles');
  });

  it('does not treat a 1.609 ratio over years as a unit mix (plausible rate)', () => {
    // 60,000 → 96,561 over 3 years (1,096 days) = 33 miles/day: ordinary mileage
    const out = mileageConflicts([
      { source: 'mot', date: '2023-03-01', miles: 60_000 },
      { source: 'mot', date: '2026-03-01', miles: 96_561 }
    ]);
    expect(out).toEqual([]);
  });

  it('a backwards reading that is also a 1.609 ratio gets both codes', () => {
    const out = mileageConflicts([
      { source: 'mot', date: '2026-03-01', miles: 94_790 },
      { source: 'engineer', date: '2026-09-20', miles: 58_900 }
    ]);
    expect(out.map((c) => c.code).sort()).toEqual(['NON_MONOTONIC', 'UNIT_SUSPECT']);
  });
});

describe('projectOdometer', () => {
  const t = (completedDate: string, odometerMiles: number): MotTest => ({ completedDate, result: 'PASSED', odometerMiles, odometerUnit: 'mi', defects: [] });

  it('projects from a perfectly linear history (7,200 miles per 365 days)', () => {
    const history = [t('2024-03-01', 46_800), t('2025-03-01', 54_000), t('2026-03-01', 61_200)];
    const r = projectOdometer(history, '2026-09-20');
    // slope = 7,200 / 365 miles per day; annual = slope × 365.25 = 7,204.93 → 7,205
    expect(r.annualMiles).toBe(Math.round((7_200 / 365) * 365.25));
    expect(r.annualMiles).toBe(7_205);
    // 1 Mar 2026 → 20 Sep 2026 = 30+30+31+30+31+31+20 = 203 days
    expect(daysBetween('2026-03-01', '2026-09-20')).toBe(203);
    // 61,200 + 203 × 7,200/365 = 61,200 + 4,004.38 → 65,204
    expect(r.miles).toBe(61_200 + Math.round((203 * 7_200) / 365));
    expect(r.miles).toBe(65_204);
    expect(r.basis).toBe('projected_from_mot');
    expect(r.method).toBe('regression');
    expect(r.fromTest?.completedDate).toBe('2026-03-01');
  });

  it('uses least squares over all tests when the history is not collinear', () => {
    // x = 0, 365, 730 days; y = 40,000, 48,000, 54,000
    // mean x = 365, mean y = 47,333.33; Sxy = 5,110,000; Sxx = 266,450 → slope = 19.178 miles/day
    const history = [t('2024-03-01', 40_000), t('2025-03-01', 48_000), t('2026-03-01', 54_000)];
    const r = projectOdometer(history, '2026-03-31'); // 30 days after last test
    const slope = 5_110_000 / 266_450;
    expect(r.annualMiles).toBe(Math.round(slope * 365.25)); // 7,005
    expect(r.annualMiles).toBe(7_005);
    expect(r.miles).toBe(54_000 + Math.round(slope * 30)); // 54,000 + 575 = 54,575
    expect(r.miles).toBe(54_575);
    expect(r.method).toBe('regression');
  });

  it('falls back to the last two readings with only two tests', () => {
    const history = [t('2025-03-01', 54_000), t('2026-03-01', 61_200)];
    const r = projectOdometer(history, '2026-03-11'); // 10 days later
    expect(r.method).toBe('last_two');
    expect(r.annualMiles).toBe(7_205);
    expect(r.miles).toBe(61_200 + Math.round((10 * 7_200) / 365)); // + 197 → 61,397
    expect(r.miles).toBe(61_397);
  });

  it('returns the actual reading when atDate is a test date, and copes with a single test', () => {
    const history = [t('2025-03-01', 54_000), t('2026-03-01', 61_200)];
    const exact = projectOdometer(history, '2026-03-01');
    expect(exact.basis).toBe('reading');
    expect(exact.miles).toBe(61_200);

    const single = projectOdometer([t('2026-03-01', 61_200)], '2026-09-20');
    expect(single.basis).toBe('reading');
    expect(single.miles).toBe(61_200);
    expect(single.annualMiles).toBe(0);
    expect(single.method).toBe('none');
    expect(single.note).toContain('Only one MOT reading');

    const none = projectOdometer([], '2026-09-20');
    expect(none.miles).toBe(0);
    expect(none.method).toBe('none');
  });

  it('ignores tests without a readable odometer and anchors on the latest test before atDate', () => {
    const history: MotTest[] = [
      t('2024-03-01', 46_800),
      { completedDate: '2024-06-01', result: 'FAILED', defects: [] }, // no reading
      t('2025-03-01', 54_000),
      t('2026-03-01', 61_200)
    ];
    // atDate between tests → anchor on 2025-03-01 (the latest at or before atDate)
    const r = projectOdometer(history, '2025-03-31');
    expect(r.fromTest?.completedDate).toBe('2025-03-01');
    expect(r.miles).toBe(54_000 + Math.round((30 * 7_200) / 365)); // + 592 → 54,592
    expect(r.miles).toBe(54_592);
  });
});

describe('crossFileRegistrationCheck', () => {
  const vehicle = (id: string, registration: string, ownership: Vehicle['ownership'] = 'client'): Vehicle => ({
    id,
    registration,
    make: 'VW',
    model: 'Golf',
    odometer: [],
    ownership,
    lookups: [],
    createdAt: '2026-01-01T00:00:00Z'
  });
  const claim = (id: string, clientVehicleId: string, thirdPartyVehicleId?: string): Claim =>
    ({
      id,
      reference: `CCG-2026-${id}`,
      status: 'accepted',
      openedAt: '2026-01-01T00:00:00Z',
      accident: { occurredAt: '2026-01-01T00:00:00Z', location: 'x', circumstances: 'y' },
      liability: 'unknown',
      claimantId: 'p1',
      clientVehicleId,
      thirdPartyIds: [],
      ...(thirdPartyVehicleId ? { thirdPartyVehicleId } : {}),
      gtaSubscriber: false,
      linkedClaimIds: [],
      flags: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }) as Claim;
  const fleet = (id: string, vehicleId: string): FleetUnit => ({
    id,
    vehicleId,
    declaredUses: ['credit_hire'],
    dailyRatePence: 4980,
    gtaGroup: 'S1',
    keeperAddressCurrent: true,
    status: 'available'
  });

  it('finds duplicate claims on the same registration (as client or third-party vehicle)', () => {
    const vehicles = [vehicle('v1', 'AB12CDE'), vehicle('v2', 'ab12 cde'), vehicle('v3', 'XY99ZZZ')];
    const claims = [claim('c1', 'v1'), claim('c2', 'v3', 'v2'), claim('c3', 'v3')];
    const r = crossFileRegistrationCheck('ab12 cde', claims, vehicles, []);
    expect(r.registration).toBe('AB12CDE');
    expect(r.matchedVehicleIds).toEqual(['v1', 'v2']);
    expect(r.duplicateClaimIds).toEqual(['c1', 'c2']);
    expect(r.isFleetUnit).toBe(false);
    expect(r.hardStop).toBe(false);
    expect(r.severity).toBe('warn');
    expect(r.message).toContain('AB12 CDE already appears on 2 other claims (CCG-2026-c1, CCG-2026-c2)');
    // excluding the file being checked
    expect(crossFileRegistrationCheck('AB12CDE', claims, vehicles, [], { excludeClaimId: 'c1' }).duplicateClaimIds).toEqual(['c2']);
  });

  it('hard-stops when the registration is a fleet unit (lesson h)', () => {
    const vehicles = [vehicle('v1', 'LF24ABC', 'fleet')];
    const r = crossFileRegistrationCheck('LF24 ABC', [], vehicles, [fleet('f1', 'v1')]);
    expect(r.isFleetUnit).toBe(true);
    expect(r.hardStop).toBe(true);
    expect(r.severity).toBe('block');
    expect(r.message).toContain('fleet unit');
    expect(r.message).toContain('Hard stop');
    // fleet detected by ownership alone too
    const r2 = crossFileRegistrationCheck('LF24 ABC', [], vehicles, []);
    expect(r2.hardStop).toBe(true);
  });

  it('is clean when nothing matches', () => {
    const r = crossFileRegistrationCheck('ZZ99 ZZZ', [], [], []);
    expect(r.duplicateClaimIds).toEqual([]);
    expect(r.severity).toBe('none');
    expect(r.message).toContain('not on any other file');
  });
});

describe('DVLA VES mapper', () => {
  it('maps every field in the BLUEPRINT §4.1 table', () => {
    const payload = {
      registrationNumber: 'ab12 cde',
      taxStatus: 'Taxed',
      taxDueDate: '2027-02-01',
      motStatus: 'Valid',
      motExpiryDate: '2027-03-01',
      make: 'VOLKSWAGEN',
      yearOfManufacture: 2019,
      monthOfFirstRegistration: '2019-03',
      engineCapacity: 1498,
      co2Emissions: 112,
      fuelType: 'PETROL',
      colour: 'GREY',
      markedForExport: false,
      typeApproval: 'M1',
      wheelplan: '2 AXLE RIGID BODY',
      dateOfLastV5CIssued: '2024-05-10',
      euroStatus: 'EURO6',
      revenueWeight: 1850
    };
    const v = mapDvlaVes(payload);
    expect(v).toEqual({
      registration: 'AB12CDE',
      make: 'VOLKSWAGEN',
      yearOfManufacture: 2019,
      monthOfFirstRegistration: '2019-03',
      fuelType: 'petrol',
      colour: 'GREY',
      engineCapacityCc: 1498,
      co2Gkm: 112,
      euroStatus: 'EURO6',
      taxStatus: 'Taxed',
      taxDueDate: '2027-02-01',
      motStatus: 'Valid',
      motExpiryDate: '2027-03-01',
      markedForExport: false,
      dateOfLastV5CIssued: '2024-05-10'
    });
    expect(dvlaVesExtras(payload)).toEqual({ typeApproval: 'M1', wheelplan: '2 AXLE RIGID BODY', revenueWeightKg: 1850 });
  });

  it('maps VES fuel descriptions to FuelType', () => {
    expect(mapVesFuelType('PETROL')).toBe('petrol');
    expect(mapVesFuelType('DIESEL')).toBe('diesel');
    expect(mapVesFuelType('HYBRID ELECTRIC')).toBe('hybrid');
    expect(mapVesFuelType('ELECTRICITY')).toBe('electric');
    expect(mapVesFuelType('GAS BI-FUEL')).toBe('lpg');
    expect(mapVesFuelType('STEAM')).toBe('other');
    expect(mapVesFuelType(undefined)).toBeUndefined();
  });

  it('omits absent fields rather than inventing them', () => {
    expect(mapDvlaVes({ registrationNumber: 'AB12CDE' })).toEqual({ registration: 'AB12CDE' });
  });
});

describe('DVSA MOT history mapper', () => {
  const payload = {
    registration: 'AB12CDE',
    make: 'VOLKSWAGEN',
    model: 'GOLF',
    motTests: [
      {
        completedDate: '2026-03-01T10:15:00.000Z',
        testResult: 'PASSED',
        expiryDate: '2027-02-28',
        odometerValue: '61200',
        odometerUnit: 'MI',
        odometerResultType: 'READ',
        motTestNumber: '1001',
        defects: [{ text: 'Nearside front tyre worn close to legal limit', type: 'ADVISORY', dangerous: false }]
      },
      {
        completedDate: '2025-03-01T09:00:00.000Z',
        testResult: 'FAILED',
        odometerValue: '86905',
        odometerUnit: 'KM',
        odometerResultType: 'READ',
        motTestNumber: '1000',
        defects: [{ text: 'Brake pipe excessively corroded', type: 'DANGEROUS', dangerous: true }]
      },
      {
        completedDate: '2024-03-01T09:00:00.000Z',
        testResult: 'PASSED',
        odometerResultType: 'UNREADABLE',
        motTestNumber: '999',
        defects: []
      }
    ]
  };

  it('maps tests, converts km to miles and emits odometer readings', () => {
    const r = mapDvsaMotHistory(payload);
    expect(r.registration).toBe('AB12CDE');
    expect(r.make).toBe('VOLKSWAGEN');
    expect(r.model).toBe('GOLF');
    expect(r.motHistory).toHaveLength(3);
    expect(r.motHistory[0]).toEqual({
      completedDate: '2026-03-01',
      result: 'PASSED',
      expiryDate: '2027-02-28',
      odometerMiles: 61_200,
      odometerUnit: 'mi',
      testNumber: '1001',
      defects: [{ type: 'ADVISORY', text: 'Nearside front tyre worn close to legal limit', dangerous: false }]
    });
    // 86,905 km ÷ 1.609344 = 54,000.26 (1.609344 × 54,000 = 86,904.576) → 54,000 miles
    expect(kmToMiles(86_905)).toBe(54_000);
    expect(r.motHistory[1]!.odometerMiles).toBe(54_000);
    expect(r.motHistory[1]!.odometerUnit).toBe('km');
    expect(r.motHistory[1]!.result).toBe('FAILED');
    expect(r.motHistory[1]!.defects[0]!.dangerous).toBe(true);
    // unreadable odometer → no mileage, still a test
    expect(r.motHistory[2]!.odometerMiles).toBeUndefined();
    expect(r.odometer).toHaveLength(2);
    expect(r.odometer[0]).toEqual({ source: 'mot', date: '2026-03-01', miles: 61_200, note: 'MOT test 1001' });
    expect(r.odometer[1]!.miles).toBe(54_000);
    expect(r.odometer[1]!.note).toContain('recorded 86,905 km, converted to miles');
  });

  it('accepts the array form and tolerates an empty payload', () => {
    expect(mapDvsaMotHistory([payload]).motHistory).toHaveLength(3);
    expect(mapDvsaMotHistory({})).toEqual({ motHistory: [], odometer: [] });
  });
});

describe('adversarial: registration, mapper and projection traps', () => {
  it('Q plates (indeterminate age) are a valid prefix-format mark', () => {
    expect(registrationFormat('Q123 ABC')).toBe('prefix');
    expect(formatRegistration('Q123ABC')).toBe('Q123 ABC');
  });

  it('a current-format mark with Z in the area code or Q in the random letters is rejected', () => {
    expect(isValidUkRegistration('ZB12 CDE')).toBe(false);
    expect(isValidUkRegistration('AB12 CDQ')).toBe(false);
    expect(isValidUkRegistration('AB12 CDZ')).toBe(true); // Z is permitted in the random letters
  });

  it('the legacy dotted completedDate shape is parsed, not silently dropped', () => {
    const r = mapDvsaMotHistory({ motTests: [{ completedDate: '2026.03.01 10:15:00', testResult: 'PASSED', odometerValue: '61200', odometerUnit: 'mi', odometerResultType: 'READ', defects: [] }] });
    expect(r.motHistory).toHaveLength(1);
    expect(r.motHistory[0]!.completedDate).toBe('2026-03-01');
    expect(r.odometer[0]!.miles).toBe(61_200);
  });

  it('maps the slash-form hybrid fuel descriptions and does not invent a reading for NO_ODOMETER', () => {
    expect(mapVesFuelType('PETROL/ELECTRIC')).toBe('hybrid');
    expect(mapVesFuelType('DIESEL/ELECTRIC')).toBe('hybrid');
    expect(mapVesFuelType('ELECTRIC DIESEL')).toBe('hybrid');
    expect(mapVesFuelType('PLUG-IN HYBRID ELECTRIC')).toBe('plugin_hybrid');
    expect(mapVesFuelType('PETROL/GAS')).toBe('lpg');
    const r = mapDvsaMotHistory({ motTests: [{ completedDate: '2026-03-01T10:15:00.000Z', testResult: 'PASSED', odometerValue: '0', odometerUnit: 'MI', odometerResultType: 'NO_ODOMETER', defects: [] }] });
    expect(r.motHistory[0]!.odometerMiles).toBeUndefined();
    expect(r.odometer).toEqual([]);
  });

  it('km → miles conversion is rounded to whole miles, never a float', () => {
    // 100,000 km ÷ 1.609344 = 62,137.1 → 62,137
    expect(kmToMiles(100_000)).toBe(62_137);
    expect(Number.isInteger(kmToMiles(86_905))).toBe(true);
  });

  it('a backwards projection (atDate before the first MOT) still anchors on a real reading', () => {
    const t = (completedDate: string, odometerMiles: number): MotTest => ({ completedDate, result: 'PASSED', odometerMiles, odometerUnit: 'mi', defects: [] });
    const history = [t('2025-03-01', 54_000), t('2026-03-01', 61_200)];
    // 30 days before the first test at 7,200/365 per day: 54,000 − 592 = 53,408
    const r = projectOdometer(history, '2025-01-30');
    expect(r.fromTest?.completedDate).toBe('2025-03-01');
    expect(daysBetween('2025-03-01', '2025-01-30')).toBe(-30);
    expect(r.miles).toBe(54_000 + Math.round((-30 * 7_200) / 365));
    expect(r.miles).toBe(53_408);
  });

  it('same-day readings that disagree are a VARIANCE, and two km-as-miles readings on one day are UNIT_SUSPECT', () => {
    const out = mileageConflicts([
      { source: 'handover', date: '2026-09-21', miles: 12_400 },
      { source: 'photo', date: '2026-09-21', miles: 19_956 } // 12,400 × 1.609344 = 19,955.9
    ]);
    expect(out.map((c) => c.code).sort()).toEqual(['UNIT_SUSPECT', 'VARIANCE']);
    expect(out.some((c) => c.code === 'NON_MONOTONIC')).toBe(false);
  });
});
