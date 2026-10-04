import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InsurerDirectoryEntry } from '@ccguk/domain';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { EvidenceImmutableError, ValidationError, VerificationError } from '../errors.js';
import { seedFileOne } from '../fixtures/fileOne.js';
import { createTestDatabase } from '../testing.js';
import { listAudit } from './audit.js';
import { listDueClocks, replaceClocks } from './clocks.js';
import { applyDirectoryOverrides, listDirectoryOverrides, reportDirectoryFailed, reportDirectoryUsedOk, upsertDirectoryOverride, verifyDirectoryEntry } from './directoryOverrides.js';
import { createPav } from './engineering.js';
import { deleteEvidence, findEvidenceBySha256, insertEvidence, updateEvidence } from './evidence.js';
import { activeHireForFleetUnit, createHire, endHire } from './hire.js';
import { createFleetUnit, createPenalty, createPolicy, deleteFleetUnit, listPenalties, setPenaltyStage, updateFleetUnit } from './fleet.js';
import { addLabourEntry, labourStats, listLabourEntries } from './labourLibrary.js';
import { DEFAULT_RATE_CARD, DEFAULT_SETTINGS, getSettings, patchSettings } from './settings.js';
import { upsertVehicle } from './vehicles.js';
import { getCompanyWatch, listCompanyWatch, recordCompanyPoll, upsertCompanyWatch } from './watch.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

describe('evidence', () => {
  it('is write-once at repo and database level and validates the hash', () => {
    const sha = 'a'.repeat(64);
    const e = insertEvidence(h.db, { claimId: 'c1', kind: 'photo', filename: 'x.jpg', mime: 'image/jpeg', bytes: 10, sha256: sha.toUpperCase(), storagePath: 'evidence/c1/x.jpg', uploadedBy: 'u1' });
    expect(e.immutable).toBe(true);
    expect(e.sha256).toBe(sha);
    expect(findEvidenceBySha256(h.db, sha)).toHaveLength(1);
    expect(() => updateEvidence(h.db, e.id, {})).toThrow(EvidenceImmutableError);
    expect(() => deleteEvidence(h.db, e.id)).toThrow(EvidenceImmutableError);
    expect(() => h.sqlite.prepare("update evidence set filename = 'y' where id = ?").run(e.id)).toThrow(/append-only/);
    expect(() => h.sqlite.prepare('delete from evidence where id = ?').run(e.id)).toThrow(/append-only/);
    expect(() => insertEvidence(h.db, { kind: 'photo', filename: 'x', mime: 'image/jpeg', bytes: 1, sha256: 'short', storagePath: 'p', uploadedBy: 'u' })).toThrow(ValidationError);
  });
});

describe('settings', () => {
  it('returns defaults, patches with merge and audits', () => {
    const s = getSettings(h.db);
    expect(s.companyName).toBe('Courtesy Cars Group UK Ltd');
    expect(s.rateCard).toEqual(DEFAULT_RATE_CARD);
    expect(s.rateCard).toMatchObject({ recoveryCalloutPence: 9000, perMilePence: 300, adminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500 });
    const p = patchSettings(h.db, { vatNumber: 'GB123456789', rateCard: { storageDailyPence: 5000 }, apiKeysPresent: { dvlaVes: true }, bank: { accountName: 'Courtesy Cars Group UK Ltd', sortCode: '00-00-00', accountNumber: '00000000' } }, { userId: 'admin' });
    expect(p.vatNumber).toBe('GB123456789');
    expect(p.rateCard.storageDailyPence).toBe(5000);
    expect(p.rateCard.recoveryCalloutPence).toBe(9000);
    expect(p.apiKeysPresent).toMatchObject({ dvlaVes: true, dvsaMot: false });
    expect(getSettings(h.db).bank?.accountName).toBe('Courtesy Cars Group UK Ltd');
    expect(() => patchSettings(h.db, { rateCard: { adminPence: 25.5 } }, { userId: 'admin' })).toThrow(ValidationError);
    expect(listAudit(h.db, { entity: 'settings' })).toHaveLength(1);
  });

  it('falls back to the real registered office when none is saved; bank, VAT and ICO stay unset (design doc §H.2)', () => {
    expect(DEFAULT_SETTINGS.registeredOffice).toEqual({ line1: '44 Syon Lane', line2: 'Isleworth', town: 'London', postcode: 'TW7 5NQ' });
    expect(DEFAULT_SETTINGS.bank).toBeUndefined();
    expect(DEFAULT_SETTINGS.vatNumber).toBeUndefined();
    expect(DEFAULT_SETTINGS.icoRegistration).toBeUndefined();
    expect(getSettings(h.db).registeredOffice).toEqual(DEFAULT_SETTINGS.registeredOffice);
    patchSettings(h.db, { vatNumber: 'GB123456789' }, { userId: 'admin' });
    h.sqlite.prepare('update settings set registered_office = null').run(); // a row saved by an older build
    expect(getSettings(h.db).registeredOffice).toEqual(DEFAULT_SETTINGS.registeredOffice);
    const moved = patchSettings(h.db, { registeredOffice: { line1: '1 Example Way', town: 'Leeds', postcode: 'LS1 1AA' } }, { userId: 'admin' });
    expect(moved.registeredOffice).toEqual({ line1: '1 Example Way', town: 'Leeds', postcode: 'LS1 1AA' });
  });
});

