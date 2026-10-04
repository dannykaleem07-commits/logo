/**
 * Browser converter (§A.11.4, always available): docx-preview renders the .docx in the shared headless Edge/Chromium
 * (the same lookup and instance as renderPdf), and print CSS adds the running header/footer as CSS page margin boxes
 * with counter(page)/counter(pages). `@page :first` suppresses the running header because docx-preview renders the
 * first-page header (logo + contact block) inline. When margin boxes are unsupported (old Chromium; probed once per
 * process) the converter falls back to Playwright header/footer templates with the same text.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import type { Browser } from 'playwright-core';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { getBrowser as sharedBrowser, resolveChromium as sharedResolveChromium } from '../../render.js';
import { headerFooterDetails, pageGeometry } from '../preview.js';
import type { ConverterStatus, DocxPackage, DocxPdfConverter, HeaderFooterText } from '../types.js';
import { openDocx, writeDocx } from '../zip.js';
import { hasPart, listParts, markDirty, partDom, setWAttr, wAttr, wChild, wDescendants } from '../xml.js';

const require = createRequire(import.meta.url);

/** Paths of the two browser bundles (packaging must ship both files — §G.6). */
export function browserScriptPaths(): { jszip: string; docxPreview: string } {
  const docxPreviewMain = require.resolve('docx-preview');
  return {
    jszip: require.resolve('jszip/dist/jszip.min.js'),
    docxPreview: join(dirname(docxPreviewMain), 'docx-preview.min.js')
  };
}

/** CSS string literal (content: "…"), newlines as \A. */
export function cssString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\A ')}"`;
}

export interface PrintGeometry {
  widthMm: number;
  heightMm: number;
  marginMm: { top: number; right: number; bottom: number; left: number; header: number; footer: number };
}

const FONT = 'Calibri, Carlito, "Liberation Sans", Arial, sans-serif';

/** Calibri → the closest local font when Calibri itself is missing (Carlito / Liberation Sans / Arial). */
export const FONT_FACE_CSS = [
  ['normal', 'normal', ''],
  ['bold', 'normal', ' Bold'],
  ['normal', 'italic', ' Italic'],
  ['bold', 'italic', ' Bold Italic']
]
  .map(
    ([weight, style, suffix]) =>
      `@font-face { font-family: "Calibri"; font-weight: ${weight}; font-style: ${style}; src: local("Calibri${suffix}"), local("Carlito${suffix}"), local("Liberation Sans${suffix}"), local("Arial${suffix}"); }`
  )
  .join('\n');

function pageSize(g: PrintGeometry): string {
  const a4 = Math.abs(g.widthMm - 210) < 1.5 && Math.abs(g.heightMm - 297) < 1.5;
  return a4 ? 'A4' : `${g.widthMm}mm ${g.heightMm}mm`;
}

/** Print CSS (pure; unit-tested). `marginBoxes: false` omits the margin boxes (Playwright templates are used instead). */
export function browserPrintCss(g: PrintGeometry, hf: HeaderFooterText, opts: { marginBoxes: boolean; firstFooterHasPageFields?: boolean } = { marginBoxes: true }): string {
  const m = g.marginMm;
  const headerLeft = hf.header ?? '';
  const footer = hf.footer ?? '';
  const firstFooter = hf.firstFooter ?? footer;
  const lines: string[] = [];
  lines.push(FONT_FACE_CSS);
  if (opts.marginBoxes) {
    lines.push(`@page { size: ${pageSize(g)}; margin: ${m.top}mm 0 ${m.bottom}mm 0;`);
    if (headerLeft) lines.push(`  @top-left { content: ${cssString(headerLeft)}; font: 7.5pt ${FONT}; color: #3F4552; margin-left: ${m.left}mm; vertical-align: bottom; padding-bottom: 3mm }`);
    if (hf.hasPageFields || headerLeft) lines.push(`  @top-right { content: "PAGE " counter(page) " OF " counter(pages); font: 7.5pt ${FONT}; color: #3F4552; margin-right: ${m.right}mm; vertical-align: bottom; padding-bottom: 3mm; white-space: nowrap }`);
    if (footer) lines.push(`  @bottom-center { content: ${cssString(footer)}; font: 6.5pt ${FONT}; color: #8A8F9B; white-space: pre-wrap; margin: 0 ${m.right}mm 0 ${m.left}mm }`);
    lines.push('}');
    if (hf.titlePage) {
      lines.push(`@page :first { margin-top: ${m.header}mm; @top-left { content: none } @top-right { content: none }`);
      if (firstFooter) lines.push(`  @bottom-center { content: ${cssString(firstFooter)} }`);
      if (opts.firstFooterHasPageFields) lines.push(`  @bottom-right { content: "PAGE " counter(page) " OF " counter(pages); font: 6.5pt ${FONT}; color: #8A8F9B; margin-right: ${m.right}mm; white-space: nowrap; width: 22mm }`);
      lines.push('}');
    }
  } else {
    // Playwright header/footer templates print inside these margins (no first-page distinction).
    lines.push(`@page { size: ${pageSize(g)}; margin: ${m.top}mm 0 ${m.bottom}mm 0 }`);
  }
  lines.push('html, body { margin: 0; padding: 0; background: #fff }');
  lines.push('.docx-wrapper { background: none !important; padding: 0 !important; display: block !important }');
  lines.push('section.docx { box-shadow: none !important; margin: 0 !important; min-height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important }');
  lines.push('section.docx > header { position: static !important; margin-top: 0 !important } section.docx ~ section.docx > header { display: none }');
  lines.push('section.docx > footer { display: none }');
  lines.push('section.docx + section.docx { break-before: page }');
  lines.push('tr { break-inside: avoid }');
  return lines.join('\n');
}

