import { describe, expect, it } from 'vitest';
import type { HireAgreement, RecoveryRecord, StorageRecord } from '@ccguk/domain';
import { endHireBodyFrom, endStorageBodyFrom, enforceabilityChecklist, enforceabilityScore, HIRE_TRIGGERS, hireTotals, recoveryBodyFrom, recoveryTotals, STORAGE_TRIGGERS, storageTotals, triggerLabel } from './hire';

const hire: HireAgreement = {
  id: 'h1',
  claimId: 'c1',
  fleetUnitId: 'f1',
  agreementNumber: 'CH-0001',
  startAt: '2026-09-01T10:00:00Z',
  dailyRatePence: 4232, // S1 £42.32
  vatRate: 0.2,
  gtaGroup: 'S1',
  excessPence: 0,
  additionalDrivers: [],
  signedAt: '2026-09-01T10:30:00Z',
  enforceability: { cancellationInfoProvidedAt: '2026-09-01T10:00:00Z', schedule3FormProvidedAt: '2026-09-01T10:00:00Z', cca60fCompliant: true }
};

describe('hire cards', () => {
  it('costs a running hire to the as-of instant: 10 days × £42.32 + VAT', () => {
    const t = hireTotals(hire, '2026-09-11T10:00:00Z');
    expect(t?.days).toBe(10);
    expect(t?.netPence).toBe(42_320);
    expect(t?.vatPence).toBe(8_464);
    expect(t?.grossPence).toBe(50_784);
  });
  it('lists the four dates and the 60F flag, in order', () => {
    const items = enforceabilityChecklist(hire);
    expect(items.map((i) => i.key)).toEqual(['cancellationInfo', 'schedule3', 'expressRequest', 'signed', 'cca60f']);
    expect(items.map((i) => i.ok)).toEqual([true, true, false, true, true]);
    expect(enforceabilityScore(hire)).toEqual({ ok: 4, total: 5 });
    expect(items[2]!.basis).toMatch(/W v Veolia/);
  });
  it('every GTA trigger says it is a benchmark', () => {
    for (const t of HIRE_TRIGGERS.filter((t) => /GTA/.test(t.basis))) expect(t.basis).toMatch(/benchmark/);
    expect(triggerLabel(HIRE_TRIGGERS, 'repair_complete_24h')).toMatch(/24 hours/);
    expect(triggerLabel(STORAGE_TRIGGERS, undefined)).toBe('—');
  });
});

describe('end dialogs require a trigger and a date', () => {
  const now = '2026-10-04T12:00:00.000Z';
  it('end hire', () => {
    const bad = endHireBodyFrom({ endTrigger: '', endAt: '', collectedAt: '', odometerIn: '', reason: '' }, hire, now);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['endAt', 'endTrigger']);
    const early = endHireBodyFrom({ endTrigger: 'repair_complete_24h', endAt: '2026-08-31T10:00:00Z', collectedAt: '', odometerIn: '', reason: '' }, hire, now);
    expect(early).toMatchObject({ ok: false, errors: { endAt: expect.stringContaining('before the start') } });
    const manual = endHireBodyFrom({ endTrigger: 'manual', endAt: '2026-09-20T10:00:00Z', collectedAt: '', odometerIn: '12345', reason: '' }, hire, now);
    expect(manual).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
    const ok = endHireBodyFrom({ endTrigger: 'tl_payment_5wd', endAt: '2026-09-20T10:00:00Z', collectedAt: '', odometerIn: '12345', reason: '' }, hire, now);
    expect(ok).toEqual({ ok: true, body: { endTrigger: 'tl_payment_5wd', endAt: '2026-09-20T10:00:00Z', collectedAt: undefined, odometerIn: 12345, reason: undefined } });
  });
  it('end storage', () => {
    const storage: StorageRecord = { id: 's1', claimId: 'c1', location: 'Yard', startAt: '2026-09-01T09:00:00Z', dailyRatePence: 4500, vatRate: 0.2 };
    expect(endStorageBodyFrom({ endTrigger: '', endAt: '', reason: '' }, storage, now).ok).toBe(false);
    expect(endStorageBodyFrom({ endTrigger: 'report_issued', endAt: '2026-09-05T09:00:00Z', reason: '' }, storage, now)).toEqual({ ok: true, body: { endTrigger: 'report_issued', endAt: '2026-09-05T09:00:00Z', reason: undefined } });
    const charge = storageTotals(storage, '2026-09-05T09:00:00Z');
    expect(charge?.days).toBe(4);
    expect(charge?.netPence).toBe(18_000); // £45/day
  });
});

describe('recovery', () => {
  it('rate card £90 + £3/mile + £25', () => {
    const r: RecoveryRecord = { id: 'r1', claimId: 'c1', at: '2026-09-01T08:00:00Z', fromLocation: 'A', toLocation: 'B', calloutPence: 9000, loadedMiles: 12, perLoadedMilePence: 300, adminPence: 2500, vatRate: 0.2, evidenceIds: [] };
    const t = recoveryTotals(r);
    expect(t.netPence).toBe(9000 + 3600 + 2500);
    expect(t.grossPence).toBe(Math.round(15_100 * 1.2));
    const body = recoveryBodyFrom({ at: '2026-09-01T08:00:00Z', fromLocation: ' A ', toLocation: 'B', loadedMiles: '12', evidenceIds: [] });
    expect(body).toEqual({ ok: true, body: { at: '2026-09-01T08:00:00Z', fromLocation: 'A', toLocation: 'B', loadedMiles: 12, evidenceIds: [] } });
    expect(recoveryBodyFrom({ at: '', fromLocation: '', toLocation: '', loadedMiles: '-1', evidenceIds: [] }).ok).toBe(false);
  });
});
