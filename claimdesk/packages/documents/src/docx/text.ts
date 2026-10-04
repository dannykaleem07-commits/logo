/**
 * Text model (§A.4): normaliseText(), slugify() (normative), the paragraph text model with a run map, and
 * replaceRange() which edits the first run holding a match and trims the rest, so placeholders that Word split across
 * runs (proofErr, rsid changes, spell-check) are handled.
 */
import type { Element, Node } from '@xmldom/xmldom';
import { childElements, createT, createW, insertAfter, isElement, isW, ln, NS, removeNode, setTText, setWAttr, wAttr, wChild } from './xml.js';

/** NFC; U+00A0→space; U+2018/2019→'; U+201C/201D→"; trim; collapse runs of spaces. */
export function normaliseText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\u00A0/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Normative (§A.4): scanner ids and mapping selectors depend on it. */
export function slugify(text: string, max = 48): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛']/g, '')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/£/g, ' gbp ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = s.slice(0, max).replace(/-+$/g, '');
  return cut || 'x';
}

// ---------------------------------------------------------------------------
// Checkbox glyphs (text and Wingdings w:sym)
// ---------------------------------------------------------------------------

export const GLYPH_UNCHECKED = '☐'; // ☐
export const GLYPH_CHECKED = '☒'; // ☒
export const GLYPH_CHECKED_ALT = '☑'; // ☑
export const GLYPH_CHARS = new Set([GLYPH_UNCHECKED, GLYPH_CHECKED, GLYPH_CHECKED_ALT]);

const SYM_FONTS = /^wingdings( 2)?$/i;
const SYM_UNCHECKED = new Set(['F06F', 'F0A8', 'F0A3']);
const SYM_CHECKED = new Set(['F0FD', 'F0FE', 'F078']);

/** '☐' / '☒' for a Wingdings checkbox w:sym, else undefined. */
export function symGlyph(sym: Element): string | undefined {
  const font = wAttr(sym, 'font') ?? '';
  const ch = (wAttr(sym, 'char') ?? '').toUpperCase();
  if (!SYM_FONTS.test(font)) return undefined;
  if (SYM_UNCHECKED.has(ch)) return GLYPH_UNCHECKED;
  if (SYM_CHECKED.has(ch)) return GLYPH_CHECKED;
  return undefined;
}

export function isCheckedGlyph(ch: string): boolean {
  return ch === GLYPH_CHECKED || ch === GLYPH_CHECKED_ALT;
}

// ---------------------------------------------------------------------------
// Paragraph text model
// ---------------------------------------------------------------------------

export interface RunPiece {
  run: Element;
  /** The w:t holding this piece, or null for tab/br/sym pieces. */
  t: Element | null;
  start: number;
  end: number;
  text: string;
  /** Engine extra: the node that produced the piece (w:t, w:tab, w:br, w:cr, w:sym, w:noBreakHyphen). */
  node: Element;
}

export interface ParaText {
  para: Element;
  /** Concatenation of w:t (w:tab → '\t', w:br → '\n'). */
  text: string;
  pieces: RunPiece[];
}

/** Containers inside a paragraph whose runs are part of the visible text. */
const RUN_CONTAINERS = new Set(['hyperlink', 'smartTag', 'sdt', 'sdtContent', 'ins', 'fldSimple', 'customXml', 'moveTo', 'bdo', 'dir']);

/** Runs of a paragraph in document order (descending into hyperlinks, content controls, insertions …). */
export function paragraphRuns(p: Element): Element[] {
  const out: Element[] = [];
  const visit = (el: Element): void => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (!isElement(c) || c.namespaceURI !== NS.w) continue;
      const name = ln(c);
      if (name === 'r') out.push(c);
      else if (RUN_CONTAINERS.has(name)) visit(c);
    }
  };
  visit(p);
  return out;
}

function nodeText(node: Element): string | undefined {
  if (node.namespaceURI !== NS.w) return undefined;
  switch (ln(node)) {
    case 't':
      return node.textContent ?? '';
    case 'tab':
    case 'ptab':
      return '\t';
    case 'br':
    case 'cr':
      return '\n';
    case 'noBreakHyphen':
      return '-';
    case 'sym':
      return symGlyph(node) ?? '';
    default:
      return undefined;
  }
}

