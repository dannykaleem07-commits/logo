import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GtaSuggestion } from '@ccguk/domain';
import { updateFleetUnit } from './fleetApi';
import { applySuggestion, editRate } from './gtaPanel';
import {
  buildPenaltyBody,
  buildUnitBody,
  buildUnitPatch,
  type UnitForm,
  describeDueDate,
  dueTone,
  emptyPenaltyForm,
  emptyUnitForm,
  groupAlertsBySeverity,
  isTerminalStage,
  nextStages,
  penaltyDocumentTemplate,
  sortPenalties,
  transitionNeedsHire,
  unitToForm,
  validatePenaltyForm,
  validateUnitForm,
  type FleetUnitView
} from './fleet';

const today = '2026-10-04';

describe('dueTone', () => {
  it('colours expired red, within 30 days amber, later green, missing grey', () => {
    expect(dueTone('2026-10-03', today)).toBe('expired');
    expect(dueTone('2026-10-04', today)).toBe('soon');
    expect(dueTone('2026-11-03', today)).toBe('soon');
    expect(dueTone('2026-11-04', today)).toBe('ok');
    expect(dueTone(undefined, today)).toBe('unknown');
    expect(describeDueDate('2026-10-01', today)).toBe('expired 3 days ago');
    expect(describeDueDate('2026-10-05', today)).toBe('due in 1 day');
    expect(describeDueDate(undefined, today)).toBe('not recorded');
  });
});

describe('penalty stages', () => {
  it('offers the identify → transfer → representations → appeal path and stops at paid/cancelled', () => {
    expect(nextStages('received')).toContain('hirer_identified');
    expect(nextStages('hirer_identified')).toContain('liability_transferred');
    expect(nextStages('liability_transferred')).toContain('representations');
    expect(nextStages('representations')).toContain('appeal');
    expect(isTerminalStage('paid')).toBe(true);
    expect(isTerminalStage('cancelled')).toBe(true);
    expect(isTerminalStage('appeal')).toBe(false);
    expect(transitionNeedsHire('hirer_identified')).toBe(true);
    expect(transitionNeedsHire('paid')).toBe(false);
  });
  it('picks the s.172 response for NIPs and the liability transfer notice for PCNs', () => {
    expect(penaltyDocumentTemplate({ kind: 'nip_s172', stage: 'hirer_identified' })?.templateId).toBe('notice.s172_response');
    expect(penaltyDocumentTemplate({ kind: 'pcn_council', stage: 'received' })?.templateId).toBe('notice.pcn_liability_transfer');
    expect(penaltyDocumentTemplate({ kind: 'pcn_council', stage: 'paid' })).toBeNull();
  });
  it('sorts open notices by deadline ahead of closed ones', () => {
    const rows = sortPenalties([
      { stage: 'paid' as const, responseDeadline: '2026-01-01' },
      { stage: 'received' as const, responseDeadline: '2026-10-20' },
      { stage: 'appeal' as const, responseDeadline: '2026-10-10' }
    ]);
    expect(rows.map((r) => r.responseDeadline)).toEqual(['2026-10-10', '2026-10-20', '2026-01-01']);
  });
});

describe('alerts', () => {
  it('groups by severity in block → warn → info order and drops empty groups', () => {
    const groups = groupAlertsBySeverity([
      { fleetUnitId: 'u1', code: 'MOT_DUE', severity: 'warn', message: 'MOT due', dueDate: '2026-10-20' },
      { fleetUnitId: 'u2', code: 'USE_NOT_COVERED', severity: 'block', message: 'Self-drive not covered' },
      { fleetUnitId: 'u1', code: 'TAX_DUE', severity: 'warn', message: 'Tax due', dueDate: '2026-10-10' }
    ]);
    expect(groups.map((g) => g.severity)).toEqual(['block', 'warn']);
    expect(groups[1]!.alerts.map((a) => a.code)).toEqual(['TAX_DUE', 'MOT_DUE']);
  });
});

