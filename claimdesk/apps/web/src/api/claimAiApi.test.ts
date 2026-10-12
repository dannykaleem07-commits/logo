// owned by claimai-web
/** AI input client (docs/CLAIM-AI-INPUT.md §11): paths, methods, bodies; polling by status; normalisers; fixture key paths. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimAiApi, inputPollMs, normaliseDetail, normalisePanel, panelPollMs, type AiInputStatus } from './claimAiApi';
import { mockApi } from '../screens/intake/bundles/__fixtures__/mockApi';
import {
  ACTION_KEYS,
  CATCH_UP_FILE_KEYS,
  CATCH_UP_VIEW_KEYS,
  catchUpDetail,
  DETAIL_KEYS,
  INSTRUCTION_KEYS,
  PANEL_KEYS,
  panelFixture,
  SUMMARY_KEYS,
  updateApplied,
  updatePreview,
} from '../screens/claim/ai/__fixtures__/fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('claimAiApi routes', () => {
  it('calls every route of §11.2 with the right method, path and body', async () => {
    const d = updatePreview();
    const api = mockApi({
      'GET /claims/:id/ai-input': () => panelFixture(),
      'GET /claims/:id/ai-input/inputs': () => ({ items: [], total: 0 }),
      'GET /claims/:id/ai-input/:inputId': () => d,
      'POST /claims/:id/ai-input/updates': () => ({ status: 201, body: d }),
      'POST /claims/:id/ai-input/catch-up': () => ({ status: 201, body: catchUpDetail() }),
      'POST /claims/:id/ai-input/:inputId/:action': () => d,
      'POST /claims/:id/ai-input/:inputId/files/:fileId': () => catchUpDetail(),
      'PATCH /claims/:id/ai-input/:inputId': () => catchUpDetail(),
      'GET /claims/:id/instructions': () => ({ items: panelFixture().instructions }),
      'POST /claims/:id/instructions': () => ({ status: 201, body: panelFixture().instructions[0] }),
      'POST /claims/:id/instructions/:instructionId/retire': () => panelFixture().instructions[0],
    });
    vi.stubGlobal('fetch', vi.fn(api.fetch));
    await claimAiApi.panel('c1');
    await claimAiApi.inputs('c1', { offset: 20, kind: 'update' });
    await claimAiApi.createUpdate('c1', { text: '  Client called, car repaired, hire ended yesterday  ', channel: 'typed' });
    await claimAiApi.createUpdate('c1', { text: '', channel: 'call_note', extraText: ' They said the car is ready. ' });
    await claimAiApi.get('c1', 'u1');
    await claimAiApi.answer('c1', 'u1', [{ questionId: 'q1', optionId: 'HA-0042' }]);
    await claimAiApi.apply('c1', 'u1', { actions: [{ key: 'a4', ticked: true, edits: { value: 'AB123' } }] });
    await claimAiApi.undo('c1', 'u1', { actionKeys: ['a3'] });
    await claimAiApi.cancel('c1', 'u1');
    await claimAiApi.thinkAgain('c1', 'u1');
    await claimAiApi.createCatchUp('c1', { note: '  ', autoApply: false });
    await claimAiApi.filesDone('c1', 'cu1');
    await claimAiApi.overrideFile('c1', 'cu1', 'f4', { direction: 'out', date: '2026-10-05' });
    await claimAiApi.setAutoApply('c1', 'cu1', false);
    await claimAiApi.instructions('c1', 'active');
    await claimAiApi.addInstruction('c1', { text: ' Ask me first ', appliesTo: ['mail'], until: null });
    await claimAiApi.retireInstruction('c1', 'ins-1', '  ');
    await claimAiApi.retireInstruction('c1', 'ins-1', 'Insurer replied');
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /claims/c1/ai-input',
      'GET /claims/c1/ai-input/inputs',
      'POST /claims/c1/ai-input/updates',
      'POST /claims/c1/ai-input/updates',
      'GET /claims/c1/ai-input/u1',
      'POST /claims/c1/ai-input/u1/answers',
      'POST /claims/c1/ai-input/u1/apply',
      'POST /claims/c1/ai-input/u1/undo',
      'POST /claims/c1/ai-input/u1/cancel',
      'POST /claims/c1/ai-input/u1/think-again',
      'POST /claims/c1/ai-input/catch-up',
      'POST /claims/c1/ai-input/cu1/files-done',
      'POST /claims/c1/ai-input/cu1/files/f4',
      'PATCH /claims/c1/ai-input/cu1',
      'GET /claims/c1/instructions',
      'POST /claims/c1/instructions',
      'POST /claims/c1/instructions/ins-1/retire',
      'POST /claims/c1/instructions/ins-1/retire',
    ]);
    const c = api.calls;
    expect(c[1]!.query).toEqual({ limit: '20', offset: '20', kind: 'update' });
    expect(c[2]!.body).toEqual({ text: 'Client called, car repaired, hire ended yesterday', channel: 'typed' });
    expect(c[3]!.body).toEqual({ text: '', channel: 'call_note', extraText: 'They said the car is ready.' });
    expect(c[5]!.body).toEqual({ answers: [{ questionId: 'q1', optionId: 'HA-0042' }] });
    expect(c[6]!.body).toEqual({ actions: [{ key: 'a4', ticked: true, edits: { value: 'AB123' } }] });
    expect(c[7]!.body).toEqual({ actionKeys: ['a3'] });
    expect(c[8]!.body).toEqual({});
    expect(c[10]!.body).toEqual({ autoApply: false });
    expect(c[12]!.body).toEqual({ direction: 'out', date: '2026-10-05' });
    expect(c[13]!.body).toEqual({ autoApply: false });
    expect(c[14]!.query).toEqual({ status: 'active' });
    expect(c[15]!.body).toEqual({ text: 'Ask me first', appliesTo: ['mail'], until: null });
    expect(c[16]!.body).toEqual({});
    expect(c[17]!.body).toEqual({ reason: 'Insurer replied' });
  });

  it('passes the server error envelope through (409 INPUT_BUSY)', async () => {
    const api = mockApi({ 'POST /claims/:id/ai-input/:inputId/apply': () => ({ status: 409, body: { error: { code: 'INPUT_BUSY', message: 'Already being applied' } } }) });
    vi.stubGlobal('fetch', vi.fn(api.fetch));
    await expect(claimAiApi.apply('c1', 'u1', {})).rejects.toMatchObject({ status: 409, code: 'INPUT_BUSY' });
  });
});

describe('polling rules (§11.2)', () => {
  it('2 s while interpreting or applying, 5 s while waiting for the AI or reading files, else none', () => {
    const expected: Record<AiInputStatus, number | false> = {
      interpreting: 2000,
      applying: 2000,
      waiting_ai: 5000,
      reading: 5000,
      clarify: false,
      preview: false,
      applied: false,
      partly_applied: false,
      nothing_to_do: false,
      cancelled: false,
      failed: false,
      undone: false,
    };
    for (const [s, ms] of Object.entries(expected)) expect(inputPollMs(s as AiInputStatus), s).toBe(ms);
    expect(inputPollMs(undefined)).toBe(false);
  });
  it('the panel polls at the fastest rate any open input needs', () => {
    const p = panelFixture();
    expect(panelPollMs(p)).toBe(false);
    p.open[1]!.status = 'reading';
    expect(panelPollMs(p)).toBe(5000);
    p.open[0]!.status = 'interpreting';
    expect(panelPollMs(p)).toBe(2000);
    expect(panelPollMs(undefined)).toBe(false);
  });
});

describe('normalisers', () => {
  it('keep a full answer as it is', () => {
    const d = updatePreview();
    expect(normaliseDetail(d)).toEqual(d);
    const c = catchUpDetail();
    expect(normaliseDetail(c)).toEqual(c);
    const p = panelFixture();
    expect(normalisePanel(p)).toEqual(p);
  });
  it('fill a partial answer so the screen never breaks', () => {
    const d = normaliseDetail({ id: 'u9', status: 'interpreting' });
    expect(d.actions).toEqual([]);
    expect(d.questions).toEqual([]);
    expect(d.counts.actions).toBe(0);
    expect(d.catchUp).toBeNull();
    const p = normalisePanel({ items: [] }, 'c9');
    expect(p.claim.id).toBe('c9');
    expect(p.ai.available).toBe(true);
    expect(p.badge).toEqual({ open: 0, instructions: 0 });
  });
});

describe('fixtures carry every key path of §11.1', () => {
  const has = (o: object, keys: readonly string[], what: string) => {
    for (const k of keys) expect(Object.prototype.hasOwnProperty.call(o, k), `${what}.${k}`).toBe(true);
  };
  it('update preview / applied, catch-up, panel', () => {
    for (const [name, d] of [
      ['updatePreview', updatePreview()],
      ['updateApplied', updateApplied()],
      ['catchUp', catchUpDetail()],
    ] as const) {
      has(d, DETAIL_KEYS, name);
      for (const a of d.actions) has(a, ACTION_KEYS, `${name}.actions[${a.key}]`);
    }
    const c = catchUpDetail().catchUp!;
    has(c, CATCH_UP_VIEW_KEYS, 'catchUp.catchUp');
    for (const f of c.files) has(f, CATCH_UP_FILE_KEYS, `catchUp.files[${f.fileId}]`);
    const p = panelFixture();
    has(p, PANEL_KEYS, 'panel');
    for (const s of [...p.open, ...p.history.items]) has(s, SUMMARY_KEYS, `panel summary ${s.id}`);
    for (const i of p.instructions) has(i, INSTRUCTION_KEYS, `panel instruction ${i.id}`);
    expect(updateApplied().whatChanged).toMatchObject({ lines: expect.any(Array), clocks: expect.any(Array), autopilot: expect.any(Object) });
  });
});
