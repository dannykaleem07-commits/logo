import { describe, expect, it } from 'vitest';
import type { HireAgreement, RecoveryRecord, StorageRecord } from '@ccguk/domain';
import {
  BEFORE_ACCIDENT_WARNING,
  correctHireBodyFrom,
  correctionChangesText,
  correctionPreview,
  correctionToast,
  editHireFormFrom,
  emptyStartHireForm,
  END_BEFORE_START,
  endHireBodyFrom,
  endStorageBodyFrom,
  enforceabilityChecklist,
  enforceabilityScore,
  enteredLateText,
  FUTURE_END_WARNING,
  GTA_BENCHMARK_NOTE,
  HIRE_TRIGGERS,
  hireDateWarnings,
  hireTotals,
  OLD_START_WARNING,
  paperworkSignedNow,
  pickFleetUnit,
  recoveryBodyFrom,
  recoveryTotals,
  startHireBodyFrom,
  STORAGE_TRIGGERS,
  storageTotals,
  triggerLabel,
  type StartHireForm
} from './hire';
import { MANAGER_WARNING_PREFIX } from '../../../lib/managerMode';

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

describe('0.3: future end is a warning, end before start is relaxed in manager mode', () => {
  const now = '2026-10-04T12:00:00.000Z';
  const base = { endTrigger: 'client_returned' as const, collectedAt: '', odometerIn: '', reason: '' };
  it('end hire: a future end (booked return) is allowed with a warning', () => {
    const r = endHireBodyFrom({ ...base, endAt: '2026-10-10T10:00:00.000Z' }, hire, now);
    expect(r.ok).toBe(true);
    expect(r.warnings?.endAt).toBe(FUTURE_END_WARNING);
  });
  it('end hire: end before start is an error, and a relaxed warning in manager mode', () => {
    const off = endHireBodyFrom({ ...base, endAt: '2026-08-31T10:00:00Z' }, hire, now);
    expect(off).toMatchObject({ ok: false, errors: { endAt: END_BEFORE_START } });
    const on = endHireBodyFrom({ ...base, endAt: '2026-08-31T10:00:00Z' }, hire, now, { managerOn: true });
    expect(on.ok).toBe(true);
    expect(on.warnings?.endAt).toBe(`${MANAGER_WARNING_PREFIX}${END_BEFORE_START}`);
    if (on.ok) expect(on.relaxed).toEqual(['endHire.endAt']);
  });
  it('end hire: the trigger and a manual reason stay required in manager mode', () => {
    const r = endHireBodyFrom({ ...base, endTrigger: 'manual', endAt: '' }, hire, now, { managerOn: true });
    expect(r).toMatchObject({ ok: false, errors: { endAt: expect.any(String), reason: expect.any(String) } });
  });
  it('date warnings: future end, start before the accident, start over a year ago', () => {
    expect(hireDateWarnings('2026-09-01T10:00:00Z', '2026-10-09T10:00:00Z', now, '2026-09-02T08:00:00Z')).toEqual({ endAt: FUTURE_END_WARNING, startAt: BEFORE_ACCIDENT_WARNING });
    expect(hireDateWarnings('2025-09-01T10:00:00Z', '', now).startAt).toBe(OLD_START_WARNING);
    expect(hireDateWarnings('2026-09-01T10:00:00Z', '2026-09-05T10:00:00Z', now, '2026-08-30T10:00:00Z')).toEqual({});
  });
});

