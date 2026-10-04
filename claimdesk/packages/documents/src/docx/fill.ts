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
import { openDocx, writeDocx } from './zip.js';
import { childElements, closestW, createT, createW, insertAfter, isW, markDirty, NS, removeNode, setTText, setWAttr, stripControlChars, wAttr, wChild, wChildren, wDescendants } from './xml.js';

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
function newValueRun(p: Element, valueRunStyle?: RunStyle): Element {
  const doc = p.ownerDocument!;
  const markRPr = wChild(wChild(p, 'pPr'), 'rPr');
  if (markRPr && childElements(markRPr).some((c) => !['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange'].includes(c.localName ?? ''))) {
    const run = createW(doc, 'r');
    const rPr = markRPr.cloneNode(true) as Element;
    for (const c of childElements(rPr)) if (['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange'].includes(c.localName ?? '')) removeNode(c);
    run.appendChild(rPr);
    return run;
  }
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
function fillEmptyParagraph(p: Element, text: string, valueRunStyle?: RunStyle): void {
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

function setCellText(tc: Element, text: string, valueRunStyle?: RunStyle): void {
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

function fillTable(t: Extract<SlotTarget, { t: 'table' }>, rows: Array<Record<string, string>>, valueRunStyle?: RunStyle): void {
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

function renumber(paras: Element[]): void {
  let start: number | undefined;
  paras.forEach((p, i) => {
    const run = paragraphRuns(p).find((r) => runText(r).trim().length > 0);
    if (!run) return;
    const txt = runText(run);
    const mm = /^(\s*)(\d+)\.(\s*)$/.exec(txt);
    if (!mm) return;
    if (start === undefined) start = Number(mm[2]);
    const t = wChildren(run, 't')[0];
    if (t) setTText(t, `${mm[1]}${start + i}.${mm[3]}`);
  });
}

function fillParagraphs(t: Extract<SlotTarget, { t: 'paragraphs' }>, items: string[], replaceFixedLead: boolean): void {
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
  renumber(paras);
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
              fillEmptyParagraph(t.para, text, opts.valueRunStyle);
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
          later.push(() => fillTable(t, value.rows, opts.valueRunStyle));
          break;
        }
        case 'paragraphs': {
          if (value.type !== 'paragraphs') break;
          later.push(() => fillParagraphs(t, value.items, value.replaceFixedLead ?? false));
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
  // 3. Removals.
  for (const fn of removals) fn();
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
  setDocxProperties(pkg, opts.coreProps);
  const docx = writeDocx(pkg, { mtime: opts.now });
  return { docx, sha256: sha256Hex(docx), report };
}
