/**
 * Smoke test for Claim → Documents → "Fill a CCGUK template" with a mocked fetch (same approach as
 * app/router.smoke.test.tsx: render to a string under node, no DOM). The API calls go through templatesApi with a
 * stubbed global fetch; the dialog's state is driven through the same reducer the component uses, and the request
 * Generate sends is built by the same function the dialog's Generate button calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../components/Toast';
import { docxKeys, docxValuesQueryOptions, templatesApi, type ClaimTemplateValues } from '../../api/templatesApi';
import { FillTemplateDialog } from '../claim/tabs/FillTemplateDialog';
import { buildGenerateBody, fillReducer, initialFillState, rowsOf, type FillState } from '../claim/lib/fillValues';
import { claimView, docxDocument, T01, T03, T04, TEMPLATE_LIST, values01, values03 } from './testFixtures';

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockApi(values: Record<string, ClaimTemplateValues>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const path = url.split('?')[0]!;
      if (method === 'GET' && path === '/api/docx-templates') return json({ items: TEMPLATE_LIST });
      const m = /^\/api\/claims\/([^/]+)\/docx-templates\/([^/]+)\/values$/.exec(path);
      if (method === 'GET' && m) {
        const v = values[decodeURIComponent(m[2]!)];
        return v ? json(v) : json({ error: { code: 'NOT_FOUND', message: 'No such template' } }, 404);
      }
      if (method === 'POST' && path === '/api/claims/claim-1/docx-documents') return json(docxDocument({ id: 'doc-new' }), 201);
      return json({ error: { code: 'NOT_FOUND', message: `${method} ${path}` } }, 404);
    })
  );
}

async function client(state: FillState): Promise<QueryClient> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await qc.prefetchQuery({ queryKey: docxKeys.templates, queryFn: () => templatesApi.listDocxTemplates({ includeInactive: true }) });
  if (state.templateId) await qc.prefetchQuery(docxValuesQueryOptions('claim-1', state.templateId, state.variant, state.subject));
  return qc;
}

function render(qc: QueryClient, state: Partial<FillState>): string {
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/claims/claim-1/documents']}>
          <FillTemplateDialog view={claimView()} onClose={() => undefined} initialState={state} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** The Generate / Check button's opening tag. */
