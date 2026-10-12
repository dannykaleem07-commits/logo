// owned by intake-server
/**
 * Attaching a bundle to an existing claim (docs/SMART-INTAKE.md §6.9, §9): files filed on the claim, details proposed
 * through the existing policy, the owner's ticked keys applied, the rest in ONE bundle confirm card whose resolver
 * applies exactly the listed proposals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { drain, NOW, setAgents, uploadToBundle, v5cA } from './fixtures/smartIntake/scenario.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let t: TestApp;
let claim: { id: string; reference: string };

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  setAgents(t.ctx, false);
  claim = (await t.api<{ id: string; reference: string }>('POST', '/claims', FNOL)).body;
});
afterEach(async () => {
  await t.close();
});

describe('attaching a bundle', () => {
  it('files the documents, applies the ticked details and asks about the rest on one card', async () => {
    const id = (await t.api<Any>('POST', '/intake/bundles', { name: 'More for KX21 ABC' })).body.id;
    await uploadToBundle(t, id, [await v5cA()]);
    await drain(t);
    expect((await t.api<Any>('POST', `/intake/bundles/${id}/attach`, { claimId: 'nope' })).status).toBe(404);
    const r = await t.api<Any>('POST', `/intake/bundles/${id}/attach`, { claimId: claim.id, apply: ['vehicle.vin'] });
    expect(r.status).toBe(200);
    expect(r.body.claim).toEqual({ id: claim.id, reference: claim.reference });
    expect(r.body.bundle.status).toBe('attached');
    expect(r.body.filed.evidence).toBe(1);
    expect(r.body.proposals.applied).toBeGreaterThanOrEqual(1);
    const view = (await t.api<Any>('GET', `/claims/${claim.id}`)).body;
    expect(view.vehicle.vin).toBe('WVWZZZ1JZXW000123');
    const ev = (await t.api<Any>('GET', `/claims/${claim.id}/evidence`)).body.items;
    expect(ev.find((e: Any) => e.filename === 'SMART-A-V5C.pdf')?.kind).toBe('v5c');
    // the rest: one confirm card for the bundle
    expect(r.body.proposals.pending).toBeGreaterThan(0);
    const card = t.ctx.repos.getNeedsYouItem(t.ctx.db, r.body.proposals.needsYouId)!;
    expect(card.kind).toBe('confirm_fields');
    expect(card.dedupeKey).toBe(`confirm_fields:bundle:${id}:${claim.id}`);
    const listed = (card.payload as Any).proposals as Array<{ id: string; target: string }>;
    expect(listed.length).toBe(r.body.proposals.pending);
    const colour = listed.find((p) => p.target === 'vehicle:client.colour')!;
    const res = await t.api<Any>('POST', `/needs-you/${card.id}/resolve`, { optionId: 'apply', edits: { apply: [colour.id] } });
    expect(res.status).toBe(200);
    expect((await t.api<Any>('GET', `/claims/${claim.id}`)).body.vehicle.colour).toBe('BLUE');
    const statuses = listed.map((p) => t.ctx.repos.getClaimUpdateProposal(t.ctx.db, p.id)?.status);
    expect(statuses.filter((s) => s === 'applied')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'pending')).toHaveLength(0);
    const audit = t.ctx.handle.sqlite.prepare(`SELECT after FROM audit_log WHERE action = 'intake.bundle.attach'`).get() as { after: string };
    expect(JSON.parse(audit.after)).toMatchObject({ claimId: claim.id, groupKey: 'main' });
  });
});
