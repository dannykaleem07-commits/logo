/**
 * Settings → GTA benchmark rates (TEMPLATES-VEHICLES-DESKTOP §F.3): CRUD, the server-side verification rule, hide/show
 * of KB rows, segment defaults, and the merged table feeding /kb/gta-rates and the hire calculations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GtaRate } from '@ccguk/domain';
import { recomputeClocks } from '../services/claimView.js';
import { createTestApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z');
});
afterEach(async () => {
  await t.close();
});

type Row = { id: string; group: string; dailyRatePence?: number; period: string; suppressed: boolean; verification: { status: string; sourceUrl?: string; verifiedBy?: string; verifiedAt?: string }; createdBy: string };
type Item = GtaRate & { origin: 'kb' | 'manual'; id?: string; overridesKb?: boolean; kbRate?: GtaRate; suppressed?: boolean };
type ErrorBody = { error: { code: string; message: string } };

const body = (over: Record<string, unknown> = {}) => ({ group: 'S1', description: 'Small car (our rate)', dailyRatePence: 4400, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', ...over });

describe('GTA benchmark rate settings', () => {
  it('lists KB rows with the benchmark note', async () => {
    const res = await t.api<{ items: Item[]; note: string }>('GET', '/settings/gta-rates');
    expect(res.status).toBe(200);
    expect(res.body.note).toMatch(/not a GTA subscriber/);
    expect(res.body.items.find((i) => i.group === 'S1' && i.period === '2026-27')).toMatchObject({ origin: 'kb', dailyRatePence: 4232 });
    expect(res.body.items.every((i) => i.origin === 'kb')).toBe(true);
  });

  it('creates an override (unverified by default), refuses a duplicate, updates and deletes it — all audited', async () => {
    const created = await t.api<Row>('POST', '/settings/gta-rates', body({ group: 's1', verification: { status: 'unverified', sourceNote: 'phone quote' } }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ group: 'S1', dailyRatePence: 4400, suppressed: false, createdBy: 'handler', verification: { status: 'unverified', sourceNote: 'phone quote' } });
    const dup = await t.api<ErrorBody>('POST', '/settings/gta-rates', body());
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('GTA_RATE_EXISTS');

    const list = await t.api<{ items: Item[] }>('GET', '/settings/gta-rates');
    const s1 = list.body.items.filter((i) => i.group === 'S1' && i.period === '2026-27');
    expect(s1).toHaveLength(1);
    expect(s1[0]).toMatchObject({ origin: 'manual', overridesKb: true, dailyRatePence: 4400, id: created.body.id, kbRate: { dailyRatePence: 4232 } });

    const kb = await t.api<{ items: Array<{ group: string; dailyRatePence: number }> }>('GET', '/kb/gta-rates?date=2026-10-05&group=S1');
    expect(kb.body.items[0]!.dailyRatePence).toBe(4400);

    const updated = await t.api<Row>('PUT', `/settings/gta-rates/${created.body.id}`, body({ dailyRatePence: 4500 }));
    expect(updated.status).toBe(200);
    expect(updated.body.dailyRatePence).toBe(4500);

    expect((await t.api('DELETE', `/settings/gta-rates/${created.body.id}`)).status).toBe(204);
    expect((await t.api('DELETE', `/settings/gta-rates/${created.body.id}`)).status).toBe(404);
    const back = await t.api<{ items: Array<{ dailyRatePence: number }> }>('GET', '/kb/gta-rates?date=2026-10-05&group=S1');
    expect(back.body.items[0]!.dailyRatePence).toBe(4232);
    const actions = t.ctx.repos.listAudit(t.ctx.db, { entity: 'gta_rates' }).map((a) => a.action).sort();
    expect(actions).toEqual(['gta_rate.create', 'gta_rate.delete', 'gta_rate.update']);
  });

  it('verification rule: verified needs an https source; the server stamps who and when and ignores client values', async () => {
    const noUrl = await t.api<ErrorBody>('POST', '/settings/gta-rates', body({ verification: { status: 'verified' } }));
    expect(noUrl.status).toBe(400);
    const http = await t.api<ErrorBody>('POST', '/settings/gta-rates', body({ verification: { status: 'verified', sourceUrl: 'http://www.gtacredithire.com/rates/' } }));
    expect(http.status).toBe(400);
    const ok = await t.api<Row>('POST', '/settings/gta-rates', body({ group: 'PV2', dailyRatePence: 7900, verification: { status: 'verified', sourceUrl: 'https://www.gtacredithire.com/rates/', verifiedBy: 'someone-else', verifiedAt: '2001-01-01' } }));
    expect(ok.status).toBe(201);
    expect(ok.body.verification).toEqual({ status: 'verified', sourceUrl: 'https://www.gtacredithire.com/rates/', verifiedBy: 'handler', verifiedAt: '2026-10-05' });
    // A manual-only row joins the merged table.
    const items = (await t.api<{ items: Item[] }>('GET', '/settings/gta-rates')).body.items;
    expect(items.find((i) => i.group === 'PV2' && i.period === '2026-27')).toMatchObject({ origin: 'manual', overridesKb: false, verification: { status: 'verified' } });
  });

  it('validates group, period, dates and pence', async () => {
    for (const bad of [body({ group: 'small' }), body({ period: '2026/27' }), body({ effectiveFrom: '2027-07-01' }), body({ dailyRatePence: 0 }), body({ dailyRatePence: 44.5 })]) {
      expect((await t.api('POST', '/settings/gta-rates', bad)).status).toBe(400);
    }
    expect((await t.api('PUT', '/settings/gta-rates/nope', body())).status).toBe(404);
  });

  it('hides a KB row and shows it again', async () => {
    const hidden = await t.api<Item>('POST', '/settings/gta-rates/suppress', { group: 'CP1', period: '2025-26', suppressed: true });
    expect(hidden.status).toBe(200);
    expect(hidden.body).toMatchObject({ group: 'CP1', suppressed: true, origin: 'kb' });
    const kb = await t.api<{ items: Array<{ group: string }> }>('GET', '/kb/gta-rates?date=2026-03-01');
    expect(kb.body.items.some((r) => r.group === 'CP1')).toBe(false);
    const shown = await t.api<Item>('POST', '/settings/gta-rates/suppress', { group: 'CP1', period: '2025-26', suppressed: false });
    expect(shown.body).toMatchObject({ group: 'CP1', origin: 'kb' });
    expect(shown.body.suppressed).toBeUndefined();
    expect((await t.api<{ items: Array<{ group: string }> }>('GET', '/kb/gta-rates?date=2026-03-01')).body.items.some((r) => r.group === 'CP1')).toBe(true);
    expect((await t.api('POST', '/settings/gta-rates/suppress', { group: 'ZZ9', period: '2025-26', suppressed: true })).status).toBe(404);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'gta_rate.suppress' })).toHaveLength(2);
  });
});

describe('GTA segment defaults', () => {
  it('lists every segment from the KB file, overrides and resets', async () => {
    const list = await t.api<{ items: Array<{ segment: string; label: string; group: string; origin: string }> }>('GET', '/settings/gta-segments');
    expect(list.body.items).toHaveLength(19);
    expect(list.body.items.find((i) => i.segment === 'city')).toMatchObject({ label: 'City car', group: 'S1', origin: 'kb' });
    const put = await t.api<{ segment: string; group: string; origin: string }>('PUT', '/settings/gta-segments/city', { group: 's2' });
    expect(put.body).toMatchObject({ segment: 'city', group: 'S2', origin: 'manual' });
    expect((await t.api('PUT', '/settings/gta-segments/hovercraft', { group: 'S1' })).status).toBe(404);
    expect((await t.api('PUT', '/settings/gta-segments/city', { group: 'bad group' })).status).toBe(400);
    expect((await t.api('DELETE', '/settings/gta-segments/city')).status).toBe(204);
    expect((await t.api<{ items: Array<{ segment: string; group: string; origin: string }> }>('GET', '/settings/gta-segments')).body.items.find((i) => i.segment === 'city')).toMatchObject({ group: 'S1', origin: 'kb' });
    const actions = t.ctx.repos.listAudit(t.ctx.db, { entity: 'gta_segment_defaults' }).map((a) => a.action).sort();
    expect(actions).toEqual(['gta_segment.reset', 'gta_segment.update']);
  });
});

describe('hire calculations use the merged rates', () => {
  it('GET /claims/:id/hire benchmarks against an override', async () => {
    const ids = t.ctx.repos.seedFileOne(t.ctx.db);
    recomputeClocks(t.ctx, ids.claimId);
    type HireList = { hire: Array<{ calculation: { benchmark?: { group: string; gtaDailyRatePence: number } } }> };
    const before = await t.api<HireList>('GET', `/claims/${ids.claimId}/hire`);
    expect(before.body.hire[0]!.calculation.benchmark).toMatchObject({ group: 'S1', gtaDailyRatePence: 4232 });
    await t.api('POST', '/settings/gta-rates', body({ dailyRatePence: 4999 }));
    const after = await t.api<HireList>('GET', `/claims/${ids.claimId}/hire`);
    expect(after.body.hire[0]!.calculation.benchmark).toMatchObject({ group: 'S1', gtaDailyRatePence: 4999 });
  });
});
