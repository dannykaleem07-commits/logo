import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadClaimBundle } from './bundle.js';
import { closeDatabase, type DatabaseHandle } from './client.js';
import { NotFoundError } from './errors.js';
import { FILE_ONE, seedFileOne, type FileOneIds } from './fixtures/fileOne.js';
import { ledgerPosition, totalPaid } from './repos/ledger.js';
import { recoveryNetPence } from './repos/recovery.js';
import { createTestDatabase } from './testing.js';
import { chargeableDays } from './util.js';

let h: DatabaseHandle;
let ids: FileOneIds;
beforeEach(() => {
  h = createTestDatabase();
  ids = seedFileOne(h.db);
});
afterEach(() => closeDatabase(h));

describe('loadClaimBundle — File 1 archetype round trip', () => {
  it('assembles the claim, parties and vehicles', () => {
    const b = loadClaimBundle(h.db, ids.claimId);
    expect(b.claim.id).toBe(ids.claimId);
    expect(b.claim.reference).toBe('CCG-2026-00001');
    expect(b.claim.status).toBe('chasing');
    expect(b.claim.accident.occurredAt).toBe('2026-08-08T14:30:00.000Z');
    expect(b.claimant.name).toBe('Jane Doe');
    expect(b.claimant.phone).toBe('07700 900123');
    expect(b.driver?.id).toBe(ids.claimantId);
    expect(b.vehicle.registration).toBe('AB12CDE');
    expect(b.vehicle.odometer).toHaveLength(2);
    expect(b.vehicle.odometer[1]).toMatchObject({ source: 'accident_report', miles: 49980 });
    expect(b.thirdParties.map((p) => p.name)).toEqual(['John Smith']);
    expect(b.thirdPartyVehicle?.registration).toBe('XY34ZZZ');
    expect(b.atFaultInsurer?.name).toBe('Example Insurance Ltd');
    expect(b.flags).toEqual([]);
  });

  it('carries the chronology in date order with the brief’s dates', () => {
    const b = loadClaimBundle(h.db, ids.claimId);
    const types = b.events.map((e) => e.type);
    expect(types[0]).toBe('fnol');
    expect(types.at(-1)).toBe('payment_received');
    expect(types.indexOf('services_agreed')).toBeLessThan(types.indexOf('ncaf_sent'));
    expect(types.indexOf('intervention_offer')).toBeLessThan(types.indexOf('intervention_reply_sent'));
    expect(types.indexOf('report_issued')).toBeLessThan(types.indexOf('storage_ended'));
    expect(types.indexOf('payment_pack_sent')).toBeLessThan(types.indexOf('payment_received'));
    for (let i = 1; i < b.events.length; i++) expect(b.events[i]!.at >= b.events[i - 1]!.at).toBe(true);
    expect(b.events.find((e) => e.type === 'ncaf_sent')?.at).toBe(FILE_ONE.ncafSentAt);
    expect(b.events.find((e) => e.type === 'payment_pack_sent')?.at).toBe(FILE_ONE.packSentAt);
    expect(b.events.find((e) => e.type === 'payment_received')?.data).toEqual({ amountPence: 111200 });
  });

  it('carries hire, storage and recovery with the rate-card figures', () => {
    const b = loadClaimBundle(h.db, ids.claimId);
    expect(b.hire).toHaveLength(1);
    const hire = b.hire[0]!;
    expect(hire.dailyRatePence).toBe(4980);
    expect(hire.startAt).toBe('2026-08-10T10:00:00.000Z');
    expect(hire.endAt).toBe('2026-09-02T10:00:00.000Z');
    expect(hire.endTrigger).toBe('replacement_purchased');
    expect(chargeableDays(hire.startAt, hire.endAt!)).toBe(23);
    expect(chargeableDays(hire.startAt, hire.endAt!) * hire.dailyRatePence).toBe(114540); // £1,145.40
    expect(hire.enforceability.cca60fCompliant).toBe(true);
    expect(hire.additionalDrivers).toEqual([]);

    expect(b.storage).toHaveLength(1);
    expect(b.storage[0]!.dailyRatePence).toBe(4500);
    expect(chargeableDays(b.storage[0]!.startAt, b.storage[0]!.endAt!)).toBe(10);
    expect(b.storage[0]!.endTrigger).toBe('salvage_released');

    expect(b.recovery).toHaveLength(1);
    expect(b.recovery[0]).toMatchObject({ calloutPence: 9000, loadedMiles: 12, perLoadedMilePence: 300, adminPence: 2500 });
    expect(recoveryNetPence(b.recovery[0]!)).toBe(15100); // £151.00
  });

  it('carries the ledger — £1,112 received, not the £1,287 the old letter stated', () => {
    const b = loadClaimBundle(h.db, ids.claimId);
    const claimed = b.ledger.filter((l) => l.kind === 'claimed');
    expect(Object.fromEntries(claimed.map((l) => [l.head, l.amountPence]))).toEqual({ hire: 114540, storage: 45000, recovery: 15100, engineer_fee: 28500, pav: 650000 });
    const paid = b.ledger.filter((l) => l.kind === 'paid');
    expect(paid).toHaveLength(1);
    expect(paid[0]!.amountPence).toBe(111200);
    expect(paid[0]!.date).toBe('2026-09-25');
    expect(totalPaid(h.db, ids.claimId)).toBe(FILE_ONE.paidPence);
    expect(totalPaid(h.db, ids.claimId)).not.toBe(FILE_ONE.statedInLetterPence);
    const pos = ledgerPosition(h.db, ids.claimId);
    expect(pos.totals.claimedPence).toBe(114540 + 45000 + 15100 + 28500 + 650000);
    expect(pos.heads.find((x) => x.head === 'hire')?.outstandingPence).toBe(114540 - 111200);
  });

  it('carries the intervention register with the £20.37/day offer and the 1-WD reply', () => {
    const b = loadClaimBundle(h.db, ids.claimId);
    expect(b.offers).toHaveLength(1);
    const o = b.offers[0]!;
    expect(o.dailyRatePence).toBe(2037);
    expect(o.receivedAt).toBe('2026-08-11T09:15:00.000Z');
    expect(o.clientDecision).toBe('declined');
    expect(o.clientReasons).toContain('excess');
    expect(o.replySentAt).toBe('2026-08-12T09:00:00.000Z');
    expect(o.terms.excessPence).toBe(75000);
    expect(o.suitabilityReasons).toEqual(['class', 'excess', 'delivery']);
  });

  it('carries evidence (immutable), documents (without html by default), clocks and engineering', () => {
    const b = loadClaimBundle(h.db, ids.claimId);
    expect(b.evidence).toHaveLength(1);
    expect(b.evidence[0]!.immutable).toBe(true);
    expect(b.evidence[0]!.sha256).toHaveLength(64);
    expect(b.evidence[0]!.exif?.make).toBe('Apple');

    expect(b.documents.map((d) => d.templateId).sort()).toEqual(['letter.ncaf', 'pack.gta_payment']);
    for (const d of b.documents) {
      expect(d.html).toBe('');
      expect(d.status).toBe('sent');
      expect(d.dataSnapshot).toBeTruthy();
    }
    expect(b.documents.find((d) => d.templateId === 'letter.ncaf')?.sentAt).toBe(FILE_ONE.ncafSentAt);
    expect(b.documents.find((d) => d.templateId === 'pack.gta_payment')?.sentAt).toBe(FILE_ONE.packSentAt);

    const withHtml = loadClaimBundle(h.db, ids.claimId, { includeHtml: true });
    expect(withHtml.documents.find((d) => d.templateId === 'pack.gta_payment')?.html).toContain('£1,145.40');

    expect(b.clocks).toHaveLength(1);
    expect(b.clocks[0]).toMatchObject({ kind: 'gta_6_7_settlement_1_month', status: 'running', claimId: ids.claimId });
    expect(b.clocks[0]).not.toHaveProperty('computedAt');

    expect(b.pav?.pavPence).toBe(650000);
    expect(b.pav?.comparables).toHaveLength(3);
    expect(b.pav?.subject.odometerAtLoss).toBe(49980);
    expect(b.report?.feePence).toBe(28500);
    expect(b.report?.issuedAt).toBe('2026-08-18T16:00:00.000Z');
    expect(b.report?.pavAssessmentId).toBe(ids.pavId);
    expect(b.estimate).toBeUndefined();
  });

  it('survives a JSON round trip unchanged (plain data only)', () => {
    const b = loadClaimBundle(h.db, ids.claimId, { includeHtml: true });
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });

  it('returns [] clocks when the cache is empty and throws for unknown claims', () => {
    h.sqlite.prepare('delete from clocks').run();
    expect(loadClaimBundle(h.db, ids.claimId).clocks).toEqual([]);
    expect(() => loadClaimBundle(h.db, 'nope')).toThrow(NotFoundError);
  });
});
