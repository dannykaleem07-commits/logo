/**
 * Text and preview (§A.9): docxToPlainText(), docxToPreviewHtml(), extractHeaderFooter().
 */
import type { Element } from '@xmldom/xmldom';
import { detectHeading, readStyles, runFormat, paragraphStyleId } from './context.js';
import { normaliseText, paragraphRuns, paragraphText, runText } from './text.js';
import type { DocxPackage, HeaderFooterText } from './types.js';
import { openDocx } from './zip.js';
import { bodyOf, childElements, hasPart, isW, NS, partDom, wAttr, wChild, wChildren, wDescendants } from './xml.js';

/** Plain text of the body: every paragraph (incl. table cells) in document order, one per line; ☐/☒ kept. */
export function docxPlainTextFromPackage(pkg: DocxPackage): string {
  const body = bodyOf(partDom(pkg, 'word/document.xml'));
  const lines: string[] = [];
  for (const p of wDescendants(body, 'p')) {
    const t = paragraphText(p).text.replace(/\u00A0/g, ' ');
    if (t.trim().length) lines.push(t.replace(/[ \t]+$/g, ''));
  }
  return lines.join('\n');
}

export function docxToPlainText(bytes: Uint8Array): string {
  return docxPlainTextFromPackage(openDocx(bytes));
}

// ---------------------------------------------------------------------------
// Preview HTML
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paragraphHtml(p: Element, styles: ReturnType<typeof readStyles>): string {
  const ps = paragraphStyleId(p);
  let html = '';
  for (const r of paragraphRuns(p)) {
    const t = runText(r);
    if (!t) continue;
    let h = esc(t).replace(/\n/g, '<br>').replace(/\t/g, ' ');
    const f = runFormat(r, styles, ps);
    if (f.italic) h = `<em>${h}</em>`;
    if (f.bold) h = `<strong>${h}</strong>`;
    html += h;
  }
  return html;
}

