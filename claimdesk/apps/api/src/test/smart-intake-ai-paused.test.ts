// owned by intake-server
/**
 * Smart intake with the AI paused (docs/SMART-INTAKE.md §5.6, §6.2): the bundle is read from the documents' text,
 * the AI check waits (agents off, kill switch, usage limit) and says why, the owner can still register, and nothing is
 * registered automatically; text aimed at an AI becomes an owner-only signal and blocks automatic registration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { claimFormA, drain, NOW, setAgents, uploadToBundle, v5cA } from './fixtures/smartIntake/scenario.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
});
afterEach(async () => {
  await t.close();
});

async function bundleOf(name: string): Promise<string> {
  const id = (await t.api<Any>('POST', '/intake/bundles', { name })).body.id;
  await uploadToBundle(t, id, [await v5cA(), await claimFormA()]);
  return id;
}
const detail = async (id: string) => (await t.api<Any>('GET', `/intake/bundles/${id}`)).body;

describe('with the AI paused', () => {
  it('agents off: the draft comes from the text, the AI check waits, the owner can register, nothing is automatic', async () => {
    setAgents(t.ctx, false);
    await t.api('PATCH', '/settings/intake', { bundles: { autoRegister: true } });
    const id = await bundleOf('Jane Doe – Corsa crash');
    const jobs = await drain(t);
    expect(jobs.some((j) => j.type === 'intake.extract')).toBe(false);
    const d = await detail(id);
    expect(d.files.every((f: Any) => f.stage === 'waiting_ai' && f.waiting?.reason === 'agents_off')).toBe(true);
    expect(d.reasoning).toMatchObject({ status: 'waiting_ai', waiting: { reason: 'agents_off' } });
    expect(d.draft.fields.find((f: Any) => f.key === 'vehicle.registration').source.engine).toBe('rules');
    expect(d.autoRegister.eligible).toBe(false);
    expect(d.autoRegister.blockers.map((b: Any) => b.code)).toContain('AI_REASONING_NOT_DONE');
    expect(t.ctx.repos.listAgentJobs(t.ctx.db, { type: 'intake.bundle_register', limit: 5 })).toEqual([]);
    expect(d.register.canRegister).toBe(true);
    // switching the agents on drains the waiting AI work and improves the draft
    setAgents(t.ctx, true);
    await drain(t);
    const after = await detail(id);
    expect(after.draft.fields.find((f: Any) => f.key === 'vehicle.registration').source.engine).toBe('ai');
    expect(after.files.every((f: Any) => f.engine === 'ai')).toBe(true);
    expect(after.reasoning.status).toBe('done');
  });

  it('kill switch: the AI check waits with the reason', async () => {
    setAgents(t.ctx, true);
    await t.api('PATCH', '/settings/autonomy', { killSwitch: true });
    const id = await bundleOf('Jane Doe – Corsa crash');
    await drain(t);
    const d = await detail(id);
    expect(d.reasoning.waiting?.reason).toBe('kill_switch');
    expect(d.files[0].waiting?.reason).toBe('kill_switch');
  });

  it('usage limit: the AI check waits until the limit resets', async () => {
    setAgents(t.ctx, true);
    const id = await bundleOf('Paused Case');
    await drain(t);
    const job = t.ctx.repos.listAgentJobs(t.ctx.db, { type: 'intake.bundle_reason', limit: 5 })[0]!;
    expect(job.status).toBe('waiting_usage');
    const d = await detail(id);
    expect(d.reasoning.status).toBe('waiting_ai');
    expect(d.reasoning.waiting?.reason).toBe('usage');
  });

  it('text aimed at an AI becomes an owner-only signal and blocks automatic registration', async () => {
    setAgents(t.ctx, true);
    const id = await bundleOf('Injection Case');
    await drain(t);
    const d = await detail(id);
    expect(d.signals.map((s: Any) => s.code)).toContain('INSTRUCTIONS_IN_DOCUMENT');
    expect(d.autoRegister.blockers.map((b: Any) => b.code)).toContain('INSTRUCTIONS_IN_DOCUMENT');
  });
});
