// @vitest-environment jsdom
// owned by intake-web
/**
 * The case bundle page (docs/SMART-INTAKE.md §11.4, §16.5) against a mocked API with the synthetic BundleDetail: the
 * board, Move to…, conflicts (Register disabled until resolved, Accept all preselected), the provenance drawer, the
 * owner-only panel, Register → case brief, and typing never losing focus.
 */
import { act, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, typeAndExpectFocus } from '../../../test/harness';
import { bundleKeys, type BundleDetail } from '../../../api/bundlesApi';
import { BundlePage } from './BundlePage';
import { REGISTER_RESULT, summaryOf } from './__fixtures__/bundleDetail';
import { bundleDetail, mockApi, type Handler } from './__fixtures__/mockApi';

function renderPage(detail: BundleDetail, routes: Record<string, Handler> = {}) {
  const api = mockApi({
    'GET /intake/bundles/:id/progress': () => ({ bundle: summaryOf(detail), files: detail.files.map((f) => ({ id: f.id, filename: f.filename, stage: f.stage, stageLabel: f.stageLabel, waiting: f.waiting })) }),
    'GET /intake/bundles/:id': () => detail,
    'GET /intake/:id': () => ({ id: 'item-f1', pageTexts: ['V5C REGISTRATION CERTIFICATE\nRegistration mark KX21 ABC\nMake VAUXHALL'], extractions: [], proposalList: [], childItems: [], needsYou: [], status: 'proposed', proposals: { pending: 0, applied: 0, rejected: 0, superseded: 0 } }),
    ...routes,
  });
  vi.stubGlobal('fetch', vi.fn(api.fetch));
  const r = renderWithProviders(
    <Routes>
      <Route path="/intake/bundles/:id" element={<BundlePage />} />
    </Routes>,
    { route: '/intake/bundles/b1', queryData: [[bundleKeys.detail('b1'), detail]] },
  );
  return { ...r, api };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
});
afterEach(() => vi.unstubAllGlobals());