describe('unit form', () => {
  it('validates the essentials and the Collingwood two-uses rule', () => {
    const f = emptyUnitForm();
    const e = validateUnitForm(f, true);
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['registration', 'gtaGroup', 'declaredUses', 'dailyRatePence']));
    f.vehicle.registration = 'LK19 XYZ';
    f.gta = { ...f.gta, group: 'S1', groupDirty: true };
    f.declaredUses = ['credit_hire', 'self_drive'];
    f.gta = { ...f.gta, ratePence: 4980, rateDirty: true };
    expect(validateUnitForm(f, true)).toEqual({ policyId: expect.stringContaining('Collingwood') });
    f.policyId = 'pol-1';
    expect(validateUnitForm(f, true)).toEqual({});
    f.keeperLine1 = '1 Depot Road';
    expect(validateUnitForm(f, true)).toHaveProperty('keeperPostcode');
    f.keeperPostcode = 'n1 1aa';
    expect(validateUnitForm(f, true)).toEqual({});
    f.gta = { ...f.gta, group: 'nonsense group' };
    expect(validateUnitForm(f, true)).toHaveProperty('gtaGroup');
    f.gta = { ...f.gta, group: 'S1' };
    f.vehicle = { ...f.vehicle, vin: 'WF0SHORT' };
    expect(validateUnitForm(f, true)).toEqual({ vehicle: { vin: expect.stringMatching(/17 characters/) } });
  });
  it('builds the POST body with the vehicle (picker fields + spec + source), group, rate and the GTA suggestion', () => {
    const suggestion: GtaSuggestion = {
      group: 'M1',
      confidence: 'low',
      basis: 'segment_default',
      reason: 'Group M1 is the starting suggestion for the suv-small segment.',
      segment: 'suv-small',
      rate: { group: 'M1', dailyRatePence: 6549, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' }, origin: 'kb' },
      note: 'benchmark'
    };
    let f: UnitForm = { ...emptyUnitForm(), declaredUses: ['credit_hire'], keeperLine1: '1 Depot Road', keeperPostcode: 'n1 1aa', serviceDueDate: '2027-01-15' };
    f.vehicle = {
      ...f.vehicle,
      registration: 'lk19 xyz',
      make: 'Ford',
      model: 'Puma',
      variant: 'ST-Line',
      catalogue: { makeSlug: 'ford', modelSlug: 'puma', generationId: 'ford-puma-mk1' },
      segment: 'suv-small',
      engineCapacityCc: 999,
      fuelType: 'petrol',
      features: ['dab'],
      extras: ['tow_bar']
    };
    f = { ...f, gta: applySuggestion(f.gta, suggestion, ['M1', 'S1']) };
    const body = buildUnitBody(f);
    expect(body.vehicle).toMatchObject({
      registration: 'LK19XYZ',
      make: 'Ford',
      model: 'Puma',
      variant: 'ST-Line',
      engineCapacityCc: 999,
      fuelType: 'petrol',
      ownership: 'fleet',
      spec: { catalogue: { makeSlug: 'ford', modelSlug: 'puma', generationId: 'ford-puma-mk1' }, segment: 'suv-small', features: ['dab'], extras: ['tow_bar'] },
      source: { provider: 'catalogue' }
    });
    expect('manual' in (body.vehicle ?? {})).toBe(false);
    expect(body.gtaGroup).toBe('M1');
    expect(body.dailyRatePence).toBe(6549);
    expect(body.gtaSuggestion).toEqual({ group: 'M1', basis: 'segment_default', rateGroup: 'M1', ratePeriod: '2026-27' });
    expect(body.keeperAddressOnV5C).toEqual({ line1: '1 Depot Road', line2: undefined, town: undefined, postcode: 'N1 1AA' });
    expect(body.serviceDueDate).toBe('2027-01-15');
    // the user's own rate is sent as typed
    const own = buildUnitBody({ ...f, gta: editRate(f.gta, 5900) });
    expect(own.dailyRatePence).toBe(5900);
    expect(own.gtaGroup).toBe('M1');
  });
  it('round-trips a unit row into the form; its group and rate are the user\'s own (not overwritten by a suggestion)', () => {
    const unit: FleetUnitView = {
      id: 'u1',
      vehicleId: 'v1',
      declaredUses: ['pco'],
      policyId: 'pol-2',
      dailyRatePence: 5300,
      gtaGroup: 'M',
      keeperAddressOnV5C: { line1: '1 Depot Road', postcode: 'N1 1AA' },
      keeperAddressCurrent: false,
      serviceDueDate: '2026-12-01',
      status: 'on_hire',
      phvLicensed: true,
      registration: 'AB12CDE',
      vehicle: { id: 'v1', registration: 'AB12CDE', make: 'Mitsubishi', model: 'Outlander', odometer: [], ownership: 'fleet', lookups: [], createdAt: '2026-01-01T00:00:00Z', motExpiryDate: '2027-03-01', spec: { features: [], extras: [], doors: 5 } }
    };
    const f = unitToForm(unit);
    expect(f).toMatchObject({ declaredUses: ['pco'], policyId: 'pol-2', keeperLine1: '1 Depot Road', keeperAddressCurrent: false, status: 'on_hire', phvLicensed: true });
    expect(f.vehicle).toMatchObject({ registration: 'AB12CDE', make: 'Mitsubishi', model: 'Outlander', motExpiryDate: '2027-03-01', doors: 5 });
    expect(f.gta).toMatchObject({ group: 'M', ratePence: 5300, groupDirty: true, rateDirty: true });
  });
  it('PATCH body keeps the vehicle changes (with their source) and the unit fields', () => {
    const unit: FleetUnitView = {
      id: 'u1',
      vehicleId: 'v1',
      declaredUses: ['credit_hire'],
      dailyRatePence: 5300,
      gtaGroup: 'M',
      keeperAddressCurrent: true,
      status: 'available',
      registration: 'AB12CDE',
      vehicle: { id: 'v1', registration: 'AB12CDE', make: 'Ford', model: 'Focus', colour: 'Blue', odometer: [], ownership: 'fleet', lookups: [], createdAt: '2026-01-01T00:00:00Z' }
    };
    const f = unitToForm(unit);
    const initial = f.vehicle;
    const unchanged = buildUnitPatch(f, initial);
    expect(unchanged.vehicle).toBeUndefined();
    expect(unchanged).toMatchObject({ gtaGroup: 'M', dailyRatePence: 5300, declaredUses: ['credit_hire'] });
    const edited = { ...f, vehicle: { ...f.vehicle, colour: '', motExpiryDate: '2027-05-01', variant: 'Titanium' } };
    const body = buildUnitPatch(edited, initial);
    expect(body.vehicle).toEqual({ source: { provider: 'manual' }, variant: 'Titanium', colour: null, motExpiryDate: '2027-05-01' });
  });
});

