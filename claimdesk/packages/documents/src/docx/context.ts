/**
 * Structure walk helpers (§A.5): styles, run formatting, headings (incl. CCGUK-02 banner tables), tables (header rows,
 * column qualifiers, label columns, spacer rows/columns), cells (label-like / value cells, cell headings).
 */
import type { Document, Element } from '@xmldom/xmldom';
import { BANNER_CODE_RE, cleanLabel, findBlanks, isBracketPlaceholder, isDarkFill, isGreyColor, isShaded, LEVEL1_NAMED_RE, LEVEL1_NUMBER_RE, LEVEL1_PART_RE, LEVEL2_CODE_RE, LEVEL2_NUMBER_RE } from './patterns.js';
import { GLYPH_CHARS, normaliseText, paragraphRuns, paragraphText, runText, slugify } from './text.js';
import { childElements, isW, onOff, wAttr, wChild, wChildren, wDescendants } from './xml.js';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

export interface StyleInfo {
  id: string;
  name: string;
  basedOn?: string;
  outlineLvl?: number;
  bold?: boolean;
  caps?: boolean;
  italic?: boolean;
  color?: string;
}

export type StyleMap = Map<string, StyleInfo>;

export function readStyles(doc: Document | undefined): StyleMap {
  const map: StyleMap = new Map();
  if (!doc) return map;
  for (const s of wDescendants(doc, 'style')) {
    const id = wAttr(s, 'styleId');
    if (!id) continue;
    const pPr = wChild(s, 'pPr');
    const rPr = wChild(s, 'rPr');
    const info: StyleInfo = { id, name: (wAttr(wChild(s, 'name')) ?? id).toLowerCase() };
    const basedOn = wAttr(wChild(s, 'basedOn'));
    if (basedOn) info.basedOn = basedOn;
    const ol = wAttr(wChild(pPr, 'outlineLvl'));
    if (ol !== undefined) info.outlineLvl = Number(ol);
    const b = onOff(wChild(rPr, 'b'));
    if (b !== undefined) info.bold = b;
    const caps = onOff(wChild(rPr, 'caps'));
    if (caps !== undefined) info.caps = caps;
    const i = onOff(wChild(rPr, 'i'));
    if (i !== undefined) info.italic = i;
    const color = wAttr(wChild(rPr, 'color'));
    if (color) info.color = color;
    map.set(id, info);
  }
  return map;
}

function styleChain(styles: StyleMap, id: string | undefined): StyleInfo[] {
  const out: StyleInfo[] = [];
  const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const s = styles.get(cur);
    if (!s) break;
    out.push(s);
    cur = s.basedOn;
  }
  return out;
}

function styleProp<K extends 'bold' | 'caps' | 'italic' | 'color' | 'outlineLvl'>(styles: StyleMap, id: string | undefined, key: K): StyleInfo[K] | undefined {
  for (const s of styleChain(styles, id)) if (s[key] !== undefined) return s[key];
  return undefined;
}

export function paragraphStyleId(p: Element): string | undefined {
  return wAttr(wChild(wChild(p, 'pPr'), 'pStyle'));
}

/** Outline level of a paragraph: direct w:outlineLvl, else its style's (incl. heading names). */
export function paragraphOutlineLevel(p: Element, styles: StyleMap): number | undefined {
  const direct = wAttr(wChild(wChild(p, 'pPr'), 'outlineLvl'));
  if (direct !== undefined) return Number(direct);
  const id = paragraphStyleId(p);
  if (!id) return undefined;
  const lvl = styleProp(styles, id, 'outlineLvl');
  if (lvl !== undefined) return lvl;
  const name = styles.get(id)?.name ?? id.toLowerCase();
  if (name === 'title') return -1;
  const mm = /^heading ?(\d)$/.exec(name);
  if (mm) return Number(mm[1]) - 1;
  return undefined;
}

export interface RunFormat {
  bold: boolean;
  caps: boolean;
  italic: boolean;
  color?: string;
}

export function runFormat(run: Element, styles: StyleMap, pStyle?: string): RunFormat {
  const rPr = wChild(run, 'rPr');
  const rStyle = wAttr(wChild(rPr, 'rStyle'));
  const pick = <K extends 'bold' | 'caps' | 'italic'>(el: string, key: K): boolean =>
    onOff(wChild(rPr, el)) ?? (styleProp(styles, rStyle, key) as boolean | undefined) ?? (styleProp(styles, pStyle, key) as boolean | undefined) ?? false;
  const color = wAttr(wChild(rPr, 'color')) ?? styleProp(styles, rStyle, 'color') ?? styleProp(styles, pStyle, 'color');
  const fmt: RunFormat = { bold: pick('b', 'bold'), caps: pick('caps', 'caps'), italic: pick('i', 'italic') };
  if (color && color !== 'auto') fmt.color = color;
  return fmt;
}

