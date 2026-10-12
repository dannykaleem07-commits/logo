// owned by intake-server (added by the integration verifier)
/**
 * Switching automatic registration on while a clean bundle is already waiting (docs/SMART-INTAKE.md §10, §14): the
 * waiting bundle is looked at again at once — its blockers stop saying "off", and it is registered by agent:intake
 * without waiting for another file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { CLEAN, cleanCaseFiles, drain, NOW, setAgents, uploadToBundle } from './fixtures/smartIntake/scenario.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  setAgents(t.ctx, true);
});
afterEach(async () => {
  await t.close();
});

describe('Settings > Intake: automatic registration switched on later', () => {
  it('re-checks the waiting bundles and registers the eligible one', async () => {
    const b = (await t.api<Any>('POST', '/intake/bundles', { name: CLEAN })).body;
    expect((await uploadToBundle(t, b.id, await cleanCaseFiles())).status).toBe(201);
    await drain(t);
    let d = (await t.api<Any>('GET', `/intake/bundles/${b.id}`)).body;
    expect(d.status).toBe('needs_you');
    expect(d.reasoning.status).toBe('done');
    expect(d.autoRegister.blockers.map((x: Any) => x.code)).toEqual(['SETTING_OFF']);

    const on = await t.api<Any>('PATCH', '/settings/intake', { bundles: { autoRegister: true } });
    expect(on.status).toBe(200);
    d = (await t.api<Any>('GET', `/intake/bundles/${b.id}`)).body;
    expect(d.autoRegister.settingOn).toBe(true);
    expect(d.autoRegister.blockers.map((x: Any) => x.code)).not.toContain('SETTING_OFF');
    expect(d.autoRegister.eligible).toBe(true);

    await drain(t);
    d = (await t.api<Any>('GET', `/intake/bundles/${b.id}`)).body;
    expect(d.status).toBe('registered');
    const regAudit = t.ctx.handle.sqlite.prepare(`SELECT user_id FROM audit_log WHERE action = 'intake.bundle.register' AND entity_id = ?`).get(b.id) as { user_id: string };
    expect(regAudit.user_id).toBe('agent:intake');
  }, 120_000);

  it('an AI check that cannot finish is explained in plain words (the technical reason stays on the job)', async () => {
    const b = (await t.api<Any>('POST', '/intake/bundles', { name: 'No Matching Case' })).body;
    expect((await uploadToBundle(t, b.id, await cleanCaseFiles())).status).toBe(201);
    await drain(t, { rounds: 600 });
    const d = (await t.api<Any>('GET', `/intake/bundles/${b.id}`)).body;
    expect(d.reasoning.status).toBe('failed');
    expect(d.error).toMatch(/^The AI check of these documents did not finish/);
    expect(d.error).not.toMatch(/invalid result|fixture|job type/i);
  }, 120_000);
});

