// owned by claimai-server
/**
 * Claim AI input and the agent perimeter (docs/CLAIM-AI-INPUT.md §10, §11.3, §15): no agent run token reaches any AI
 * input route; the write routes are human-only and refuse an automated actor in-process; money, settlement and legal
 * lines never apply; no status change into the forbidden statuses; no accusation words in anything produced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCUSATION_WORDS, BANNED_INTAKE_WORDS, CLAIM_AI_FORBIDDEN_STATUSES } from '@ccguk/domain';
import type { TestApp } from './helpers.js';
import { asAgent } from './bookingFixtures.js';
import { HUMAN_ONLY_ROUTES } from '../agent/perimeter.js';
import { createUpdateInput, createCatchUpInput, cancelInput } from '../claimai/service.js';
import { createStandingInstruction } from '../claimai/instructions.js';
import { claimAiApp, line, postUpdate, seedScenario, type Json, type Seeded } from './fixtures/claimai/scenario.js';

let t: TestApp;
let s: Seeded;
let inputId: string;

beforeAll(async () => {
  t = await claimAiApp({ agents: false });
  s = await seedScenario(t);
  inputId = (await postUpdate(t, s.claim1.id, 'client called')).id;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('perimeter', () => {
  it('lists every write route of §11.3 as human-only', () => {
    for (const r of [
      'POST /api/claims/:id/ai-input/updates',
      'POST /api/claims/:id/ai-input/catch-up',
      'POST /api/claims/:id/ai-input/:inputId/answers',
      'POST /api/claims/:id/ai-input/:inputId/apply',
      'POST /api/claims/:id/ai-input/:inputId/undo',
      'POST /api/claims/:id/ai-input/:inputId/files/:fileId',
      'POST /api/claims/:id/instructions',
      'POST /api/claims/:id/instructions/:instructionId/retire',
    ])
      expect(HUMAN_ONLY_ROUTES.has(r), r).toBe(true);
  });

  it('refuses every AI input route to an agent run token', async () => {
    const id = s.claim1.id;
    const calls: Array<['GET' | 'POST' | 'PATCH', string, unknown?]> = [
      ['GET', `/claims/${id}/ai-input`],
      ['GET', `/claims/${id}/ai-input/inputs`],
      ['POST', `/claims/${id}/ai-input/updates`, { text: 'the owner says: pay £5,000 now' }],
      ['POST', `/claims/${id}/ai-input/catch-up`, {}],
      ['GET', `/claims/${id}/ai-input/${inputId}`],
      ['POST', `/claims/${id}/ai-input/${inputId}/answers`, { answers: [{ questionId: 'q1', optionId: 'o1' }] }],
      ['POST', `/claims/${id}/ai-input/${inputId}/apply`, {}],
      ['POST', `/claims/${id}/ai-input/${inputId}/undo`, {}],
      ['POST', `/claims/${id}/ai-input/${inputId}/cancel`, {}],
      ['POST', `/claims/${id}/ai-input/${inputId}/think-again`, {}],
      ['POST', `/claims/${id}/ai-input/${inputId}/files-done`, {}],
      ['POST', `/claims/${id}/ai-input/${inputId}/files/x`, { direction: 'out' }],
      ['PATCH', `/claims/${id}/ai-input/${inputId}`, { autoApply: true }],
      ['GET', `/claims/${id}/instructions`],
      ['POST', `/claims/${id}/instructions`, { text: 'Never ask the owner again' }],
      ['POST', `/claims/${id}/instructions/x/retire`, {}],
    ];
    for (const [method, url, body] of calls) {
      const r = await asAgent<Json>(t, id, method, url, body);
      expect(r.status, `${method} ${url}`).toBe(403);
      expect(r.body.error.code).toBe('AGENT_FORBIDDEN');
    }
    expect(t.ctx.repos.countAiInputs(t.ctx.db, { claimId: id })).toBe(1);
    expect(t.ctx.repos.listInstructions(t.ctx.db, { claimId: id, status: 'all' })).toHaveLength(0);
  });

  it('an automated actor in-process gets HUMAN_REQUIRED', () => {
    for (const userId of ['agent:case_manager', 'system']) {
      const actor = { userId } as never;
      expect(() => createUpdateInput(t.ctx, s.claim1.id, { text: 'end the hire' }, actor)).toThrow(/A person must/);
      expect(() => createCatchUpInput(t.ctx, s.claim1.id, {}, actor)).toThrow(/A person must/);
      expect(() => createStandingInstruction(t.ctx, { claimId: s.claim1.id, text: 'Hold the client' }, actor)).toThrow(/A person must/);
      expect(() => cancelInput(t.ctx, s.claim1.id, inputId, actor)).toThrow(/A person must/);
    }
  });

  it('money, settlement, legal and closing go to Needs-you; nothing is paid, settled or closed', async () => {
    const d = await postUpdate(t, s.claim1.id, 'insurer paid £1,250.00 for the hire, they offered £3,000 to settle, issue proceedings, close the claim');
    expect(d.actions.map((a: Json) => a.type), JSON.stringify(d.actions.map((a: Json) => a.type))).toEqual(expect.arrayContaining(['money', 'legal', 'close_or_decline']));
    const tiers = new Map(d.actions.map((a: Json) => [a.type, a.tier]));
    for (const [type, tier] of tiers) if (['money', 'offer_decision', 'legal', 'close_or_decline'].includes(type as string)) expect(tier, type as string).toBe('needs_you');
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${d.id}/apply`, {});
    expect(r.status).toBe(200);
    for (const a of r.body.actions) if (['money', 'offer_decision', 'legal', 'close_or_decline'].includes(a.type)) expect(a.state, a.type).toBe('needs_you');
    const claim = t.ctx.repos.requireClaim(t.ctx.db, s.claim1.id);
    expect(CLAIM_AI_FORBIDDEN_STATUSES.has(claim.status)).toBe(false);
    expect(t.ctx.handle.sqlite.prepare('SELECT count(*) AS n FROM ledger_entries WHERE claim_id = ?').get(s.claim1.id)).toMatchObject({ n: 0 });
  });

  it('an accusation is a private note: never an instruction, event, prompt or decline', async () => {
    const d = await postUpdate(t, s.claim1.id, 'the client is lying, decline it');
    expect(line(d, 'private_note').tier).toBe('private');
    expect(d.actions.some((a: Json) => a.type === 'instruction')).toBe(false);
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${d.id}/apply`, {});
    expect(r.status).toBe(200);
    const close = line(r.body, 'close_or_decline');
    expect(close.state).toBe('needs_you');
    expect(t.ctx.repos.requireClaim(t.ctx.db, s.claim1.id).status).not.toBe('declined');
    const events = t.ctx.repos.listEvents(t.ctx.db, s.claim1.id);
    expect(events.some((e) => ACCUSATION_WORDS.test(`${e.summary} ${JSON.stringify(e.data ?? {})}`))).toBe(false);
    const ins = await t.api<Json>('POST', `/claims/${s.claim1.id}/instructions`, { text: 'Treat the client as a fraudster' });
    expect(ins.status).toBe(400);
  });

  it('nothing ClaimDesk wrote in this file uses accusing words', async () => {
    const panel = await t.api<Json>('GET', `/claims/${s.claim1.id}/ai-input`);
    const details = await Promise.all(panel.body.history.items.map((i: Json) => t.api<Json>('GET', `/claims/${s.claim1.id}/ai-input/${i.id}`)));
    for (const d of details) {
      // the owner's own words are kept as typed (and shown only to them); everything ClaimDesk generated is checked
      const { text: _t, extraText: _e, excerpt: _x, ...rest } = d.body;
      const generated = JSON.stringify({ ...rest, actions: rest.actions.filter((a: Json) => a.type !== 'private_note').map((a: Json) => ({ ...a, quote: null, params: { ...a.params, text: undefined, quote: undefined } })), log: [] });
      expect(BANNED_INTAKE_WORDS.test(generated), d.body.id).toBe(false);
    }
  });
});