export function runText(run: Element): string {
  let s = '';
  for (const c of childElements(run)) {
    const t = nodeText(c);
    if (t !== undefined) s += t;
  }
  return s;
}

export function paragraphText(p: Element): ParaText {
  const pieces: RunPiece[] = [];
  let text = '';
  for (const run of paragraphRuns(p)) {
    for (const c of childElements(run)) {
      const t = nodeText(c);
      if (t === undefined) continue;
      pieces.push({ run, t: ln(c) === 't' ? c : null, start: text.length, end: text.length + t.length, text: t, node: c });
      text += t;
    }
  }
  return { para: p, text, pieces };
}

// ---------------------------------------------------------------------------
// Run properties helpers
// ---------------------------------------------------------------------------

export function runProps(run: Element): Element | undefined {
  return wChild(run, 'rPr');
}

function ensureRPr(run: Element): Element {
  let rPr = wChild(run, 'rPr');
  if (!rPr) {
    rPr = createW(run.ownerDocument!, 'rPr');
    run.insertBefore(rPr, run.firstChild);
  }
  return rPr;
}

/** Drop italics and set the value colour on a run (hint placeholder → filled value). */
export function restyleHintRun(run: Element, color = '3F4552'): void {
  const rPr = ensureRPr(run);
  for (const name of ['i', 'iCs']) {
    const el = wChild(rPr, name);
    if (el) removeNode(el);
  }
  let c = wChild(rPr, 'color');
  if (!c) {
    c = createW(run.ownerDocument!, 'color');
    // Keep CT_RPr order roughly: colour goes before sz/szCs when present.
    const before = wChild(rPr, 'spacing') ?? wChild(rPr, 'w') ?? wChild(rPr, 'kern') ?? wChild(rPr, 'position') ?? wChild(rPr, 'sz') ?? wChild(rPr, 'szCs');
    if (before) rPr.insertBefore(c, before);
    else rPr.appendChild(c);
  }
  setWAttr(c, 'val', color);
  for (const attr of ['themeColor', 'themeTint', 'themeShade']) {
    if (c.hasAttributeNS(NS.w, attr)) c.removeAttributeNS(NS.w, attr);
  }
}

function runHasContent(run: Element): boolean {
  return childElements(run).some((c) => !isW(c, 'rPr'));
}

/** Append `lines` to a run after `ref` (or at the end), with <w:br/> between lines. Returns the last inserted node. */
function appendLines(run: Element, lines: string[], ref: Node | null): Element | undefined {
  const doc = run.ownerDocument!;
  let last: Node | null = ref;
  let lastEl: Element | undefined;
  lines.forEach((line, i) => {
    if (i > 0) {
      const br = createW(doc, 'br');
      if (last) insertAfter(br, last);
      else run.appendChild(br);
      last = br;
      lastEl = br;
    }
    if (line.length > 0 || lines.length === 1) {
      const t = createT(doc, line);
      if (last) insertAfter(t, last);
      else run.appendChild(t);
      last = t;
      lastEl = t;
    }
  });
  return lastEl;
}

/** Insert `<w:br/>line` pairs after `ref` inside a run; returns the last inserted node (or `ref`). */
function insertLinesAfter(run: Element, ref: Node, lines: string[]): Node {
  const doc = run.ownerDocument!;
  let cur = ref;
  for (const line of lines) {
    const br = createW(doc, 'br');
    insertAfter(br, cur);
    cur = br;
    if (line.length > 0) {
      const t = createT(doc, line);
      insertAfter(t, cur);
      cur = t;
    }
  }
  return cur;
}

/** Elements strictly between a and b in document order within the same paragraph (shallow, by sibling walk). */
function removeMarkersBetween(para: Element, from: Element, to: Element): void {
  if (from === to) return;
  const all = para.getElementsByTagNameNS(NS.w, '*');
  let inside = false;
  const doomed: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    if (el === from) {
      inside = true;
      continue;
    }
    if (el === to) break;
    if (inside && (isW(el, 'proofErr') || isW(el, 'bookmarkStart') || isW(el, 'bookmarkEnd'))) doomed.push(el);
  }
  for (const el of doomed) removeNode(el);
}

/**
 * Replace [start,end) of the paragraph text, keeping the rPr of the run that holds `start`; empties/removes the other
 * runs it spans. `\n` in `value` becomes <w:br/>. With `restyleHint`, the value is isolated in its own run (cloned rPr)
 * with italics dropped and colour 3F4552, so neighbouring printed text keeps its style.
 */
