/**
 * fillDocx(): apply FillInstruction[] in place (§A.7).
 *
 * The same bytes are re-scanned (deterministic) to locate each slot; an id that is not found is reported, never
 * guessed. Text edits inside one paragraph run right-to-left so earlier offsets stay valid; structural edits (table
 * rows, numbered paragraphs, removals, blocks) run afterwards. Signature slots are always skipped.
 */
import type { Element } from '@xmldom/xmldom';
import { sha256Hex } from '../hash.js';
import { setDocxProperties } from './props.js';
import { scanPackage, targetParagraph, type SlotTarget } from './scan.js';
import { GLYPH_CHECKED, GLYPH_UNCHECKED, paragraphRuns, paragraphText, replaceRange, restyleHintRun, runText, symGlyph } from './text.js';
import type { DocxSlot, FillInstruction, FillOptions, FillReport, FillResult, RunStyle, SlotValue } from './types.js';
import { safeLinkTarget } from './safety.js';
import { openDocx, writeDocx } from './zip.js';
import { childElements, closestW, createT, createW, decodeUtf8, insertAfter, isW, markDirty, NS, partDom, removeNode, setTText, setWAttr, stripControlChars, wAttr, wChild, wChildren, wDescendants } from './xml.js';

export const MAX_VALUE_LENGTH = 20_000;
export const DEFAULT_VALUE_STYLE: Required<Omit<RunStyle, 'bold'>> & { bold: boolean } = { font: 'Calibri', sizeHalfPoints: 18, color: '1A1A1A', bold: false };

const TEXT_KINDS = new Set(['cell', 'line', 'block', 'inline', 'blank', 'bracket', 'token', 'control', 'mergefield']);

function cleanValue(s: string): string {
  return stripControlChars(s.replace(/\r\n?/g, '\n')).slice(0, MAX_VALUE_LENGTH);
}

// ---------------------------------------------------------------------------
// Run construction
// ---------------------------------------------------------------------------

function runFromStyle(doc: Element['ownerDocument'], style: RunStyle): Element {
  const run = createW(doc!, 'r');
  const rPr = createW(doc!, 'rPr');
  if (style.font) {
    const f = createW(doc!, 'rFonts');
    for (const a of ['ascii', 'hAnsi', 'cs', 'eastAsia']) setWAttr(f, a, style.font);
    rPr.appendChild(f);
  }
  if (style.bold) rPr.appendChild(createW(doc!, 'b'));
  if (style.color) {
    const c = createW(doc!, 'color');
    setWAttr(c, 'val', style.color);
    rPr.appendChild(c);
  }
  if (style.sizeHalfPoints) {
    const sz = createW(doc!, 'sz');
    setWAttr(sz, 'val', String(style.sizeHalfPoints));
    rPr.appendChild(sz);
    const szCs = createW(doc!, 'szCs');
    setWAttr(szCs, 'val', String(style.sizeHalfPoints));
    rPr.appendChild(szCs);
  }
  if (rPr.firstChild) run.appendChild(rPr);
  return run;
}

/** Run properties for a value inserted into a run-less paragraph: paragraph mark rPr → valueRunStyle → default. */
function newValueRun(p: Element, valueRunStyle?: RunStyle | null): Element {
  const doc = p.ownerDocument!;
  const markRPr = wChild(wChild(p, 'pPr'), 'rPr');
  if (markRPr && childElements(markRPr).some((c) => !['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange'].includes(c.localName ?? ''))) {
    const run = createW(doc, 'r');
    const rPr = markRPr.cloneNode(true) as Element;
    for (const c of childElements(rPr)) if (['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange'].includes(c.localName ?? '')) removeNode(c);
    run.appendChild(rPr);
    return run;
  }
  // null: inherit the paragraph / document defaults (uploaded templates)
  if (valueRunStyle === null) return createW(doc, 'r');
  return runFromStyle(doc, valueRunStyle ?? DEFAULT_VALUE_STYLE);
}

