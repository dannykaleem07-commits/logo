import { describe, expect, it } from 'vitest';
import type { Vehicle } from '@ccguk/domain';
import { conflictsFrom, emptyOdometerForm, identificationRows, motDefectCounts, motRows, odometerBodyFrom, sortReadings } from './vehicle';

const vehicle: Vehicle = {
  id: 'v1',
  registration: 'AB12CDE',
  make: 'FORD',
  model: 'FOCUS',
  yearOfManufacture: 2018,
  odometer: [
    { source: 'engineer', date: '2026-09-05', miles: 61_200 },
    { source: 'mot', date: '2026-03-01', miles: 58_000 }
  ],
  motHistory: [
    { completedDate: '2025-03-01', result: 'PASSED', odometerMiles: 49_000, defects: [{ type: 'ADVISORY', text: 'Tyre worn' }] },
    { completedDate: '2026-03-01', result: 'FAILED', odometerMiles: 58_000, defects: [{ type: 'MAJOR', text: 'Brake pipe corroded' }, { type: 'DANGEROUS', text: 'Tyre cord exposed', dangerous: true }] }
  ],
  ownership: 'client',
  lookups: [],
  createdAt: '2026-09-01T00:00:00Z'
};

describe('vehicle tab helpers', () => {
  it('orders MOT tests newest first and counts defects', () => {
    const rows = motRows(vehicle);
    expect(rows.map((t) => t.completedDate)).toEqual(['2026-03-01', '2025-03-01']);
    expect(motDefectCounts(rows[0]!)).toEqual({ dangerous: 1, major: 1, minor: 0, advisory: 0 });
  });
  it('sorts readings by date and accepts both conflict response shapes', () => {
    expect(sortReadings(vehicle.odometer).map((r) => r.miles)).toEqual([58_000, 61_200]);
    const c = conflictsFrom({ vehicleId: 'v1', conflicts: [{ code: 'NON_MONOTONIC', message: 'later lower', a: vehicle.odometer[1], b: vehicle.odometer[0] }] });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ code: 'NON_MONOTONIC', message: 'later lower' });
    expect(conflictsFrom([{ code: 'VARIANCE', message: 'm' }])).toHaveLength(1);
    expect(conflictsFrom(null)).toEqual([]);
  });
  it('odometer form needs a source, a past date, whole miles and a photo for camera-based sources', () => {
    const today = '2026-10-04';
    const f = emptyOdometerForm(today);
    expect(odometerBodyFrom(f, today).ok).toBe(false);
    expect(odometerBodyFrom({ ...f, source: 'photo', miles: '61250' }, today)).toMatchObject({ ok: false, errors: { evidenceId: expect.any(String) } });
    expect(odometerBodyFrom({ ...f, source: 'client', miles: '61250.5' }, today)).toMatchObject({ ok: false, errors: { miles: expect.any(String) } });
    expect(odometerBodyFrom({ ...f, source: 'client', miles: '61250', note: ' said on the phone ' }, today)).toEqual({ ok: true, body: { source: 'client', date: today, miles: 61_250, evidenceId: undefined, note: 'said on the phone' } });
  });
  it('identification rows hide nothing the record has', () => {
    const rows = identificationRows(vehicle);
    expect(rows.find((r) => r.label === 'Registration')?.value).toBe('AB12CDE');
    expect(rows.find((r) => r.label === 'Make / model')?.value).toBe('FORD FOCUS');
    expect(rows.find((r) => r.label === 'VIN')?.value).toBeUndefined();
  });
});
