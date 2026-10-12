// owned by claimai-server
/**
 * Standing case instructions (docs/CLAIM-AI-INPUT.md §7, §16.3): the prompt block in every claim-scoped run (and only
 * there), the Autopilot plan waiting on a hold, ask-before-sending, the outbox rule `owner_instruction`, the case
 * manager's drafter hand-off turned into a task, retiring, and accusation words refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentInput } from '../agent/contracts.js';
import type { TestApp } from './helpers.js';
import { assemblePrompts } from '../ai/prompts.js';
import { CASE_REVIEW_SPEC, DRAFTER_SPEC } from '../casework/specs.js';
import { MAIL_REPLY_SPEC } from '../agent/handlers/mail.js';
import { AUTOPILOT_JUDGE_SPEC } from '../autopilot/judge.js';
import { CLAIM_INPUT_SPEC } from '../claimai/interpret.js';
import { createEmailDraft, afterReview } from '../mail/outbox.js';
import { ALREADY_DONE_HEADER, INSTRUCTIONS_HEADER } from '../claimai/promptBlock.js';
import { CLIENT, claimAiApp, seedScenario, type Json, type Seeded } from './fixtures/claimai/scenario.js';
import { run, setUpMail, TOUCHES_NONE } from './fixtures/mail/helpers.js';

let t: TestApp;
let s: Seeded;
let holdId: string;

const input = (claimId: string): AgentInput => ({ task: 'Test task', brief: { claimId }, question: 'Return JSON.' });
const plan = async (): Promise<Json> => (await t.api<Json>('GET', `/claims/${s.claim1.id}/autopilot`)).body;
const stepsOf = (p: Json): Json[] => p.plan?.steps ?? p.steps ?? [];

beforeAll(async () => {
  t = await claimAiApp({ agents: true });
  await setUpMail(t.ctx);
  s = await seedScenario(t);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('standing instructions', () => {
  it('the owner adds a hold on the client until Monday (audited as the owner, end job queued)', async () => {
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/instructions`, { text: "Don't contact the client until Monday — call 07700 900456 first", until: '2026-10-18T23:00:00.000Z', effect: { kind: 'hold_contact', contacts: ['client'] } });
    expect(r.status).toBe(201);
    holdId = r.body.id;
    expect(r.body.status).toBe('active');
    expect(r.body.appliesTo).toEqual(['all']);
    expect(r.body.effectLabel).toBeTruthy();
    const due = t.ctx.handle.sqlite.prepare(`SELECT idempotency_key FROM agent_jobs WHERE type = 'claim.instruction_due'`).all() as Array<{ idempotency_key: string }>;
    expect(due.map((d) => d.idempotency_key)).toContain(`claim.instruction_due:${holdId}:2026-10-18T23:00:00.000Z`);
  });

  it('every claim-scoped run carries the block (masked); an unscoped run does not; the system prefix is unchanged', () => {
    for (const spec of [CASE_REVIEW_SPEC, DRAFTER_SPEC, MAIL_REPLY_SPEC, AUTOPILOT_JUDGE_SPEC, CLAIM_INPUT_SPEC]) {
      const scoped = assemblePrompts(spec, input(s.claim1.id), t.ctx, { claimId: s.claim1.id });
      expect(scoped.user, spec.jobType).toContain(INSTRUCTIONS_HEADER);
      expect(scoped.user).toContain("Don't contact the client until Monday");
      expect(scoped.user).not.toContain('07700 900456');
      const bare = assemblePrompts(spec, input(s.claim1.id), t.ctx, { claimId: null });
      expect(bare.user).not.toContain(INSTRUCTIONS_HEADER);
      expect(scoped.system).toEqual(bare.system);
      expect(scoped.promptVersion).toBe(bare.promptVersion);
    }
    const other = assemblePrompts(CASE_REVIEW_SPEC, input(s.claim2.id), t.ctx, { claimId: s.claim2.id });
    expect(other.user).not.toContain(INSTRUCTIONS_HEADER);
    expect(other.user).not.toContain(ALREADY_DONE_HEADER);
  });

  it('the Autopilot waits on steps to the client and carries on with the insurer', async () => {
    await t.api('POST', `/claims/${s.claim1.id}/autopilot/evaluate`, {});
    const p = await plan();
    const steps = stepsOf(p);
    expect(steps.length).toBeGreaterThan(0);
    const held = steps.filter((x: Json) => x.blockedBy?.kind === 'instruction' || (x.blockedBy ?? []).some?.((b: Json) => b.kind === 'instruction'));
    const json = JSON.stringify(p);
    expect(json).toContain("you asked 'Don't contact the client until Monday");
    expect(held.length, JSON.stringify(steps.map((x: Json) => [x.stepId ?? x.id, x.status, x.blockedBy]))).toBeGreaterThan(0);
    for (const h of held) expect(h.status).toBe('waiting');
    // insurer steps are not held by a client hold
    expect(held.every((h: Json) => !/insurer|ncaf|handling/i.test(String(h.stepId ?? h.id)))).toBe(true);
  });

  it('an email drafted to the client asks the owner with rule owner_instruction', async () => {
    const d = createEmailDraft(t.ctx, { claimId: s.claim1.id, kind: 'ack', to: [CLIENT.email], cc: [], subject: 'We have your claim', bodyText: 'Dear Jane,\n\nWe have your claim and will be in touch.\n\nClaims Team', attach: [], inReplyToMessageId: null } as never, 'agent:mail', { loop: 0 });
    const review = t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'outbox', targetId: d.outbox.id, claimId: s.claim1.id, loop: 0, rules: { issues: [] }, facts: { issues: [] }, critic: { confidence: 0.97, issues: [] }, verdict: 'pass', touches: TOUCHES_NONE, now: t.ctx.now() });
    const r = await afterReview(t.ctx, d.outbox.id, review.id, { id: 'test-job', correlationId: null } as never);
    expect(r.outcome).toBe('asked');
    const o = t.ctx.repos.requireOutbox(t.ctx.db, d.outbox.id);
    expect(JSON.stringify(o.policy)).toContain('owner_instruction');
    const card = t.ctx.repos.getNeedsYouItem(t.ctx.db, r.needsYouId!);
    expect(JSON.stringify(card)).toMatch(/You asked/);
  });

  it('a case-review hand-off to write to the client becomes a task due when the hold ends', async () => {
    const r = await run(t.ctx, 'case.review', { claimId: s.claim1.id, reason: 'owner', marker: 'CI-HELD-HANDOFF' }, { claimId: s.claim1.id });
    expect(r.outcome.kind, JSON.stringify(r.outcome)).toBe('done');
    const tasks = t.ctx.repos.listTasks(t.ctx.db, { claimId: s.claim1.id, status: 'open', limit: 50 });
    const held = tasks.find((x) => x.title.startsWith('Held:'));
    expect(held).toBeTruthy();
    expect(held!.dueAt).toBe('2026-10-18T23:00:00.000Z');
    const drafts = r.followUps.filter((f) => f.type === 'draft.compose');
    expect(drafts).toHaveLength(1); // the insurer chaser goes ahead
  });

  it('ask before sending raises the Autopilot step to confirm', async () => {
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/instructions`, { text: 'Ask me before anything goes to the insurer', effect: { kind: 'ask_before_sending', contacts: ['at_fault_insurer'] }, appliesTo: ['autopilot'] });
    expect(r.status).toBe(201);
    await t.api('POST', `/claims/${s.claim1.id}/autopilot/evaluate`, {});
    const p = await plan();
    const steps = stepsOf(p);
    const confirm = steps.filter((x: Json) => x.mode === 'confirm' || x.effectiveMode === 'confirm');
    expect(confirm.length).toBeGreaterThan(0);
    await t.api('POST', `/claims/${s.claim1.id}/instructions/${r.body.id}/retire`, {});
  });

  it('retiring the hold: the plan no longer waits on it', async () => {
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/instructions/${holdId}/retire`, { reason: 'Spoke to the client' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('retired');
    expect(r.body.retiredReason).toBe('Spoke to the client');
    await t.api('POST', `/claims/${s.claim1.id}/autopilot/evaluate`, {});
    expect(JSON.stringify(await plan())).not.toContain("you asked 'Don't contact the client until Monday");
    const again = await t.api<Json>('POST', `/claims/${s.claim1.id}/instructions/${holdId}/retire`, {});
    expect(again.status).toBe(409);
    const all = await t.api<Json>('GET', `/claims/${s.claim1.id}/instructions`);
    expect(all.body.items.find((i: Json) => i.id === holdId).status).toBe('retired');
  });

  it('accusation words are refused; bad bodies are 400', async () => {
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/instructions`, { text: 'The client is lying, treat everything as fraud' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('ACCUSATION_NOT_ALLOWED');
    expect((await t.api('POST', `/claims/${s.claim1.id}/instructions`, { text: 'no' })).status).toBe(400);
    expect((await t.api('POST', `/claims/${s.claim1.id}/instructions`, { text: 'Hold the client', appliesTo: ['robots'] })).status).toBe(400);
  });
});
