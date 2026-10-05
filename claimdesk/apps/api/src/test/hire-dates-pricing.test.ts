/**
 * ClaimDesk 0.3 — hire pricing guide and editable, backdatable hire dates (docs/V03-MANAGER-MODE-HIRE-PRICING.md §B, §C,
 * verification §I.4 and §I.5). The manager-mode cases run last: they use override-api's routes and gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Claim, ClaimEvent, Clock, FleetUnit, HireAgreement, LedgerEntry } from '@ccguk/domain';
import { createTestApp, FNOL, type TestApp } from './helpers.js';

type Created = { claim: Claim };
type ApiError = { error: { code: string; message: string; details?: Record<string, unknown>; override?: { code: string; class: string; allowed: boolean; managerMode: string } } };
type Guide = {
  higherGroup: boolean;
  differencePerDayPence: number | null;
  notices: string[];
  suggestions: Array<{ id: string; label: string; dailyRatePence: number }>;
  hireCar: { group: string | null; dailyRatePence: number | null };
  clientCar: { group: string | null; dailyRatePence: number | null; source: string };
  fleetUnit: { id: string; registration?: string; gtaGroup: string; dailyRatePence: number };
  clientVehicle: { id: string; registration: string; gtaGroup?: string };
  clientSuggestion: { basis: string };
  groupsOnDate: string[];
  note: string;
};
type HireItem = HireAgreement & {
  calculation: { days: number; netPence: number; likeForLike?: { group: string; gtaDailyRatePence: number } };
  pricing: { snapshot: boolean; clientGtaGroup: string | null; hireGtaDailyRatePence: number | null; clientGtaDailyRatePence: number | null; differencePerDayPence: number | null; higherGroup: boolean; notices: string[] };
  recordedAt: string;
  backdated: boolean;
  corrections: Array<{ at: string; by: string; reason: string; changes: Record<string, { from: unknown; to: unknown }> }>;
};
type CreatedHire = { hire: HireAgreement; pricing: Guide; warnings: string[] };
type Corrected = {
  changed: boolean;
  hire: HireAgreement;
  before: { days: number; netPence: number };
  after: { days: number; netPence: number };
  ledger: { action: string; entryId?: string; message: string };
  warnings: string[];
  clocks: Clock[];
};

const HIGHER =
  "Higher group than the damaged car: the car you are giving (M2, £74.68/day guide) is in a higher group than the client's damaged car (S1, £42.32/day guide). Like-for-like guide £42.32/day; difference £32.36/day.";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z');
});
afterEach(async () => {
  await t.close();
});

function fleetUnit(registration: string, gtaGroup: string, dailyRatePence: number, make = 'Nissan', model = 'Qashqai'): FleetUnit {
  const v = t.ctx.repos.upsertVehicle(t.ctx.db, { registration, make, model, ownership: 'fleet' });
  const policy = t.ctx.repos.createPolicy(t.ctx.db, { insurerName: 'Fleet Insurer Ltd', policyNumber: `FL-${registration}`, coveredUses: ['credit_hire', 'self_drive'], startDate: '2026-01-01', endDate: '2026-12-31' });
  return t.ctx.repos.createFleetUnit(t.ctx.db, { vehicleId: v.id, declaredUses: ['credit_hire'], policyId: policy.id, dailyRatePence, gtaGroup });
}

async function claimWithClientGroup(group: string | undefined, registration = 'KX21 ABC'): Promise<Claim> {
  const created = await t.api<Created>('POST', '/claims', { ...FNOL, vehicle: { ...FNOL.vehicle, registration } });
  expect(created.status).toBe(201);
  const claim = created.body.claim;
  if (group) t.ctx.repos.updateVehicle(t.ctx.db, claim.clientVehicleId, { gtaGroup: group });
  return claim;
}

const hireList = async (claimId: string): Promise<HireItem[]> => (await t.api<{ hire: HireItem[] }>('GET', `/claims/${claimId}/hire`)).body.hire;
const events = async (claimId: string, type: string): Promise<ClaimEvent[]> => (await t.api<{ events: ClaimEvent[] }>('GET', `/claims/${claimId}/events?type=${type}`)).body.events;
const flagsOf = (claimId: string) => t.ctx.repos.requireClaim(t.ctx.db, claimId).flags;

describe('pricing guide (§B, §I.4)', () => {
  it('higher-group car: M2 at £74.68 against a client S1 — difference, exact notice, three chips', async () => {
    const claim = await claimWithClientGroup('S1');
    const unit = fleetUnit('FL25 MXX', 'M2', 7468);
    const r = await t.api<Guide>('GET', `/claims/${claim.id}/hire/pricing-guide?fleetUnitId=${unit.id}&startAt=2026-10-05T10:00:00.000Z`);
    expect(r.status).toBe(200);
    expect(r.body.higherGroup).toBe(true);
    expect(r.body.differencePerDayPence).toBe(3236);
    expect(r.body.notices[0]).toBe(HIGHER);
    expect(r.body.hireCar).toMatchObject({ group: 'M2', dailyRatePence: 7468 });
    expect(r.body.clientCar).toMatchObject({ group: 'S1', dailyRatePence: 4232, source: 'recorded' });
    expect(r.body.clientSuggestion.basis).toBe('recorded');
    expect(r.body.suggestions.map((s) => [s.label, s.dailyRatePence])).toEqual([
      ['Fleet rate', 7468],
      ['Car we give — guide', 7468],
      ["Client's car — guide (like for like)", 4232],
    ]);
    expect(r.body.fleetUnit).toMatchObject({ id: unit.id, registration: 'FL25MXX', gtaGroup: 'M2', dailyRatePence: 7468 });
    expect(r.body.clientVehicle).toMatchObject({ registration: 'KX21ABC', gtaGroup: 'S1' });
    expect(r.body.groupsOnDate).toEqual(expect.arrayContaining(['S1', 'M', 'M2']));
    expect(r.body.note).toMatch(/not a GTA subscriber/);
    // GTA figures are unverified benchmarks: reported as such, never upgraded
    expect(r.body.notices.some((n) => /is unverified\.$/.test(n))).toBe(true);
  });

  it('same group, lower group and a manual client group', async () => {
    const claim = await claimWithClientGroup('S1');
    const polo = fleetUnit('FL44 EET', 'S1', 4232, 'Volkswagen', 'Polo');
    const same = await t.api<Guide>('GET', `/claims/${claim.id}/hire/pricing-guide?fleetUnitId=${polo.id}`);
    expect(same.body.differencePerDayPence).toBe(0);
    expect(same.body.higherGroup).toBe(false);
    expect(same.body.notices.some((n) => /group than the damaged car/.test(n))).toBe(false);

    const lower = await t.api<Guide>('GET', `/claims/${claim.id}/hire/pricing-guide?fleetUnitId=${polo.id}&clientGroup=m`);
    expect(lower.body.clientCar).toMatchObject({ group: 'M', dailyRatePence: 5666, source: 'manual' });
    expect(lower.body.higherGroup).toBe(false);
    expect(lower.body.notices[0]).toMatch(/^Lower group than the damaged car: the car you are giving \(S1, £42\.32\/day guide\) is in a lower group than the client's damaged car \(M, £56\.66\/day guide\)/);

    expect((await t.api<ApiError>('GET', `/claims/${claim.id}/hire/pricing-guide?fleetUnitId=${polo.id}&clientGroup=not-a-group`)).status).toBe(400);
  });

  it('a client car with no group and no suggestion says so', async () => {
    const claim = await claimWithClientGroup(undefined);
    t.ctx.repos.updateVehicle(t.ctx.db, claim.clientVehicleId, { make: 'UNKNOWN', model: 'UNKNOWN' });
    const unit = fleetUnit('FL25 MXX', 'M2', 7468);
    const r = await t.api<Guide>('GET', `/claims/${claim.id}/hire/pricing-guide?fleetUnitId=${unit.id}`);
    expect(r.body.clientCar).toMatchObject({ group: null, source: 'none' });
    expect(r.body.notices).toContain("The client's car has no GTA group yet — choose one to see the like-for-like guide.");
  });
});

describe('hire dates (§C, §I.5)', () => {
  async function backdatedHire() {
    const claim = await claimWithClientGroup('S1');
    const unit = fleetUnit('FL25 MXX', 'M2', 7468);
    const res = await t.api<CreatedHire>('POST', `/claims/${claim.id}/hire`, {
      fleetUnitId: unit.id,
      startAt: '2026-09-20T09:00:00.000Z',
      endAt: '2026-09-27T09:00:00.000Z',
      endTrigger: 'client_returned',
      endReason: 'Client brought the car back',
      dailyRatePence: 4232,
    });
    expect(res.status).toBe(201);
    return { claim, unit, hire: res.body.hire, created: res.body };
  }

  it('POST with a past start and end: unit stays available, events marked lateEntry, 7 days charged, snapshot stored', async () => {
    const { claim, unit, hire, created } = await backdatedHire();
    expect(hire).toMatchObject({ endAt: '2026-09-27T09:00:00.000Z', endTrigger: 'client_returned', clientGtaGroup: 'S1', clientGtaDailyRatePence: 4232, hireGtaDailyRatePence: 7468, fleetDailyRatePence: 7468 });
    expect(hire.pricingNote).toContain('Higher group than the damaged car');
    expect(created.pricing.higherGroup).toBe(true);
    expect(created.warnings.some((w) => /before the accident/.test(w))).toBe(true);
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.id).status).toBe('available');
    const started = await events(claim.id, 'hire_started');
    const ended = await events(claim.id, 'hire_ended');
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(started[0]!.data).toMatchObject({ hireId: hire.id, lateEntry: true });
    expect(ended[0]!.data).toMatchObject({ hireId: hire.id, endTrigger: 'client_returned', days: 7, lateEntry: true });
    const [item] = await hireList(claim.id);
    expect(item!.calculation.days).toBe(7);
    expect(item!.calculation.netPence).toBe(7 * 4232);
    expect(item!.calculation.likeForLike).toMatchObject({ group: 'S1', gtaDailyRatePence: 4232 });
    expect(item!.pricing).toMatchObject({ snapshot: true, clientGtaGroup: 'S1', hireGtaDailyRatePence: 7468, clientGtaDailyRatePence: 4232, differencePerDayPence: 3236, higherGroup: true });
    expect(item!.pricing.notices[0]).toBe(HIGHER);
    expect(item!.backdated).toBe(true);
    expect(item!.corrections).toEqual([]);
    const audit = t.ctx.repos.listAudit(t.ctx.db, { entityId: hire.id, action: 'hire.create' });
    expect(audit[0]!.after).toMatchObject({ lateEntry: true, override: null, pricing: { clientGtaGroup: 'S1', higherGroup: true } });
  });

  it('PATCH moving the start by +2 days: recalculated, correcting event, clocks follow, audited, ledger superseded', async () => {
    const { claim, hire } = await backdatedHire();
    const ledgerRow = await t.api<LedgerEntry>('POST', `/claims/${claim.id}/ledger`, { head: 'hire', kind: 'claimed', amountPence: 7 * 4232, date: '2026-09-27', description: 'Credit hire 7 days × £42.32' });
    expect(ledgerRow.status).toBe(201);
    const [originalStart] = await events(claim.id, 'hire_started');
    const clocksBefore = (await t.api<{ clocks: Clock[] }>('GET', `/claims/${claim.id}/clocks`)).body.clocks;
    expect(clocksBefore.find((c) => c.kind === 'gta_4_1_ncaf_1wd')?.sourceEventId).toBe(originalStart!.id);

    const r = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${hire.id}`, { startAt: '2026-09-22T09:00:00.000Z', reason: 'agent forgot to upload' });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    expect(r.body.before).toMatchObject({ days: 7, netPence: 7 * 4232 });
    expect(r.body.after).toMatchObject({ days: 5, netPence: 5 * 4232 });
    expect(r.body.hire.startAt).toBe('2026-09-22T09:00:00.000Z');

    const started = await events(claim.id, 'hire_started');
    expect(started).toHaveLength(2); // GET events keeps the corrected one
    const correcting = started.find((e) => e.id !== originalStart!.id)!;
    expect(correcting.data).toMatchObject({ hireId: hire.id, correctsEventId: originalStart!.id, correction: true, reason: 'agent forgot to upload', lateEntry: true });
    expect(correcting.summary).toMatch(/start corrected from .* to .* — agent forgot to upload$/);
    const ncaf = r.body.clocks.find((c) => c.kind === 'gta_4_1_ncaf_1wd');
    expect(ncaf?.sourceEventId).toBe(correcting.id);
    expect(Date.parse(ncaf!.startsAt)).toBe(Date.parse('2026-09-22T09:00:00.000Z'));

    const audit = t.ctx.repos.listAudit(t.ctx.db, { entityId: hire.id, action: 'hire.correct' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toMatchObject({ startAt: '2026-09-20T09:00:00.000Z', days: 7 });
    expect(audit[0]!.after).toMatchObject({ startAt: '2026-09-22T09:00:00.000Z', days: 5, reason: 'agent forgot to upload', claimId: claim.id, ledger: 'superseded' });

    // ledger: the single live claimed row is superseded by a corrected row
    expect(r.body.ledger.action).toBe('superseded');
    const live = t.ctx.repos.listLedger(t.ctx.db, claim.id, { head: 'hire' });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: r.body.ledger.entryId, kind: 'claimed', amountPence: 5 * 4232, supersedesId: ledgerRow.body.id });
    expect(live[0]!.description).toBe('Credit hire 5 days × £42.32 (corrected: agent forgot to upload)');
    // the system-written row has its own ledger.append audit row, like a manual one
    const appended = t.ctx.repos.listAudit(t.ctx.db, { action: 'ledger.append', entityId: r.body.ledger.entryId! });
    expect(appended).toHaveLength(1);
    expect(appended[0]!.after).toMatchObject({ amountPence: 5 * 4232, supersedesId: ledgerRow.body.id, reason: 'hire.correct' });

    const [item] = await hireList(claim.id);
    expect(item!.calculation.days).toBe(5);
    expect(item!.corrections).toHaveLength(1);
    expect(item!.corrections[0]).toMatchObject({ reason: 'agent forgot to upload', changes: { startAt: { from: '2026-09-20T09:00:00.000Z', to: '2026-09-22T09:00:00.000Z' }, days: { from: 7, to: 5 } } });

    // nothing changed → changed:false, nothing written
    const same = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${hire.id}`, { startAt: '2026-09-22T09:00:00.000Z', reason: 'no-op' });
    expect(same.body.changed).toBe(false);
    expect(t.ctx.repos.listAudit(t.ctx.db, { entityId: hire.id, action: 'hire.correct' })).toHaveLength(1);
    // a reason is required
    expect((await t.api<ApiError>('PATCH', `/claims/${claim.id}/hire/${hire.id}`, { startAt: '2026-09-23T09:00:00.000Z' })).status).toBe(400);
  });

  it('with an invoiced row, the flag is raised and the invoiced row is untouched', async () => {
    const { claim, hire } = await backdatedHire();
    await t.api('POST', `/claims/${claim.id}/ledger`, { head: 'hire', kind: 'claimed', amountPence: 7 * 4232, date: '2026-09-27', description: 'Credit hire 7 days' });
    const invoiced = await t.api<LedgerEntry>('POST', `/claims/${claim.id}/ledger`, { head: 'hire', kind: 'invoiced', amountPence: 7 * 4232, date: '2026-09-28', description: 'Invoice INV-1' });
    const r = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${hire.id}`, { endAt: '2026-09-25T09:00:00.000Z', reason: 'returned earlier than recorded' });
    expect(r.body.ledger.action).toBe('invoiced');
    const flag = flagsOf(claim.id).find((f) => f.code === 'HIRE_PERIOD_CHANGED_AFTER_INVOICE');
    expect(flag?.message).toBe(`Hire ${hire.agreementNumber} changed after it was invoiced (invoiced £296.24, now 5 days £211.60): issue a corrected invoice or a credit note.`);
    const rows = t.ctx.repos.listLedger(t.ctx.db, claim.id, { head: 'hire', includeSuperseded: true });
    expect(rows).toHaveLength(2);
    expect(rows.find((e) => e.id === invoiced.body.id)).toEqual(invoiced.body);
    // the end correction is an appended hire_ended correcting the first
    const ended = await events(claim.id, 'hire_ended');
    expect(ended).toHaveLength(2);
    const original = ended.find((e) => e.at === '2026-09-27T09:00:00.000Z' || Date.parse(e.at) === Date.parse('2026-09-27T09:00:00.000Z'))!;
    const correcting = ended.find((e) => e.id !== original.id)!;
    expect(correcting.data).toMatchObject({ correctsEventId: original.id, days: 5, correction: true });
    // a later correction brings the one open flag up to date (it does not keep the first correction's figures)
    const again = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${hire.id}`, { endAt: '2026-09-24T09:00:00.000Z', reason: 'returned earlier still' });
    expect(again.body.ledger.action).toBe('invoiced');
    const open = flagsOf(claim.id).filter((f) => f.code === 'HIRE_PERIOD_CHANGED_AFTER_INVOICE' && !f.clearedAt);
    expect(open).toHaveLength(1);
    expect(open[0]!.message).toBe(`Hire ${hire.agreementNumber} changed after it was invoiced (invoiced £296.24, now 4 days £169.28): issue a corrected invoice or a credit note.`);
  });

  it('two claimed rows → review flag; ledger "skip" leaves the ledger alone', async () => {
    const { claim, hire } = await backdatedHire();
    await t.api('POST', `/claims/${claim.id}/ledger`, { head: 'hire', kind: 'claimed', amountPence: 4 * 4232, date: '2026-09-27', description: 'part 1' });
    await t.api('POST', `/claims/${claim.id}/ledger`, { head: 'hire', kind: 'claimed', amountPence: 3 * 4232, date: '2026-09-27', description: 'part 2' });
    const skip = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${hire.id}`, { dailyRatePence: 4000, reason: 'agreed lower rate', ledger: 'skip' });
    expect(skip.body.ledger.action).toBe('none');
    expect(flagsOf(claim.id).some((f) => f.code === 'HIRE_LEDGER_REVIEW')).toBe(false);
    const notes = await events(claim.id, 'note');
    expect(notes.at(-1)!.summary).toBe(`Hire ${hire.agreementNumber} daily rate corrected from £42.32 to £40.00 — agreed lower rate`);
    const review = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${hire.id}`, { dailyRatePence: 4100, reason: 'rate agreed again' });
    expect(review.body.ledger.action).toBe('review');
    expect(flagsOf(claim.id).some((f) => f.code === 'HIRE_LEDGER_REVIEW' && !f.clearedAt)).toBe(true);
  });

  it('an end in the future: still running (on hire) and charged only up to now', async () => {
    const { claim, unit, hire } = await backdatedHire();
    const r = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${hire.id}`, { endAt: '2026-10-08T09:00:00.000Z', reason: 'client keeps the car until Thursday' });
    expect(r.status).toBe(200);
    expect(r.body.hire.endAt).toBe('2026-10-08T09:00:00.000Z');
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.id).status).toBe('on_hire');
    // 20 Sep 09:00 → now 5 Oct 09:00 = 15 days, not 18 to the future end
    expect(r.body.after.days).toBe(15);
    const [item] = await hireList(claim.id);
    expect(item!.calculation.days).toBe(15);
    expect(item!.calculation.netPence).toBe(15 * 4232);
    // once the end has arrived it is charged to the end
    t.setNow('2026-10-09T09:00:00.000Z');
    const [later] = await hireList(claim.id);
    expect(later!.calculation.days).toBe(18);
  });

  it('re-opening with endAt null makes the hire running again and the unit on_hire', async () => {
    const { claim, unit, hire } = await backdatedHire();
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.id).status).toBe('available');
    const r = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${hire.id}`, { endAt: null, reason: 'car not actually returned' });
    expect(r.status).toBe(200);
    expect(r.body.hire.endAt).toBeUndefined();
    expect(r.body.hire.endTrigger).toBeUndefined();
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.id).status).toBe('on_hire');
    const [ended] = await events(claim.id, 'hire_ended');
    const notes = await events(claim.id, 'note');
    expect(notes.find((n) => n.data?.['correctsEventId'] === ended!.id)?.summary).toBe(`Hire ${hire.agreementNumber} re-opened — end removed: car not actually returned`);
    const [item] = await hireList(claim.id);
    expect(item!.endAt).toBeUndefined();
    expect(item!.calculation.days).toBe(15); // 20 Sep 09:00 → now 5 Oct 09:00 (10:00 London)
  });

  it('HIRE_OVERLAP without manager mode: 409 naming the other agreement, with details.overlaps and override.allowed', async () => {
    const { claim, unit, hire } = await backdatedHire();
    const other = await claimWithClientGroup('S1', 'AB12 CDE');
    const r = await t.api<ApiError>('POST', `/claims/${other.id}/hire`, { fleetUnitId: unit.id, startAt: '2026-09-25T09:00:00.000Z', endAt: '2026-09-30T09:00:00.000Z' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('HIRE_OVERLAP');
    expect(r.body.error.message).toBe(`FL25 MXX is on hire ${hire.agreementNumber} (claim ${claim.reference}) from 20 Sep 2026 10:00 to 27 Sep 2026 10:00.`);
    expect(r.body.error.details?.['overlaps']).toEqual([{ hireId: hire.id, agreementNumber: hire.agreementNumber, claimId: claim.id, claimReference: claim.reference, startAt: hire.startAt, endAt: hire.endAt }]);
    expect(r.body.error.override).toMatchObject({ code: 'HIRE_OVERLAP', class: 'A', allowed: true, managerMode: 'off' });
    // touching periods are fine: a hire from the moment the first ended
    const touching = await t.api<CreatedHire>('POST', `/claims/${other.id}/hire`, { fleetUnitId: unit.id, startAt: '2026-09-27T09:00:00.000Z', endAt: '2026-09-29T09:00:00.000Z' });
    expect(touching.status).toBe(201);
    // PATCH into another hire's period is refused the same way
    const patch = await t.api<ApiError>('PATCH', `/claims/${other.id}/hire/${touching.body.hire.id}`, { startAt: '2026-09-26T09:00:00.000Z', reason: 'moved earlier' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('HIRE_OVERLAP');
  });

  it('end before start: HIRE_END_BEFORE_START (class B) on create, end and PATCH; already ended → HIRE_ALREADY_ENDED', async () => {
    const claim = await claimWithClientGroup('S1');
    const unit = fleetUnit('FL25 MXX', 'M2', 7468);
    const r = await t.api<ApiError>('POST', `/claims/${claim.id}/hire`, { fleetUnitId: unit.id, startAt: '2026-09-20T09:00:00.000Z', endAt: '2026-09-19T09:00:00.000Z' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('HIRE_END_BEFORE_START');
    expect(r.body.error.override).toMatchObject({ code: 'HIRE_END_BEFORE_START', class: 'B', allowed: true });
    expect(t.ctx.repos.listHire(t.ctx.db, claim.id)).toHaveLength(0);

    const running = await t.api<CreatedHire>('POST', `/claims/${claim.id}/hire`, { fleetUnitId: unit.id, startAt: '2026-10-01T09:00:00.000Z' });
    expect(running.status).toBe(201);
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.id).status).toBe('on_hire');
    const end = await t.api<ApiError>('POST', `/claims/${claim.id}/hire/${running.body.hire.id}/end`, { endAt: '2026-09-30T09:00:00.000Z', endTrigger: 'manual' });
    expect(end.body.error.code).toBe('HIRE_END_BEFORE_START');
    const patch = await t.api<ApiError>('PATCH', `/claims/${claim.id}/hire/${running.body.hire.id}`, { endAt: '2026-09-30T09:00:00.000Z', reason: 'typo test' });
    expect(patch.body.error.code).toBe('HIRE_END_BEFORE_START');

    const ok = await t.api<{ hire: HireAgreement }>('POST', `/claims/${claim.id}/hire/${running.body.hire.id}/end`, { endAt: '2026-10-03T09:00:00.000Z', endTrigger: 'client_returned' });
    expect(ok.status).toBe(200);
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.id).status).toBe('available');
    const [endedEvent] = await events(claim.id, 'hire_ended');
    expect(endedEvent!.data).toMatchObject({ lateEntry: true });
    const again = await t.api<ApiError>('POST', `/claims/${claim.id}/hire/${running.body.hire.id}/end`, { endAt: '2026-10-04T09:00:00.000Z', endTrigger: 'client_returned' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'HIRE_ALREADY_ENDED', message: 'Use Edit dates to change the end' });
    expect(again.body.error.override).toBeUndefined();
  });

  it('an older hire_started with no data.hireId, on a claim with two hires, is still the one corrected', async () => {
    const claim = await claimWithClientGroup('S1');
    const unit = fleetUnit('FL44 EET', 'S1', 4232, 'Volkswagen', 'Polo');
    const other = fleetUnit('FL33 EET', 'S1', 4232, 'Volkswagen', 'Polo');
    const seeded = t.ctx.repos.createHire(t.ctx.db, { claimId: claim.id, fleetUnitId: unit.id, startAt: '2026-09-16T09:00:00.000Z', dailyRatePence: 4232, vatRate: 0, gtaGroup: 'S1', excessPence: 0 });
    t.ctx.repos.createHire(t.ctx.db, { claimId: claim.id, fleetUnitId: other.id, startAt: '2026-09-01T09:00:00.000Z', endAt: '2026-09-05T09:00:00.000Z', dailyRatePence: 4232, vatRate: 0, gtaGroup: 'S1', excessPence: 0 });
    const untagged = t.ctx.repos.appendEvent(t.ctx.db, { claimId: claim.id, type: 'hire_started', at: '2026-09-16T09:00:00.000Z', summary: 'Hire started on FL44 EET', attributableTo: 'ccguk', evidenceIds: [], createdBy: 'system', recordedAt: '2026-09-16T09:00:00.000Z' });
    const r = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${seeded.id}`, { startAt: '2026-08-26T09:00:00.000Z', reason: 'agent forgot to upload' });
    expect(r.status).toBe(200);
    const started = await events(claim.id, 'hire_started');
    const correcting = started.find((e) => e.id !== untagged.id && e.data?.['hireId'] === seeded.id)!;
    expect(correcting.data).toMatchObject({ correctsEventId: untagged.id, correction: true });
  });

  it('a pre-0.3 hire (no snapshot) is priced at read time with snapshot:false', async () => {
    const claim = await claimWithClientGroup('S1');
    const unit = fleetUnit('FL25 MXX', 'M2', 7468);
    t.ctx.repos.createHire(t.ctx.db, { claimId: claim.id, fleetUnitId: unit.id, startAt: '2026-09-01T09:00:00.000Z', endAt: '2026-09-03T09:00:00.000Z', dailyRatePence: 7468, vatRate: 0, gtaGroup: 'M2', excessPence: 0 });
    const [item] = await hireList(claim.id);
    expect(item!.pricing).toMatchObject({ snapshot: false, clientGtaGroup: 'S1', hireGtaDailyRatePence: 7468, clientGtaDailyRatePence: 4232, differencePerDayPence: 3236, higherGroup: true });
    // the 0007 pricing columns are null: the unit's own rate is reported as the fleet rate
    expect((item!.pricing as unknown as { fleetDailyRatePence: number | null }).fleetDailyRatePence).toBe(7468);
    expect(item!.calculation.likeForLike?.group).toBe('S1');
  });
});

describe('manager mode on hires (override-api gate; run last)', () => {
  const header = { 'x-manager-override': encodeURIComponent('Verify test') };

  it('with manager mode on and the header, overlap and end-before-start are saved and audited as override.<CODE>', async () => {
    const claim = await claimWithClientGroup('S1');
    const unit = fleetUnit('FL25 MXX', 'M2', 7468);
    const first = await t.api<CreatedHire>('POST', `/claims/${claim.id}/hire`, { fleetUnitId: unit.id, startAt: '2026-09-20T09:00:00.000Z', endAt: '2026-09-27T09:00:00.000Z' });
    expect(first.status).toBe(201);

    // header without manager mode on → still refused
    const refused = await t.api<ApiError>('POST', `/claims/${claim.id}/hire`, { fleetUnitId: unit.id, startAt: '2026-09-25T09:00:00.000Z', endAt: '2026-09-26T09:00:00.000Z' }, header);
    expect(refused.status).toBe(409);
    expect(refused.body.error.override?.managerMode).toBe('off');

    const on = await t.api<{ on: boolean }>('POST', '/auth/manager-mode', { on: true });
    expect(on.status).toBe(200);
    expect(on.body.on).toBe(true);

    const res = await t.app.inject({ method: 'POST', url: `/api/claims/${claim.id}/hire`, payload: { fleetUnitId: unit.id, startAt: '2026-09-25T09:00:00.000Z', endAt: '2026-09-26T09:00:00.000Z' }, headers: header });
    expect(res.statusCode).toBe(201);
    const applied = JSON.parse(decodeURIComponent(String(res.headers['x-manager-overrides']))) as Array<{ code: string; reason: string }>;
    expect(applied).toEqual([expect.objectContaining({ code: 'HIRE_OVERLAP', reason: 'Verify test' })]);
    const overlapAudit = t.ctx.repos.listAudit(t.ctx.db, { action: 'override.HIRE_OVERLAP' });
    expect(overlapAudit).toHaveLength(1);
    expect(overlapAudit[0]).toMatchObject({ entity: 'claims', entityId: claim.id, after: { reason: 'Verify test', target: { entity: 'fleet_units', entityId: unit.id } } });

    // end before start, saved in manager mode: 0 days, HIRE_DATES_INVALID flag; correcting the dates clears it
    const unit2 = fleetUnit('FL26 ABC', 'S1', 4232, 'Volkswagen', 'Polo');
    const odd = await t.api<CreatedHire>('POST', `/claims/${claim.id}/hire`, { fleetUnitId: unit2.id, startAt: '2026-09-20T09:00:00.000Z', endAt: '2026-09-19T09:00:00.000Z' }, header);
    expect(odd.status).toBe(201);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'override.HIRE_END_BEFORE_START' })).toHaveLength(1);
    expect(flagsOf(claim.id).find((f) => f.code === 'HIRE_DATES_INVALID' && !f.clearedAt)).toBeDefined();
    const oddItem = (await hireList(claim.id)).find((h) => h.id === odd.body.hire.id)!;
    expect(oddItem.calculation.days).toBe(0);
    const fixed = await t.api<Corrected>('PATCH', `/claims/${claim.id}/hire/${odd.body.hire.id}`, { endAt: '2026-09-21T09:00:00.000Z', reason: 'end date typo' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.after.days).toBe(1);
    const cleared = flagsOf(claim.id).find((f) => f.code === 'HIRE_DATES_INVALID');
    expect(cleared).toMatchObject({ clearedBy: 'system', clearedReason: 'Dates corrected' });

    // PATCH into an overlap with the header in manager mode
    const moved = await t.app.inject({ method: 'PATCH', url: `/api/claims/${claim.id}/hire/${first.body.hire.id}`, payload: { endAt: '2026-09-25T12:00:00.000Z', reason: 'manager correction' }, headers: header });
    expect(moved.statusCode).toBe(200);
    const patchAudit = t.ctx.repos.listAudit(t.ctx.db, { action: 'override.HIRE_OVERLAP' });
    expect(patchAudit).toHaveLength(2);
    expect(patchAudit.some((a) => (a.after as { target: { entity: string } }).target.entity === 'hire_agreements')).toBe(true);
  });

  it('overrideAllocation alone no longer bypasses ALLOCATION_REFUSED; manager mode does', async () => {
    const claim = await claimWithClientGroup('S1');
    const unit = fleetUnit('FL25 MXX', 'M2', 7468);
    t.ctx.repos.updateFleetUnit(t.ctx.db, unit.id, { status: 'off_road' });
    const refused = await t.api<ApiError>('POST', `/claims/${claim.id}/hire`, { fleetUnitId: unit.id, startAt: '2026-10-05T10:00:00.000Z', overrideAllocation: { reason: 'boss said so' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ALLOCATION_REFUSED');
    expect(refused.body.error.details?.['reasons']).toEqual(expect.arrayContaining([expect.any(String)]));
    await t.api('POST', '/auth/manager-mode', { on: true });
    const ok = await t.api<CreatedHire>('POST', `/claims/${claim.id}/hire`, { fleetUnitId: unit.id, startAt: '2026-10-05T10:00:00.000Z', overrideAllocation: { reason: 'boss said so' } }, header);
    expect(ok.status).toBe(201);
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, unit.id).status).toBe('off_road'); // kept: derived status never overrides off_road
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'override.ALLOCATION_REFUSED' })).toHaveLength(1);
    const audit = t.ctx.repos.listAudit(t.ctx.db, { entityId: ok.body.hire.id, action: 'hire.create' });
    expect(audit[0]!.after).toMatchObject({ override: { reason: 'boss said so' } });
  });
});
