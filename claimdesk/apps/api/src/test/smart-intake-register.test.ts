// owned by intake-server
/**
 * Registering a bundle (docs/SMART-INTAKE.md §6.7, §6.10, §9): blockers refuse with 409 and the list; the owner's
 * card registers through its resolver; without a mailbox the request for missing documents becomes a question; a
 * failure after the claim exists leaves the bundle registered with the error and a retry finishes it once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { claimFormA, drain, NOW, setAgents, textPackA, uploadToBundle, v5cA } from './fixtures/smartIntake/scenario.js';
import { registerTestHooks } from '../intake/bundles/register.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  setAgents(t.ctx, false);
});
afterEach(async () => {
  registerTestHooks.failAtStep = null;
  await t.close();
});

async function readyBundle(files: Array<Promise<Any> | Any>): Promise<string> {
  const id = (await t.api<Any>('POST', '/intake/bundles', { name: 'Jane Doe – Corsa crash' })).body.id;
  expect((await uploadToBundle(t, id, await Promise.all(files))).status).toBe(201);
  await drain(t);
  return id;
}

describe('registering a bundle', () => {
  it('refuses with the blockers while details disagree, then registers once they are chosen', async () => {
    const id = await readyBundle([v5cA(), claimFormA(), textPackA()]);
    const refused = await t.api<Any>('POST', `/intake/bundles/${id}/register`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BUNDLE_NOT_READY');
    expect(refused.body.error.details.blockers.map((b: Any) => b.code)).toContain('OPEN_CONFLICTS');
    // the lock was released
    expect((await t.api<Any>('GET', `/intake/bundles/${id}`)).body.status).not.toBe('registering');
    // choose one conflict by hand, accept the rest at register
    const d = (await t.api<Any>('GET', `/intake/bundles/${id}`)).body;
    const vin = d.conflicts.find((c: Any) => c.key === 'vehicle.vin');
    const other = vin.options.find((o: Any) => !o.preselected);
    const chosen = await t.api<Any>('POST', `/intake/bundles/${id}/conflicts/${vin.id}/choose`, { value: other.value });
    expect(chosen.body.conflicts.find((c: Any) => c.id === vin.id)).toMatchObject({ status: 'resolved', chosenValue: other.value });
    expect((await t.api<Any>('POST', `/intake/bundles/${id}/conflicts/${vin.id}/choose`, { value: 'NOT AN OPTION' })).status).toBe(400);
    const ok = await t.api<Any>('POST', `/intake/bundles/${id}/register`, { acceptPreselected: true });
    expect(ok.status).toBe(201);
    expect(ok.body.claim.reference).toMatch(/^CCG-/);
    const view = (await t.api<Any>('GET', `/claims/${ok.body.claim.id}`)).body;
    expect(view.vehicle.vin).toBe(other.value);
    // registering again is refused
    expect((await t.api<Any>('POST', `/intake/bundles/${id}/register`, {})).body.error.code).toBe('BUNDLE_CLOSED');
  });

  it('registers from the owner’s Needs-you card; with no mailbox the request becomes a question', async () => {
    const id = await readyBundle([v5cA(), claimFormA()]);
    const d = (await t.api<Any>('GET', `/intake/bundles/${id}`)).body;
    expect(d.register.canRegister).toBe(true);
    expect(d.register.fnolWarnings.length).toBeGreaterThan(0);
    // plain sentences for the owner, not field paths ("accident.postcode: …")
    for (const w of d.register.fnolWarnings as string[]) expect(w).not.toMatch(/^[A-Za-z][\w.[\]]*:\s/);
    expect(d.register.willDo.join('\n')).toMatch(/Call the client/);
    // the request line counts exactly the items the prepared email asks for (not the hire paperwork)
    const asked = (d.checklist.request?.body.match(/^- /gm) ?? []).length;
    const line = d.register.willDo.find((l: string) => l.startsWith('Prepare a request')) ?? '';
    expect(asked).toBeGreaterThan(0);
    expect(line).toContain(`for ${asked} missing document${asked === 1 ? '' : 's'} `);
    const card = t.ctx.repos.getNeedsYouItem(t.ctx.db, d.needsYouId)!;
    expect(card.kind).toBe('new_claim');
    expect(card.payload).toMatchObject({ bundleId: id, name: 'Jane Doe – Corsa crash' });
    expect(card.options.map((o) => o.id)).toEqual(['register', 'attach', 'cancel']);
    const res = await t.api<Any>('POST', `/needs-you/${card.id}/resolve`, { optionId: 'register' });
    expect(res.status).toBe(200);
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, card.id)!.status).toBe('resolved');
    const b = (await t.api<Any>('GET', `/intake/bundles/${id}`)).body;
    expect(b.status).toBe('registered');
    const brief = (await t.api<Any>('GET', `/claims/${b.claim.id}/intake-brief`)).body;
    expect(brief.request.status).toBe('prepared_no_email');
    const q = t.ctx.repos.getNeedsYouItem(t.ctx.db, brief.request.needsYouId)!;
    expect(q.kind).toBe('question');
    expect(q.summary).toMatch(/Documents we still need/);
    expect((await t.api<Any>('GET', `/claims/${b.claim.id}/intake-brief`)).status).toBe(200);
  });

  it('finishes a failed step on retry without doing anything twice', async () => {
    const id = await readyBundle([v5cA(), claimFormA()]);
    registerTestHooks.failAtStep = 7;
    const first = await t.api<Any>('POST', `/intake/bundles/${id}/register`, {});
    expect(first.status).toBe(201);
    expect(first.body.error).toMatch(/injected failure at step 7/);
    expect(first.body.bundle.status).toBe('registered');
    expect(first.body.events).toBe(0);
    const claimId = first.body.claim.id;
    const evidenceBefore = (await t.api<Any>('GET', `/claims/${claimId}/evidence`)).body.items.length;
    const retry = await t.api<Any>('POST', `/intake/bundles/${id}/register/retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.error).toBeNull();
    expect(retry.body.claim.id).toBe(claimId);
    expect((await t.api<Any>('GET', `/claims/${claimId}/evidence`)).body.items.length).toBe(evidenceBefore);
    const again = await t.api<Any>('POST', `/intake/bundles/${id}/register/retry`, {});
    expect(again.body.events).toBe(0);
    const events = (await t.api<Any>('GET', `/claims/${claimId}`)).body.events.filter((e: Any) => e.data?.intakeBundleId === id);
    expect(new Set(events.map((e: Any) => e.data.intakeTimelineId)).size).toBe(events.length);
    expect(t.ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM claims`).get()).toMatchObject({ n: 1 });
  });

  it('cancels from the card with a reason', async () => {
    const id = await readyBundle([v5cA(), claimFormA()]);
    const d = (await t.api<Any>('GET', `/intake/bundles/${id}`)).body;
    expect((await t.api<Any>('POST', `/needs-you/${d.needsYouId}/resolve`, { optionId: 'cancel' })).status).toBe(400);
    expect((await t.api<Any>('POST', `/needs-you/${d.needsYouId}/resolve`, { optionId: 'cancel', note: 'not one of ours' })).status).toBe(200);
    expect((await t.api<Any>('GET', `/intake/bundles/${id}`)).body.status).toBe('cancelled');
  });
});
