/**
 * Smoke tests (render to a string under node, no DOM, no API) for Settings → Document templates, the template detail
 * page and the claim's document view for Word documents. Query data is seeded into the cache, as in
 * app/router.smoke.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes } from '../../app/router';
import { ToastProvider } from '../../components/Toast';
import { qk } from '../../api/hooks';
import { docxKeys } from '../../api/templatesApi';
import type { AuthUser, ClaimDocument } from '../../api/client';
import { DocumentView } from '../claim/tabs/DocumentView';
import { DocumentsTab } from '../claim/tabs/DocumentsTab';
import { claimView, detail01, docxDocument, T01, TEMPLATE_LIST } from './testFixtures';

const USER: AuthUser = { id: 'courtesycars', name: 'Courtesy Cars', username: 'courtesycars', email: 'claims@courtesycars.net', role: 'admin' };

function seeded(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  qc.setQueryData(qk.me, USER);
  return qc;
}

function renderRoute(path: string, qc: QueryClient): string {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}

function renderDocument(doc: ClaimDocument): string {
  const qc = seeded();
  qc.setQueryData(qk.document(doc.id), doc);
  const view = { ...claimView(), documents: [doc] };
  return renderToString(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/claims/claim-1/documents/${doc.id}`]}>
          <Routes>
            <Route path="/claims/:id/documents/:docId" element={<DocumentView view={view} />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe('Settings → Document templates', () => {
  it('lists the library with source, mapped, warnings and the converter card', () => {
    const qc = seeded();
    qc.setQueryData(docxKeys.templates, TEMPLATE_LIST);
    qc.setQueryData(docxKeys.converters, { preference: 'auto', order: ['word', 'libreoffice', 'browser'], available: { word: { ok: true }, libreoffice: { ok: false }, browser: { ok: true } } });
    const html = renderRoute('/settings/templates', qc);
    expect(html).toContain('Document templates');
    expect(html).toContain('Upload a Word template');
    expect(html).toContain('Customer Agreement &amp; Letter of Authority');
    expect(html).toContain('Built-in');
    expect(html).toContain('Uploaded');
    expect(html).toContain('38 of 40');
    expect(html).toContain('1 · Needs review');
    expect(html).toContain('PDFs are produced with:');
    expect(html).toContain('Microsoft Word');
    expect(html).toContain('always available');
    expect(html).toContain('not found');
  });

  it('renders the loading state before the API answers', () => {
    expect(renderRoute('/settings/templates', seeded())).toContain('Loading the templates');
  });

  it('template detail: warnings to review, details and the mapping grouped by section with signature slots locked', () => {
    const qc = seeded();
    qc.setQueryData(docxKeys.template(T01), detail01());
    const html = renderRoute(`/settings/templates/${T01}`, qc);
    expect(html).toContain('Wording to review');
    expect(html).toContain('I have reviewed this wording');
    expect(html).toContain('former supplier wording');
    expect(html).toContain('Download original');
    expect(html).toContain('Download a test copy');
    expect(html).not.toContain('Upload new version'); // built-in
    expect(html).toContain('Reset to default');
    expect(html).toContain('Suggested 0.82');
    expect(html).toContain('Signed by hand — never filled');
    expect(html).toContain('Handler fills');
    // sections in outline order: page header, title block, 01, 05, 13
    const order = ['Page header', 'Title block', '01 Customer and claim details', '05 Services', '13 Client authorisation'].map((t) => html.indexOf(`>${t}<`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('4 filled from the claim · 0 entered by the handler · 1 left as printed · 1 signed by hand · 1 not mapped');
  });
});

describe('claim documents: Word documents', () => {
  it('the Documents tab offers Fill a CCGUK template and marks Word rows', () => {
    const qc = seeded();
    const view = { ...claimView(), documents: [docxDocument()] };
    const html = renderToString(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/claims/claim-1/documents']}>
            <DocumentsTab view={view} />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    );
    expect(html).toContain('Fill a CCGUK template');
    expect(html).toContain('New document');
    expect(html).toMatch(/badge-blue[^>]*>Word</);
  });

  it('a Word draft shows the Word preview, the Word download and no PDF yet; values used are listed', () => {
    const html = renderDocument(docxDocument());
    expect(html).toContain('Opening the Word document');
    expect(html).toContain('Download Word (.docx)');
    expect(html).toContain('href="/api/documents/doc-1/docx"');
    expect(html).toContain('The PDF is made when the document is approved');
    expect(html).not.toContain('Download PDF');
    expect(html).toContain('Values used');
    expect(html).toContain('Full name (client)');
    expect(html).toContain('OWN-123');
    expect(html).not.toContain('Download on letterhead (Word)');
  });

  it('an approved Word document offers the PDF and says which program made it', () => {
    const html = renderDocument(docxDocument({ status: 'approved', approvedAt: '2026-10-04T11:00:00.000Z', approvedBy: 'courtesycars', pdfConverter: 'word' }));
    expect(html).toContain('Download PDF');
    expect(html).toContain('PDF made with Microsoft Word');
    expect(html).not.toContain('The PDF is made when the document is approved');
  });

  it('an HTML letter keeps its preview and PDF link and adds the letterhead Word download', () => {
    const html = renderDocument(docxDocument({ id: 'doc-2', templateId: 'letter.ncaf', format: 'html', dataSnapshot: {} }));
    expect(html).toContain('Download on letterhead (Word)');
    expect(html).toContain('href="/api/documents/doc-2/letterhead.docx"');
    expect(html).toContain('>PDF<');
    expect(html).toContain('<iframe');
    expect(html).not.toContain('Values used');
    expect(html).not.toContain('Download Word (.docx)');
  });
});
