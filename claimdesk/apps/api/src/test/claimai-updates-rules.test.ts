// owned by claimai-server
/**
 * AI input — updates the phrase parser understands on its own (docs/CLAIM-AI-INPUT.md §16.3), agents off: preview,
 * Do it through the owner's routes, What changed, Undo, standing instructions, a timed pause ended by the supervisor,
 * and a reminder task.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from './helpers.js';
import { audits, claimAiApp, getInput, jobRows, line, postUpdate, seedScenario, type Json, type Seeded } from './fixtures/claimai/scenario.js';
import { drain } from './fixtures/mail/helpers.js';

let t: TestApp;
let s: Seeded;

beforeAll(async () => {
  t = await claimAiApp({ agents: false });
  s = await seedScenario(t);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('AI input — rules-only updates (agents off)', () => {
  let first: Json;

  it('previews "client called, car repaired, hire ended yesterday" with three lines from the rules', async () => {
    first = await postUpdate(t, s.claim1.id, 'client called, car repaired, hire ended yesterday');
    expect(first.status).toBe('preview');
    expect(first.engine).toBe('rules');
    expect(first.kind).toBe('update');
    const types = first.actions.map((a: Json) => `${a.type}:${a.params.eventType ?? ''}`);
    expect(types).toEqual(expect.arrayContaining(['event:call', 'event:repair_completed', 'hire_end:']));
    expect(first.actions).toHaveLength(3);
    const call = first.actions.find((a: Json) => a.params.eventType === 'call');
    expect(call.at.slice(0, 10)).toBe('2026-10-12');
    expect(call.tier).toBe('apply');
    const repaired = first.actions.find((a: Json) => a.params.eventType === 'repair_completed');
    expect(repaired.at.slice(0, 10)).toBe('2026-10-11');
    const end = line(first, 'hire_end');
    expect(end.params.agreementNumber).toBe('HA-0042');
    expect(end.params.endAt.slice(0, 10)).toBe('2026-10-11');
    expect(end.params.endTrigger).toBe('repair_complete_24h');
    expect(first.canApply).toBe(true);
    expect(first.questions).toEqual([]);
    // the owner's input is audited with its length only
    const created = audits(t.ctx, 'claim_ai.input.create').find((a) => a.entity_id === first.id);
    expect(created?.user_id).not.toMatch(/^agent:/);
    expect(JSON.stringify(created?.after)).not.toContain('car repaired');
  });

  it('Do it writes the events and ends the hire through the routes, then shows What changed', async () => {
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${first.id}/apply`, {});
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.status).toBe('applied');
    expect(d.actions.every((a: Json) => a.state === 'applied')).toBe(true);
    const events = t.ctx.repos.listEvents(t.ctx.db, s.claim1.id);
    const call = events.find((e) => e.type === 'call');
    expect(call).toBeTruthy();
    expect((call!.data as Json)?.source).toBe('ai_input');
    expect(events.some((e) => e.type === 'repair_completed' && e.at.slice(0, 10) === '2026-10-11')).toBe(true);
    const hire = t.ctx.repos.requireHire(t.ctx.db, s.hire.id);
    expect(hire.endAt?.slice(0, 10)).toBe('2026-10-11');
    expect(events.some((e) => e.type === 'hire_ended')).toBe(true);
    // each line audited as the owner
    const lines = audits(t.ctx, 'claim_ai.action.event').filter((a) => (a.after as Json)?.inputId === first.id);
    expect(lines.length).toBe(2);
    expect(lines.every((a) => !a.user_id.startsWith('agent:'))).toBe(true);
    // agents re-plan
    expect(jobRows(t.ctx, 'case.review').some((j) => j.claim_id === s.claim1.id)).toBe(true);
    expect(jobRows(t.ctx, 'autopilot.tick').some((j) => j.claim_id === s.claim1.id)).toBe(true);
    // What changed
    expect(d.whatChanged).toBeTruthy();
    expect(d.whatChanged.lines.length).toBeGreaterThanOrEqual(3);
    expect(d.whatChanged.lines.map((l: Json) => l.kind)).toEqual(expect.arrayContaining(['event', 'hire']));
    expect(d.canUndo).toBe(true);
    // applying twice is refused
    const again = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${first.id}/apply`, {});
    expect(again.status).toBe(409);
  });

  it('Undo re-opens the hire; a repair-completed line says to correct it in Chronology', async () => {
    const end = line(first, 'hire_end');
    const u = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${first.id}/undo`, { actionKeys: [end.key] });
    expect(u.status).toBe(200);
    expect(t.ctx.repos.requireHire(t.ctx.db, s.hire.id).endAt ?? null).toBeNull();
    expect(line(u.body, 'hire_end').state).toBe('undone');
    const repaired = u.body.actions.find((a: Json) => a.params.eventType === 'repair_completed');
    expect(repaired.undo.available).toBe(false);
    expect(String(repaired.undo.why)).toMatch(/Chronology/i);
    expect(u.body.status).toBe('applied'); // undone only when every applied line is undone (§6.3)
    // What changed follows the undo: the hire line now reads "Undone: …", the others stay as applied
    const texts = u.body.whatChanged.lines.map((l: Json) => l.text);
    expect(texts.some((x: string) => /^Undone: End hire/.test(x))).toBe(true);
    expect(texts.some((x: string) => /^End hire/.test(x))).toBe(false);
    expect(texts.some((x: string) => /Repair completed/.test(x) && !/^Undone/.test(x))).toBe(true);
  });

  it('"don\'t chase the client until Monday" becomes a standing instruction until Monday 19 October', async () => {
    const d = await postUpdate(t, s.claim1.id, "don't chase the client until Monday");
    expect(d.status).toBe('preview');
    const ins = line(d, 'instruction');
    expect(ins.tier).toBe('apply');
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${d.id}/apply`, {});
    expect(r.status).toBe(200);
    const list = await t.api<Json>('GET', `/claims/${s.claim1.id}/instructions?status=active`);
    const made = list.body.items.find((i: Json) => i.source?.inputId === d.id);
    expect(made).toBeTruthy();
    expect(made.until).toBe('2026-10-18T23:00:00.000Z');
    expect(made.effect.kind).toBe('hold_contact');
    expect(made.effect.contacts).toContain('client');
    expect(made.createdBy).not.toMatch(/^agent:/);
  });

  it('"pause this claim until Friday" pauses the agents and the supervisor resumes them on Friday', async () => {
    const d = await postUpdate(t, s.claim1.id, 'pause this claim until Friday');
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${d.id}/apply`, {});
    expect(r.status).toBe(200);
    expect(r.body.actions.filter((a: Json) => a.state === 'applied').length).toBeGreaterThanOrEqual(1);
    expect(t.ctx.repos.listPausedClaims(t.ctx.db)).toContain(s.claim1.id);
    const due = jobRows(t.ctx, 'claim.instruction_due').filter((j) => j.payload.claimId === s.claim1.id && String(j.payload.until).startsWith('2026-10-15T23'));
    expect(due.length).toBe(1);
    // Friday comes
    t.setNow('2026-10-16T08:00:00.000Z');
    const ran = await drain(t.ctx, 'claim.instruction_due');
    expect(ran.some((x) => x.outcome.kind === 'done')).toBe(true);
    const ended = audits(t.ctx, 'claim_ai.instruction.due');
    expect(ended.length).toBeGreaterThanOrEqual(1);
    expect(ended.every((a) => a.user_id === 'agent:supervisor')).toBe(true);
    expect(t.ctx.repos.listPausedClaims(t.ctx.db)).not.toContain(s.claim1.id);
    t.setNow('2026-10-12T09:00:00.000Z');
  });

  it('"remind me to call the insurer tomorrow" makes a task for 13 October at 09:00', async () => {
    const d = await postUpdate(t, s.claim1.id, 'remind me to call the insurer tomorrow');
    const task = line(d, 'task');
    expect(task.params.dueAt).toBe('2026-10-13T08:00:00.000Z');
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${d.id}/apply`, {});
    expect(r.status).toBe(200);
    const id = line(r.body, 'task').result.refs.taskId;
    expect(t.ctx.repos.getTask(t.ctx.db, id)?.dueAt).toBe('2026-10-13T08:00:00.000Z');
  });

  it('the panel lists the open and past inputs and the instructions', async () => {
    const p = await t.api<Json>('GET', `/claims/${s.claim1.id}/ai-input`);
    expect(p.status).toBe(200);
    expect(p.body.claim.reference).toBe(s.claim1.reference);
    expect(p.body.history.total).toBeGreaterThanOrEqual(4);
    expect(p.body.instructions.length).toBeGreaterThanOrEqual(1);
    expect(p.body.ai.available).toBe(false);
    const page = await t.api<Json>('GET', `/claims/${s.claim1.id}/ai-input/inputs?limit=2&kind=update`);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBeGreaterThanOrEqual(4);
  });

  it('every JSON shape carries exactly the keys of the contract (§11.1)', async () => {
    const keys = (o: Json) => Object.keys(o).sort();
    const summary = ['id', 'claimId', 'kind', 'channel', 'status', 'statusLabel', 'excerpt', 'createdAt', 'createdBy', 'createdByName', 'appliedAt', 'engine', 'counts', 'headline', 'waiting', 'bundle'];
    const p = (await t.api<Json>('GET', `/claims/${s.claim1.id}/ai-input`)).body;
    expect(keys(p)).toEqual(['ai', 'badge', 'claim', 'history', 'instructions', 'open'].sort());
    expect(keys(p.history.items[0])).toEqual([...summary].sort());
    expect(keys(p.history.items[0].counts)).toEqual(['actions', 'applied', 'waitingTick', 'needsYou', 'undone', 'failed', 'questions'].sort());
    expect(keys(p.instructions[0])).toEqual(['id', 'claimId', 'text', 'appliesTo', 'appliesToLabel', 'effect', 'effectLabel', 'activeFrom', 'until', 'status', 'createdBy', 'createdByName', 'createdAt', 'source', 'retiredBy', 'retiredAt', 'retiredReason'].sort());
    const d = await getInput(t, s.claim1.id, first.id);
    expect(keys(d)).toEqual([...summary, 'text', 'extraText', 'understood', 'actions', 'questions', 'notDone', 'pendingText', 'warnings', 'catchUp', 'whatChanged', 'log', 'canApply', 'canUndo', 'canCancel', 'canThinkAgain', 'revision'].sort());
    expect(keys(d.actions[0])).toEqual(['key', 'type', 'tier', 'tierLabel', 'ticked', 'tickable', 'title', 'detail', 'why', 'at', 'precision', 'quote', 'source', 'from', 'confidence', 'current', 'params', 'editable', 'undo', 'state', 'result', 'link', 'bundleFileId'].sort());
    expect(keys(d.actions[0].result)).toEqual(['refs', 'message', 'error', 'at'].sort());
    expect(keys(d.whatChanged)).toEqual(['lines', 'clocks', 'autopilot'].sort());
    expect(keys(d.log[0])).toEqual(['seq', 'at', 'kind', 'actionKey', 'actor', 'actorName', 'note'].sort());
  });

  it('validates the body and refuses a closed claim', async () => {
    const empty = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/updates`, { text: '   ' });
    expect(empty.status).toBe(400);
    const long = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/updates`, { text: 'x'.repeat(8001) });
    expect(long.status).toBe(400);
    t.ctx.handle.sqlite.prepare(`UPDATE claims SET status = 'closed' WHERE id = ?`).run(s.claim2.id);
    const closed = await t.api<Json>('POST', `/claims/${s.claim2.id}/ai-input/updates`, { text: 'client called' });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('CLAIM_CLOSED');
  });

  it('"TP insurer admitted liability today ref AB123" is read whole by the rules with the AI paused: note + reference + liability tick', async () => {
    const d = await postUpdate(t, s.claim1.id, 'TP insurer admitted liability today ref AB123');
    expect(d.status).toBe('preview');
    expect(d.engine).toBe('rules');
    expect(d.pendingText).toEqual([]);
    expect(jobRows(t.ctx, 'claim.input_interpret').filter((j) => j.payload.inputId === d.id)).toHaveLength(0);
    const ref = line(d, 'field_update');
    expect(ref.params).toMatchObject({ target: 'claim.atFaultInsurerRef', value: 'AB123' });
    expect(line(d, 'liability_position')).toMatchObject({ tier: 'confirm', ticked: false });
    expect(d.actions.find((a: Json) => a.type === 'note').at.slice(0, 10)).toBe('2026-10-12');
    const r = await t.api<Json>('POST', `/claims/${s.claim1.id}/ai-input/${d.id}/apply`, { actions: [{ key: ref.key, ticked: true }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(t.ctx.repos.requireClaim(t.ctx.db, s.claim1.id).atFaultInsurerRef).toBe('AB123');
    expect(t.ctx.repos.listEvents(t.ctx.db, s.claim1.id).some((e) => e.type === 'note' && /admitted liability/.test(e.summary ?? ''))).toBe(true);
  });
});

export { getInput };
