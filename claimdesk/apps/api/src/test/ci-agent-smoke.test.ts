/**
 * The Windows CI "Agent smoke (fake AI)" step in-process (docs/SUPREME-DESIGN.md §R.3) — owned by the integrator.
 * Same steps as the workflow: AI_DRIVER=fake, tick the setup checklist and switch the agents on through the API, drop
 * the CI .eml into inbox\mail, let the queue run → GET /api/needs-you shows an item. No real model is called.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CHECKLIST_ITEM_IDS } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { createSupervisor, type Supervisor } from '../agent/supervisor.js';
import { inboxDir, resetInboxTracking, scanInboxOnce } from '../services/imports.js';

const T0 = '2026-10-07T09:00:00.000Z';
let t: TestApp;
let sup: Supervisor;

beforeEach(async () => {
  t = await createTestApp(T0, { config: { aiDriverOverride: 'fake' } });
  resetInboxTracking();
  sup = createSupervisor(t.ctx);
});
afterEach(async () => {
  await sup.worker.stop(1000);
  resetInboxTracking();
  await t.close();
});

// The message the workflow writes (claimdesk-windows.yml, "Agent smoke (fake AI)").
const CI_EML = [
  'From: Claims Handler <handler@insurer.example>',
  'To: claims@courtesycars.net',
  'Subject: New claim notification - please acknowledge',
  'Date: Wed, 07 Oct 2026 09:00:00 +0100',
  'Message-ID: <ci-smoke-0001@insurer.example>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Dear Claims Team,',
  '',
  "We act for the insurer of the third party vehicle LM19 XYZ. Please send us your client's details and confirm",
  'your reference. This is a synthetic message for the ClaimDesk CI smoke test.',
  '',
  'Regards,',
  'Example Insurance plc',
  '',
].join('\r\n');

it('an .eml dropped in inbox\\mail produces a Needs-you item once the agents are switched on (fake AI)', async () => {
  // Agents off (the install default): the AI lane stays shut.
  const before = await t.api<{ enabled: boolean; driver: string }>('GET', '/agents/status');
  expect(before.body).toMatchObject({ enabled: false, driver: 'fake' });

  for (const item of CHECKLIST_ITEM_IDS) expect((await t.api('POST', '/ai/checklist', { item, done: true })).status).toBe(200);
  const on = await t.api<{ agents: { enabled: boolean }; blockers: string[] }>('PATCH', '/ai/settings', { agentsEnabled: true });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  expect(on.body.agents.enabled).toBe(true);

  const dir = path.join(inboxDir(t.ctx), 'mail');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ci-smoke.eml'), CI_EML);
  const now = Date.parse(T0);
  await scanInboxOnce(t.ctx, now);
  const staged = await scanInboxOnce(t.ctx, now + 10_000);
  expect(staged.map((s) => s.purpose)).toEqual(['mail']);

  for (let i = 0; i < 40; i += 1) {
    const hb = await sup.tick(T0);
    await sup.worker.idle();
    if (hb.started === 0) break;
  }
  const ny = await t.api<{ items: Array<{ kind: string; title: string }> }>('GET', '/needs-you');
  expect(ny.status).toBe(200);
  expect(ny.body.items.length).toBeGreaterThanOrEqual(1);
  expect(ny.body.items.map((i) => i.kind)).toContain('new_claim');
  const imports = await t.api<{ items: Array<{ status: string; consumedBy?: string }> }>('GET', '/imports?purpose=mail');
  expect(imports.body.items[0]).toMatchObject({ status: 'consumed', consumedBy: 'mail' });
});