/** Runs with visible (non-whitespace) text. */
export function textRuns(p: Element): Element[] {
  return paragraphRuns(p).filter((r) => runText(r).trim().length > 0);
}

export function allRunsBold(p: Element, styles: StyleMap): boolean {
  const runs = textRuns(p);
  const ps = paragraphStyleId(p);
  return runs.length > 0 && runs.every((r) => runFormat(r, styles, ps).bold);
}

export function allRunsBoldOrCaps(p: Element, styles: StyleMap): boolean {
  const runs = textRuns(p);
  const ps = paragraphStyleId(p);
  return runs.length > 0 && runs.every((r) => {
    const f = runFormat(r, styles, ps);
    return f.bold || f.caps || isAllCaps(runText(r));
  });
}

export function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

export function hasGlyph(text: string): boolean {
  for (const ch of text) if (GLYPH_CHARS.has(ch)) return true;
  return false;
}

/** Text has a blank pattern, a glyph or a bracket placeholder (i.e. it is not printed static label text). */
export function hasSlotPattern(text: string): boolean {
  if (hasGlyph(text)) return true;
  if (findBlanks(text, []).length > 0) return true;
  const re = /\[([^[\]\n]{1,160})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (isBracketPlaceholder(m[1] ?? '')) return true;
  return /\{\{.+?\}\}/.test(text);
}

export function hasPageBreakBefore(p: Element): boolean {
  const pPr = wChild(p, 'pPr');
  if (onOff(wChild(pPr, 'pageBreakBefore'))) return true;
  for (const br of wDescendants(p, 'br')) if (wAttr(br, 'type') === 'page') return true;
  return false;
}

export function hasSectPr(p: Element): boolean {
  return !!wChild(wChild(p, 'pPr'), 'sectPr');
}

export function hasBottomBorder(p: Element): boolean {
  const b = wChild(wChild(wChild(p, 'pPr'), 'pBdr'), 'bottom');
  if (!b) return false;
  const v = wAttr(b) ?? 'single';
  return v !== 'none' && v !== 'nil';
}

/** Label-like paragraph inside a container: short printed text, bold/caps/grey or ending with ':'/'?'. */
export function isLabelParagraph(p: Element, styles: StyleMap): boolean {
  const text = normaliseText(paragraphText(p).text);
  if (!text || text.length > 60 || hasSlotPattern(text)) return false;
  if (/[:?]$/.test(text)) return true;
  if (allRunsBoldOrCaps(p, styles)) return true;
  const runs = textRuns(p);
  const ps = paragraphStyleId(p);
  return runs.length > 0 && runs.every((r) => isGreyColor(runFormat(r, styles, ps).color));
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

/** Heading text with placeholders removed (ids must not change when a placeholder in a heading is filled). */
export function headingText(text: string): string {
  return normaliseText(text.replace(/\[[^[\]\n]{1,160}\]/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ').replace(/[\t\n]+/g, ' '));
}

export interface HeadingHit {
  level: 1 | 2;
  title: string;
  slug: string;
}

function nextNonEmptySibling(el: Element): Element | undefined {
  for (let n = el.nextSibling; n; n = n.nextSibling) {
    if (isW(n, 'p')) {
      if (normaliseText(paragraphText(n).text).length === 0 && !wDescendants(n, 'drawing').length) continue;
      return n;
    }
    if (isW(n, 'tbl') || isW(n, 'sdt')) return n;
  }
  return undefined;
}

/** Heading detection for a body paragraph (not inside a table, no checkbox glyph). */
export function detectHeading(p: Element, styles: StyleMap): HeadingHit | undefined {
  const raw = paragraphText(p).text;
  const text = normaliseText(raw);
  if (!text || hasGlyph(text)) return undefined;
  const title = headingText(raw);
  if (!title) return undefined;
  const hit = (level: 1 | 2): HeadingHit => ({ level, title, slug: slugify(title) });
  const ol = paragraphOutlineLevel(p, styles);
  const raw1 = raw.replace(/^\s+/, '');
  if (ol === -1 || ol === 0) return hit(1);
  if (LEVEL1_NUMBER_RE.test(raw1) || LEVEL1_PART_RE.test(text) || LEVEL1_NAMED_RE.test(text)) return hit(1);
  if (ol === 1) return hit(2);
  if (LEVEL2_CODE_RE.test(text)) return hit(2);
  const bold = allRunsBold(p, styles);
  if (LEVEL2_NUMBER_RE.test(text) && bold) return hit(2);
  if (bold && text.length <= 90 && !text.endsWith('.')) {
    const next = nextNonEmptySibling(p);
    if (next && isW(next, 'tbl')) return hit(2);
    if (next && isW(next, 'p')) {
      const nt = normaliseText(paragraphText(next).text);
      if (hasGlyph(nt.slice(0, 2)) || isLabelParagraph(next, styles)) return hit(2);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface CellInfo {
  el: Element;
  rowIndex: number;
  index: number;
  /** First grid column. */
  col: number;
  span: number;
  width: number;
  fill?: string;
  vMergeCont: boolean;
  /** Direct paragraphs of the cell. */
  paras: Element[];
  /** Normalised text of the direct paragraphs (joined by a space). */
  text: string;
  hasNestedTable: boolean;
  bottomBorderOnly: boolean;
  tcMar?: { top?: number; bottom?: number };
}

export interface RowInfo {
  el: Element;
  index: number;
  cells: CellInfo[];
  height?: number;
  spacer: boolean;
}

export interface TableInfo {
  el: Element;
  grid: number[];
  rows: RowInfo[];
  headerRow: boolean;
  /** Grid column → header cell (only when headerRow). */
  headerByCol: Map<number, CellInfo>;
  labelColumns: Set<number>;
  spacerColumns: Set<number>;
}

function twips(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function cellBorderBottomOnly(tcPr: Element | undefined): boolean {
  const b = wChild(tcPr, 'tcBorders');
  if (!b) return false;
  const val = (name: string): string | undefined => wAttr(wChild(b, name));
  const on = (v: string | undefined): boolean => v !== undefined && v !== 'none' && v !== 'nil';
  return on(val('bottom')) && !on(val('top')) && !on(val('left')) && !on(val('right')) && !on(val('start')) && !on(val('end'));
}

export function analyseTable(tbl: Element, styles: StyleMap): TableInfo {
  const grid = wChildren(wChild(tbl, 'tblGrid') ?? tbl, 'gridCol').map((g) => twips(wAttr(g, 'w')) ?? 0);
  const rows: RowInfo[] = [];
  wChildren(tbl, 'tr').forEach((tr, rowIndex) => {
    const trPr = wChild(tr, 'trPr');
    let col = Number(wAttr(wChild(trPr, 'gridBefore')) ?? 0) || 0;
    const cells: CellInfo[] = [];
    wChildren(tr, 'tc').forEach((tc, index) => {
      const tcPr = wChild(tc, 'tcPr');
      const span = Number(wAttr(wChild(tcPr, 'gridSpan')) ?? 1) || 1;
      const tcW = wChild(tcPr, 'tcW');
      let width = 0;
      for (let i = col; i < col + span; i++) width += grid[i] ?? 0;
      if (tcW && (wAttr(tcW, 'type') ?? 'dxa') === 'dxa') width = twips(wAttr(tcW, 'w')) ?? width;
      const vm = wChild(tcPr, 'vMerge');
      const vMergeCont = !!vm && wAttr(vm) !== 'restart';
      const paras = wChildren(tc, 'p');
      const text = normaliseText(paras.map((p) => paragraphText(p).text).join(' '));
      const fill = wAttr(wChild(tcPr, 'shd'), 'fill');
      const mar = wChild(tcPr, 'tcMar');
      const info: CellInfo = { el: tc, rowIndex, index, col, span, width, vMergeCont, paras, text, hasNestedTable: wChildren(tc, 'tbl').length > 0, bottomBorderOnly: cellBorderBottomOnly(tcPr) };
      if (fill) info.fill = fill;
      if (mar) {
        const top = twips(wAttr(wChild(mar, 'top'), 'w'));
        const bottom = twips(wAttr(wChild(mar, 'bottom'), 'w'));
        info.tcMar = {};
        if (top !== undefined) info.tcMar.top = top;
        if (bottom !== undefined) info.tcMar.bottom = bottom;
      }
      cells.push(info);
      col += span;
    });
    const h = twips(wAttr(wChild(trPr, 'trHeight')));
    const allEmpty = cells.every((c) => c.text.length === 0 && !c.hasNestedTable);
    const row: RowInfo = { el: tr, index: rowIndex, cells, spacer: h !== undefined && h <= 200 && allEmpty };
    if (h !== undefined) row.height = h;
    rows.push(row);
  });

  const info: TableInfo = { el: tbl, grid, rows, headerRow: false, headerByCol: new Map(), labelColumns: new Set(), spacerColumns: new Set() };
  const row0 = rows[0];
  if (row0 && rows.length > 1) {
    const tblHeader = onOff(wChild(wChild(row0.el, 'trPr'), 'tblHeader')) === true;
    const nonEmpty = row0.cells.filter((c) => c.text.length > 0);
    const darkHeader = nonEmpty.length >= 2 && nonEmpty.every((c) => isDarkFill(c.fill));
    info.headerRow = tblHeader || darkHeader;
  }
  if (info.headerRow && row0) {
    for (const c of row0.cells) for (let i = c.col; i < c.col + c.span; i++) info.headerByCol.set(i, c);
    const dataRows = rows.slice(1).filter((r) => !r.spacer);
    const colCount = Math.max(grid.length, ...rows.map((r) => r.cells.reduce((n, c) => Math.max(n, c.col + c.span), 0)));
    for (let col = 0; col < colCount; col++) {
      const cells = dataRows.map((r) => r.cells.find((c) => c.col === col)).filter((c): c is CellInfo => !!c);
      const header = info.headerByCol.get(col);
      if (header && header.col === col && header.text.length === 0 && cells.every((c) => c.text.length === 0)) {
        info.spacerColumns.add(col);
        continue;
      }
      if (cells.length === 0) continue;
      const nonEmpty = cells.filter((c) => c.text.length > 0);
      if (nonEmpty.length * 2 >= cells.length && nonEmpty.length > 0 && !nonEmpty.some((c) => hasSlotPattern(c.text))) info.labelColumns.add(col);
    }
  }
  void styles;
  return info;
}

/** Value cell (§A.5): empty, or exactly a blank pattern, `£`, `CCG-`, or a bracket placeholder. */
export function isValueCell(c: CellInfo): boolean {
  if (c.hasNestedTable) return false;
  const t = c.text;
  if (t.length === 0) return true;
  if (t === '£' || t === 'CCG-') return true;
  const blanks = findBlanks(t, []);
  if (blanks.length === 1 && blanks[0]!.start === 0 && blanks[0]!.end === t.length) return true;
  const br = /^\[([^[\]\n]{1,160})\]$/.exec(t);
  return !!br && isBracketPlaceholder(br[1] ?? '');
}

/** Label-like cell (§A.5) — plus: printed text only (no glyph/blank/bracket). */
export function isLabelLikeCell(c: CellInfo, table: TableInfo, styles: StyleMap): boolean {
  if (c.text.length === 0 || hasSlotPattern(c.text)) return false;
  if (isShaded(c.fill)) return true;
  if (/[:?]$/.test(c.text)) return true;
  if (c.paras.some((p) => textRuns(p).length > 0) && c.paras.filter((p) => textRuns(p).length > 0).every((p) => allRunsBoldOrCaps(p, styles))) return true;
  return table.headerRow && table.labelColumns.has(c.col);
}

export function isNarrow(c: CellInfo): boolean {
  return c.width > 0 && c.width < 400;
}

/** Cell label for a cell in a table row (see scan.ts for the full rule). */
export function cellLabel(cell: CellInfo, row: RowInfo, table: TableInfo, styles: StyleMap): { label?: string; qualifier?: string; qualifierTitle?: string } {
  const out: { label?: string; qualifier?: string; qualifierTitle?: string } = {};
  if (table.headerRow && row.index > 0) {
    const h = table.headerByCol.get(cell.col);
    if (h && h.text && h !== cell) {
      out.qualifier = slugify(h.text);
      out.qualifierTitle = h.text;
    }
    // Leftmost cell of the contiguous run of label-column cells to the left (value columns are skipped).
    let found: CellInfo | undefined;
    for (let i = cell.index - 1; i >= 0; i--) {
      const c = row.cells[i]!;
      if (table.spacerColumns.has(c.col)) break;
      if (table.labelColumns.has(c.col) && c.text.length > 0) {
        found = c;
        for (let j = i - 1; j >= 0; j--) {
          const d = row.cells[j]!;
          if (table.labelColumns.has(d.col) && d.text.length > 0 && !table.spacerColumns.has(d.col)) found = d;
          else break;
        }
        break;
      }
    }
    if (!found) {
      for (let i = cell.index - 1; i >= 0; i--) {
        const c = row.cells[i]!;
        if (isLabelLikeCell(c, table, styles)) {
          found = c;
          break;
        }
      }
    }
    if (found) out.label = found.text;
    else if (row.cells[0] && row.cells[0] !== cell && row.cells[0].text && !hasSlotPattern(row.cells[0].text)) out.label = row.cells[0].text;
    return out;
  }
  for (let i = cell.index - 1; i >= 0; i--) {
    const c = row.cells[i]!;
    if (isLabelLikeCell(c, table, styles)) {
      out.label = c.text;
      return out;
    }
  }
  const first = row.cells[0];
  if (first && first !== cell && first.text && !hasSlotPattern(first.text)) out.label = first.text;
  return out;
}

/** Cell heading (§A.5): first paragraph all caps / all bold, ≤ 60 chars, followed by label paragraphs. */
export function cellHeading(cell: CellInfo, styles: StyleMap): { slug: string; title: string; para: Element } | undefined {
  const idx = cell.paras.findIndex((p) => normaliseText(paragraphText(p).text).length > 0);
  const first = cell.paras[idx];
  const second = cell.paras[idx + 1];
  if (!first || !second || normaliseText(paragraphText(second).text).length === 0) return undefined;
  const text = normaliseText(paragraphText(first).text);
  if (text.length > 60 || hasSlotPattern(text)) return undefined;
  if (!(isAllCaps(text) || allRunsBold(first, styles))) return undefined;
  if (!isLabelParagraph(second, styles)) return undefined;
  const title = cleanLabel(text);
  return { slug: slugify(title), title, para: first };
}

/** Banner table (CCGUK-02): one row, first (non-narrow) cell dark-filled holding `PART A` / `A1`. */
export function bannerTitle(tbl: Element): string | undefined {
  const rows = wChildren(tbl, 'tr');
  if (rows.length !== 1) return undefined;
  const cells = wChildren(rows[0]!, 'tc');
  let i = 0;
  const textOf = (tc: Element): string => normaliseText(wChildren(tc, 'p').map((p) => paragraphText(p).text).join(' '));
  const widthOf = (tc: Element): number => twips(wAttr(wChild(wChild(tc, 'tcPr'), 'tcW'), 'w')) ?? 1000;
  while (i < cells.length && widthOf(cells[i]!) < 400 && textOf(cells[i]!).length === 0) i++;
  const codeCell = cells[i];
  const next = cells[i + 1];
  if (!codeCell || !next) return undefined;
  const fill = wAttr(wChild(wChild(codeCell, 'tcPr'), 'shd'), 'fill');
  if (!isDarkFill(fill)) return undefined;
  const code = textOf(codeCell).replace(/\s+/g, ' ');
  if (!BANNER_CODE_RE.test(code.toUpperCase())) return undefined;
  const firstRun = wDescendants(next, 'r').map((r) => runText(r)).find((t) => t.trim().length > 0);
  if (!firstRun) return undefined;
  return `${code.replace(/^PART\s*/i, 'PART ')} ${normaliseText(firstRun)}`;
}

/** Run-level formatting check for a paragraph's first and last runs (inline slots). */
export function inlineLabel(p: Element, styles: StyleMap): { label: string; valueRun: Element } | undefined {
  const runs = paragraphRuns(p);
  if (runs.length < 2) return undefined;
  const first = runs[0]!;
  const last = runs[runs.length - 1]!;
  const firstText = runText(first);
  if (!firstText.trim() || runText(last).length !== 0) return undefined;
  // Everything between the label and the value run must be empty too.
  for (const r of runs.slice(1, -1)) if (runText(r).trim().length > 0) return undefined;
  const f = runFormat(first, styles, paragraphStyleId(p));
  if (!(f.bold || f.caps || isAllCaps(firstText))) return undefined;
  if (!isGreyColor(f.color)) return undefined;
  if (hasSlotPattern(firstText)) return undefined;
  return { label: cleanLabel(firstText), valueRun: last };
}

export function childParagraphsAndTables(container: Element): Element[] {
  return childElements(container).filter((c) => isW(c, 'p') || isW(c, 'tbl') || isW(c, 'sdt'));
}
