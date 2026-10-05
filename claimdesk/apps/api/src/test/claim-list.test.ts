import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '@ccguk/domain';
import { isClockOverdue, oldestOverdue, type ClaimListResponse } from '../services/claimList.js';
import { createTestApp, FNOL, type TestApp } from './helpers.js';

/** GET /claims enrichment (docs/V03-MANAGER-MODE-HIRE-PRICING.md §E2). */
describe('GET /claims list rows', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp('2026-10-05T09:00:00.000Z');
  });
  afterEach(async () => {
    await t.close();
  });

  async function newClaim(): Promise<string> {
    const res = await t.api<{ claim: { id: string } }>('POST', '/claims', FNOL);
    expect(res.status).toBe(201);
    return res.body.claim.id;
  }

  it('adds the insurer name, the handler name, the outstanding amount and keeps the existing fields', async () => {
    const id = await newClaim();
    expect((await t.api('POST', `/claims/${id}/ledger`, { head: 'hire', kind: 'claimed', amountPence: 114540, date: '2026-10-04', description: 'Hire 23 days' })).status).toBe(201);
    expect((await t.api('POST', `/claims/${id}/ledger`, { head: 'hire', kind: 'paid', amountPence: 40000, date: '2026-10-05', description: 'Interim payment' })).status).toBe(201);
    const res = await t.api<ClaimListResponse>('GET', '/claims');
    expect(res.status).toBe(200);
    const row = res.body.items.find((c) => c.id === id)!;
    expect(row).toBeDefined();
    expect(row.claimantName).toBe('Amina Yusuf');
    expect(row.registration).toBe('KX21ABC');
    expect(typeof row.openFlags).toBe('number');
    expect(row.insurerName).toBe('Example Insurance plc');
    const handler = row.handlerId ? t.ctx.repos.getUser(t.ctx.db, row.handlerId) : undefined;
    expect(row.handlerName).toBe(handler?.name);
    expect(row.outstandingPence).toBe(114540 - 40000);
    expect(res.body.total).toBe(res.body.items.length);
    expect(Array.isArray(res.body.byStatus)).toBe(true);
  });

  it('a claim with no ledger rows has nothing outstanding and no overdue clock today', async () => {
    const id = await newClaim();
    const row = (await t.api<ClaimListResponse>('GET', '/claims')).body.items.find((c) => c.id === id)!;
    expect(row.outstandingPence).toBe(0);
    const clocks = t.ctx.repos.listClocks(t.ctx.db, id);
    const anyOverdue = clocks.some((c) => isClockOverdue(c, Date.parse('2026-10-05T09:00:00.000Z')));
    expect(Boolean(row.oldestOverdueClock)).toBe(anyOverdue);
  });

  it('reports the oldest overdue clock from the clocks cache once time has passed', async () => {
    const id = await newClaim();
    const clocks = t.ctx.repos.listClocks(t.ctx.db, id).filter((c) => c.status === 'running');
    expect(clocks.length).toBeGreaterThan(0);
    const earliest = [...clocks].sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0]!;
    // Two years on, every running clock is overdue.
    t.setNow('2028-10-05T09:00:00.000Z');
    const row = (await t.api<ClaimListResponse>('GET', '/claims')).body.items.find((c) => c.id === id)!;
    expect(row.oldestOverdueClock).toBeDefined();
    expect(row.oldestOverdueClock!.id).toBe(earliest.id);
    expect(row.oldestOverdueClock!.dueAt).toBe(earliest.dueAt);
    expect(row.oldestOverdueClock!.daysOverdue).toBeGreaterThan(300);
    // Long clocks (limitation) may still be running in two years' time.
    const overdueThen = clocks.filter((c) => c.dueAt < '2028-10-05T09:00:00.000Z').length;
    expect(overdueThen).toBeGreaterThan(0);
    expect(row.oldestOverdueClock!.moreOverdue).toBe(overdueThen - 1);
  });

  it('filters still work (status) and the rows are enriched the same way', async () => {
    await newClaim();
    const res = await t.api<ClaimListResponse>('GET', '/claims?status=intake,accepted');
    expect(res.status).toBe(200);
    for (const r of res.body.items) expect(r).toHaveProperty('outstandingPence');
  });
});

describe('oldestOverdue', () => {
  const clock = (id: string, dueAt: string, status: Clock['status'] = 'running'): Clock => ({ id, claimId: 'c', kind: 'ncaf_ack' as Clock['kind'], label: id, basis: 'test', startsAt: '2026-01-01T00:00:00.000Z', dueAt, status });
  const now = '2026-10-05T12:00:00.000Z';

  it('ignores met, stopped and future clocks; picks the earliest overdue; counts the others', () => {
    const r = oldestOverdue([clock('future', '2026-10-06T00:00:00.000Z'), clock('met', '2026-09-01T00:00:00.000Z', 'met'), clock('b', '2026-10-01T12:00:00.000Z'), clock('a', '2026-09-28T12:00:00.000Z', 'breached'), clock('stopped', '2026-08-01T00:00:00.000Z', 'stopped')], now)!;
    expect(r.id).toBe('a');
    expect(r.daysOverdue).toBe(7);
    expect(r.moreOverdue).toBe(1);
  });

  it('a breached clock is overdue even when its due time is in the future (recorded breach)', () => {
    expect(isClockOverdue({ status: 'breached', dueAt: '2027-01-01T00:00:00.000Z' }, Date.parse(now))).toBe(true);
    expect(oldestOverdue([], now)).toBeUndefined();
  });
});
