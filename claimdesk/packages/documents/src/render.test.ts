import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { closeBrowser, htmlSha256, htmlTitle, launchArgs, mergePdfs, pdfPageCount, renderPdf, resolveChromium, scanPlaywrightBrowsers, sha256Hex } from './render.js';
import { exampleLetterTemplate } from './templates/_example.js';
import { baseLayout, pageBreak } from './layout.js';
import { sampleBaseData } from './common.js';

afterAll(async () => {
  await closeBrowser();
});

describe('chromium discovery', () => {
  it('finds a chromium binary', () => {
    const exe = resolveChromium();
    expect(exe).toBeTruthy();
    expect(exe).toMatch(/chrom/i);
  });
  it('scans a browsers directory and tolerates a missing one', () => {
    expect(scanPlaywrightBrowsers('/definitely/not/here')).toBeUndefined();
    const dir = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    if (dir) expect(scanPlaywrightBrowsers(dir)).toMatch(/chromium/);
  });
  it('disables the sandbox when running as root or when asked', () => {
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const args = launchArgs();
    if (asRoot || process.env['CHROMIUM_NO_SANDBOX'] === '1') expect(args).toContain('--no-sandbox');
    else expect(args).toEqual([]);
  });
});

describe('renderPdf', () => {
  it('renders the example letter to a PDF with pages and a sha256', async () => {
    const html = exampleLetterTemplate.render(exampleLetterTemplate.sample());
    const { pdf, sha256, pages } = await renderPdf(html, { reference: 'CCG-2026-00012' });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(htmlSha256(html)).toMatch(/^[0-9a-f]{64}$/);
    expect(await pdfPageCount(pdf)).toBe(pages);
  }, 60_000);

  it('paginates with page breaks and merges PDFs', async () => {
    const base = sampleBaseData();
    const long = baseLayout({
      title: 'Multi-page test',
      kind: 'report',
      reference: 'CCG-TEST',
      date: base.date,
      settings: base.settings,
      bodyHtml: `<p>Page one.</p>${pageBreak()}<p>Page two.</p>${pageBreak()}<p>Page three.</p>`
    });
    const a = await renderPdf(long, { reference: 'CCG-TEST' });
    expect(a.pages).toBe(3);
    const b = await renderPdf(baseLayout({ title: 'One', kind: 'notice', reference: 'CCG-TEST', date: base.date, bodyHtml: '<p>x</p>' }), {
      reference: 'CCG-TEST',
      landscape: true
    });
    expect(b.pages).toBe(1);
    const merged = await mergePdfs([a.pdf, b.pdf]);
    expect(await pdfPageCount(merged)).toBe(4);
    expect(merged.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 60_000);
});

describe('installed browser candidates', () => {
  it('lists Edge before Chrome on Windows using the Program Files variables', async () => {
    const { installedBrowserCandidates } = await import('./render.js');
    const list = installedBrowserCandidates('win32', { 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', PROGRAMFILES: 'C:\\Program Files' } as NodeJS.ProcessEnv);
    expect(list[0]).toMatch(/Microsoft[\\/]Edge[\\/]Application[\\/]msedge\.exe$/);
    expect(list.some((p) => /chrome\.exe$/.test(p))).toBe(true);
    expect(list.findIndex((p) => /msedge/.test(p))).toBeLessThan(list.findIndex((p) => /chrome\.exe/.test(p)));
  });
  it('returns nothing extra on Linux (PATH and Playwright cover it)', async () => {
    const { installedBrowserCandidates } = await import('./render.js');
    expect(installedBrowserCandidates('linux', {} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('PDF metadata (§A.12)', () => {
  it('stamps Author/Creator/Producer/Title/Subject/Keywords/Language and hashes the stamped bytes', async () => {
    const html = exampleLetterTemplate.render(exampleLetterTemplate.sample());
    const { pdf, sha256, pages } = await renderPdf(html, { reference: 'CCG-2026-00012', metadata: { title: 'Letter — CCG-2026-00012', subject: 'Letter', keywords: ['CCG-2026-00012', 'letter.example'] } });
    expect(sha256).toBe(sha256Hex(pdf));
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(pages);
    expect(doc.getAuthor()).toBe('Courtesy Cars Group UK Ltd');
    expect(doc.getCreator()).toBe('ClaimDesk');
    expect(doc.getProducer()).toBe('ClaimDesk — Courtesy Cars Group UK Ltd');
    expect(doc.getTitle()).toBe('Letter — CCG-2026-00012');
    expect(doc.getSubject()).toBe('Letter');
    expect(doc.getKeywords()).toBe('CCG-2026-00012 letter.example');
    expect(pdf.toString('latin1')).toMatch(/\/Lang \(en-GB\)/);
  }, 60_000);

  it('defaults the Title to the HTML <title>; mergePdfs sets Author and copies the first Title', async () => {
    const html = exampleLetterTemplate.render(exampleLetterTemplate.sample());
    const a = await renderPdf(html, { reference: 'CCG-2026-00012' });
    const docA = await PDFDocument.load(a.pdf, { updateMetadata: false });
    expect(docA.getTitle()).toBe(htmlTitle(html));
    expect(docA.getAuthor()).toBe('Courtesy Cars Group UK Ltd');
    const merged = await mergePdfs([a.pdf, a.pdf]);
    const m = await PDFDocument.load(merged, { updateMetadata: false });
    expect(m.getTitle()).toBe(htmlTitle(html));
    expect(m.getAuthor()).toBe('Courtesy Cars Group UK Ltd');
    expect(m.getCreator()).toBe('ClaimDesk');
  }, 60_000);
});
