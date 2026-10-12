// owned by claimai-server
/**
 * Claim AI input test scenario (docs/CLAIM-AI-INPUT.md §16): a fixed clock (Monday 12 October 2026, 10:00 London),
 * claim CCG-2026-00001 opened late for an accident on 1 October, at-fault insurer Example Mutual Insurance with no
 * reference yet, an open hire HA-0042 from 3 October, and claim CCG-2026-00002 for the "other claim" letter. Every
 * person, vehicle and reference is invented. No model or network is ever called (AI_DRIVER=fake, FakeDriver fixtures
 * under apps/api/src/ai/fixtures/claimai/).
 */
import type { AppContext } from '../../../context.js';
import { createTestApp, FNOL, type TestApp } from '../../helpers.js';
import { recomputeClocks } from '../../../services/claimView.js';
import { storeEvidenceBuffer } from '../../../services/evidence.js';
import { AGENT_NAMES } from '@ccguk/domain';
import { startWorker } from '../../../agent/worker.js';
import { openGates } from '../../../agent/queue.js';
import { intakeJobHandlers } from '../../../agent/handlers/intake.js';
import { claimAiJobHandlers } from '../../../agent/handlers/claimai.js';

export const NOW = '2026-10-12T09:00:00.000Z';
export const INSURER = 'Example Mutual Insurance';
export const INSURER_EMAIL = 'claims@example-mutual.example.test';
export const CLIENT = { name: 'Jane Doe', email: 'jane.doe@example.test', phone: '07700 900456', vrm: 'KX21 ABC' };
export const OTHER = { name: 'Chris Contact', vrm: 'JK66 MNO' };

export async function claimAiApp(opts: { agents?: boolean } = {}): Promise<TestApp> {
  const t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  setAgents(t.ctx, opts.agents ?? false);
  return t;
}

/** Agents on / off (Settings > AI). */
export function setAgents(ctx: AppContext, enabled: boolean): void {
  const s = ctx.repos.getAgentSettings(ctx.db);
  ctx.repos.patchAgentSettings(ctx.db, { agents: { ...s.agents, enabled } } as never, { userId: 'test' }, ctx.now());
}

export function setKillSwitch(ctx: AppContext, on: boolean): void {
  const s = ctx.repos.getAgentSettings(ctx.db);
  ctx.repos.patchAgentSettings(ctx.db, { autonomy: { ...s.autonomy, killSwitch: on } } as never, { userId: 'test' }, ctx.now());
}

export interface Seeded {
  claim1: { id: string; reference: string };
  claim2: { id: string; reference: string };
  hire: { id: string; agreementNumber: string };
}

/** Seed the two claims, the open hire HA-0042 on claim 1 and `services_agreed` on 1 October (so the NCAF is due). */
export async function seedScenario(t: TestApp, opts: { secondHire?: boolean } = {}): Promise<Seeded> {
  const one = await t.api<Json>('POST', '/claims', {
    ...FNOL,
    claimant: { kind: 'individual', name: CLIENT.name, phone: CLIENT.phone, email: CLIENT.email, address: { line1: '5 Example Road', town: 'Testville', postcode: 'AB1 2CD' }, roles: ['claimant', 'driver'] },
    vehicle: { registration: CLIENT.vrm, make: 'Vauxhall', model: 'Corsa', ownership: 'client' },
    thirdPartyVehicle: { registration: 'LM19 XYZ', make: 'Ford', model: 'Focus', ownership: 'third_party' },
    atFaultInsurer: { kind: 'company', name: INSURER, email: INSURER_EMAIL, roles: ['insurer'] },
    accident: { ...FNOL.accident, occurredAt: '2026-10-01T07:35:00.000Z', location: 'Example Road, Testville' },
  });
  if (one.status !== 201) throw new Error(`seed claim 1: ${one.status} ${JSON.stringify(one.body)}`);
  const two = await t.api<Json>('POST', '/claims', {
    ...FNOL,
    claimant: { kind: 'individual', name: OTHER.name, phone: '07700 900999', email: 'chris.contact@example.test', address: { line1: '3 Far Lane', town: 'Distant', postcode: 'DI5 7NT' }, roles: ['claimant', 'driver'] },
    vehicle: { registration: OTHER.vrm, make: 'Fiat', model: '500', ownership: 'client' },
    thirdPartyVehicle: { registration: 'RS17 TUV', make: 'Audi', model: 'A3', ownership: 'third_party' },
  });
  if (two.status !== 201) throw new Error(`seed claim 2: ${two.status} ${JSON.stringify(two.body)}`);
  const c1 = one.body.claim ?? one.body;
  const c2 = two.body.claim ?? two.body;
  const claim1 = { id: c1.id as string, reference: c1.reference as string };
  const claim2 = { id: c2.id as string, reference: c2.reference as string };
  const ev = await t.api('POST', `/claims/${claim1.id}/events`, { type: 'services_agreed', at: '2026-10-01T13:00:00.000Z', summary: 'Client agreed our services by phone' });
  if (ev.status !== 201) throw new Error(`seed services_agreed: ${ev.status} ${JSON.stringify(ev.body)}`);
  const hire = seedHire(t.ctx, claim1.id, 'HA-0042', '2026-10-03T09:00:00.000Z', 'CC26HIR');
  if (opts.secondHire) seedHire(t.ctx, claim1.id, 'HA-0043', '2026-10-05T09:00:00.000Z', 'CC26HIS');
  recomputeClocks(t.ctx, claim1.id);
  return { claim1, claim2, hire };
}