/** Put `text` into a run (replacing its text content), '\n' → <w:br/>. */
function setRunText(run: Element, text: string): void {
  for (const c of childElements(run)) if (isW(c, 't') || isW(c, 'br') || isW(c, 'tab') || isW(c, 'cr')) removeNode(c);
  const doc = run.ownerDocument!;
  text.split('\n').forEach((line, i) => {
    if (i > 0) run.appendChild(createW(doc, 'br'));
    if (line.length > 0) run.appendChild(createT(doc, line));
  });
}

/** Fill an empty paragraph (cell / line / block): first run with an empty w:t, else a run without text, else a new run. */
function fillEmptyParagraph(p: Element, text: string, valueRunStyle?: RunStyle | null): void {
  const runs = paragraphRuns(p);
  const target = runs.find((r) => wChildren(r, 't').length > 0 && runText(r).length === 0) ?? runs.find((r) => runText(r).length === 0);
  if (target) {
    setRunText(target, text);
    return;
  }
  const run = newValueRun(p, valueRunStyle);
  setRunText(run, text);
  p.appendChild(run);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface RangeOp {
  para: Element;
  pos: number;
  apply: () => void;
}

function glyphSwap(para: Element, pos: number, checked: boolean): void {
  const pt = paragraphText(para);
  const piece = pt.pieces.find((pc) => pc.start <= pos && pos < pc.end);
  if (!piece) return;
  if (isW(piece.node, 'sym')) {
    const cur = symGlyph(piece.node);
    if (cur === undefined) return;
    if (checked) setWAttr(piece.node, 'char', 'F0FE');
    else if (cur !== GLYPH_UNCHECKED) setWAttr(piece.node, 'char', 'F0A8');
    return;
  }
  const next = checked ? GLYPH_CHECKED : GLYPH_UNCHECKED;
  if (pt.text[pos] === next) return;
  replaceRange(pt, pos, pos + 1, next);
}

function setSdtCheckbox(sdt: Element, checked: boolean): void {
  const sdtPr = wChild(sdt, 'sdtPr');
  const cb = sdtPr?.getElementsByTagNameNS(NS.w14, 'checkbox')[0];
  const ch = cb?.getElementsByTagNameNS(NS.w14, 'checked')[0];
  if (ch) ch.setAttributeNS(NS.w14, 'w14:val', checked ? '1' : '0');
  const content = wChild(sdt, 'sdtContent');
  if (!content) return;
  for (const t of wDescendants(content, 't')) {
    const s = t.textContent ?? '';
    const swapped = checked ? s.replace(/[☐]/g, GLYPH_CHECKED) : s.replace(/[☒☑]/g, GLYPH_UNCHECKED);
    if (swapped !== s) setTText(t, swapped);
  }
  for (const sym of wDescendants(content, 'sym')) {
    if (symGlyph(sym) !== undefined) setWAttr(sym, 'char', checked ? 'F0FE' : 'F0A8');
  }
}

function fillSdtText(sdt: Element, text: string, hint: boolean): void {
  const sdtPr = wChild(sdt, 'sdtPr');
  const plc = wChild(sdtPr, 'showingPlcHdr');
  if (plc) removeNode(plc);
  const content = wChild(sdt, 'sdtContent');
  if (!content) return;
  const paras = wChildren(content, 'p');
  const holder = paras[0] ?? content;
  const runs = holder === content ? wChildren(content, 'r') : paragraphRuns(holder);
  let first = runs[0];
  if (!first) {
    first = createW(sdt.ownerDocument!, 'r');
    holder.appendChild(first);
  }
  for (const r of runs.slice(1)) removeNode(r);
  for (const p of paras.slice(1)) removeNode(p);
  setRunText(first, text);
  const rPr = wChild(first, 'rPr');
  const rStyle = wChild(rPr, 'rStyle');
  if (rStyle && /placeholder/i.test(wAttr(rStyle) ?? '')) removeNode(rStyle);
  if (hint) restyleHintRun(first);
}

function fillField(t: Extract<SlotTarget, { t: 'field' }>, text: string): void {
  const first = t.nodes[0];
  if (!first || !first.parentNode) return;
  const run = createW(first.ownerDocument!, 'r');
  if (t.resultRPr) run.appendChild(t.resultRPr.cloneNode(true));
  setRunText(run, text);
  first.parentNode.insertBefore(run, first);
  for (const n of t.nodes) removeNode(n);
}

function shrinkBlockMargins(tc: Element): void {
  const mar = wChild(wChild(tc, 'tcPr'), 'tcMar');
  if (!mar) return;
  const top = wChild(mar, 'top');
  const bottom = wChild(mar, 'bottom');
  const big = (el: Element | undefined): boolean => Number(wAttr(el, 'w') ?? 0) >= 1000;
  if (big(top) || big(bottom)) {
    for (const el of [top, bottom]) {
      if (el) {
        setWAttr(el, 'w', '120');
        setWAttr(el, 'type', 'dxa');
      }
    }
  }
}

function cellShading(tr: Element): string {
  return wChildren(tr, 'tc')
    .map((tc) => wAttr(wChild(wChild(tc, 'tcPr'), 'shd'), 'fill') ?? '')
    .join(',');
}

function setCellText(tc: Element, text: string, valueRunStyle?: RunStyle | null): void {
  let p = wChildren(tc, 'p')[0];
  if (!p) {
    p = createW(tc.ownerDocument!, 'p');
    tc.appendChild(p);
  }
  // A cell that already holds text (numbering column) is overwritten in its first run.
  const runs = paragraphRuns(p);
  const withText = runs.find((r) => runText(r).length > 0);
  if (withText) {
    setRunText(withText, text);
    for (const r of runs) if (r !== withText && runText(r).length > 0) setRunText(r, '');
    return;
  }
  fillEmptyParagraph(p, text, valueRunStyle);
}

function fillTable(t: Extract<SlotTarget, { t: 'table' }>, rows: Array<Record<string, string>>, valueRunStyle?: RunStyle | null): void {
  const dataRows = [...t.rows];
  const n = dataRows.length;
  if (rows.length > n && n > 0) {
    const period = n >= 2 && cellShading(dataRows[n - 1]!) !== cellShading(dataRows[n - 2]!) ? 2 : 1;
    const sources = dataRows.slice(n - period).map((r) => r.cloneNode(true) as Element);
    let after: Element = dataRows[n - 1]!;
    for (let k = 0; k < rows.length - n; k++) {
      const clone = sources[k % period]!.cloneNode(true) as Element;
      if (t.totalRow && t.totalRow.parentNode) t.totalRow.parentNode.insertBefore(clone, t.totalRow);
      else insertAfter(clone, after);
      after = clone;
      dataRows.push(clone);
    }
  }
  dataRows.forEach((tr, i) => {
    const cells = wChildren(tr, 'tc');
    if (t.numCol === 0 && i >= n && cells[0]) setCellText(cells[0], String(i + 1), valueRunStyle);
    const values = rows[i];
    if (!values) return;
    t.colSlugs.forEach((slug, j) => {
      const v = values[slug];
      const tc = cells[t.colCells[j] ?? -1];
      if (v === undefined || v === '' || !tc) return;
      setCellText(tc, cleanValue(v), valueRunStyle);
    });
  });
}

const NUMBER_RUN = /^(\s*)(\d+)\.(\s*)$/;

function numberRunOf(p: Element): Element | undefined {
  const run = paragraphRuns(p).find((r) => runText(r).trim().length > 0);
  return run && NUMBER_RUN.test(runText(run)) ? run : undefined;
}

/** Number the paragraphs 1..n in order; `skip` (headings, tables) take no number and do not advance the count. */
function renumber(paras: Element[], skip: Set<number> = new Set()): void {
  let start: number | undefined;
  let n = 0;
  paras.forEach((p, i) => {
    if (skip.has(i)) return;
    const run = numberRunOf(p);
    if (!run) return;
    const mm = NUMBER_RUN.exec(runText(run))!;
    if (start === undefined) start = Number(mm[2]);
    const t = wChildren(run, 't')[0];
    if (t) setTText(t, `${mm[1]}${start + n}.${mm[3]}`);
    n += 1;
  });
}

/** Drop the leading tab that separates the number from the text (a w:tab element or a '\t' in the first w:t). */
function stripLeadingTab(p: Element): void {
  for (const r of paragraphRuns(p)) {
    for (const c of childElements(r)) {
      const name = c.localName ?? '';
      if (name === 'rPr') continue;
      if (name === 'tab') {
        removeNode(c);
        return;
      }
      if (name === 't') {
        const txt = c.textContent ?? '';
        if (txt === '') continue;
        if (txt.startsWith('\t')) setTText(c, txt.slice(1));
        return;
      }
      return;
    }
  }
}

/** Insert w:b in schema order (after rStyle / rFonts). */
function addBold(rPr: Element): void {
  if (wChild(rPr, 'b')) return;
  const b = createW(rPr.ownerDocument!, 'b');
  const after = childElements(rPr).filter((c) => isW(c, 'rStyle') || isW(c, 'rFonts')).pop();
  if (after) insertAfter(b, after);
  else rPr.insertBefore(b, rPr.firstChild);
}

/** A numbered paragraph → an unnumbered heading in the number's own style (bold, navy), flush with the margin. */
function toHeadingParagraph(p: Element): void {
  const num = numberRunOf(p);
  const numRPr = num ? wChild(num, 'rPr') : undefined;
  if (num) removeNode(num);
  stripLeadingTab(p);
  for (const r of paragraphRuns(p)) {
    const old = wChild(r, 'rPr');
    if (numRPr) {
      const rPr = numRPr.cloneNode(true) as Element;
      if (old) r.replaceChild(rPr, old);
      else r.insertBefore(rPr, r.firstChild);
    } else {
      addBold(old ?? (r.insertBefore(createW(r.ownerDocument!, 'rPr'), r.firstChild) as Element));
    }
  }
  const doc = p.ownerDocument!;
  let pPr = wChild(p, 'pPr');
  if (!pPr) pPr = p.insertBefore(createW(doc, 'pPr'), p.firstChild) as Element;
  const ind = wChild(pPr, 'ind');
  if (ind) {
    setWAttr(ind, 'left', '0');
    setWAttr(ind, 'hanging', '0');
  }
  if (!wChild(pPr, 'keepNext')) {
    const keep = createW(doc, 'keepNext');
    const style = wChild(pPr, 'pStyle');
    if (style) insertAfter(keep, style);
    else pPr.insertBefore(keep, pPr.firstChild);
  }
}

const MONEY_CELL = /^\(?[-−–]?\s*£|^[-−]?[\d,]+\.\d{2}$/;

function bodyTextWidth(p: Element): number {
  const body = p.ownerDocument ? wDescendants(p.ownerDocument, 'body')[0] : undefined;
  const sect = body ? wChildren(body, 'sectPr')[0] : undefined;
  const w = Number(wAttr(wChild(sect, 'pgSz'), 'w') ?? 11906);
  const mar = wChild(sect, 'pgMar');
  const left = Number(wAttr(mar, 'left') ?? 1134);
  const right = Number(wAttr(mar, 'right') ?? 1134);
  const width = w - left - right;
  return Number.isFinite(width) && width > 2000 ? width : 9638;
}

/** A numbered paragraph → a real Word table (rows of cells), in the paragraph's text style, indented like the body. */
function toTableInPlace(p: Element, table: { rows: string[][]; headerRows?: number }): void {
  const doc = p.ownerDocument!;
  const runs = paragraphRuns(p).filter((r) => runText(r).trim().length > 0);
  const num = numberRunOf(p);
  const textRun = runs.filter((r) => r !== num).pop() ?? runs[runs.length - 1];
  const textRPr = textRun ? wChild(textRun, 'rPr') : undefined;
  const ind = Number(wAttr(wChild(wChild(p, 'pPr'), 'ind'), 'left') ?? 0) || 0;
  const cols = Math.max(1, ...table.rows.map((r) => r.length));
  const avail = Math.max(2000, bodyTextWidth(p) - ind);
  const widths = cols === 1 ? [avail] : [Math.round(avail * 0.46), ...Array.from({ length: cols - 1 }, () => Math.floor((avail - Math.round(avail * 0.46)) / (cols - 1)))];
  const el = (name: string, attrs: Record<string, string> = {}, children: Element[] = []): Element => {
    const e = createW(doc, name);
    for (const [k, v] of Object.entries(attrs)) setWAttr(e, k, v);
    for (const c of children) e.appendChild(c);
    return e;
  };
  const border = (name: string) => el(name, { val: 'single', sz: '4', space: '0', color: 'D0D5DD' });
  const tbl = el('tbl', {}, [
    el('tblPr', {}, [
      el('tblW', { w: String(avail), type: 'dxa' }),
      el('tblInd', { w: String(ind), type: 'dxa' }),
      el('tblBorders', {}, [border('top'), border('bottom'), border('insideH')]),
      el('tblLayout', { type: 'fixed' }),
      el('tblCellMar', {}, [el('left', { w: '60', type: 'dxa' }), el('right', { w: '60', type: 'dxa' })])
    ]),
    el('tblGrid', {}, widths.map((w) => el('gridCol', { w: String(w) })))
  ]);
  const header = table.headerRows ?? 0;
  // a column of amounts is right-aligned throughout (its heading included)
  const moneyCol = Array.from({ length: cols }, (_, ci) => ci > 0 && table.rows.slice(header).some((r) => MONEY_CELL.test((r[ci] ?? '').trim())));
  table.rows.forEach((cells, ri) => {
    const tr = el('tr');
    if (ri < header) tr.appendChild(el('trPr', {}, [el('tblHeader')]));
    for (let ci = 0; ci < cols; ci++) {
      const text = cleanValue(cells[ci] ?? '');
      const pPr = el('pPr', {}, [el('spacing', { before: '30', after: '30' }), ...(moneyCol[ci] ? [el('jc', { val: 'right' })] : [])]);
      const para = el('p', {}, [pPr]);
      if (text) {
        const r = el('r');
        const rPr = textRPr ? (textRPr.cloneNode(true) as Element) : el('rPr');
        if (ri < header) addBold(rPr);
        r.appendChild(rPr);
        r.appendChild(createT(doc, text.replace(/\n+/g, ' ')));
        para.appendChild(r);
      }
      tr.appendChild(el('tc', {}, [el('tcPr', {}, [el('tcW', { w: String(widths[ci]), type: 'dxa' })]), para]));
    }
    tbl.appendChild(tr);
  });
  p.parentNode!.insertBefore(tbl, p);
  // a small gap after the table, in the body's paragraph spacing
  const spacer = el('p', {}, [el('pPr', {}, [el('spacing', { before: '0', after: '120' })])]);
  insertAfter(spacer, tbl);
  removeNode(p);
}

function fillParagraphs(t: Extract<SlotTarget, { t: 'paragraphs' }>, items: string[], replaceFixedLead: boolean, extras: { headings?: number[]; tables?: Array<{ index: number; rows: string[][]; headerRows?: number }> } = {}): void {
  const paras = [...t.paras];
  const ranges = [...t.ranges];
  const last = paras[paras.length - 1]!;
  const lastRange = ranges[ranges.length - 1]!;
  // More items → clone the (pristine) last paragraph first.
  if (items.length > paras.length) {
    const pristine = last.cloneNode(true) as Element;
    let after = last;
    for (let k = paras.length; k < items.length; k++) {
      const clone = pristine.cloneNode(true) as Element;
      insertAfter(clone, after);
      after = clone;
      paras.push(clone);
      ranges.push(lastRange);
    }
  }
  // Fewer items → remove the surplus (never paragraph 1).
  if (items.length < paras.length) {
    const keep = Math.max(1, items.length);
    for (const p of paras.slice(keep)) removeNode(p);
    paras.length = keep;
    ranges.length = keep;
  }
  paras.forEach((p, i) => {
    const item = cleanValue(items[i] ?? '');
    const [bs, be] = ranges[i]!;
    const pt = paragraphText(p);
    if (i === 0 && item === '') {
      const s = bs > 0 && pt.text[bs - 1] === ' ' ? bs - 1 : bs;
      replaceRange(pt, s, be, '');
      return;
    }
    if (i === 0 && replaceFixedLead && t.leadText) {
      const ls = pt.text.indexOf(t.leadText);
      if (ls >= 0 && ls < bs) {
        replaceRange(pt, ls, be, item, { restyleHint: t.hint });
        return;
      }
    }
    replaceRange(pt, bs, be, item, { restyleHint: t.hint });
  });
  const headings = new Set((extras.headings ?? []).filter((i) => i > 0 && i < paras.length));
  const tables = (extras.tables ?? []).filter((x) => x.index > 0 && x.index < paras.length && !headings.has(x.index) && x.rows.length > 0);
  renumber(paras, new Set([...headings, ...tables.map((x) => x.index)]));
  for (const i of headings) toHeadingParagraph(paras[i]!);
  for (const x of tables) toTableInPlace(paras[x.index]!, x);
}

/**
 * A link to anything but http/https/mailto (e.g. javascript:) never reaches a filled document, even from a template
 * stored before the upload gate refused them: its target becomes "#".
 */
function neutraliseUnsafeLinks(pkg: ReturnType<typeof openDocx>): void {
  for (const name of [...pkg.entries.keys()]) {
    if (!name.endsWith('.rels')) continue;
    const raw = decodeUtf8(pkg.entries.get(name)!);
    if (!/hyperlink/i.test(raw)) continue;
    const doc = partDom(pkg, name);
    const rels = doc.getElementsByTagNameNS(NS.rels, 'Relationship');
    let changed = false;
    for (let i = 0; i < rels.length; i++) {
      const r = rels[i]!;
      if (!/\/hyperlink$/.test(r.getAttribute('Type') ?? '')) continue;
      if (safeLinkTarget(r.getAttribute('Target') ?? '')) continue;
      r.setAttribute('Target', '#');
      changed = true;
    }
    if (changed) markDirty(pkg, name);
  }
}

/** Remove a paragraph safely (keeps section properties and the one paragraph a cell must hold). */
function removeParagraph(p: Element): void {
  if (wChild(wChild(p, 'pPr'), 'sectPr')) {
    for (const r of paragraphRuns(p)) removeNode(r);
    return;
  }
  const parent = p.parentNode as Element | null;
  if (parent && isW(parent, 'tc') && wChildren(parent, 'p').length <= 1) {
    for (const c of childElements(p)) if (!isW(c, 'pPr')) removeNode(c);
    return;
  }
  removeNode(p);
}

function removeRow(tr: Element): void {
  const tbl = tr.parentNode as Element | null;
  if (tbl && isW(tbl, 'tbl') && wChildren(tbl, 'tr').length <= 1) {
    const container = tbl.parentNode as Element | null;
    removeNode(tbl);
    if (container && isW(container, 'tc') && wChildren(container, 'p').length === 0) container.appendChild(createW(container.ownerDocument!, 'p'));
    return;
  }
  removeNode(tr);
}

/** The last body element before the final sectPr of word/document.xml (undefined when there is none). */
function lastBodyContent(pkg: ReturnType<typeof openDocx>): { body: Element; el: Element } | undefined {
  if (!pkg.entries.has('word/document.xml')) return undefined;
  const body = wDescendants(partDom(pkg, 'word/document.xml'), 'body')[0];
  if (!body) return undefined;
  const kids = childElements(body).filter((c) => !isW(c, 'sectPr'));
  const el = kids[kids.length - 1];
  return el ? { body, el } : undefined;
}

/** A paragraph with nothing visible in it: no runs, fields, content controls, drawings or section break. */
function isBareParagraph(p: Element): boolean {
  if (!isW(p, 'p')) return false;
  if (wChild(wChild(p, 'pPr'), 'sectPr')) return false;
  return childElements(p).every((c) => isW(c, 'pPr') || isW(c, 'bookmarkStart') || isW(c, 'bookmarkEnd') || isW(c, 'proofErr'));
}

/** Drop bare paragraphs at the end of the body, keeping one after a closing table (Word needs it). */
function trimTrailingEmptyParagraphs(body: Element): boolean {
  let changed = false;
  for (;;) {
    const kids = childElements(body).filter((c) => !isW(c, 'sectPr'));
    const last = kids[kids.length - 1];
    if (!last || !isBareParagraph(last)) break;
    const prev = kids[kids.length - 2];
    if (!prev || isW(prev, 'tbl')) break;
    removeNode(last);
    changed = true;
  }
  return changed;
}

function removeBodyNode(el: Element): void {
  if (isW(el, 'p')) {
    removeParagraph(el);
    return;
  }
  if (isW(el, 'sectPr') || wDescendants(el, 'sectPr').length > 0) return;
  removeNode(el);
}

function kindAccepts(slot: DocxSlot, target: SlotTarget, value: SlotValue): boolean {
  if (value.type === 'remove') return true;
  if (slot.kind === 'checkbox') return value.type === 'check';
  if (slot.kind === 'choice') return value.type === 'choice';
  if (slot.kind === 'table') return value.type === 'rows';
  if (slot.kind === 'paragraphs') return value.type === 'paragraphs';
  if (target.t === 'sdt' && target.checkbox) return value.type === 'check';
  return TEXT_KINDS.has(slot.kind) && value.type === 'text';
}

function isEmptyValue(value: SlotValue): boolean {
  switch (value.type) {
    case 'text':
      return value.text.trim().length === 0;
    case 'choice':
      return value.selected.length === 0 && Object.values(value.blanks ?? {}).every((v) => v.trim().length === 0);
    case 'rows':
      return value.rows.length === 0;
    case 'paragraphs':
      return value.items.length === 0;
    default:
      return false;
  }
}

/** Value text for a blank: drop a leading currency sign when the template prints one. */
function blankText(slot: DocxSlot, text: string): string {
  if (slot.blank?.pattern === 'money' && slot.blank.hasCurrency) return text.replace(/^\s*£\s*/, '');
  return text;
}

export function fillDocx(bytes: Uint8Array, instructions: FillInstruction[], opts: FillOptions): FillResult {
  const pkg = openDocx(bytes);
  const { scan, targets, blockNodes } = scanPackage(pkg);
  const byId = new Map(scan.slots.map((s) => [s.id, s]));
  const report: FillReport = { filled: [], removed: [], skipped: [] };
  // the mapping's own style wins; an uploaded template otherwise inherits its own font (null), a built-in gets the default
  const valueStyle: RunStyle | null | undefined = opts.valueRunStyle ?? (opts.inheritValueStyle ? null : undefined);
  const rangeOps: RangeOp[] = [];
  const later: Array<() => void> = [];
  const removals: Array<() => void> = [];
  const touched = new Set<string>();

  for (const ins of instructions) {
    const slot = byId.get(ins.slotId);
    const tlist = targets.get(ins.slotId);
    if (!slot || !tlist?.length) {
      report.skipped.push({ slotId: ins.slotId, reason: 'NOT_FOUND' });
      continue;
    }
    if (slot.signature) {
      report.skipped.push({ slotId: ins.slotId, reason: 'SIGNATURE_SLOT' });
      continue;
    }
    const value = ins.value;
    if (!kindAccepts(slot, tlist[0]!, value)) {
      report.skipped.push({ slotId: ins.slotId, reason: 'TYPE_MISMATCH' });
      continue;
    }
    if (value.type === 'remove') {
      for (const t of tlist) {
        touched.add(t.part);
        if (value.scope === 'row') {
          const anchor = t.t === 'table' ? t.tbl : targetParagraph(t) ?? (t.t === 'sdt' ? t.sdt : undefined);
          const tr = anchor ? closestW(anchor, 'tr') : undefined;
          if (tr) removals.push(() => removeRow(tr));
          else {
            const p = targetParagraph(t);
            if (p) removals.push(() => removeParagraph(p));
          }
        } else {
          const p = targetParagraph(t);
          if (p) removals.push(() => removeParagraph(p));
          else if (t.t === 'table') removals.push(() => removeNode(t.tbl));
        }
      }
      report.removed.push(slot.id);
      continue;
    }
    if (isEmptyValue(value)) {
      report.skipped.push({ slotId: ins.slotId, reason: 'EMPTY_VALUE' });
      continue;
    }
    // Validate choice options before touching anything.
    if (value.type === 'choice') {
      const slugs = new Set((slot.options ?? []).map((o) => o.slug));
      const unknown = value.selected.some((s) => !slugs.has(s)) || Object.keys(value.blanks ?? {}).some((s) => !slugs.has(s) || !(slot.options ?? []).find((o) => o.slug === s)?.blank);
      if (unknown) {
        report.skipped.push({ slotId: ins.slotId, reason: 'OPTION_NOT_FOUND' });
        continue;
      }
    }

    for (const t of tlist) {
      touched.add(t.part);
      switch (t.t) {
        case 'range': {
          if (value.type !== 'text') break;
          const text = blankText(slot, cleanValue(value.text));
          const { para, start, end, hint } = t;
          rangeOps.push({ para, pos: start, apply: () => replaceRange(paragraphText(para), start, end, text, { restyleHint: hint }) });
          break;
        }
        case 'glyphs': {
          if (value.type === 'check') {
            const pos = t.glyphs[0]!;
            rangeOps.push({ para: t.para, pos, apply: () => glyphSwap(t.para, pos, value.checked) });
          } else if (value.type === 'choice') {
            const selected = new Set(value.selected);
            for (const o of t.options ?? []) {
              if (selected.size > 0) {
                const on = selected.has(o.slug);
                rangeOps.push({ para: t.para, pos: o.glyph, apply: () => glyphSwap(t.para, o.glyph, on) });
              }
              const bv = value.blanks?.[o.slug];
              if (bv !== undefined && bv.trim() !== '' && o.blank) {
                const [s, e] = o.blank;
                const text = cleanValue(bv);
                rangeOps.push({ para: t.para, pos: s, apply: () => replaceRange(paragraphText(t.para), s, e, text) });
              }
            }
          }
          break;
        }
        case 'empty': {
          if (value.type !== 'text') break;
          const text = cleanValue(value.text);
          later.push(() => {
            if (t.run) {
              setRunText(t.run, text);
            } else {
              fillEmptyParagraph(t.para, text, valueStyle);
            }
            if (slot.kind === 'block' && t.cell) shrinkBlockMargins(t.cell);
          });
          break;
        }
        case 'sdt': {
          if (t.checkbox && value.type === 'check') later.push(() => setSdtCheckbox(t.sdt, value.checked));
          else if (value.type === 'text') {
            const text = cleanValue(value.text);
            later.push(() => fillSdtText(t.sdt, text, slot.hint));
          }
          break;
        }
        case 'field': {
          if (value.type !== 'text') break;
          const text = cleanValue(value.text);
          later.push(() => fillField(t, text));
          break;
        }
        case 'table': {
          if (value.type !== 'rows') break;
          later.push(() => fillTable(t, value.rows, valueStyle));
          break;
        }
        case 'paragraphs': {
          if (value.type !== 'paragraphs') break;
          later.push(() => fillParagraphs(t, value.items, value.replaceFixedLead ?? false, { ...(value.headings ? { headings: value.headings } : {}), ...(value.tables ? { tables: value.tables } : {}) }));
          break;
        }
      }
    }
    report.filled.push(slot.id);
  }

  // 1. In-paragraph edits, right to left per paragraph.
  const byPara = new Map<Element, RangeOp[]>();
  for (const op of rangeOps) byPara.set(op.para, [...(byPara.get(op.para) ?? []), op]);
  for (const ops of byPara.values()) {
    ops.sort((a, b) => b.pos - a.pos);
    for (const op of ops) op.apply();
  }
  // 2. Whole-run / structural fills.
  for (const fn of later) fn();
  // 3. Removals. When they take away the end of the body (e.g. empty Enc./Cc. lines), the spacer and rule that only
  // introduced them would otherwise be left behind and can spill onto a page of their own.
  const bodyEnd = removals.length ? lastBodyContent(pkg) : undefined;
  for (const fn of removals) fn();
  if (bodyEnd && !bodyEnd.el.parentNode && trimTrailingEmptyParagraphs(bodyEnd.body)) touched.add('word/document.xml');
  // 4. Blocks (variants).
  for (const prefix of opts.removeBlocks ?? []) {
    for (const b of scan.blocks) {
      if (!b.id.startsWith(prefix)) continue;
      for (const el of blockNodes.get(b.id) ?? []) removeBodyNode(el);
      report.removed.push(`block:${b.id}`);
      touched.add(b.part);
    }
  }
  for (const part of touched) markDirty(pkg, part);
  neutraliseUnsafeLinks(pkg);
  setDocxProperties(pkg, opts.coreProps);
  const docx = writeDocx(pkg, { mtime: opts.now });
  return { docx, sha256: sha256Hex(docx), report };
}
