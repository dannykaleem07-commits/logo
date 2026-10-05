import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@ccguk/domain';
import { activeEntries, correctsText, emptyLedgerForm, filterRows, HEAD_LABEL, HEAD_ORDER, kindSign, ledgerBodyFrom, positionByHead, runningTotals } from './ledger';

let seq = 0;
const entry = (over: Partial<LedgerEntry>): LedgerEntry => {
  seq += 1;
  return {
    id: over.id ?? `e${seq}`,
    claimId: 'c1',
    head: 'hire',
    kind: 'claimed',
    amountPence: 0,
    date: '2026-09-01',
    description: 'x',
    createdBy: 'u1',
    createdAt: `2026-09-01T00:00:${String(seq).padStart(2, '0')}Z`,
    ...over
  };
};

describe('positionByHead (live File 1: £1,287 claimed, £1,112 received)', () => {
  it('sums claimed / offered / paid / outstanding by head, skipping superseded rows', () => {
    const entries = [
      entry({ id: 'h1', head: 'hire', kind: 'claimed', amountPence: 128_700 }),
      entry({ id: 'h2', head: 'hire', kind: 'offered', amountPence: 111_200 }),
      entry({ id: 'h3', head: 'hire', kind: 'paid', amountPence: 111_200, date: '2026-09-10' }),
      entry({ id: 'r1', head: 'recovery', kind: 'claimed', amountPence: 20_000 }),
      entry({ id: 'r2', head: 'recovery', kind: 'claimed', amountPence: 13_800, supersedesId: 'r1', description: 'corrected: 90 + 3×... ' }),
      entry({ id: 's1', head: 'storage', kind: 'claimed', amountPence: 45_000 }),
      entry({ id: 's2', head: 'storage', kind: 'written_off', amountPence: 9_000 })
    ];
    const { heads, totals } = positionByHead(entries);
    expect(heads.map((h) => h.head)).toEqual(['hire', 'recovery', 'storage']);
    const hire = heads[0]!;
    expect(hire).toMatchObject({ claimedPence: 128_700, offeredPence: 111_200, paidPence: 111_200, outstandingPence: 17_500 });
    expect(heads[1]).toMatchObject({ claimedPence: 13_800, outstandingPence: 13_800 }); // r1 superseded by r2
    expect(heads[2]).toMatchObject({ claimedPence: 45_000, writtenOffPence: 9_000, outstandingPence: 36_000 });
    expect(totals.claimedPence).toBe(128_700 + 13_800 + 45_000);
    expect(totals.outstandingPence).toBe(17_500 + 13_800 + 36_000);
    expect(activeEntries(entries).map((e) => e.id)).not.toContain('r1');
  });
  it('orders heads the way the brief lists them and labels every head', () => {
    expect(HEAD_ORDER[0]).toBe('hire');
    for (const h of HEAD_ORDER) expect(HEAD_LABEL[h]).toBeTruthy();
  });
});

describe('runningTotals', () => {
  it('moves the balance only for money kinds and marks corrections', () => {
    expect(kindSign('claimed')).toBe(1);
    expect(kindSign('paid')).toBe(-1);
    expect(kindSign('offered')).toBe(0);
    const rows = runningTotals([
      entry({ id: 'a', kind: 'claimed', amountPence: 10_000, date: '2026-09-01' }),
      entry({ id: 'b', kind: 'offered', amountPence: 8_000, date: '2026-09-02' }),
      entry({ id: 'c', kind: 'paid', amountPence: 8_000, date: '2026-09-03' }),
      entry({ id: 'd', kind: 'claimed', amountPence: 12_000, date: '2026-09-04', supersedesId: 'a' })
    ]);
    expect(rows.map((r) => r.runningPence)).toEqual([0, 0, -8_000, 4_000]);
    expect(rows[0]!.superseded).toBe(true);
    expect(rows[3]!.correction).toBe(true);
    expect(filterRows(rows, {}).map((r) => r.entry.id)).toEqual(['b', 'c', 'd']);
    expect(filterRows(rows, { showSuperseded: true, kind: 'claimed' }).map((r) => r.entry.id)).toEqual(['a', 'd']);
  });
});

describe('ledgerBodyFrom', () => {
  const today = '2026-10-04';
  it('rejects zero, negative non-adjustments and future dates', () => {
    const base = { ...emptyLedgerForm(today), head: 'hire' as const, kind: 'paid' as const, description: 'Remittance' };
    expect(ledgerBodyFrom({ ...base, amountPence: 0 }, today)).toMatchObject({ ok: false, errors: { amountPence: expect.stringContaining('zero') } });
    expect(ledgerBodyFrom({ ...base, amountPence: -500 }, today)).toMatchObject({ ok: false, errors: { amountPence: expect.stringContaining('adjustment') } });
    expect(ledgerBodyFrom({ ...base, amountPence: 500, date: '2026-10-05' }, today)).toMatchObject({ ok: false, errors: { date: expect.any(String) } });
    expect(ledgerBodyFrom({ ...base, kind: 'adjustment', amountPence: -500 }, today).ok).toBe(true);
  });
  it('sends pence, never pounds, and drops blanks', () => {
    const r = ledgerBodyFrom({ ...emptyLedgerForm(today), head: 'hire', kind: 'paid', amountPence: 111_200, description: ' BACS from esure ', reference: 'REM-1 ' }, today);
    expect(r).toEqual({
      ok: true,
      body: { head: 'hire', kind: 'paid', amountPence: 111_200, vatPence: undefined, date: today, description: 'BACS from esure', reference: 'REM-1', counterpartyId: undefined, supersedesId: undefined, sourceEvidenceId: undefined, sourceDocumentId: undefined }
    });
  });
});

describe('correctsText', () => {
  it('names the corrected entry by its date and description, never its id', () => {
    const old = entry({ id: 'd0ac4f6f-632f-4f5c-b8a3-99371a8489c3', date: '2026-09-27', description: 'Credit hire 7 days × £49.99' });
    const fix = entry({ supersedesId: old.id });
    expect(correctsText(fix, [old, fix])).toBe('corrects the entry of 27 Sept 2026 (Credit hire 7 days × £49.99)');
    expect(correctsText(fix, [fix])).toBe('corrects an earlier entry');
    expect(correctsText(old, [old])).toBe('');
  });
});