describe('BundlePage', () => {
  it('shows the files sorted into cases with reasons, packs with their segments and copies under the primary', () => {
    renderPage(bundleDetail());
    for (const label of ['This case', 'New case B — Ali Example', 'CCG-2026-00001 — Sam Sample', 'Not sure', 'Excluded']) expect(screen.getByRole('region', { name: label })).toBeTruthy();
    const main = screen.getByRole('region', { name: 'This case' });
    expect(within(main).getByText('Same registration KX21 ABC as the V5C')).toBeTruthy();
    expect(within(main).getByText('pages 1–2')).toBeTruthy();
    expect(within(main).getByText('copy of IMG_2041.png')).toBeTruthy();
    expect(within(main).getByText('1 copy (not filed twice)')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Not sure' })).getByText('No registration, name or date to go on')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach to CCG-2026-00001' })).toBeTruthy();
    expect(screen.getByText(/Agents are paused — this draft is from the documents’ text/)).toBeTruthy();
    expect(screen.getByText('AI check queued — agents are switched off')).toBeTruthy();
  });

  it('Move to… sends the file to the chosen group', async () => {
    const d = bundleDetail();
    const { user, api } = renderPage(d, { 'POST /intake/bundles/:id/files/:f/move': () => d });
    const card = screen.getByLabelText('SMART-B-V5C.pdf');
    await user.click(within(card).getByRole('button', { name: 'Move to…' }));
    await user.selectOptions(within(card).getByLabelText('Move SMART-B-V5C.pdf to'), 'main');
    await vi.waitFor(() => expect(api.find('POST', '/intake/bundles/b1/files/f9/move')).toHaveLength(1));
    expect(api.find('POST', '/intake/bundles/b1/files/f9/move')[0]!.body).toEqual({ groupKey: 'main' });
  });

  it('Register stays disabled while a conflict is open; Accept all preselected resolves them', async () => {
    const d = bundleDetail();
    const resolved: BundleDetail = {
      ...d,
      conflictsOpen: 0,
      conflicts: d.conflicts.map((c) => ({ ...c, status: 'resolved' as const, chosenValue: c.options.find((o) => o.preselected)!.value, resolvedBy: 'courtesycars', resolvedAt: d.updatedAt })),
      register: { ...d.register, canRegister: true, blockers: d.register.blockers.filter((b) => b.for === 'auto') },
    };
    const { user, api } = renderPage(d, { 'POST /intake/bundles/:id/conflicts/accept-preselected': () => resolved });
    const register = screen.getByRole('button', { name: 'Register claim' }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    expect(register.parentElement!.getAttribute('title')).toBe('2 details conflict — choose which is right.');
    const panel = screen.getByText('2 details conflict').closest('section')!;
    expect(within(panel).getByText('The V5C outranks the bodyshop estimate for the VIN')).toBeTruthy();
    expect(within(panel).getAllByText('Preselected')).toHaveLength(2);
    expect(within(panel).getByText('best source: V5C')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Accept all preselected' }));
    await vi.waitFor(() => expect(api.find('POST', '/intake/bundles/b1/conflicts/accept-preselected')).toHaveLength(1));
    await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Register claim' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Conflicts resolved')).toBeTruthy();
  });

  it('Use this chooses one option of a conflict', async () => {
    const d = bundleDetail();
    const { user, api } = renderPage(d, { 'POST /intake/bundles/:id/conflicts/:c/choose': () => d });
    await user.click(screen.getByRole('button', { name: 'Use WVWZZZ1JZXW000007 for VIN' }));
    await vi.waitFor(() => expect(api.find('POST', '/intake/bundles/b1/conflicts/c%3Avehicle.vin/choose')).toHaveLength(1));
    expect(api.find('POST', '/intake/bundles/b1/conflicts/c%3Avehicle.vin/choose')[0]!.body).toEqual({ value: 'WVWZZZ1JZXW000007' });
  });

  it('the provenance drawer shows the file at the page, the quote highlighted and every reading', async () => {
    const { user } = renderPage(bundleDetail());
    const row = document.querySelector('[data-key="vehicle.registration"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Source: V5C · p1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Where “Registration” came from' });
    expect(within(drawer).getByText('“Registration mark KX21 ABC”')).toBeTruthy();
    expect((within(drawer).getByTitle('Preview of SMART-A-V5C.pdf') as HTMLIFrameElement).getAttribute('src')).toBe('/api/evidence/ev-f1/file#page=1');
    const mark = await within(drawer).findByText('Registration mark KX21 ABC', { selector: 'mark' });
    expect(mark.tagName).toBe('MARK');
    expect(within(drawer).getByText('All readings of this field')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the owner-only panel says nothing was declined; Noted keeps a note', async () => {
    const d = bundleDetail();
    const { user, api } = renderPage(d, { 'POST /intake/bundles/:id/signals/:s/ack': () => d });
    const panel = screen.getByText('Worth a look').closest('section')!;
    expect(within(panel).getByText('Only you see this. Nothing has been declined or reported.')).toBeTruthy();
    expect(within(panel).getByText(/Camera clocks are often wrong/)).toBeTruthy();
    expect(within(panel).getByText(/Their bodyshop always uses it/)).toBeTruthy();
    await user.click(within(panel).getAllByRole('button', { name: 'Noted' })[0]!);
    await typeAndExpectFocus(user, within(panel).getByLabelText('Your note (optional)') as HTMLInputElement, 'Asked the client');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && /\/signals\/.+\/ack$/.test(c.path))).toBe(true));
    expect(api.calls.find((c) => /\/ack$/.test(c.path))!.body).toEqual({ note: 'Asked the client' });
  });

  it('Register claim shows what it will do, then the case brief', async () => {
    const d = bundleDetail();
    d.conflicts = [];
    d.register = { ...d.register, canRegister: true, blockers: [] };
    const { user, api } = renderPage(d, { 'POST /intake/bundles/:id/register': () => ({ status: 201, body: REGISTER_RESULT }) });
    await user.click(screen.getByRole('button', { name: 'Register claim' }));
    const dialog = await screen.findByRole('dialog', { name: 'Register claim for Jane Doe' });
    expect(within(dialog).getByText('Files 8 documents (1 copy not filed twice)')).toBeTruthy();
    expect(within(dialog).getByText('Prepares a request for 3 documents (you approve it before it is sent)')).toBeTruthy();
    expect((within(dialog).getByLabelText('CCG-2026-00001 — Sam Sample (1 file)') as HTMLSelectElement).value).toBe('attach');
    await user.click(within(dialog).getByRole('button', { name: 'Register' }));
    await screen.findByText('Case brief — CCG-2026-00042');
    expect(api.find('POST', '/intake/bundles/b1/register')[0]!.body).toEqual({ acceptPreselected: false, requestMissingDocs: true, groups: { 'case:B': 'split_off', 'claim:c-old': 'attach', unsure: 'split_off' } });
    expect(screen.getByText(/Jane Doe’s Vauxhall Corsa \(KX21 ABC\) was hit by LM19 XYZ/)).toBeTruthy();
    expect(screen.getByText('Liability guide — your decision')).toBeTruthy();
    expect(screen.getByText(/Call the client: confirm their account/)).toBeTruthy();
    expect(screen.getByText('Offer a replacement car')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open claim CCG-2026-00042' }).getAttribute('href')).toBe('/claims/c-new');
  });

  it('a refused register lists the blockers in the dialog', async () => {
    const d = bundleDetail();
    d.conflicts = [];
    d.register = { ...d.register, canRegister: true, blockers: [] };
    const { user } = renderPage(d, {
      'POST /intake/bundles/:id/register': () => ({ status: 409, body: { error: { code: 'BUNDLE_NOT_READY', message: 'Not ready', details: { blockers: [{ code: 'FILES_IN_PROGRESS', text: '1 file is still being read.', for: 'owner' }] } } } }),
    });
    await user.click(screen.getByRole('button', { name: 'Register claim' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Register' }));
    expect(await within(dialog).findByText('1 file is still being read.')).toBeTruthy();
  });

  it('typing the bundle name and a field value never loses focus while the page refreshes', async () => {
    const d = bundleDetail();
    const { user, api, queryClient } = renderPage(d, { 'PATCH /intake/bundles/:id': () => summaryOf(d), 'POST /intake/bundles/:id/fields': () => d });
    // background refreshes while typing (as polling does)
    const churn = setInterval(() => act(() => queryClient.setQueryData(bundleKeys.detail('b1'), { ...d, updatedAt: new Date().toISOString() })), 15);
    try {
      const name = screen.getByLabelText('Bundle name') as HTMLInputElement;
      await user.clear(name);
      await typeAndExpectFocus(user, name, 'Jane Doe – rear-ended at lights');
      await user.keyboard('{Enter}');
      await vi.waitFor(() => expect(api.find('PATCH', '/intake/bundles/b1')).toHaveLength(1));
      expect(api.find('PATCH', '/intake/bundles/b1')[0]!.body).toEqual({ name: 'Jane Doe – rear-ended at lights' });

      const row = document.querySelector('[data-key="client.phone"]') as HTMLElement;
      await user.click(within(row).getByRole('button', { name: 'Edit Phone' }));
      const input = within(row).getByLabelText('New value for Phone') as HTMLInputElement;
      await user.clear(input);
      await typeAndExpectFocus(user, input, '07700 900456');
      await user.click(within(row).getByRole('button', { name: 'Save' }));
      await vi.waitFor(() => expect(api.find('POST', '/intake/bundles/b1/fields')).toHaveLength(1));
      expect(api.find('POST', '/intake/bundles/b1/fields')[0]!.body).toEqual({ key: 'client.phone', value: '07700 900456' });
    } finally {
      clearInterval(churn);
    }
  });

  it('a field value the server refuses shows the validator message under the field', async () => {
    const { user } = renderPage(bundleDetail(), { 'POST /intake/bundles/:id/fields': () => ({ status: 400, body: { error: { code: 'VALIDATION', message: 'Not a UK registration' } } }) });
    const row = document.querySelector('[data-key="vehicle.registration"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Edit Registration' }));
    const input = within(row).getByLabelText('New value for Registration') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'NOPE');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByText('Not a UK registration')).toBeTruthy();
  });
});
