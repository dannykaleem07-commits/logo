// owned by claimai-server
/**
 * "Already sent" recognition (docs/CLAIM-AI-INPUT.md §9, §16.3): letters recorded from a catch-up stop the Autopilot
 * from sending them again, appear as virtual sent rows and in the Case Brief's prior letters, and count as the answer
 * to an inbound email in the case sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from './helpers.js';
import { uploadToBundle } from './fixtures/smartIntake/scenario.js';
import { claimAiApp, drainCatchUp, getInput, seedScenario, type Json, type Seeded } from './fixtures/claimai/scenario.js';
import { handlingRefRequest, ncafSent } from './fixtures/claimai/files.js';
import { eml, MAILBOX, run, setUpMail } from './fixtures/mail/helpers.js';
import { loadAutopilotFacts } from '../autopilot/facts.js';
import { buildCaseBrief } from '../casework/caseBrief.js';
import { sweepCandidates } from '../casework/agents.js';
import { INSURER_EMAIL } from './fixtures/claimai/scenario.js';

let t: TestApp;
let s: Seeded;
let mailbox: Awaited<ReturnType<typeof setUpMail>>['mailbox'];

beforeAll(async () => {
  t = await claimAiApp({ agents: false });
  ({ mailbox } = await setUpMail(t.ctx));
  s = await seedScenario(t);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('already sent outside ClaimDesk', () => {
  it('an inbound email of 8 October waits for an answer', async () => {
    mailbox.deliver(eml({ from: INSURER_EMAIL, subject: `Your client ${s.claim1.reference}`, body: 'Please send us your client details.', date: 'Thu, 08 Oct 2026 10:00:00 +0100' }), 'INBOX', new Date('2026-10-08T09:00:00.000Z'));
    await run(t.ctx, 'mail.sync', {});
    const msg = t.ctx.repos.listMailMessages(t.ctx.db, { claimId: s.claim1.id, direction: 'in' })[0];
    expect(msg).toBeTruthy();
    expect(sweepCandidates(t.ctx).find((c) => c.claimId === s.claim1.id)?.reasons).toContain('unanswered inbound email');
  });

  it('a catch-up records the NCAF (2 Oct) and the handling-reference request (9 Oct)', async () => {
    const c = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/catch-up`, { autoApply: true });
    expect(c.status).toBe(201);
    expect((await uploadToBundle(t, c.body.catchUp.bundleId, [await ncafSent(s.claim1.reference), handlingRefRequest(s.claim1.reference, MAILBOX)])).status).toBe(201);
    await t.api('POST', `/claims/${s.claim1.id}/ai-input/${c.body.id}/files-done`, {});
    await drainCatchUp(t);
    t.setNow('2026-10-12T09:30:00.000Z');
    const d = await getInput(t, s.claim1.id, c.body.id);
    expect(d.status).toBe('applied');
    const records = t.ctx.repos.listCorrespondence(t.ctx.db, s.claim1.id);
    expect(records.map((r) => r.kind).sort()).toEqual(['handling_ref_request', 'ncaf']);
  });

  it('virtual sent rows for the Autopilot; the plan counts the NCAF as done', async () => {
    const facts = loadAutopilotFacts(t.ctx, s.claim1.id);
    const virtual = facts.outbox.filter((o) => o.offSystem);
    expect(virtual.map((o) => o.kind)).toEqual(['handling_ref_request']); // the NCAF has no email kind: its event does the work
    expect(virtual[0]).toMatchObject({ status: 'sent', autopilotStepId: null });
    expect(virtual[0]!.id.startsWith('corr:')).toBe(true);
    const outboxBefore = t.ctx.repos.listOutbox(t.ctx.db, { claimId: s.claim1.id }).length;
    const r = await run(t.ctx, 'autopilot.tick', { claimId: s.claim1.id }, { claimId: s.claim1.id });
    expect(r.outcome.kind, JSON.stringify(r.outcome)).toBe('done');
    const outbox = t.ctx.repos.listOutbox(t.ctx.db, { claimId: s.claim1.id });
    expect(outbox.filter((o) => o.kind === 'handling_ref_request' || o.kind === 'ncaf_cover')).toHaveLength(0);
    expect(outbox.length).toBeGreaterThanOrEqual(outboxBefore);
    const docs = t.ctx.repos.listSentDocuments(t.ctx.db, s.claim1.id, true);
    expect(docs.filter((x) => x.templateId === 'letter.ncaf' || x.templateId === 'letter.handling_ref_request')).toHaveLength(0);
    const allDocs = t.ctx.handle.sqlite.prepare(`SELECT template_id FROM documents WHERE claim_id = ?`).all(s.claim1.id) as Array<{ template_id: string }>;
    expect(allDocs.filter((x) => x.template_id === 'letter.ncaf' || x.template_id === 'letter.handling_ref_request')).toHaveLength(0);
    const view = (await t.api<Json>('GET', `/claims/${s.claim1.id}/autopilot`)).body;
    const steps: Json[] = view.plan?.steps ?? view.steps ?? [];
    const ncaf = steps.find((x) => String(x.stepId ?? x.id) === 'notify.ncaf');
    expect(ncaf?.status).toBe('done');
  });

  it('the Case Brief lists them among the prior letters', () => {
    const brief = buildCaseBrief(t.ctx, s.claim1.id);
    const prior = brief.correspondence.priorLetters;
    expect(prior.some((p) => p.templateId === 'letter.ncaf' && p.sentAt.startsWith('2026-10-02'))).toBe(true);
    expect(prior.some((p) => p.templateId === 'letter.handling_ref_request' && p.sentAt.startsWith('2026-10-09'))).toBe(true);
  });

  it('the sweep counts the request of 9 October as the answer to the email of 8 October', () => {
    const c = sweepCandidates(t.ctx).find((x) => x.claimId === s.claim1.id);
    expect(c?.reasons ?? []).not.toContain('unanswered inbound email');
  });
});