describe('directory overrides', () => {
  const entry: InsurerDirectoryEntry = { id: 'admiral', name: 'Admiral', brands: ['Admiral'], thirdPartyClaimsPhone: '0333 220 2047', copycatDomains: [], copycatNumbers: [], verification: { status: 'unverified' } };

  it('never let code mark an entry verified; a human with a source URL can', () => {
    expect(() => upsertDirectoryOverride(h.db, 'admiral', { verification: { status: 'verified' } }, { userId: 'system' })).toThrow(VerificationError);
    expect(() => upsertDirectoryOverride(h.db, 'admiral', { verification: { status: 'verified' } }, { userId: 'u1' })).toThrow(VerificationError);
    expect(() => verifyDirectoryEntry(h.db, 'admiral', { userId: 'system' }, { sourceUrl: 'https://www.admiral.com/claims' })).toThrow(VerificationError);
    const v = verifyDirectoryEntry(h.db, 'admiral', { userId: 'u1' }, { sourceUrl: 'https://www.admiral.com/claims', verifiedAt: '2026-10-04' });
    expect(v.verification).toMatchObject({ status: 'verified', sourceUrl: 'https://www.admiral.com/claims', verifiedBy: 'u1', verifiedAt: '2026-10-04' });
    const merged = applyDirectoryOverrides([entry], listDirectoryOverrides(h.db));
    expect(merged[0]!.verification.status).toBe('verified');
    expect(merged[0]!.thirdPartyClaimsPhone).toBe('0333 220 2047');
  });

  it('report failed turns the record red and keeps notes; used-ok records the date', () => {
    const f = reportDirectoryFailed(h.db, 'aviva', { userId: 'u1' }, 'number unobtainable', '2026-10-04');
    expect(f.verification?.status).toBe('failed');
    expect(f.lastFailed).toBe('2026-10-04');
    expect(f.notes).toContain('unobtainable');
    const ok = reportDirectoryUsedOk(h.db, 'aviva', { userId: 'u1' }, '2026-10-05');
    expect(ok.lastUsedOk).toBe('2026-10-05');
    expect(ok.lastFailed).toBe('2026-10-04');
    expect(listAudit(h.db, { action: 'directory.override' })).toHaveLength(2);
  });
});

describe('company watch', () => {
  it('upserts CARFLEX LTD as high risk and merges poll results', () => {
    const w = upsertCompanyWatch(h.db, { companyNumber: '12640635', name: 'CARFLEX LTD', role: 'supplier', riskLevel: 'high', riskReasons: ['proposal to strike off', 'dormant/overdue accounts'] });
    expect(w.riskLevel).toBe('high');
    const polled = recordCompanyPoll(h.db, '12640635', { status: 'active-proposal-to-strike-off', accountsOverdue: true, gazetteNotices: [{ date: '2026-07-01', type: 'strike-off', note: 'First Gazette notice' }], polledAt: '2026-10-04T02:00:00.000Z' });
    expect(polled.status).toBe('active-proposal-to-strike-off');
    expect(polled.gazetteNotices).toHaveLength(1);
    recordCompanyPoll(h.db, '12640635', { gazetteNotices: [{ date: '2026-07-01', type: 'strike-off', note: 'First Gazette notice' }, { date: '2026-09-01', type: 'strike-off-suspended', note: 'suspended' }] });
    expect(getCompanyWatch(h.db, '12640635')?.gazetteNotices).toHaveLength(2);
    expect(listCompanyWatch(h.db, { riskLevel: 'high' })).toHaveLength(1);
    expect(getCompanyWatch(h.db, '1')?.companyNumber).toBeUndefined();
  });
});