export function seedHire(ctx: AppContext, claimId: string, agreementNumber: string, startAt: string, registration: string): { id: string; agreementNumber: string } {
  const v = ctx.repos.upsertVehicle(ctx.db, { registration, make: 'Kia', model: 'Picanto', ownership: 'fleet' });
  const policy = ctx.repos.createPolicy(ctx.db, { insurerName: 'Fleet Insurer Ltd', policyNumber: `FL-${registration}`, coveredUses: ['credit_hire', 'self_drive'], startDate: '2026-01-01', endDate: '2026-12-31' });
  const unit = ctx.repos.createFleetUnit(ctx.db, { vehicleId: v.id, declaredUses: ['credit_hire'], policyId: policy.id, dailyRatePence: 4232, gtaGroup: 'S1' });
  const h = ctx.repos.createHire(ctx.db, { claimId, fleetUnitId: unit.id, agreementNumber, startAt, dailyRatePence: 4232, vatRate: 0.2, gtaGroup: 'S1', excessPence: 0 } as never);
  return { id: h.id, agreementNumber: h.agreementNumber };
}

/** Jobs of a type (oldest first) straight from the queue table. */
export function jobRows(ctx: AppContext, type: string): Array<{ id: string; status: string; payload: Record<string, unknown>; idempotency_key: string | null; run_after: string | null; claim_id: string | null }> {
  return (ctx.handle.sqlite.prepare('SELECT id, status, payload, idempotency_key, run_after, claim_id FROM agent_jobs WHERE type = ? ORDER BY created_at, rowid').all(type) as Array<{ id: string; status: string; payload: string; idempotency_key: string | null; run_after: string | null; claim_id: string | null }>).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function audits(ctx: AppContext, action: string): Array<{ user_id: string; entity_id: string; after: Record<string, unknown> | null }> {
  return (ctx.handle.sqlite.prepare('SELECT user_id, entity_id, after FROM audit_log WHERE action = ? ORDER BY at, rowid').all(action) as Array<{ user_id: string; entity_id: string; after: string | null }>).map((r) => ({ ...r, after: r.after ? JSON.parse(r.after) : null }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** POST an update and return the AiInputDetail. */
export async function postUpdate(t: TestApp, claimId: string, text: string, extra: { channel?: string; extraText?: string } = {}): Promise<Json> {
  const r = await t.api<Json>('POST', `/claims/${claimId}/ai-input/updates`, { text, ...extra });
  if (r.status !== 201) throw new Error(`update: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function getInput(t: TestApp, claimId: string, inputId: string): Promise<Json> {
  const r = await t.api<Json>('GET', `/claims/${claimId}/ai-input/${inputId}`);
  if (r.status !== 200) throw new Error(`detail: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const line = (d: Json, type: string, n = 0): Json => d.actions.filter((a: Json) => a.type === type)[n];

/** File a document on the claim as the owner would (bytes generated by the test). */
export async function addEvidence(t: TestApp, claimId: string, filename: string, kind: string, content: Buffer, mime = 'application/pdf'): Promise<{ id: string }> {
  const r = await storeEvidenceBuffer(t.ctx, content, { claimId, filename, mime, fields: { kind } as never, actor: { userId: 'owner-test' } as never });
  return { id: r.evidence.id };
}

/**
 * Drain the intake + claim-AI jobs (cpu/io; the AI lane only when agents are on) with the real worker, moving the
 * clock past debounce windows. Every other agent is paused (their jobs stay queued for the test to run by hand).
 */
export async function drainCatchUp(t: TestApp, opts: { rounds?: number } = {}): Promise<Array<{ type: string; outcome: string }>> {
  t.setNow(new Date(Date.parse(t.ctx.now()) + 10 * 60_000).toISOString());
  const w = startWorker(t.ctx, { owner: 'claimai-test', handlers: [...intakeJobHandlers, ...claimAiJobHandlers] });
  const gates = { ...openGates(), pausedAgents: [...AGENT_NAMES.filter((a) => a !== 'intake' && a !== 'supervisor'), 'system'] };
  const settings = t.ctx.repos.getAgentSettings(t.ctx.db);
  const aiOpen = settings.agents.enabled && !settings.autonomy.killSwitch;
  if (!aiOpen) Object.assign(gates.lanes.ai, { open: false, maxPriority: -1, reason: settings.autonomy.killSwitch ? 'kill_switch' : 'agents_off' });
  const all: Array<{ type: string; outcome: string }> = [];
  for (let i = 0; i < (opts.rounds ?? 300); i += 1) {
    const settled = await w.tick(t.ctx.now(), gates);
    if (!settled.length) {
      const pending = t.ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM agent_jobs WHERE status = 'queued' AND (type LIKE 'intake.%' OR type = 'claim.catch_up_apply') AND run_after > ?`).get(t.ctx.now()) as { n: number };
      if (!pending.n) break;
      t.setNow(new Date(Date.parse(t.ctx.now()) + 60_000).toISOString());
      continue;
    }
    all.push(...settled.map((x) => ({ type: x.type, outcome: x.outcome })));
  }
  await w.stop(100);
  return all;
}
