// @vitest-environment jsdom
// owned by claimai-web
/**
 * The AI input tab against a mocked API (docs/CLAIM-AI-INPUT.md §14.2, §16.6): the preview renders by tier, confirm lines
 * are unticked, Do it posts the ticks and edits, a question answer posts, undo posts, catch-up rows post the owner's
 * direction, instructions can be removed, history pages. No network is ever used.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/harness';
import { mockApi, type Handler } from '../../intake/bundles/__fixtures__/mockApi';
import { resetUploadQueues, uploadQueueFor } from '../../intake/bundles/uploadQueue';
import { bundlesApi } from '../../../api/bundlesApi';
import { DEFAULT_LIMITS } from '../../../api/uploads';
import type { AiInputDetail, AiInputPanel } from '../../../api/claimAiApi';
import type { ClaimView } from '../claimFile';
import { AiInputTab } from './AiInputTab';
import { catchUpDetail, panelFixture, updateApplied, updatePreview } from './__fixtures__/fixtures';

const view = { claim: { id: 'c1', reference: 'CCG-2026-00001', status: 'hire_active' } } as unknown as ClaimView;

function setup(opts: { panel?: AiInputPanel; u1?: () => AiInputDetail; cu1?: () => AiInputDetail; extra?: Record<string, Handler>; history?: Handler } = {}) {
  const panel = opts.panel ?? panelFixture();
  const api = mockApi({
    'GET /claims/:id/ai-input': () => panel,
    'GET /claims/:id/ai-input/inputs': opts.history ?? (() => panel.history),
    ...(opts.extra ?? {}),
    'GET /claims/:id/ai-input/u1': () => (opts.u1 ?? updatePreview)(),
    'GET /claims/:id/ai-input/cu1': () => (opts.cu1 ?? catchUpDetail)(),
    'GET /intake/bundles/:id/progress': () => ({ bundle: { readiness: 'needs_review', status: 'needs_you', revision: 1, computedRevision: 1 }, files: [] }),
  });
  vi.stubGlobal('fetch', vi.fn(api.fetch));
  const r = renderWithProviders(<AiInputTab view={view} />, { route: '/claims/c1/ai' });
  return { ...r, api };
}

const line = (key: string) => document.querySelector(`[data-key="${key}"]`) as HTMLElement;
const bodyOf = (api: ReturnType<typeof mockApi>, method: string, path: string) => api.find(method, path).map((c) => c.body);

beforeEach(() => {
  resetUploadQueues();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => vi.unstubAllGlobals());

describe('AI input tab — update preview', () => {
  it('renders "I understood", the lines grouped by tier, confirm lines unticked and the Do-it count', async () => {
    setup();
    expect(await screen.findByText(/^I understood: The insurer admitted liability/)).toBeTruthy();
    const preview = screen.getByText(/^I understood/).closest('section')!;
    for (const t of ['Will do', 'Needs your tick', 'Goes to Needs-you', 'Private note', "Won't do"]) expect(within(preview).getByRole('region', { name: t })).toBeTruthy();
    expect((within(line('a4')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((within(line('a5')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((within(line('a1')).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(within(line('a9')).queryByRole('checkbox')).toBeNull();
    expect(within(line('a4')).getByText('TPI/778812')).toBeTruthy();
    expect(within(line('a4')).getByText('“ref AB123”')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Do it (6)' })).toBeTruthy();
    expect(within(preview).getByText(/keep the client posted/)).toBeTruthy();
  });

  it('Do it posts the ticked keys and the edits, then shows What changed', async () => {
    const { user, api } = setup({ extra: { 'POST /claims/:id/ai-input/u1/apply': () => updateApplied() } });
    await screen.findByText(/^I understood/);
    await user.click(within(line('a5')).getByRole('checkbox'));
    await user.click(within(line('a2')).getByRole('checkbox'));
    await user.click(within(line('a3')).getByRole('button', { name: 'Change' }));
    fireEvent.change(within(line('a3')).getByLabelText('Date it happened'), { target: { value: '2026-10-10' } });
    await user.click(screen.getByRole('button', { name: 'Do it (6)' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/u1/apply')).toHaveLength(1));
    const body = bodyOf(api, 'POST', '/claims/c1/ai-input/u1/apply')[0] as { actions: Array<{ key: string; ticked: boolean; edits?: unknown }> };
    const by = Object.fromEntries(body.actions.map((a) => [a.key, a]));
    expect(by.a5).toEqual({ key: 'a5', ticked: true });
    expect(by.a2).toEqual({ key: 'a2', ticked: false });
    expect(by.a4).toEqual({ key: 'a4', ticked: false });
    expect(by.a3).toEqual({ key: 'a3', ticked: true, edits: { at: '2026-10-10T12:00:00.000Z' } });
    expect(by.a9).toBeUndefined();
    expect(await screen.findByText('What changed')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Hire HA-0042 ended/ }).getAttribute('href')).toBe('/claims/c1/hire');
    expect(screen.getByText('Handling reference (GTA 4.2)')).toBeTruthy();
    expect(screen.getByText('Tell the insurer the hire ended')).toBeTruthy();
  });

  it('What changed stays on screen after Do it although the input leaves the open list', async () => {
    let applied = false;
    const panel = panelFixture();
    const api = mockApi({
      'GET /claims/:id/ai-input': () => (applied ? { ...panel, open: panel.open.filter((o) => o.id !== 'u1') } : panel),
      'GET /claims/:id/ai-input/inputs': () => panel.history,
      'POST /claims/:id/ai-input/u1/apply': () => ((applied = true), updateApplied()),
      'GET /claims/:id/ai-input/u1': () => (applied ? updateApplied() : updatePreview()),
      'GET /claims/:id/ai-input/cu1': () => catchUpDetail(),
    });
    vi.stubGlobal('fetch', vi.fn(api.fetch));
    const { user } = renderWithProviders(<AiInputTab view={view} />, { route: '/claims/c1/ai' });
    await screen.findByText(/^I understood/);
    await user.click(screen.getByRole('button', { name: 'Do it (6)' }));
    expect(await screen.findByRole('heading', { name: 'What changed' })).toBeTruthy();
    await waitFor(() => expect(api.find('GET', '/claims/c1/ai-input').length).toBeGreaterThan(1));
    expect(screen.getByRole('heading', { name: 'What changed' })).toBeTruthy();
  });

  it('a VALIDATION refusal lands on its line', async () => {
    const { user } = setup({ extra: { 'POST /claims/:id/ai-input/u1/apply': () => ({ status: 400, body: { error: { code: 'VALIDATION', message: 'Invalid', details: { key: 'a3', message: 'The hire cannot end before it started' } } } }) } });
    await screen.findByText(/^I understood/);
    await user.click(screen.getByRole('button', { name: 'Do it (6)' }));
    expect(await within(line('a3')).findByText('The hire cannot end before it started')).toBeTruthy();
  });

  it('asks a clarifying question and posts the answer', async () => {
    const clarify = () => {
      const d = updatePreview();
      d.status = 'clarify';
      d.questions = [{ id: 'q1', text: 'Which hire ended?', options: [{ id: 'HA-0042', label: 'HA-0042' }, { id: 'HA-0043', label: 'HA-0043' }], allowText: false, allowDate: true, about: 'a3', answer: null }];
      return d;
    };
    const { user, api } = setup({ u1: clarify, extra: { 'POST /claims/:id/ai-input/u1/answers': () => updatePreview() } });
    expect(await screen.findByText('Which hire ended?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'HA-0043' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/u1/answers')).toHaveLength(1));
    expect(bodyOf(api, 'POST', '/claims/c1/ai-input/u1/answers')[0]).toEqual({ answers: [{ questionId: 'q1', optionId: 'HA-0043' }] });
  });

  it('cancel posts and closes the preview', async () => {
    const cancelled = () => ({ ...updatePreview(), status: 'cancelled' as const, canApply: false, canCancel: false });
    const { user, api } = setup({ extra: { 'POST /claims/:id/ai-input/u1/cancel': cancelled } });
    const preview = (await screen.findByText(/^I understood/)).closest('section')!;
    await user.click(within(preview).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/u1/cancel')).toHaveLength(1));
    expect(await screen.findByText('Cancelled — nothing was changed')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/^I understood/)).toBeNull());
  });

  it('Read it posts the owner text (and the call note as facts) and shows the new input', async () => {
    const created = () => ({ ...updatePreview(), id: 'u2', understood: 'The client called.' });
    const panel = panelFixture();
    panel.open = [];
    const { user, api } = setup({ panel, extra: { 'POST /claims/:id/ai-input/updates': () => ({ status: 201, body: created() }), 'GET /claims/:id/ai-input/u2': created } });
    const box = (await screen.findByLabelText('What happened, or what should ClaimDesk do?')) as HTMLTextAreaElement;
    await user.type(box, 'Client called, car repaired');
    await user.click(screen.getByRole('button', { name: 'Paste a call note or voice-note transcript' }));
    await user.click(screen.getByRole('button', { name: 'Voice-note transcript' }));
    await user.type(screen.getByLabelText('Voice-note transcript'), 'Garage says ready');
    await user.click(screen.getByRole('button', { name: 'Read it' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/updates')).toHaveLength(1));
    expect(bodyOf(api, 'POST', '/claims/c1/ai-input/updates')[0]).toEqual({ text: 'Client called, car repaired', channel: 'voice_note', extraText: 'Garage says ready' });
    expect(await screen.findByText('I understood: The client called.')).toBeTruthy();
    // the draft is kept until Do it succeeds
    expect(window.localStorage.getItem('claimdesk.aiInput.draft.c1')).toContain('Client called');
  });

  it('shows the agents-paused banner when the AI is not available', async () => {
    const panel = panelFixture();
    panel.ai = { available: false, waiting: { reason: 'agents_off' } };
    setup({ panel });
    expect(await screen.findByText(/Agents are paused — simple updates still work; the rest waits for the AI\./)).toBeTruthy();
  });
});

describe('AI input tab — what changed and undo', () => {
  it('undo one line, undo all (with a confirm), try again on a failed line', async () => {
    const { user, api } = setup({
      u1: updateApplied,
      extra: { 'POST /claims/:id/ai-input/u1/undo': () => updateApplied(), 'POST /claims/:id/ai-input/u1/apply': () => updateApplied() },
    });
    expect(await screen.findByText('What changed')).toBeTruthy();
    await user.click(within(line('a3')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/u1/undo')).toHaveLength(1));
    expect(bodyOf(api, 'POST', '/claims/c1/ai-input/u1/undo')[0]).toEqual({ actionKeys: ['a3'] });
    // repair_completed cannot be undone here: the line says why and has no Undo button
    expect(within(line('a2')).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(within(line('a2')).getByText(/correct it in Chronology/)).toBeTruthy();
    await user.click(within(line('a6')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/u1/apply')).toHaveLength(1));
    expect(bodyOf(api, 'POST', '/claims/c1/ai-input/u1/apply')[0]).toEqual({ actions: [{ key: 'a6', ticked: true }] });
    await user.click(screen.getByRole('button', { name: 'Undo all' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Undo all/ }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/u1/undo')).toHaveLength(2));
    expect(bodyOf(api, 'POST', '/claims/c1/ai-input/u1/undo')[1]).toEqual({});
  });

  it('a partial apply leaves the unticked lines to tick later', async () => {
    const partly = () => ({ ...updateApplied(), status: 'partly_applied' as const, canApply: true });
    setup({ u1: partly });
    expect(await screen.findByText('Still waiting for you')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Do these' })).toBeTruthy();
  });
});

describe('AI input tab — catch-up', () => {
  it('lists the files with who sent it, the real date and badges; the direction select posts an override', async () => {
    const { user, api } = setup({ extra: { 'POST /claims/:id/ai-input/cu1/files/:fileId': () => catchUpDetail() } });
    const card = (await screen.findByText('Catch-up documents')).closest('section')!;
    expect(await within(card).findByText('CATCHUP-NCAF-SENT.pdf')).toBeTruthy();
    expect(within(card).getByText('Already on file', { selector: '.badge' })).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'CCG-2026-00002' }).getAttribute('href')).toBe('/claims/c2/ai');
    expect(within(card).getAllByText(/from the letter/).length).toBeGreaterThan(0);
    expect(within(card).getByText(/email date/)).toBeTruthy();
    expect(within(card).getByText(/pages 2–3/)).toBeTruthy();
    const plain = within(card).getByText('CATCHUP-PLAIN-LETTER.pdf').closest('li')!;
    await user.selectOptions(within(plain).getByLabelText('Who sent it'), 'out');
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/cu1/files/f4')).toHaveLength(1));
    expect(bodyOf(api, 'POST', '/claims/c1/ai-input/cu1/files/f4')[0]).toEqual({ direction: 'out' });
    await user.click(within(plain).getByRole('button', { name: 'Not this claim' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/cu1/files/f4')).toHaveLength(2));
    expect(bodyOf(api, 'POST', '/claims/c1/ai-input/cu1/files/f4')[1]).toEqual({ notThisClaim: true });
  });

  it('changing the real date posts it; File and record now applies with the ticks; auto-apply toggles', async () => {
    const { user, api } = setup({
      extra: {
        'POST /claims/:id/ai-input/cu1/files/:fileId': () => catchUpDetail(),
        'POST /claims/:id/ai-input/cu1/apply': () => catchUpDetail(),
        'PATCH /claims/:id/ai-input/cu1': () => catchUpDetail(),
      },
    });
    const card = (await screen.findByText('Catch-up documents')).closest('section')!;
    const ncaf = (await within(card).findByText('CATCHUP-NCAF-SENT.pdf')).closest('li')!;
    await user.click(within(ncaf).getByRole('button', { name: 'Change date' }));
    fireEvent.change(within(ncaf).getByLabelText('Date it was sent or received'), { target: { value: '2026-10-03' } });
    await user.click(within(ncaf).getByRole('button', { name: 'Save date' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/cu1/files/f1')).toHaveLength(1));
    expect(bodyOf(api, 'POST', '/claims/c1/ai-input/cu1/files/f1')[0]).toEqual({ date: '2026-10-03' });
    expect(within(card).getByText(/Record 2 letters we sent outside ClaimDesk/)).toBeTruthy();
    await user.click(within(line('r2')).getByRole('checkbox'));
    await user.click(within(card).getByRole('button', { name: 'File and record now (4)' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/cu1/apply')).toHaveLength(1));
    const body = bodyOf(api, 'POST', '/claims/c1/ai-input/cu1/apply')[0] as { actions: Array<{ key: string; ticked: boolean }> };
    expect(body.actions).toEqual([
      { key: 'd1', ticked: true },
      { key: 'f1', ticked: true },
      { key: 'r1', ticked: true },
      { key: 'r2', ticked: true },
    ]);
    await user.click(within(card).getByLabelText(/Apply automatically when read/));
    await waitFor(() => expect(api.find('PATCH', '/claims/c1/ai-input/cu1')).toHaveLength(1));
    expect(bodyOf(api, 'PATCH', '/claims/c1/ai-input/cu1')[0]).toEqual({ autoApply: false });
  });

  it('starting a catch-up creates it, then uploads to its bundle and says files-done when the queue drains', async () => {
    const panel = panelFixture();
    panel.open = panel.open.filter((o) => o.kind !== 'catch_up');
    const created = () => {
      const d = catchUpDetail();
      d.id = 'cu2';
      d.status = 'reading';
      d.catchUp!.readiness = 'reading';
      d.catchUp!.files = [];
      d.catchUp!.filesDone = false;
      return d;
    };
    const { user, api } = setup({
      panel,
      extra: {
        'POST /claims/:id/ai-input/catch-up': () => ({ status: 201, body: created() }),
        'GET /claims/:id/ai-input/cu2': created,
        'POST /claims/:id/ai-input/cu2/files-done': created,
        'POST /intake/bundles/:id/files': () => ({ files: [{ fileId: 'nf1', itemId: 'ni1', filename: 'letter.pdf', outcome: 'added' }], bundle: {} }),
      },
    });
    // The upload goes through an injected transport (never XHR / the network); it posts through the mocked fetch.
    uploadQueueFor('b-cu1', '', {
      limits: async () => DEFAULT_LIMITS,
      sendBatch: (bundleId, files) => bundlesApi.addFiles(bundleId, files),
      sendChunked: () => Promise.reject(new Error('not used')),
    });
    const card = (await screen.findByText('Catch-up documents')).closest('section')!;
    await user.type(within(card).getByLabelText('Note (optional)'), 'Posted letters');
    const input = card.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['%PDF-1.4 synthetic'], 'letter.pdf', { type: 'application/pdf' });
    await user.upload(input, file);
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/catch-up')).toHaveLength(1));
    expect(bodyOf(api, 'POST', '/claims/c1/ai-input/catch-up')[0]).toEqual({ note: 'Posted letters', autoApply: true });
    await waitFor(() => expect(api.find('POST', '/intake/bundles/b-cu1/files')).toHaveLength(1));
    await waitFor(() => expect(api.find('POST', '/claims/c1/ai-input/cu2/files-done')).toHaveLength(1));
  });
});

describe('AI input tab — instructions and history', () => {
  it('lists active instructions, keeps removed ones under Earlier, and Remove posts (reason optional)', async () => {
    const { user, api } = setup({ extra: { 'POST /claims/:id/instructions/:instructionId/retire': () => panelFixture().instructions[0] } });
    const card = (await screen.findByText('Standing instructions (1)')).closest('section')!;
    expect(within(card).getByText("Don't chase the client until Monday 19 October 2026.")).toBeTruthy();
    expect(within(card).getByText('Holds every email to the client')).toBeTruthy();
    expect(within(card).getByText(/Until Mon 19 Oct 2026/)).toBeTruthy();
    expect(within(card).getByText('Earlier (1)')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/instructions/ins-1/retire')).toHaveLength(1));
    expect(bodyOf(api, 'POST', '/claims/c1/instructions/ins-1/retire')[0]).toEqual({});
  });

  it('adds an instruction with who follows it and until when', async () => {
    const { user, api } = setup({ extra: { 'POST /claims/:id/instructions': () => ({ status: 201, body: panelFixture().instructions[0] }) } });
    const card = (await screen.findByText('Standing instructions (1)')).closest('section')!;
    await user.click(within(card).getByRole('button', { name: 'Add an instruction' }));
    await user.type(within(card).getByLabelText(/^Instruction/), 'Ask me before sending anything to the insurer');
    await user.click(within(card).getByRole('button', { name: 'Mail' }));
    fireEvent.change(within(card).getByLabelText('Until (optional)'), { target: { value: '2026-10-30' } });
    await user.click(within(card).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.find('POST', '/claims/c1/instructions')).toHaveLength(1));
    expect(bodyOf(api, 'POST', '/claims/c1/instructions')[0]).toEqual({ text: 'Ask me before sending anything to the insurer', appliesTo: ['mail'], until: '2026-10-30' });
  });

  it('pages the history 20 at a time and opens an input', async () => {
    const panel = panelFixture();
    const page = (offset: number) => ({ items: panel.history.items.map((i) => ({ ...i, id: `${i.id}-${offset}` })), total: 45 });
    const { user, api } = setup({ panel, history: (c) => page(Number(c.query.offset ?? 0)) });
    const card = (await screen.findByText('History')).closest('section')!;
    expect(await within(card).findByText('1–3 of 45')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(api.find('GET', '/claims/c1/ai-input/inputs').some((c) => c.query.offset === '20')).toBe(true));
    expect(await within(card).findByText('21–23 of 45')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Newer' })).toBeTruthy();
  });
});
