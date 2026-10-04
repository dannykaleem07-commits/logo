import { describe, expect, it } from 'vitest';
import {
  buildPenaltyBody,
  buildUnitBody,
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
    f.registration = 'LK19 XYZ';
    f.gtaGroup = 's1';
    f.declaredUses = ['credit_hire', 'self_drive'];
    f.dailyRatePence = 4980;
    expect(validateUnitForm(f, true)).toEqual({ policyId: expect.stringContaining('Collingwood') });
    f.policyId = 'pol-1';
    expect(validateUnitForm(f, true)).toEqual({});
    f.keeperLine1 = '1 Depot Road';
    expect(validateUnitForm(f, true)).toHaveProperty('keeperPostcode');
    f.keeperPostcode = 'n1 1aa';
    expect(validateUnitForm(f, true)).toEqual({});
  });
  it('builds the body with pence, normalised registration and the keeper address', () => {
    const f = { ...emptyUnitForm(), registration: 'lk19 xyz', make: 'Volkswagen', model: 'Golf', gtaGroup: 's1', declaredUses: ['credit_hire' as const], dailyRatePence: 4980, keeperLine1: '1 Depot Road', keeperPostcode: 'n1 1aa', serviceDueDate: '2027-01-15' };
    const body = buildUnitBody(f, true);
    expect(body.vehicle).toMatchObject({ registration: 'LK19XYZ', make: 'Volkswagen', model: 'Golf', ownership: 'fleet', manual: true });
    expect(body.gtaGroup).toBe('S1');
    expect(body.dailyRatePence).toBe(4980);
    expect(body.keeperAddressOnV5C).toEqual({ line1: '1 Depot Road', line2: undefined, town: undefined, postcode: 'N1 1AA' });
    expect(body.serviceDueDate).toBe('2027-01-15');
  });
  it('round-trips a unit row into the form', () => {
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
      vehicle: { id: 'v1', registration: 'AB12CDE', make: 'Mitsubishi', model: 'Outlander', odometer: [], ownership: 'fleet', lookups: [], createdAt: '2026-01-01T00:00:00Z', motExpiryDate: '2027-03-01' }
    };
    const f = unitToForm(unit);
    expect(f).toMatchObject({ registration: 'AB12CDE', make: 'Mitsubishi', gtaGroup: 'M', declaredUses: ['pco'], dailyRatePence: 5300, keeperLine1: '1 Depot Road', keeperAddressCurrent: false, status: 'on_hire', phvLicensed: true, motExpiryDate: '2027-03-01' });
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