function buttonTag(html: string, label: string): string {
  const i = html.indexOf(`>${label}</button>`);
  expect(i, `${label} button`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<button', i), i + 1);
}

const t01 = TEMPLATE_LIST.find((t) => t.id === T01)!;

describe('Fill a CCGUK template', () => {
  beforeEach(() => mockApi({ [T01]: values01(), [T03]: values03() }));
  afterEach(() => vi.unstubAllGlobals());

  it('step 1 lists the active Word templates by group; inactive ones are hidden', async () => {
    const qc = await client(initialFillState());
    expect(calls[0]).toMatchObject({ url: '/api/docx-templates?includeInactive=true', method: 'GET' });
    const html = render(qc, {});
    for (const label of ['Agreements', 'Forms', 'Statements', 'Letters', 'Your templates']) expect(html).toContain(label);
    expect(html).toContain('Vehicle Credit Hire Agreement');
    expect(html).toContain('Chaser letter');
    expect(html).not.toContain('Old form');
    expect(html).toContain('Needs review');
    expect(buttonTag(html, 'Check the values')).toContain('disabled');
  });

  it('choosing agreement.ccguk_01_customer_loa enables the next step', async () => {
    const chosen = fillReducer(initialFillState(), { type: 'chooseTemplate', template: t01 });
    const qc = await client(chosen);
    const html = render(qc, chosen);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-template="agreement.ccguk_01_customer_loa"/);
    expect(buttonTag(html, 'Check the values')).not.toContain('disabled');
  });

  it('a witness statement needs its witness before the values can be checked', async () => {
    const chosen = fillReducer(initialFillState(), { type: 'chooseTemplate', template: TEMPLATE_LIST.find((t) => t.id === T04)! });
    const qc = await client({ ...chosen, templateId: '' });
    const html = render(qc, chosen);
    expect(html).toContain('Choose the witness…');
    expect(html).toContain('Wendy Witness');
    expect(html).toContain('dashcam.mp4');
    expect(buttonTag(html, 'Check the values')).toContain('disabled');
  });

  it('step 2 renders the value rows with their origin badges, and Generate posts the expected body', async () => {
    let state = fillReducer(initialFillState(), { type: 'chooseTemplate', template: t01 });
    state = fillReducer(state, { type: 'next' });
    const qc = await client(state);
    expect(calls.some((c) => c.url === '/api/claims/claim-1/docx-templates/agreement.ccguk_01_customer_loa/values' && c.method === 'GET')).toBe(true);

    const html = render(qc, state);
    for (const label of ['Customer full name', 'Date of birth', 'Registration', 'Own claim ref.', 'STANDARD AUTHORITY', 'Signature', 'Date signed']) expect(html).toContain(label);
    expect(html).toContain('From claim');
    expect(html).toContain('Suggested — tick to confirm');
    expect(html).toContain('Confirm this value');
    expect(html).toContain('>Enter<');
    expect(html).toContain('Signed by hand — left blank');
    expect(html).toContain('4 filled from the claim · 1 to confirm · 4 to enter · 2 left for signing');
    expect(html).toContain('This box is about 2 cm wide — keep it short');
    expect(html).toContain('Prints: AB12 CDE');
    expect(html).toContain('The records use rates that differ from the printed contract');
    expect(html).toContain('If neither box is ticked, Standard Authority applies');
    expect(buttonTag(html, 'Generate')).not.toContain('disabled');

    // the handler confirms the date, enters two values and leaves the rest as planned
    state = fillReducer(state, { type: 'confirm', slotId: 'title/date', confirmed: true });
    state = fillReducer(state, { type: 'edit', slotId: '01-customer-and-claim-details/own-claim-ref', value: 'OWN-123' });
    state = fillReducer(state, { type: 'edit', slotId: '01-customer-and-claim-details/mileage', value: '45,210' });
    state = fillReducer(state, { type: 'edit', slotId: '01-customer-and-claim-details/customer-full-name', value: 'Amelia Hart' });
    const after = render(qc, state);
    expect(after).toContain('5 filled from the claim · 0 to confirm · 2 to enter · 2 left for signing · 2 entered by you');

    const values = qc.getQueryData<ClaimTemplateValues>(docxValuesQueryOptions('claim-1', T01, undefined, {}).queryKey)!;
    const doc = await templatesApi.generateDocxDocument('claim-1', buildGenerateBody(state, rowsOf(values)));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/claims/claim-1/docx-documents');
    expect(post.body).toEqual({
      templateId: 'agreement.ccguk_01_customer_loa',
      values: {
        '01-customer-and-claim-details/mileage': 45210,
        '01-customer-and-claim-details/own-claim-ref': 'OWN-123'
      },
      confirm: ['title/date']
    });
    expect(doc).toMatchObject({ id: 'doc-new', format: 'docx' });
  });

  it('GTA figures carry the benchmark caveat, and Generate stays disabled while a required value is missing', async () => {
    let state = fillReducer(initialFillState(), { type: 'chooseTemplate', template: TEMPLATE_LIST.find((t) => t.id === T03)! });
    state = fillReducer(state, { type: 'next' });
    const qc = await client(state);
    expect(calls.some((c) => c.url === '/api/claims/claim-1/docx-templates/agreement.ccguk_03_credit_hire/values?variant=hirer')).toBe(true);
    const html = render(qc, state);
    expect(html).toContain('GTA rates are an industry benchmark only. Courtesy Cars Group UK Ltd is not a GTA subscriber.');
    expect(html).toContain('Hirer copy (without the internal enforceability page)');
    expect(html).toContain('Hire reference is required');
    expect(buttonTag(html, 'Generate')).toContain('disabled');

    state = fillReducer(state, { type: 'edit', slotId: '04-charges/hire-reference', value: 'CCG-HIRE-000123' });
    expect(buttonTag(render(qc, state), 'Generate')).not.toContain('disabled');
  });
});