describe('fleetApi PATCH', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends the vehicle with the unit patch (it is no longer stripped)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'u1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await updateFleetUnit('u1', { gtaGroup: 'M', vehicle: { source: { provider: 'manual' }, colour: 'Red' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/fleet/u1');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ gtaGroup: 'M', vehicle: { source: { provider: 'manual' }, colour: 'Red' } });
  });
});

describe('penalty form', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  it('requires the notice essentials and sane dates', () => {
    const f = emptyPenaltyForm('u1');
    const e = validatePenaltyForm(f, now);
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['kind', 'issuer', 'noticeNumber', 'contraventionAt', 'receivedAt', 'amountPence', 'responseDeadline']));
    f.kind = 'nip_s172';
    f.issuer = 'Met Police';
    f.noticeNumber = 'NIP123';
    f.contraventionAt = '2026-09-20T08:00:00.000Z';
    f.receivedAt = '2026-09-25T10:00:00.000Z';
    f.amountPence = 10000;
    f.responseDeadline = '2026-10-22';
    expect(validatePenaltyForm(f, now)).toEqual({});
    f.receivedAt = '2026-09-19T10:00:00.000Z';
    expect(validatePenaltyForm(f, now)).toHaveProperty('receivedAt');
    f.receivedAt = '2026-09-25T10:00:00.000Z';
    f.discountDeadline = '2026-11-01';
    expect(validatePenaltyForm(f, now)).toHaveProperty('discountDeadline');
  });
  it('builds the body with pence and optional fields dropped', () => {
    const f = { ...emptyPenaltyForm('u1'), kind: 'pcn_council' as const, issuer: ' LB Camden ', noticeNumber: 'CU123', contraventionAt: '2026-09-20T08:00:00.000Z', receivedAt: '2026-09-25T10:00:00.000Z', amountPence: 13000, responseDeadline: '2026-10-22' };
    expect(buildPenaltyBody(f)).toEqual({
      fleetUnitId: 'u1',
      kind: 'pcn_council',
      issuer: 'LB Camden',
      noticeNumber: 'CU123',
      contraventionAt: '2026-09-20T08:00:00.000Z',
      receivedAt: '2026-09-25T10:00:00.000Z',
      amountPence: 13000,
      discountDeadline: undefined,
      responseDeadline: '2026-10-22',
      hireAgreementId: undefined,
      notes: undefined
    });
  });
});
