import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { LedgerImmutableError, ValidationError } from '../errors.js';
import { createTestDatabase } from '../testing.js';
import { appendLedgerEntry, deleteLedgerEntry, ledgerPosition, listLedger, listSupersededLedger, sumLedger, totalPaid, updateLedgerEntry } from './ledger.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const claimId = 'claim-1';
const base = { claimId, createdBy: 'system' as const };

describe('ledger', () => {
  it('appends entries in integer pence and lists them by date', () => {
    appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'claimed', amountPence: 114540, date: '2026-09-02', description: 'hire' });
    appendLedgerEntry(h.db, { ...base, head: 'recovery', kind: 'claimed', amountPence: 15100, date: '2026-08-10', description: 'recovery' });
    const rows = listLedger(h.db, claimId);
    expect(rows.map((r) => r.head)).toEqual(['recovery', 'hire']);
    expect(() => appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'claimed', amountPence: 49.8, date: '2026-09-02', description: 'float' })).toThrow(ValidationError);
    expect(() => appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'paid', amountPence: -1, date: '2026-09-02', description: 'neg' })).toThrow(ValidationError);
  });

  it('repository update/delete throw LedgerImmutableError', () => {
    const e = appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'claimed', amountPence: 100, date: '2026-09-02', description: 'x' });
    expect(() => updateLedgerEntry(h.db, e.id, { amountPence: 200 })).toThrow(LedgerImmutableError);
    expect(() => deleteLedgerEntry(h.db, e.id)).toThrow(LedgerImmutableError);
    try {
      updateLedgerEntry(h.db, e.id, {});
    } catch (err) {
      expect((err as LedgerImmutableError).code).toBe('IMMUTABLE');
      expect((err as LedgerImmutableError).entity).toBe('ledger_entries');
    }
  });

  it('the database itself rejects raw UPDATE and DELETE on the ledger', () => {
    const e = appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'claimed', amountPence: 100, date: '2026-09-02', description: 'x' });
    expect(() => h.sqlite.prepare('update ledger_entries set amount_pence = 999 where id = ?').run(e.id)).toThrow(/append-only/);
    expect(() => h.sqlite.prepare('delete from ledger_entries where id = ?').run(e.id)).toThrow(/append-only/);
    expect(listLedger(h.db, claimId)[0]?.amountPence).toBe(100);
  });

  it('corrections supersede: the old row is hidden from lists and sums but still readable', () => {
    const wrong = appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'paid', amountPence: 128700, date: '2026-09-25', description: '£1,287 (as stated in letter)' });
    const right = appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'paid', amountPence: 111200, date: '2026-09-25', description: '£1,112 actually received', supersedesId: wrong.id });
    expect(listLedger(h.db, claimId).map((r) => r.id)).toEqual([right.id]);
    expect(listLedger(h.db, claimId, { includeSuperseded: true })).toHaveLength(2);
    expect(listSupersededLedger(h.db, claimId).map((r) => r.id)).toEqual([wrong.id]);
    expect(totalPaid(h.db, claimId)).toBe(111200);
    expect(() => appendLedgerEntry(h.db, { ...base, claimId: 'other', head: 'hire', kind: 'paid', amountPence: 1, date: '2026-09-25', description: 'x', supersedesId: wrong.id })).toThrow(ValidationError);
  });

  it('sums by head and kind and computes the position', () => {
    appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'claimed', amountPence: 114540, vatPence: 22908, date: '2026-09-02', description: 'hire' });
    appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'paid', amountPence: 100000, date: '2026-09-25', description: 'paid' });
    appendLedgerEntry(h.db, { ...base, head: 'hire', kind: 'interim_paid', amountPence: 11200, date: '2026-09-26', description: 'interim' });
    appendLedgerEntry(h.db, { ...base, head: 'storage', kind: 'claimed', amountPence: 45000, date: '2026-08-20', description: 'storage' });
    appendLedgerEntry(h.db, { ...base, head: 'storage', kind: 'reduced', amountPence: 36000, date: '2026-09-30', description: 'insurer caps at report + 48h' });
    appendLedgerEntry(h.db, { ...base, head: 'storage', kind: 'adjustment', amountPence: -500, date: '2026-10-01', description: 'goodwill' });
    const sums = sumLedger(h.db, claimId);
    expect(sums.find((s) => s.head === 'hire' && s.kind === 'claimed')).toMatchObject({ amountPence: 114540, vatPence: 22908, count: 1 });
    const pos = ledgerPosition(h.db, claimId);
    const hire = pos.heads.find((x) => x.head === 'hire')!;
    expect(hire.paidPence).toBe(111200);
    expect(hire.outstandingPence).toBe(114540 - 111200);
    const storage = pos.heads.find((x) => x.head === 'storage')!;
    expect(storage.reducedPence).toBe(36000);
    expect(storage.adjustmentPence).toBe(-500);
    expect(storage.outstandingPence).toBe(45000 - 500);
    expect(pos.totals.claimedPence).toBe(114540 + 45000);
    expect(pos.totals.paidPence).toBe(111200);
  });
});