/** Natural line height of Calibri / Carlito (ascent + descent + line gap over the em). */
const NATURAL_LINE = 1.22;

function docDefaultSize(pkg: DocxPackage): number {
  if (!hasPart(pkg, 'word/styles.xml')) return 22;
  const styles = partDom(pkg, 'word/styles.xml');
  const rPrDefault = wDescendants(styles, 'rPrDefault')[0];
  const sz = Number(wAttr(wChild(wChild(rPrDefault, 'rPr'), 'sz')));
  return Number.isFinite(sz) && sz > 0 ? sz : 22;
}

/**
 * docx-preview renders `w:lineRule="atLeast"` as `calc(100% + Npt)` (doubling the line) and a missing lineRule as
 * exact. Before rendering, the browser copy gets the Word semantics: atLeast → exact max(N, natural line of the
 * largest run), missing → auto. The stored .docx is never changed.
 */
export function prepareForBrowser(bytes: Uint8Array): Uint8Array {
  const pkg = openDocx(bytes);
  const dflt = docDefaultSize(pkg);
  const parts = ['word/document.xml', ...listParts(pkg, /^word\/(header|footer)\d*\.xml$/)];
  for (const part of parts) {
    const doc = partDom(pkg, part);
    let changed = false;
    for (const p of wDescendants(doc, 'p')) {
      const spacing = wChild(wChild(p, 'pPr'), 'spacing');
      const line = Number(wAttr(spacing, 'line'));
      if (!spacing || !Number.isFinite(line) || wAttr(spacing, 'line') === undefined) continue;
      const rule = wAttr(spacing, 'lineRule');
      if (rule === undefined) {
        setWAttr(spacing, 'lineRule', 'auto');
        changed = true;
        continue;
      }
      if (rule !== 'atLeast') continue;
      let maxSz = 0;
      for (const sz of wDescendants(p, 'sz')) {
        const v = Number(wAttr(sz));
        if (Number.isFinite(v) && v > maxSz) maxSz = v;
      }
      if (maxSz === 0) maxSz = dflt;
      const natural = Math.round((maxSz / 2) * NATURAL_LINE * 20);
      setWAttr(spacing, 'line', String(Math.max(line, natural)));
      setWAttr(spacing, 'lineRule', 'exact');
      changed = true;
    }
    if (changed) markDirty(pkg, part);
  }
  return writeDocx(pkg);
}

let marginBoxProbe: Promise<boolean> | undefined;

/** Does this Chromium print CSS page margin boxes? (A page with no body text: a font in its resources ⇒ yes.) */
export function marginBoxesSupported(getBrowser: () => Promise<Browser> = sharedBrowser): Promise<boolean> {
  if (!marginBoxProbe) {
    marginBoxProbe = (async () => {
      const browser = await getBrowser();
      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        await page.setContent('<!doctype html><html><head><style>@page { size: A4; margin: 20mm; @top-left { content: "MBPROBE" } } body{margin:0}</style></head><body><div style="width:10mm;height:10mm;background:#000"></div></body></html>');
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        const doc = await PDFDocument.load(pdf, { updateMetadata: false });
        const res = doc.getPage(0).node.Resources();
        const fonts = res?.lookup(PDFName.of('Font'));
        return fonts instanceof PDFDict && fonts.keys().length > 0;
      } catch {
        return false;
      } finally {
        await ctx.close();
      }
    })();
  }
  return marginBoxProbe;
}