export function replaceRange(pt: ParaText, start: number, end: number, value: string, opts?: { restyleHint?: boolean }): void {
  if (end < start) [start, end] = [end, start];
  const lines = value.split('\n');
  const pieces = pt.pieces;
  // The piece that holds `start` (prefer a w:t piece; for an insertion at a boundary take the piece ending there).
  let first = pieces.find((p) => p.start <= start && start < p.end && (start < end || p.t));
  if (!first) first = pieces.find((p) => p.t && p.start <= start && start <= p.end);
  if (!first) first = pieces.find((p) => p.start <= start && start <= p.end);
  if (!first) {
    // Empty paragraph: create a run.
    const doc = pt.para.ownerDocument!;
    const run = createW(doc, 'r');
    appendLines(run, lines, null);
    pt.para.appendChild(run);
    return;
  }
  const others = pieces.filter((p) => p !== first && p.end > start && p.start < end && p.end > p.start);
  const lastTouched = others.length ? others[others.length - 1]!.run : first.run;

  let before: string;
  let after = '';
  if (first.t) {
    before = first.text.slice(0, start - first.start);
    if (end <= first.end) after = first.text.slice(end - first.start);
  } else {
    before = '';
    if (end <= first.start) after = first.text; // insertion before a tab/br/sym keeps it
  }

  const run = first.run;
  let afterRunRef: Element | undefined;
  if (opts?.restyleHint) {
    const doc = run.ownerDocument!;
    const rPr = runProps(run);
    const valueRun = createW(doc, 'r');
    if (rPr) valueRun.appendChild(rPr.cloneNode(true));
    appendLines(valueRun, lines, null);
    restyleHintRun(valueRun);
    // Everything in the original run after the first piece's node moves to an "after" run.
    const tail: Element[] = [];
    let seen = false;
    for (const c of childElements(run)) {
      if (c === first.node) {
        seen = true;
        continue;
      }
      if (seen) tail.push(c);
    }
    let afterRun: Element | undefined;
    if (after.length > 0 || tail.length > 0) {
      afterRun = createW(doc, 'r');
      if (rPr) afterRun.appendChild(rPr.cloneNode(true));
      if (after.length > 0) {
        if (first.t) afterRun.appendChild(createT(doc, after));
        else afterRun.appendChild(first.node.cloneNode(true));
      }
      for (const c of tail) afterRun.appendChild(c);
    }
    if (first.t) {
      if (before.length > 0) setTText(first.t, before);
      else removeNode(first.t);
    } else if (end > first.start) {
      removeNode(first.node);
    } else {
      removeNode(first.node); // re-created in afterRun above
    }
    insertAfter(valueRun, run);
    if (afterRun) insertAfter(afterRun, valueRun);
    afterRunRef = afterRun;
    if (!runHasContent(run)) removeNode(run);
  } else if (first.t) {
    if (lines.length === 1) {
      setTText(first.t, before + value + after);
    } else {
      setTText(first.t, before + lines[0]!);
      let ref: Node = insertLinesAfter(run, first.t, lines.slice(1));
      if (after.length > 0) {
        const t = createT(run.ownerDocument!, after);
        insertAfter(t, ref);
        ref = t;
      }
    }
  } else {
    // The range starts on a tab/br/sym: put the value in a new w:t before it.
    const t = createT(run.ownerDocument!, lines[0]!);
    run.insertBefore(t, first.node);
    insertLinesAfter(run, t, lines.slice(1));
    if (end > first.start) removeNode(first.node);
  }

  // Trim or remove the other pieces in the range.
  for (const p of others) {
    if (p.start >= start && p.end <= end) {
      removeNode(p.node);
      if (p.run !== run && !runHasContent(p.run)) removeNode(p.run);
    } else if (p.t && p.start < end && p.end > end) {
      setTText(p.t, p.text.slice(end - p.start));
    } else if (p.t && p.start < start && p.end > start) {
      setTText(p.t, p.text.slice(0, start - p.start));
    }
  }
  if (afterRunRef && !runHasContent(afterRunRef)) removeNode(afterRunRef);
  if (lastTouched !== run && run.parentNode) removeMarkersBetween(pt.para, run, lastTouched);
  if (!opts?.restyleHint && run.parentNode && !runHasContent(run)) removeNode(run);
}