describe('fleet', () => {
  it('units, policies, penalties and hire allocation state', () => {
    const v = upsertVehicle(h.db, { registration: 'FL33 EET', make: 'VW', model: 'GOLF', ownership: 'fleet' });
    const policy = createPolicy(h.db, { insurerName: 'Collingwood', policyNumber: 'P1', coveredUses: ['credit_hire'], startDate: '2026-01-01', endDate: '2026-12-31' });
    const unit = createFleetUnit(h.db, { vehicleId: v.id, declaredUses: ['credit_hire'], policyId: policy.id, dailyRatePence: 4980, gtaGroup: 'S1', keeperAddressCurrent: false });
    expect(unit.status).toBe('available');
    expect(() => createFleetUnit(h.db, { vehicleId: 'missing', declaredUses: ['pco'], dailyRatePence: 1, gtaGroup: 'S1' })).toThrow();
    const hire = createHire(h.db, { claimId: 'c1', fleetUnitId: unit.id, startAt: '2026-08-10T10:00:00.000Z', dailyRatePence: 4980, vatRate: 0.2, gtaGroup: 'S1', excessPence: 25000 });
    expect(hire.agreementNumber).toMatch(/^CCG-H-\d{6}$/);
    expect(hire.enforceability.cca60fCompliant).toBe(false);
    expect(activeHireForFleetUnit(h.db, unit.id)?.id).toBe(hire.id);
    expect(() => deleteFleetUnit(h.db, unit.id)).toThrow(ValidationError);
    endHire(h.db, hire.id, { endAt: '2026-09-02T10:00:00.000Z', endTrigger: 'repair_complete_24h' });
    expect(() => endHire(h.db, hire.id, { endAt: '2026-09-03T10:00:00.000Z', endTrigger: 'manual' })).toThrow(ValidationError);
    expect(activeHireForFleetUnit(h.db, unit.id)).toBeUndefined();
    updateFleetUnit(h.db, unit.id, { status: 'off_road', keeperAddressCurrent: true });

    const pcn = createPenalty(h.db, { fleetUnitId: unit.id, kind: 'pcn_council', issuer: 'LB Newham', noticeNumber: 'NH123', contraventionAt: '2026-08-20T08:00:00.000Z', receivedAt: '2026-08-28T00:00:00.000Z', amountPence: 13000, discountDeadline: '2026-09-11', responseDeadline: '2026-09-25' });
    expect(pcn.stage).toBe('received');
    const moved = setPenaltyStage(h.db, pcn.id, 'liability_transferred', { hireAgreementId: hire.id, documentId: 'doc-1' });
    expect(moved.hireAgreementId).toBe(hire.id);
    expect(moved.documentIds).toEqual(['doc-1']);
    expect(listPenalties(h.db, { open: true })).toHaveLength(0);
    expect(listPenalties(h.db, { fleetUnitId: unit.id })).toHaveLength(1);
  });
});

describe('clocks cache, labour library, pav guard', () => {
  it('replaceClocks swaps the cache; listDueClocks spans claims', () => {
    replaceClocks(h.db, 'c1', [{ kind: 'chaser_day_7', label: 'Chaser 7', basis: 'playbook', startsAt: '2026-09-05T00:00:00.000Z', dueAt: '2026-09-12T00:00:00.000Z', status: 'running' }]);
    replaceClocks(h.db, 'c2', [{ kind: 'dsar_1_month', label: 'DSAR', basis: 'UK GDPR art 12(3)', startsAt: '2026-09-01T00:00:00.000Z', dueAt: '2026-10-01T00:00:00.000Z', status: 'breached' }]);
    const due = listDueClocks(h.db, { dueBefore: '2026-12-31T00:00:00.000Z' });
    expect(due.map((c) => c.claimId)).toEqual(['c1', 'c2']);
    replaceClocks(h.db, 'c1', []);
    expect(listDueClocks(h.db, { dueBefore: '2026-12-31T00:00:00.000Z' }).map((c) => c.claimId)).toEqual(['c2']);
  });

  it('labour library stores own observations and reports medians', () => {
    addLabourEntry(h.db, { make: 'VW', model: 'Golf', panel: 'Front bumper', operation: 'Replace', hours: 1.2, source: 'approved_estimate', estimateId: 'e1' });
    addLabourEntry(h.db, { make: 'vw', model: 'golf', panel: 'front bumper', operation: 'replace', hours: 1.6, source: 'approved_estimate', estimateId: 'e2' });
    addLabourEntry(h.db, { make: 'VW', model: 'Golf', panel: 'Front bumper', operation: 'Replace', hours: 1.4, source: 'manual' });
    expect(listLabourEntries(h.db, { make: 'VW' })).toHaveLength(3);
    const stats = labourStats(h.db, { panel: 'Front Bumper' });
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ count: 3, medianHours: 1.4, minHours: 1.2, maxHours: 1.6 });
    expect(() => addLabourEntry(h.db, { make: 'VW', model: 'Golf', panel: 'x', operation: 'y', hours: 0, source: 'manual' })).toThrow(ValidationError);
  });

  it('a PAV that departs from the median needs an override reason', () => {
    const ids = seedFileOne(h.db);
    const base = { claimId: ids.claimId, subject: { vehicleId: ids.clientVehicleId, registration: 'AB12CDE', make: 'VW', model: 'GOLF', year: 2019, odometerAtLoss: 49980, odometerBasis: 'reading' as const, conditionGrade: 'good' as const, conditionAdjustmentPct: 0 }, comparables: [], perMilePence: 6, perMileSource: 'fallback_band' as const, medianPence: 650000, iqrLowPence: 640000, iqrHighPence: 660000, reasoning: 'r' };
    expect(() => createPav(h.db, { ...base, pavPence: 700000 })).toThrow(ValidationError);
    expect(createPav(h.db, { ...base, pavPence: 700000, overrideReason: 'full service history and recent tyres' }).pavPence).toBe(700000);
  });
});