/** Forget the margin-box probe result (tests). */
export function resetMarginBoxProbe(): void {
  marginBoxProbe = undefined;
}

function templateText(s: string, size: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  return `<span style="font-size:${size}; font-family:${FONT.replace(/"/g, "'")}; color:#3F4552">${esc}</span>`;
}

export interface BrowserConverterOptions {
  getBrowser?: () => Promise<Browser>;
  resolveChromium?: () => string | undefined;
  /** Force the Playwright header/footer template fallback (tests; old Chromium). */
  forceTemplates?: boolean;
}

export function createBrowserConverter(opts: BrowserConverterOptions = {}): DocxPdfConverter {
  const getBrowser = opts.getBrowser ?? sharedBrowser;
  const resolveChromium = opts.resolveChromium ?? sharedResolveChromium;
  return {
    id: 'browser',
    async detect(): Promise<ConverterStatus> {
      const exe = resolveChromium();
      const scripts = (() => {
        try {
          return browserScriptPaths();
        } catch {
          return undefined;
        }
      })();
      if (!scripts) return { ok: false, detail: 'docx-preview / jszip bundles are missing' };
      return exe ? { ok: true, detail: 'Built-in browser (docx-preview)', path: exe } : { ok: true, detail: 'Built-in browser (playwright default Chromium)' };
    },
    async convert({ docxPath, outDir, header, timeoutMs }): Promise<string> {
      const bytes = new Uint8Array(await readFile(docxPath));
      const pkg = openDocx(bytes);
      const geom = pageGeometry(pkg);
      const details = headerFooterDetails(pkg);
      const hf: HeaderFooterText = header ?? details;
      const firstFooterHasPageFields = hf.titlePage && details.pageFields.firstFooter;
      const marginBoxes = opts.forceTemplates ? false : await marginBoxesSupported(getBrowser);
      const css = browserPrintCss(geom, hf, { marginBoxes, firstFooterHasPageFields });
      const scripts = browserScriptPaths();
      const browser = await getBrowser();
      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        page.setDefaultTimeout(timeoutMs);
        await page.setContent(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="c"></div></body></html>`, { timeout: timeoutMs });
        await page.addScriptTag({ path: scripts.jszip });
        await page.addScriptTag({ path: scripts.docxPreview });
        const b64 = Buffer.from(prepareForBrowser(bytes)).toString('base64');
        await page.evaluate(`(async (b64) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          await docx.renderAsync(bin.buffer, document.getElementById('c'), null, { inWrapper: true, ignoreHeight: true, breakPages: true, renderHeaders: true, renderFooters: false, experimental: true, useBase64URL: true });
          if (document.fonts) await document.fonts.ready;
          await Promise.all(Array.from(document.images).map((img) => img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; })));
          return true;
        })(${JSON.stringify(b64)})`);
        const pdfOpts: Parameters<typeof page.pdf>[0] = { preferCSSPageSize: true, printBackground: true, timeout: timeoutMs } as Parameters<typeof page.pdf>[0];
        if (!marginBoxes) {
          const m = geom.marginMm;
          Object.assign(pdfOpts!, {
            displayHeaderFooter: true,
            headerTemplate: `<div style="width:100%; display:flex; justify-content:space-between; padding:0 ${m.right}mm 0 ${m.left}mm">${templateText(hf.header ?? '', '7.5pt')}<span style="font-size:7.5pt; font-family:Arial">PAGE <span class="pageNumber"></span> OF <span class="totalPages"></span></span></div>`,
            footerTemplate: `<div style="width:100%; text-align:center">${templateText(hf.footer ?? '', '6.5pt')}</div>`
          });
        }
        const pdf = await page.pdf(pdfOpts);
        await mkdir(outDir, { recursive: true });
        const pdfPath = join(outDir, `${basename(docxPath, extname(docxPath))}.pdf`);
        await writeFile(pdfPath, pdf);
        return pdfPath;
      } finally {
        await ctx.close();
      }
    }
  };
}