describe('0.3: start hire', () => {
  const now = '2026-10-04T12:00:00.000Z';
  const filled = (over: Partial<StartHireForm> = {}): StartHireForm => ({ ...emptyStartHireForm(now), fleetUnitId: 'f1', dailyRatePence: 4999, gtaGroup: 'S1', ...over });
  it('car, start and an agreed rate above £0 are required — even in manager mode', () => {
    const r = startHireBodyFrom({ ...emptyStartHireForm(now), startAt: '' }, undefined, now, { managerOn: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['dailyRatePence', 'fleetUnitId', 'startAt']);
    expect(startHireBodyFrom(filled({ dailyRatePence: 0 }), { status: 'available' }, now).ok).toBe(false);
  });
  it('a backdated hire that has already ended goes in one step', () => {
    const r = startHireBodyFrom(filled({ startAt: '2026-09-24T08:00:00.000Z', endAt: '2026-10-01T08:00:00.000Z', endTrigger: 'client_returned', odometerOut: '12345', clientGtaGroup: 'S1' }), { status: 'available' }, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toMatchObject({ fleetUnitId: 'f1', startAt: '2026-09-24T08:00:00.000Z', endAt: '2026-10-01T08:00:00.000Z', endTrigger: 'client_returned', dailyRatePence: 4999, odometerOut: 12345, clientGtaGroup: 'S1', use: 'credit_hire' });
      expect(r.relaxed).toBeUndefined();
    }
  });
  it('an end needs what ended it; manual needs a reason', () => {
    const r = startHireBodyFrom(filled({ endAt: '2026-10-01T08:00:00.000Z' }), { status: 'available' }, now);
    expect(r).toMatchObject({ ok: false, errors: { endTrigger: expect.any(String) } });
    const m = startHireBodyFrom(filled({ endAt: '2026-10-01T08:00:00.000Z', endTrigger: 'manual' }), { status: 'available' }, now);
    expect(m).toMatchObject({ ok: false, errors: { endReason: expect.any(String) } });
  });
  it('an off-road car and an end before the start are relaxed in manager mode (and sent as relaxed rules)', () => {
    const form = filled({ endAt: '2026-09-01T08:00:00.000Z', endTrigger: 'client_returned', startAt: '2026-09-02T08:00:00.000Z' });
    const off = startHireBodyFrom(form, { status: 'off_road' }, now);
    expect(off).toMatchObject({ ok: false, errors: { fleetUnitId: expect.any(String), endAt: END_BEFORE_START } });
    const on = startHireBodyFrom(form, { status: 'off_road' }, now, { managerOn: true });
    expect(on.ok).toBe(true);
    if (on.ok) expect(on.relaxed?.sort()).toEqual(['startHire.endAt', 'startHire.fleetUnitId']);
    expect(on.warnings?.fleetUnitId).toMatch(/^Allowed in manager mode: /);
  });
  it('a car on hire now is fine for an earlier period: a warning, not an error (the server checks the overlap)', () => {
    const form = filled({ startAt: '2026-08-01T08:00:00.000Z', endAt: '2026-08-05T08:00:00.000Z', endTrigger: 'client_returned' });
    const r = startHireBodyFrom(form, { status: 'on_hire' }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relaxed ?? []).toEqual([]);
    expect(r.warnings?.fleetUnitId).toMatch(/^On hire now — fine for an earlier period/);
  });
  it('a future end is a warning only', () => {
    const r = startHireBodyFrom(filled({ endAt: '2026-10-20T08:00:00.000Z', endTrigger: 'repair_complete_24h' }), { status: 'available' }, now);
    expect(r.ok).toBe(true);
    expect(r.warnings?.endAt).toBe(FUTURE_END_WARNING);
  });
  it('"Paperwork signed now" stamps the three enforceability times and the signature with the hire start', () => {
    const f = paperworkSignedNow(filled({ startAt: '2026-09-24T08:00:00.000Z' }), now);
    expect([f.signedAt, f.cancellationInfoProvidedAt, f.schedule3FormProvidedAt, f.expressRequestToStartAt]).toEqual(Array(4).fill('2026-09-24T08:00:00.000Z'));
  });
  it('picking a car defaults the agreed rate to its fleet rate', () => {
    const f = pickFleetUnit(emptyStartHireForm(now), { id: 'u2', dailyRatePence: 7468, gtaGroup: 'M2' });
    expect(f).toMatchObject({ fleetUnitId: 'u2', dailyRatePence: 7468, gtaGroup: 'M2' });
  });
});

describe('0.3: edit dates & rate', () => {
  const now = '2026-10-04T12:00:00.000Z';
  const ended: HireAgreement = { ...hire, endAt: '2026-09-13T10:00:00Z', endTrigger: 'client_returned', dailyRatePence: 4980 };
  it('sends only what changed, with the reason and the ledger choice', () => {
    const form = { ...editHireFormFrom(ended), startAt: '2026-09-03T10:00:00.000Z', reason: 'agent forgot to upload' };
    const r = correctHireBodyFrom(form, ended, now);
    expect(r).toEqual({ ok: true, body: { startAt: '2026-09-03T10:00:00.000Z', reason: 'agent forgot to upload', ledger: 'auto' } });
    const skip = correctHireBodyFrom({ ...form, updateLedger: false }, ended, now);
    expect(skip.ok && skip.body.ledger).toBe('skip');
  });
  it('an older hire (no stored client group): editing only the start does not send the group worked out today', () => {
    const older: HireAgreement = { ...ended, clientGtaGroup: undefined };
    const form = { ...editHireFormFrom(older, 'M'), startAt: '2026-08-26T10:00:00.000Z', reason: 'agent forgot to upload' };
    expect(form.clientGtaGroup).toBe('M');
    const r = correctHireBodyFrom(form, older, now);
    expect(r).toEqual({ ok: true, body: { startAt: '2026-08-26T10:00:00.000Z', reason: 'agent forgot to upload', ledger: 'auto' } });
    // choosing a different group is sent
    const changed = correctHireBodyFrom({ ...form, clientGtaGroup: 's1' }, older, now);
    expect(changed.ok && changed.body.clientGtaGroup).toBe('S1');
  });
  it('a reason of at least 3 characters is required, and something must change', () => {
    expect(correctHireBodyFrom({ ...editHireFormFrom(ended), startAt: '2026-09-03T10:00:00.000Z', reason: 'no' }, ended, now)).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
    expect(correctHireBodyFrom({ ...editHireFormFrom(ended), reason: 'just because' }, ended, now)).toMatchObject({ ok: false, errors: { form: expect.any(String) } });
  });
  it('clearing the end re-opens the hire; groups are upper-cased', () => {
    const r = correctHireBodyFrom({ ...editHireFormFrom(ended), endAt: '', endTrigger: '', clientGtaGroup: 's1', gtaGroup: 'm2', reason: 'still out' }, ended, now);
    expect(r).toEqual({ ok: true, body: { endAt: null, gtaGroup: 'M2', clientGtaGroup: 'S1', reason: 'still out', ledger: 'auto' } });
  });
  it('end before start: error, or a relaxed warning in manager mode; old and pre-accident starts warn', () => {
    const form = { ...editHireFormFrom(ended), startAt: '2026-09-20T10:00:00.000Z', reason: 'typo' };
    expect(correctHireBodyFrom(form, ended, now)).toMatchObject({ ok: false, errors: { endAt: END_BEFORE_START } });
    const on = correctHireBodyFrom(form, ended, now, { managerOn: true });
    expect(on.ok && on.relaxed).toEqual(['editHire.endAt']);
    const old = correctHireBodyFrom({ ...form, startAt: '2025-09-01T10:00:00.000Z' }, ended, now, { accidentAt: '2026-08-30T10:00:00Z' });
    expect(old.warnings?.startAt).toContain(BEFORE_ACCIDENT_WARNING);
    expect(old.warnings?.startAt).toContain(OLD_START_WARNING);
  });
  it('live preview: now 12 days · £597.60 net → after 10 days · £498.00 net (−£99.60)', () => {
    const h: HireAgreement = { ...hire, startAt: '2026-09-01T10:00:00Z', endAt: '2026-09-13T10:00:00Z', dailyRatePence: 4980 };
    const p = correctionPreview(h, { ...editHireFormFrom(h), startAt: '2026-09-03T10:00:00.000Z' }, now);
    expect(p.text).toBe('Now 12 days · £597.60 net → after 10 days · £498.00 net (−£99.60)');
  });
  it('toast and correction lines', () => {
    const after = { startAt: '', dailyRatePence: 4980, days: 10, netPence: 49_800, grossPence: 59_760 };
    expect(correctionToast('CCG-H-000004', { changed: true, after })).toBe('Hire CCG-H-000004 updated — 10 days, £498.00 net. Clocks recalculated.');
    expect(correctionChangesText({ days: { from: 12, to: 10 }, dailyRatePence: { from: 4980, to: 4232 }, reason: { from: null, to: 'x' } })).toBe('days 12 → 10; daily rate £49.80 → £42.32');
  });
  it('entered-late text', () => {
    expect(enteredLateText({ startAt: '2026-09-01T09:00:00Z', recordedAt: '2026-10-05T08:00:00Z', recordedByName: 'Courtesy Cars' })).toBe('Started 1 Sep 10:00 · recorded 5 Oct by Courtesy Cars');
  });
  it('the benchmark note names no clause number in visible text', () => {
    expect(GTA_BENCHMARK_NOTE).toMatch(/benchmark/);
    expect(GTA_BENCHMARK_NOTE).not.toMatch(/2\.7\(j\)/);
  });
});