function tableHtml(tbl: Element, styles: ReturnType<typeof readStyles>): string {
  const rows = wChildren(tbl, 'tr').map((tr) => {
    const cells = wChildren(tr, 'tc').map((tc) => {
      const span = Number(wAttr(wChild(wChild(tc, 'tcPr'), 'gridSpan')) ?? 1) || 1;
      const inner = childElements(tc)
        .map((c) => (isW(c, 'p') ? paragraphHtml(c, styles) : isW(c, 'tbl') ? tableHtml(c, styles) : ''))
        .filter((h) => h.length > 0)
        .join('<br>');
      return `<td${span > 1 ? ` colspan="${span}"` : ''}>${inner}</td>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  });
  return `<table>${rows.join('')}</table>`;
}

export function docxToPreviewHtml(bytes: Uint8Array, meta: { title: string; kind: string; reference: string; date: string }): string {
  const pkg = openDocx(bytes);
  const styles = readStyles(hasPart(pkg, 'word/styles.xml') ? partDom(pkg, 'word/styles.xml') : undefined);
  const body = bodyOf(partDom(pkg, 'word/document.xml'));
  const parts: string[] = [];
  const walk = (container: Element): void => {
    for (const el of childElements(container)) {
      if (isW(el, 'p')) {
        const inner = paragraphHtml(el, styles);
        if (!inner.trim()) continue;
        const h = detectHeading(el, styles);
        if (h?.level === 1) parts.push(`<h2>${inner}</h2>`);
        else if (h?.level === 2) parts.push(`<h3>${inner}</h3>`);
        else parts.push(`<p>${inner}</p>`);
      } else if (isW(el, 'tbl')) parts.push(tableHtml(el, styles));
      else if (isW(el, 'sdt')) {
        const content = wChild(el, 'sdtContent');
        if (content) walk(content);
      }
    }
  };
  walk(body);
  return [
    '<!DOCTYPE html>',
    '<html lang="en-GB"><head><meta charset="utf-8">',
    `<title>${esc(meta.title)}</title>`,
    `<meta name="ccguk:kind" content="${esc(meta.kind)}">`,
    `<meta name="ccguk:reference" content="${esc(meta.reference)}">`,
    `<meta name="ccguk:date" content="${esc(meta.date)}">`,
    '<meta name="ccguk:format" content="docx">',
    '<style>body{font-family:Calibri,Carlito,Arial,sans-serif;font-size:10.5pt;color:#1a1a1a;max-width:190mm;margin:0 auto}table{border-collapse:collapse;width:100%;margin:4pt 0}td{border:1px solid #d9dce3;padding:3pt 5pt;vertical-align:top}h2{font-size:12.5pt;color:#0d1c50}h3{font-size:11pt;color:#04347f}</style>',
    '</head><body>',
    ...parts,
    '</body></html>'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Header / footer text
// ---------------------------------------------------------------------------

/** Relationship id → target part name for word/document.xml. */
export function documentRels(pkg: DocxPackage): Map<string, string> {
  const map = new Map<string, string>();
  if (!hasPart(pkg, 'word/_rels/document.xml.rels')) return map;
  const doc = partDom(pkg, 'word/_rels/document.xml.rels');
  const rels = doc.getElementsByTagNameNS(NS.rels, 'Relationship');
  for (let i = 0; i < rels.length; i++) {
    const r = rels[i]!;
    const id = r.getAttribute('Id');
    const target = r.getAttribute('Target');
    if (!id || !target || (r.getAttribute('TargetMode') ?? '') === 'External') continue;
    map.set(id, target.startsWith('/') ? target.slice(1) : `word/${target}`);
  }
  return map;
}

/** First w:sectPr in document order (section 1). */
export function firstSectPr(pkg: DocxPackage): Element | undefined {
  const body = bodyOf(partDom(pkg, 'word/document.xml'));
  return wDescendants(body, 'sectPr')[0];
}

function isPageField(instr: string): boolean {
  return /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.test(instr);
}

/** Text of a paragraph with PAGE/NUMPAGES field results removed. */
function paragraphTextNoPageFields(p: Element): string {
  let out = '';
  let inField = 0;
  let pageField = false;
  let separated = false;
  let instr = '';
  for (const r of paragraphRuns(p)) {
    const fc = wChild(r, 'fldChar');
    const type = fc ? wAttr(fc, 'fldCharType') : undefined;
    if (type === 'begin') {
      inField++;
      instr = '';
      separated = false;
      continue;
    }
    if (type === 'separate') {
      separated = true;
      pageField = isPageField(instr);
      continue;
    }
    if (type === 'end') {
      inField = Math.max(0, inField - 1);
      pageField = false;
      continue;
    }
    if (inField > 0 && !separated) {
      for (const it of wChildren(r, 'instrText')) instr += it.textContent ?? '';
      continue;
    }
    if (inField > 0 && pageField) continue;
    const parent = r.parentNode as Element | null;
    if (parent && isW(parent, 'fldSimple') && isPageField(wAttr(parent, 'instr') ?? '')) continue;
    out += runText(r);
  }
  return out;
}

function hasPageFieldIn(root: Element): boolean {
  for (const it of wDescendants(root, 'instrText')) if (isPageField(it.textContent ?? '')) return true;
  for (const fs of wDescendants(root, 'fldSimple')) if (isPageField(wAttr(fs, 'instr') ?? '')) return true;
  return false;
}

/** Running text of a header/footer part: segments (cells, paragraphs, tab stops) joined by ' | ' (header) or '\n'. */
function partText(pkg: DocxPackage, part: string, mode: 'header' | 'footer'): string {
  const root = partDom(pkg, part).documentElement as unknown as Element;
  const segs: string[] = [];
  for (const p of wDescendants(root, 'p')) {
    let t = paragraphTextNoPageFields(p);
    t = t.replace(/\b(page)\s*(of)?\s*$/i, '');
    for (const seg of t.split('\t')) {
      const n = normaliseText(seg);
      if (n) segs.push(n);
    }
  }
  return mode === 'header' ? segs.join(' | ') : segs.join('\n');
}

export interface HeaderFooterDetails extends HeaderFooterText {
  /** Which of the four parts print PAGE / NUMPAGES fields. */
  pageFields: { firstHeader: boolean; header: boolean; firstFooter: boolean; footer: boolean };
}

export function headerFooterFromPackage(pkg: DocxPackage): HeaderFooterText {
  const { pageFields, ...rest } = headerFooterDetails(pkg);
  void pageFields;
  return rest;
}

export function headerFooterDetails(pkg: DocxPackage): HeaderFooterDetails {
  const sect = firstSectPr(pkg);
  const rels = documentRels(pkg);
  const out: HeaderFooterDetails = { titlePage: !!wChild(sect, 'titlePg'), hasPageFields: false, pageFields: { firstHeader: false, header: false, firstFooter: false, footer: false } };
  if (!sect) return out;
  for (const ref of [...wChildren(sect, 'headerReference'), ...wChildren(sect, 'footerReference')]) {
    const type = wAttr(ref, 'type') ?? 'default';
    const id = ref.getAttributeNS(NS.r, 'id') ?? ref.getAttribute('r:id');
    const part = id ? rels.get(id) : undefined;
    if (!part || !hasPart(pkg, part)) continue;
    const isHeader = isW(ref, 'headerReference');
    const text = partText(pkg, part, isHeader ? 'header' : 'footer');
    const pf = hasPageFieldIn(partDom(pkg, part).documentElement as unknown as Element);
    if (pf) out.hasPageFields = true;
    if (type === 'first') {
      if (isHeader) {
        out.firstHeader = text;
        out.pageFields.firstHeader = pf;
      } else {
        out.firstFooter = text;
        out.pageFields.firstFooter = pf;
      }
    } else if (type === 'default') {
      if (isHeader) {
        out.header = text;
        out.pageFields.header = pf;
      } else {
        out.footer = text;
        out.pageFields.footer = pf;
      }
    }
  }
  return out;
}

export function extractHeaderFooter(bytes: Uint8Array): HeaderFooterText {
  return headerFooterFromPackage(openDocx(bytes));
}

/** Page geometry from the first w:sectPr (twips → mm). */
export function pageGeometry(pkg: DocxPackage): { widthMm: number; heightMm: number; marginMm: { top: number; right: number; bottom: number; left: number; header: number; footer: number } } {
  const sect = firstSectPr(pkg);
  const sz = wChild(sect, 'pgSz');
  const mar = wChild(sect, 'pgMar');
  const tw = (el: Element | undefined, name: string, dflt: number): number => {
    const v = Number(wAttr(el, name));
    return Number.isFinite(v) && wAttr(el, name) !== undefined ? v : dflt;
  };
  const mm = (t: number): number => Math.round((t / 1440) * 25.4 * 10) / 10;
  return {
    widthMm: mm(tw(sz, 'w', 11906)),
    heightMm: mm(tw(sz, 'h', 16838)),
    marginMm: {
      top: mm(tw(mar, 'top', 1440)),
      right: mm(tw(mar, 'right', 1440)),
      bottom: mm(tw(mar, 'bottom', 1440)),
      left: mm(tw(mar, 'left', 1440)),
      header: mm(tw(mar, 'header', 708)),
      footer: mm(tw(mar, 'footer', 708))
    }
  };
}
