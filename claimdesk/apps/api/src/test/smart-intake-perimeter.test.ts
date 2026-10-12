// owned by intake-server
/**
 * Smart intake and the agent perimeter (docs/SMART-INTAKE.md §8, §10, §15): no agent can call a bundle route;
 * register / attach / settings are human-only; signals and blockers never use accusing words.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BANNED_INTAKE_WORDS, RISK_SIGNAL_CODES, SIGNAL_TEXT } from '@ccguk/domain';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { asAgent } from './bookingFixtures.js';
import { HUMAN_ONLY_ROUTES } from '../agent/perimeter.js';
import { NOW } from './fixtures/smartIntake/scenario.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
});
afterEach(async () => {
  await t.close();
});

describe('perimeter', () => {
  it('lists register, retry, attach and the settings as human-only', () => {
    for (const r of ['POST /api/intake/bundles/:id/register', 'POST /api/intake/bundles/:id/register/retry', 'POST /api/intake/bundles/:id/attach', 'PATCH /api/settings/intake']) expect(HUMAN_ONLY_ROUTES.has(r)).toBe(true);
  });

  it('refuses every bundle route to an agent run token', async () => {
    const claim = (await t.api<{ id: string }>('POST', '/claims', FNOL)).body;
    const b = (await t.api<Any>('POST', '/intake/bundles', { name: 'Perimeter' })).body;
    const calls: Array<['GET' | 'POST' | 'PATCH', string, unknown?]> = [
      ['GET', '/intake/bundles'],
      ['POST', '/intake/bundles', { name: 'x' }],
      ['GET', `/intake/bundles/${b.id}`],
      ['PATCH', `/intake/bundles/${b.id}`, { name: 'y' }],
      ['POST', `/intake/bundles/${b.id}/fields`, { key: 'client.name', value: 'X Y' }],
      ['POST', `/intake/bundles/${b.id}/register`, {}],
      ['POST', `/intake/bundles/${b.id}/register/retry`, {}],
      ['POST', `/intake/bundles/${b.id}/attach`, { claimId: claim.id }],
      ['POST', `/intake/bundles/${b.id}/cancel`, { reason: 'agent says so' }],
      ['POST', `/intake/bundles/${b.id}/think-again`, {}],
      ['PATCH', '/settings/intake', { bundles: { autoRegister: true } }],
    ];
    for (const [method, url, body] of calls) {
      const r = await asAgent<Any>(t, claim.id, method, url, body);
      expect(r.status, `${method} ${url}`).toBe(403);
      expect(r.body.error.code).toBe('AGENT_FORBIDDEN');
    }
    expect((await t.api<Any>('GET', `/intake/bundles/${b.id}`)).body.name).toBe('Perimeter');
    expect(t.ctx.repos.getAgentSettings(t.ctx.db).intake.bundles.autoRegister).toBe(false);
  });

  it('signal texts never accuse anyone', () => {
    for (const code of RISK_SIGNAL_CODES) expect(BANNED_INTAKE_WORDS.test(`${SIGNAL_TEXT[code].title} ${SIGNAL_TEXT[code].template}`), code).toBe(false);
  });
});
