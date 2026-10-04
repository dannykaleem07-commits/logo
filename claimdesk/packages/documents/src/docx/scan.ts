/**
 * scanDocx(): slots, blocks, outline, warnings, plain text (§A.5, §A.6).
 *
 * The scanner walks word/document.xml body children in order (headings → sectionPath, tables, cells, blocks), then
 * each header/footer part. Inside each paragraph, detection runs in the normative order: token → control →
 * mergefield → checkbox glyphs → bracket → blank → structural (cell / inline / line / block / table / paragraphs), and
 * a character range claimed by an earlier rule is never re-used. Ids follow the grammar
 * `section/@qualifier/label#ordinal:sub`. The same bytes always give the same ids.
 *
 * `scanPackage()` (engine-internal) also returns live DOM targets for every slot so fillDocx can edit in place.
 */
import type { Element } from '@xmldom/xmldom';
import { analyseTable, bannerTitle, cellHeading, cellLabel, detectHeading, headingText, hasBottomBorder, hasPageBreakBefore, hasSectPr, hasSlotPattern, inlineLabel, isLabelParagraph, isNarrow, isValueCell, paragraphStyleId, readStyles, runFormat, textRuns, type CellInfo, type RowInfo, type StyleMap, type TableInfo } from './context.js';
import { BLOCK_ALIASES, BRACKET_RE, cleanLabel, findBlanks, firstWords, hasLetters, isBracketPlaceholder, isGreyColor, isSignatureLabel, lastWords, TOKEN_RE, type BlankMatch } from './patterns.js';
import { docxPlainTextFromPackage } from './preview.js';
import { checkDocxSafety } from './safety.js';
import { GLYPH_CHARS, isCheckedGlyph, normaliseText, paragraphRuns, paragraphText, runText, slugify, type ParaText } from './text.js';
import { DocxError, SCANNER_VERSION, type BlankPattern, type DocxBlock, type DocxIssue, type DocxLimits, type DocxPackage, type DocxScan, type DocxSlot, type SlotKind } from './types.js';
import { openDocx, resolveLimits } from './zip.js';
import { bodyOf, childElements, closestW, hasPart, isW, listParts, NS, partDom, wAttr, wChild, wChildren, wDescendants } from './xml.js';
import { sha256Hex } from '../hash.js';

// ---------------------------------------------------------------------------
// Targets (engine-internal; fill.ts consumes them)
// ---------------------------------------------------------------------------

export type SlotTarget =
  | { t: 'range'; part: string; para: Element; start: number; end: number; hint: boolean }
  | { t: 'glyphs'; part: string; para: Element; glyphs: number[]; options?: Array<{ slug: string; glyph: number; blank?: [number, number] }> }
  | { t: 'empty'; part: string; para: Element; run?: Element; cell?: Element }
  | { t: 'table'; part: string; tbl: Element; rows: Element[]; colCells: number[]; colSlugs: string[]; numCol: number; totalRow?: Element }
  | { t: 'paragraphs'; part: string; paras: Element[]; ranges: Array<[number, number]>; leadText?: string; hint: boolean }
  | { t: 'sdt'; part: string; sdt: Element; checkbox: boolean }
  | { t: 'field'; part: string; para: Element; nodes: Element[]; resultRPr?: Element };

export interface ScanResult {
  scan: DocxScan;
  /** Slot id → targets (several when a slot is merged across byte-identical header/footer parts). */
  targets: Map<string, SlotTarget[]>;
  /** Block id → body children (document part). */
  blockNodes: Map<string, Element[]>;
}

interface RawSlot {
  kind: SlotKind;
  part: string;
  sectionPath: string[];
  sectionTitles: string[];
  qualifier?: string;
  qualifierTitle?: string;
  label: string;
  /** Paragraph-level group for `sub` numbering (several blanks with the same label in one paragraph). */
  group?: string;
  preview: string;
  blank?: DocxSlot['blank'];
  options?: DocxSlot['options'];
  columns?: DocxSlot['columns'];
  rowCount?: number;
  fixedLead?: string;
  token?: DocxSlot['token'];
  signature: boolean;
  hint: boolean;
  widthTwips?: number;
  multiline: boolean;
  blockId?: string;
  target: SlotTarget;
}

// ---------------------------------------------------------------------------
// Paragraph-level detection
// ---------------------------------------------------------------------------

interface CellCtx {
  info: CellInfo;
  row: RowInfo;
  table: TableInfo;
  label?: string;
  qualifier?: string;
  qualifierTitle?: string;
}

interface ContainerCtx {
  cell?: CellCtx;
  /** Cell heading qualifier (overrides the column qualifier). */
  headingQualifier?: { slug: string; title: string; para: Element };
  /** Label of the last blank seen in the previous paragraph of this container (continuation lines). */
  lastBlankLabel?: string;
}

type ItemKind = 'token' | 'control' | 'mergefield' | 'checkbox' | 'choice' | 'bracket' | 'blank';

interface Item {
  kind: ItemKind;
  start: number;
  /** Coverage end (for label/prose computation). */
  end: number;
  raw: Omit<RawSlot, 'label' | 'sectionPath' | 'sectionTitles' | 'signature' | 'multiline' | 'part'> & { label?: string; multiline?: boolean };
  /** Option text after a single glyph (checkbox). */
  afterText?: string;
}

function boundaryIndex(seg: string): number {
  const res: number[] = [];
  const sep = /[ \u00A0]*·[ \u00A0]*|\t/.exec(seg);
  if (sep) res.push(sep.index);
  const gap = /[ \u00A0]{3,}(?=\S)/.exec(seg);
  if (gap) res.push(gap.index);
  const sentence = /\.[ \u00A0]+(?=[A-Z][a-z])/.exec(seg);
  if (sentence) res.push(sentence.index + 1);
  return res.length ? Math.min(...res) : -1;
}

/** Lead label: a bold first text run (no slot pattern) followed by more text — `STORAGE CHARGE`, `Was anyone injured?`. */
function leadLabel(p: Element, styles: StyleMap, pt: ParaText): { label: string; end: number } | undefined {
  const runs = paragraphRuns(p);
  let offset = 0;
  for (const r of runs) {
    const t = runText(r);
    if (t.trim().length === 0) {
      offset += t.length;
      continue;
    }
    const f = runFormat(r, styles, paragraphStyleId(p));
    if (!f.bold || hasSlotPattern(t) || t.length > 90) return undefined;
    const end = offset + t.length;
    if (pt.text.slice(end).trim().length === 0) return undefined;
    const label = cleanLabel(t);
    return label ? { label, end } : undefined;
  }
  return undefined;
}

function signatureFor(label: string, extra?: string): boolean {
  return isSignatureLabel(label) || (extra !== undefined && /^\W*(signature|signed)\b/i.test(extra.trim()));
}

class Walker {
  readonly slots: RawSlot[] = [];
  readonly outline: Array<{ level: 1 | 2; title: string; slug: string }> = [];
  readonly blocks: DocxBlock[] = [];
  readonly blockNodes = new Map<string, Element[]>();
  paragraphs = 0;
  tables = 0;
  private l1 = { slug: 'title', title: 'Title' };
  private l2: { slug: string; title: string } | undefined;
  private fixed: 'header' | 'footer' | undefined;
  private seenLevel1 = false;
  private block: { start: number; title?: string; slotStart: number } | undefined;
  private blockIds = new Set<string>();
  private part = 'word/document.xml';
  private maxParagraphs: number;

  constructor(readonly styles: StyleMap, limits: DocxLimits) {
    this.maxParagraphs = limits.maxParagraphs;
  }

  sectionPath(): string[] {
    if (this.fixed) return [this.fixed];
    return this.l2 ? [this.l1.slug, this.l2.slug] : [this.l1.slug];
  }

  sectionTitles(): string[] {
    if (this.fixed) return [this.fixed === 'header' ? 'Header' : 'Footer'];
    return this.l2 ? [this.l1.title, this.l2.title] : [this.l1.title];
  }

  private heading(level: 1 | 2, title: string, slug: string): void {
    this.outline.push({ level, title, slug });
    if (level === 1) {
      this.seenLevel1 = true;
      this.l1 = { slug, title };
      this.l2 = undefined;
    } else this.l2 = { slug, title };
    if (this.block && this.block.title === undefined) this.block.title = title;
  }

  private add(raw: Omit<RawSlot, 'sectionPath' | 'sectionTitles' | 'part'> & { part?: string }): void {
    this.slots.push({ ...raw, part: this.part, sectionPath: this.sectionPath(), sectionTitles: this.sectionTitles() } as RawSlot);
  }

  // ----- blocks -----

  private startBlock(index: number): void {
    this.endBlock(index);
    this.block = { start: index, slotStart: this.slots.length };
  }

  private bodyChildren: Element[] | undefined;

  private endBlock(index: number, body: Element[] | undefined = this.bodyChildren): void {
    const b = this.block;
    if (!b) return;
    this.block = undefined;
    if (index <= b.start) return;
    const base = b.title ? slugify(b.title) : 'block';
    let id = BLOCK_ALIASES[base] ?? base;
    if (this.blockIds.has(id)) {
      let n = 2;
      while (this.blockIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    this.blockIds.add(id);
    this.blocks.push({ id, title: b.title ?? 'Block', part: this.part, startIndex: b.start, endIndex: index });
    for (let i = b.slotStart; i < this.slots.length; i++) this.slots[i]!.blockId = id;
    if (body) this.blockNodes.set(id, body.slice(b.start, index));
  }

  // ----- parts -----

  walkDocument(body: Element): void {
    this.part = 'word/document.xml';
    this.fixed = undefined;
    const children = childElements(body);
    this.bodyChildren = children;
    const numbered = this.numberedGroups(children);
    children.forEach((el, i) => {
      if (isW(el, 'p')) {
        if (hasPageBreakBefore(el)) this.startBlock(i);
        this.bodyParagraph(el, children, i, numbered, {});
        if (hasSectPr(el)) this.endBlock(i, children);
      } else if (isW(el, 'tbl')) {
        const banner = bannerTitle(el);
        if (banner) {
          this.heading(1, banner, slugify(banner));
          this.tables++;
          return;
        }
        this.walkTable(el, children, i, {});
      } else if (isW(el, 'sdt')) {
        this.blockSdt(el, {});
      } else if (isW(el, 'sectPr')) {
        this.endBlock(i, children);
      }
    });
    this.endBlock(children.length, children);
  }

  walkHeaderFooter(part: string, root: Element): void {
    this.part = part;
    this.fixed = /footer/.test(part) ? 'footer' : 'header';
    this.walkContainer(root, {});
  }

  /** Walk paragraphs/tables of a container (cell, header, footer, sdtContent). */
  private walkContainer(container: Element, ctx: ContainerCtx): void {
    const children = childElements(container).filter((c) => isW(c, 'p') || isW(c, 'tbl') || isW(c, 'sdt'));
    const numbered = this.numberedGroups(children);
    children.forEach((el, i) => {
      if (isW(el, 'p')) this.bodyParagraph(el, children, i, numbered, ctx);
      else if (isW(el, 'tbl')) this.walkTable(el, children, i, ctx);
      else if (isW(el, 'sdt')) this.blockSdt(el, ctx);
    });
  }

  private blockSdt(sdt: Element, ctx: ContainerCtx): void {
    const sdtPr = wChild(sdt, 'sdtPr');
    const tag = wAttr(wChild(sdtPr, 'tag'));
    const alias = wAttr(wChild(sdtPr, 'alias'));
    const content = wChild(sdt, 'sdtContent');
    if ((tag || alias) && content) {
      const checkbox = !!sdtPr && sdtPr.getElementsByTagNameNS(NS.w14, 'checkbox').length > 0;
      const text = normaliseText(wDescendants(content, 'p').map((p) => paragraphText(p).text).join('\n'));
      const label = alias ?? tag ?? 'control';
      this.add({
        kind: checkbox ? 'checkbox' : 'control',
        label,
        preview: checkbox ? (isSdtChecked(sdt) ? '☒' : '☐') : text,
        signature: isSignatureLabel(label),
        hint: !!wChild(sdtPr, 'showingPlcHdr'),
        multiline: wDescendants(content, 'p').length > 1,
        target: { t: 'sdt', part: this.part, sdt, checkbox }
      });
      return;
    }
    if (content) this.walkContainer(content, ctx);
  }

  // ----- numbered paragraphs ('paragraphs' kind) -----

  private numberedGroups(children: Element[]): Map<Element, Element[]> {
    const groups = new Map<Element, Element[]>();
    let run: Element[] = [];
    const flush = (): void => {
      if (run.length >= 2) groups.set(run[0]!, run);
      run = [];
    };
    for (const el of children) {
      if (isW(el, 'p') && this.numberedParagraph(el)) run.push(el);
      else flush();
    }
    flush();
    return groups;
  }

  private numberedParagraph(p: Element): { number: string; bracket: [number, number]; lead: string } | undefined {
    const runs = textRuns(p);
    const first = runs[0];
    if (!first) return undefined;
    const num = runText(first).trim();
    if (!/^\d+\.$/.test(num)) return undefined;
    if (!runFormat(first, this.styles, paragraphStyleId(p)).bold) return undefined;
    const pt = paragraphText(p);
    const idx = pt.text.indexOf(num);
    const rest = pt.text.slice(idx + num.length);
    if (!rest.startsWith('\t')) return undefined;
    BRACKET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BRACKET_RE.exec(pt.text)) !== null) {
      if (m.index > idx && isBracketPlaceholder(m[1] ?? '')) {
        const lead = pt.text.slice(idx + num.length + 1, m.index).trim();
        return { number: num, bracket: [m.index, m.index + m[0].length], lead };
      }
    }
    return undefined;
  }

  // ----- paragraphs -----

  private bodyParagraph(p: Element, siblings: Element[], index: number, numbered: Map<Element, Element[]>, ctx: ContainerCtx): void {
    this.paragraphs++;
    if (this.paragraphs > this.maxParagraphs) throw new DocxError('TOO_MANY_PARAGRAPHS', `More than ${this.maxParagraphs} paragraphs`, this.part);
    // Numbered paragraphs group.
    for (const [head, group] of numbered) {
      if (group.includes(p)) {
        if (head === p) this.emitParagraphs(group);
        return;
      }
    }
    if (!ctx.cell && !this.fixed) {
      const h = detectHeading(p, this.styles);
      // Text before the first level-1 heading belongs to section `title` (no level-2 headings there).
      if (h && (h.level === 1 || this.seenLevel1)) this.heading(h.level, h.title, h.slug);
    }
    if (ctx.headingQualifier?.para === p) return;
    this.scanParagraph(p, siblings, index, ctx);
  }

  private emitParagraphs(group: Element[]): void {
    const infos = group.map((p) => this.numberedParagraph(p)!);
    const first = infos[0]!;
    const pt0 = paragraphText(group[0]!);
    const bracketRun = pt0.pieces.find((pc) => pc.start <= first.bracket[0] && first.bracket[0] < pc.end)?.run;
    const hint = bracketRun ? this.isHintRun(bracketRun, group[0]!) : false;
    const raw: Omit<RawSlot, 'sectionPath' | 'sectionTitles' | 'part'> = {
      kind: 'paragraphs',
      label: 'paragraphs',
      preview: pt0.text.slice(first.bracket[0], first.bracket[1]),
      rowCount: group.length,
      signature: false,
      hint,
      multiline: true,
      target: { t: 'paragraphs', part: this.part, paras: group, ranges: infos.map((i) => i.bracket), hint, ...(first.lead ? { leadText: first.lead } : {}) }
    };
    if (first.lead) raw.fixedLead = first.lead;
    this.add(raw);
  }

  private isHintRun(run: Element, p: Element): boolean {
    const f = runFormat(run, this.styles, paragraphStyleId(p));
    return f.italic && isGreyColor(f.color);
  }

  /** Context label for a paragraph in a cell: a label paragraph just above it, else the cell's label. */
  private contextLabel(p: Element, siblings: Element[], index: number, ctx: ContainerCtx): string | undefined {
    if (ctx.cell) {
      for (let i = index - 1; i >= 0; i--) {
        const s = siblings[i]!;
        if (!isW(s, 'p')) break;
        const t = normaliseText(paragraphText(s).text);
        if (!t) continue;
        if (ctx.headingQualifier?.para === s) break;
        if (isLabelParagraph(s, this.styles)) return cleanLabel(t);
        break;
      }
      if (ctx.cell.label) return cleanLabel(ctx.cell.label);
    }
    return undefined;
  }

  private qualifierOf(ctx: ContainerCtx): { qualifier?: string; qualifierTitle?: string } {
    if (ctx.headingQualifier) return { qualifier: ctx.headingQualifier.slug, qualifierTitle: ctx.headingQualifier.title };
    if (ctx.cell?.qualifier) return { qualifier: ctx.cell.qualifier, ...(ctx.cell.qualifierTitle ? { qualifierTitle: ctx.cell.qualifierTitle } : {}) };
    return {};
  }

  private scanParagraph(p: Element, siblings: Element[], index: number, ctx: ContainerCtx): void {
    const pt = paragraphText(p);
    const text = pt.text;
    const part = this.part;
    const claimed: Array<[number, number]> = [];
    const items: Item[] = [];
    const overlaps = (s: number, e: number): boolean => claimed.some(([a, b]) => s < b && e > a);
    const pieceRunAt = (pos: number): Element | undefined => pt.pieces.find((pc) => pc.start <= pos && pos < pc.end)?.run;

    // 1. tokens
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      claimed.push([s, e]);
      const token: { key: string; format?: string } = { key: m[1]! };
      if (m[2]) token.format = m[2];
      const run = pieceRunAt(s);
      const hint = run ? this.isHintRun(run, p) : false;
      items.push({ kind: 'token', start: s, end: e, raw: { kind: 'token', label: m[1]!, preview: m[0], token, hint, target: { t: 'range', part, para: p, start: s, end: e, hint } } });
    }

    // 2. inline content controls
    for (const sdt of wDescendants(p, 'sdt')) {
      const sdtPr = wChild(sdt, 'sdtPr');
      const tag = wAttr(wChild(sdtPr, 'tag'));
      const alias = wAttr(wChild(sdtPr, 'alias'));
      if (!tag && !alias) continue;
      const runs = new Set(wDescendants(sdt, 'r'));
      const pcs = pt.pieces.filter((pc) => runs.has(pc.run));
      const s = pcs.length ? pcs[0]!.start : 0;
      const e = pcs.length ? pcs[pcs.length - 1]!.end : 0;
      if (overlaps(s, e)) continue;
      claimed.push([s, Math.max(e, s + 1)]);
      const checkbox = !!sdtPr && sdtPr.getElementsByTagNameNS(NS.w14, 'checkbox').length > 0;
      const label = alias ?? tag ?? 'control';
      items.push({
        kind: 'control',
        start: s,
        end: e,
        raw: { kind: checkbox ? 'checkbox' : 'control', label, preview: checkbox ? (isSdtChecked(sdt) ? '☒' : '☐') : text.slice(s, e), hint: !!wChild(sdtPr, 'showingPlcHdr'), target: { t: 'sdt', part, sdt, checkbox } }
      });
    }

    // 3. merge fields (simple and complex)
    for (const f of findMergeFields(p, pt)) {
      if (overlaps(f.start, Math.max(f.end, f.start + 1))) continue;
      claimed.push([f.start, Math.max(f.end, f.start + 1)]);
      const target: SlotTarget = { t: 'field', part, para: p, nodes: f.nodes };
      if (f.resultRPr) target.resultRPr = f.resultRPr;
      items.push({ kind: 'mergefield', start: f.start, end: f.end, raw: { kind: 'mergefield', label: f.name, preview: text.slice(f.start, f.end), hint: false, target } });
    }

    // 4. checkbox glyphs
    const runRanges: Array<[number, number]> = [];
    for (const r of paragraphRuns(p)) {
      const pcs = pt.pieces.filter((pc) => pc.run === r);
      if (pcs.length) runRanges.push([pcs[0]!.start, pcs[pcs.length - 1]!.end]);
    }
    const glyphs: number[] = [];
    for (let i = 0; i < text.length; i++) if (GLYPH_CHARS.has(text[i]!) && !overlaps(i, i + 1)) glyphs.push(i);
    if (glyphs.length) {
      const candidates = findBlanks(text, claimed, runRanges);
      const groups: Array<{ opts: Array<{ glyph: number; label: string; blank?: BlankMatch; coverEnd: number }> }> = [];
      let cur: (typeof groups)[number] | undefined;
      glyphs.forEach((g, gi) => {
        const nextG = glyphs[gi + 1] ?? text.length;
        const seg = text.slice(g + 1, nextG);
        const b = boundaryIndex(seg);
        const optEnd = b >= 0 ? g + 1 + b : nextG;
        const blank = candidates.find((c) => c.start > g && c.start < optEnd);
        let label: string;
        let coverEnd: number;
        let ends: boolean;
        if (blank) {
          label = text.slice(g + 1, blank.start);
          coverEnd = blank.end;
          ends = b >= 0 || hasLetters(text.slice(blank.end, nextG));
        } else {
          label = text.slice(g + 1, optEnd);
          coverEnd = g + 1 + label.replace(/\s+$/, '').length;
          ends = b >= 0;
        }
        if (!cur) {
          cur = { opts: [] };
          groups.push(cur);
        }
        cur.opts.push({ glyph: g, label: cleanLabel(label), ...(blank ? { blank } : {}), coverEnd });
        if (ends) cur = undefined;
      });
      for (const g of groups) {
        const firstGlyph = g.opts[0]!.glyph;
        if (g.opts.length === 1) {
          const o = g.opts[0]!;
          claimed.push([o.glyph, o.glyph + 1]);
          // A blank inside a lone checkbox's text stays a separate blank slot.
          const labelEnd = o.blank ? o.blank.start : o.coverEnd;
          const after = cleanLabel(text.slice(o.glyph + 1, labelEnd));
          items.push({
            kind: 'checkbox',
            start: o.glyph,
            end: o.glyph + 1,
            afterText: after,
            raw: { kind: 'checkbox', preview: text[o.glyph]!, hint: false, target: { t: 'glyphs', part, para: p, glyphs: [o.glyph] } }
          });
          continue;
        }
        const options: NonNullable<DocxSlot['options']> = [];
        const tOpts: Array<{ slug: string; glyph: number; blank?: [number, number] }> = [];
        const used = new Set<string>();
        for (const o of g.opts) {
          claimed.push([o.glyph, o.glyph + 1]);
          let slug = slugify(o.label || 'option');
          if (used.has(slug)) {
            let n = 2;
            while (used.has(`${slug}-${n}`)) n++;
            slug = `${slug}-${n}`;
          }
          used.add(slug);
          const opt: NonNullable<DocxSlot['options']>[number] = { slug, label: o.label, checked: isCheckedGlyph(text[o.glyph]!) };
          const to: { slug: string; glyph: number; blank?: [number, number] } = { slug, glyph: o.glyph };
          if (o.blank) {
            claimed.push([o.blank.start, o.blank.end]);
            opt.blank = { pattern: o.blank.pattern, text: o.blank.text };
            to.blank = [o.blank.fillStart, o.blank.fillEnd];
          }
          options.push(opt);
          tOpts.push(to);
        }
        const end = g.opts[g.opts.length - 1]!.coverEnd;
        items.push({
          kind: 'choice',
          start: firstGlyph,
          end,
          raw: { kind: 'choice', preview: text.slice(firstGlyph, end), options, hint: false, target: { t: 'glyphs', part, para: p, glyphs: g.opts.map((o) => o.glyph), options: tOpts } }
        });
      }
    }

    // 5. brackets
    BRACKET_RE.lastIndex = 0;
    while ((m = BRACKET_RE.exec(text)) !== null) {
      const inner = m[1] ?? '';
      const s = m.index;
      const e = s + m[0].length;
      if (!isBracketPlaceholder(inner) || overlaps(s, e)) continue;
      claimed.push([s, e]);
      const run = pieceRunAt(s);
      const hint = run ? this.isHintRun(run, p) : false;
      items.push({ kind: 'bracket', start: s, end: e, raw: { kind: 'bracket', label: cleanLabel(inner) || inner, preview: m[0], hint, target: { t: 'range', part, para: p, start: s, end: e, hint } } });
    }

    // 6. blanks (the whole-cell `£` / `CCG-` value cells included)
    const blanks = findBlanks(text, claimed, runRanges);
    const trimmed = text.trim();
    if (blanks.length === 0 && ctx.cell && isValueCell(ctx.cell.info) && (trimmed === '£' || trimmed === 'CCG-')) {
      const s = text.indexOf(trimmed);
      const money = trimmed === '£';
      blanks.push({
        pattern: money ? 'money' : 'reference',
        start: s,
        end: s + trimmed.length,
        text: trimmed,
        fillStart: money ? s + 1 : s,
        fillEnd: s + trimmed.length,
        hasCurrency: money,
        ...(money ? {} : { prefix: 'CCG-' })
      });
    }
    for (const b of blanks) {
      claimed.push([b.start, b.end]);
      const blank: NonNullable<DocxSlot['blank']> = { pattern: b.pattern as BlankPattern, text: b.text, hasCurrency: b.hasCurrency };
      if (b.prefix) blank.prefix = b.prefix;
      if (b.unit) blank.unit = b.unit;
      items.push({ kind: 'blank', start: b.start, end: b.end, raw: { kind: 'blank', preview: b.text, blank, hint: false, target: { t: 'range', part, para: p, start: b.fillStart, end: b.fillEnd, hint: false } } });
    }

    // 7. structural slots (only when nothing above matched)
    if (items.length === 0) {
      this.structuralParagraph(p, pt, siblings, index, ctx);
      ctx.lastBlankLabel = undefined;
      return;
    }

    // Labels, in position order.
    items.sort((a, b) => a.start - b.start);
    const context = this.contextLabel(p, siblings, index, ctx);
    const lead = leadLabel(p, this.styles, pt);
    const leadAdjacent = !!lead && !hasLetters(text.slice(lead.end, items[0]!.start));
    const ctxLabel = context ?? (leadAdjacent ? lead!.label : undefined);
    const sectionSlug = this.sectionPath()[this.sectionPath().length - 1];
    const q = this.qualifierOf(ctx);
    let prevEnd = 0;
    let nonBlankBefore = false;
    let lastBlankLabel: string | undefined;
    const width = ctx.cell?.info.width;
    const multiline = !!ctx.cell && ctx.cell.info.span >= 3;
    items.forEach((it, i) => {
      let prose = text.slice(prevEnd, it.start);
      if (i === 0 && lead && lead.end <= it.start) prose = text.slice(lead.end, it.start);
      const proseLabel = hasLetters(prose) ? lastWords(prose, 6) : '';
      let label = it.raw.label ?? '';
      let sigExtra: string | undefined;
      if (it.kind === 'checkbox') {
        if (i === 0 && !proseLabel && context) label = context;
        else label = it.afterText || ctxLabel || 'checkbox';
      } else if (it.kind === 'choice') {
        if (proseLabel) label = proseLabel;
        else if (ctxLabel) label = ctxLabel;
        else {
          const prev = previousParagraphText(siblings, index);
          const prevIsHeading = !!prev && slugify(headingText(prev)) === sectionSlug;
          label = prev && !prevIsHeading ? lastWords(prev, 6) || 'choice' : 'choice';
        }
      } else if (it.kind === 'blank') {
        if (!nonBlankBefore && ctxLabel) label = ctxLabel;
        else if (proseLabel) label = proseLabel;
        else if (lastBlankLabel) label = lastBlankLabel;
        else {
          const nextStart = items[i + 1]?.start ?? text.length;
          const after = text.slice(it.end, nextStart);
          const afterLabel = hasLetters(after) ? firstWords(after, 4) : '';
          label = afterLabel || (it.start === 0 || !hasLetters(text) ? ctx.lastBlankLabel : undefined) || 'blank';
        }
        sigExtra = prose;
        lastBlankLabel = label;
      }
      const raw = it.raw;
      const sig = it.kind === 'checkbox' || it.kind === 'choice' ? label.length <= 60 && isSignatureLabel(label) : signatureFor(label, sigExtra);
      const qualSig = !!q.qualifierTitle && ctx.headingQualifier !== undefined && isSignatureLabel(q.qualifierTitle);
      const slot: Omit<RawSlot, 'sectionPath' | 'sectionTitles' | 'part'> = {
        ...(raw as Omit<RawSlot, 'sectionPath' | 'sectionTitles' | 'part' | 'label' | 'signature' | 'multiline'>),
        label,
        signature: sig || qualSig,
        multiline: raw.multiline ?? multiline,
        ...q
      };
      if (width) slot.widthTwips = width;
      if (it.kind === 'blank') slot.group = `${this.slots.length}:${slugify(label)}`;
      this.add(slot);
      prevEnd = Math.max(prevEnd, it.end);
      if (it.kind !== 'blank') nonBlankBefore = true;
    });
    // Sub numbering groups: blanks of this paragraph that share a label.
    const mine = this.slots.slice(this.slots.length - items.length).filter((s) => s.kind === 'blank');
    const groupKey = `${this.paragraphs}:${part}`;
    for (const s of mine) s.group = `${groupKey}:${slugify(s.label)}`;
    ctx.lastBlankLabel = lastBlankLabel;
  }

  private structuralParagraph(p: Element, pt: ParaText, siblings: Element[], index: number, ctx: ContainerCtx): void {
    const part = this.part;
    const q = this.qualifierOf(ctx);
    // inline: label run + empty value run
    const inl = inlineLabel(p, this.styles);
    if (inl && inl.label) {
      const slot: Omit<RawSlot, 'sectionPath' | 'sectionTitles' | 'part'> = {
        kind: 'inline',
        label: inl.label,
        preview: '',
        signature: isSignatureLabel(inl.label),
        hint: false,
        multiline: false,
        target: { t: 'empty', part, para: p, run: inl.valueRun },
        ...q
      };
      if (ctx.cell) slot.widthTwips = ctx.cell.info.width;
      this.add(slot);
      return;
    }
    // line: empty bottom-bordered paragraph after a label paragraph in the same cell
    if (ctx.cell && normaliseText(pt.text).length === 0 && hasBottomBorder(p)) {
      const prev = siblings[index - 1];
      if (prev && isW(prev, 'p') && normaliseText(paragraphText(prev).text) && isLabelParagraph(prev, this.styles)) {
        const label = cleanLabel(paragraphText(prev).text);
        const slot: Omit<RawSlot, 'sectionPath' | 'sectionTitles' | 'part'> = {
          kind: 'line',
          label,
          preview: '',
          signature: isSignatureLabel(label),
          hint: false,
          multiline: false,
          target: { t: 'empty', part, para: p },
          ...q
        };
        slot.widthTwips = ctx.cell.info.width;
        this.add(slot);
      }
    }
  }

  // ----- tables -----

  private walkTable(tbl: Element, siblings: Element[], index: number, ctx: ContainerCtx): void {
    this.tables++;
    const info = analyseTable(tbl, this.styles);
    const part = this.part;

    // block: one row, one cell, empty, preceded by a label paragraph
    if (info.rows.length === 1 && info.rows[0]!.cells.length === 1) {
      const cell = info.rows[0]!.cells[0]!;
      if (cell.text.length === 0 && !cell.hasNestedTable && !isNarrow(cell)) {
        const prevText = previousParagraphText(siblings, index);
        if (prevText) {
          const label = prevText.length <= 90 ? cleanLabel(prevText) : (this.fixed ? this.fixed : (this.l2?.title ?? this.l1.title).replace(/^\d{2}\s+/, ''));
          const para = cell.paras[0] ?? ensureParagraph(cell.el);
          const q = this.qualifierOf(ctx);
          this.add({ kind: 'block', label, preview: '', signature: isSignatureLabel(label), hint: false, multiline: true, widthTwips: cell.width, target: { t: 'empty', part, para, cell: cell.el }, ...q });
        }
        return;
      }
    }

    // table: header row + ≥ 2 empty data rows (optional numbering column; trailing Total rows excluded)
    let consumedRows = new Set<RowInfo>();
    if (info.headerRow) {
      const body = info.rows.slice(1).filter((r) => !r.spacer);
      const trailing: RowInfo[] = [];
      while (body.length && /^total\b/i.test(body[body.length - 1]!.cells[0]?.text ?? '')) trailing.unshift(body.pop()!);
      const numCol = body.length > 0 && body.every((r) => /^(\d+\.?)?$/.test(r.cells[0]?.text ?? '')) && body.some((r) => (r.cells[0]?.text ?? '') !== '') ? 0 : -1;
      const dataEmpty = body.length >= 2 && body.every((r) => r.cells.every((c, ci) => (ci === numCol && numCol === 0) || c.text.length === 0) && r.cells.every((c) => !c.hasNestedTable));
      if (dataEmpty) {
        const headerCells = info.rows[0]!.cells.filter((c, ci) => !(numCol === 0 && ci === 0) && !info.spacerColumns.has(c.col) && c.text.length > 0);
        const columns = headerCells.map((c) => ({ slug: slugify(c.text), label: c.text }));
        const colCells = headerCells.map((h) => body[0]!.cells.findIndex((c) => c.col === h.col));
        const label = `table-${slugify(headerCells.slice(0, 2).map((c) => c.text).join(' '))}`;
        const target: SlotTarget = { t: 'table', part, tbl, rows: body.map((r) => r.el), colCells, colSlugs: columns.map((c) => c.slug), numCol };
        if (trailing[0]) target.totalRow = trailing[0].el;
        this.add({ kind: 'table', label, preview: '', columns, rowCount: body.length, signature: false, hint: false, multiline: false, target });
        consumedRows = new Set(body);
      }
    }

    for (const row of info.rows) {
      if (info.headerRow && row.index === 0) continue;
      if (row.spacer || consumedRows.has(row)) continue;
      for (const cell of row.cells) {
        if (isNarrow(cell) || cell.vMergeCont || info.spacerColumns.has(cell.col)) continue;
        const lab = cellLabel(cell, row, info, this.styles);
        const cctx: CellCtx = { info: cell, row, table: info };
        if (lab.label) cctx.label = lab.label;
        if (lab.qualifier) cctx.qualifier = lab.qualifier;
        if (lab.qualifierTitle) cctx.qualifierTitle = lab.qualifierTitle;
        if (isValueCell(cell) && cell.text.length === 0) {
          if (!lab.label) continue;
          const label = cleanLabel(lab.label);
          const para = cell.paras[0] ?? ensureParagraph(cell.el);
          const q: { qualifier?: string; qualifierTitle?: string } = {};
          if (lab.qualifier) q.qualifier = lab.qualifier;
          if (lab.qualifierTitle) q.qualifierTitle = lab.qualifierTitle;
          this.add({
            kind: cell.bottomBorderOnly ? 'line' : 'cell',
            label,
            preview: '',
            signature: isSignatureLabel(label),
            hint: false,
            multiline: cell.span >= 3,
            widthTwips: cell.width,
            target: { t: 'empty', part, para, cell: cell.el },
            ...q
          });
          continue;
        }
        const heading = cellHeading(cell, this.styles);
        const inner: ContainerCtx = { cell: cctx };
        if (heading) inner.headingQualifier = heading;
        this.walkContainer(cell.el, inner);
      }
    }
  }
}

function previousParagraphText(siblings: Element[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const s = siblings[i]!;
    if (!isW(s, 'p')) return undefined;
    const t = normaliseText(paragraphText(s).text);
    if (t) return t;
  }
  return undefined;
}

function ensureParagraph(tc: Element): Element {
  const p = tc.ownerDocument!.createElementNS(NS.w, 'w:p');
  tc.appendChild(p);
  return p;
}

export function isSdtChecked(sdt: Element): boolean {
  const cb = wChild(sdt, 'sdtPr')?.getElementsByTagNameNS(NS.w14, 'checked')[0];
  if (!cb) return false;
  const v = cb.getAttributeNS(NS.w14, 'val') ?? cb.getAttribute('w14:val');
  return v === '1' || v === 'true';
}

interface MergeFieldHit {
  name: string;
  start: number;
  end: number;
  nodes: Element[];
  resultRPr?: Element;
}

function mergeFieldName(instr: string): string | undefined {
  const mm = /^\s*MERGEFIELD\s+("([^"]+)"|(\S+))/i.exec(instr);
  return mm ? (mm[2] ?? mm[3]) : undefined;
}

/** MERGEFIELDs in a paragraph: w:fldSimple and complex fields (begin … instrText … separate … result … end). */
function findMergeFields(p: Element, pt: ParaText): MergeFieldHit[] {
  const out: MergeFieldHit[] = [];
  const rangeOf = (runs: Set<Element>): [number, number] => {
    const pcs = pt.pieces.filter((pc) => runs.has(pc.run));
    return pcs.length ? [pcs[0]!.start, pcs[pcs.length - 1]!.end] : [0, 0];
  };
  for (const fs of wDescendants(p, 'fldSimple')) {
    const name = mergeFieldName(wAttr(fs, 'instr') ?? '');
    if (!name) continue;
    const runs = new Set(wChildren(fs, 'r'));
    const [s, e] = rangeOf(runs);
    const hit: MergeFieldHit = { name, start: s, end: e, nodes: [fs] };
    const rPr = wChild(wChildren(fs, 'r')[0], 'rPr');
    if (rPr) hit.resultRPr = rPr;
    out.push(hit);
  }
  const runs = paragraphRuns(p);
  let i = 0;
  while (i < runs.length) {
    const fc = wChild(runs[i]!, 'fldChar');
    if (fc && wAttr(fc, 'fldCharType') === 'begin') {
      const nodes: Element[] = [runs[i]!];
      let instr = '';
      let sep = false;
      const result = new Set<Element>();
      let j = i + 1;
      let depth = 0;
      for (; j < runs.length; j++) {
        const r = runs[j]!;
        nodes.push(r);
        const f = wChild(r, 'fldChar');
        const type = f ? wAttr(f, 'fldCharType') : undefined;
        if (type === 'begin') depth++;
        if (type === 'end') {
          if (depth === 0) break;
          depth--;
        }
        if (type === 'separate' && depth === 0) {
          sep = true;
          continue;
        }
        if (!sep) for (const it of wChildren(r, 'instrText')) instr += it.textContent ?? '';
        else if (!f) result.add(r);
      }
      const name = mergeFieldName(instr);
      if (name) {
        const [s, e] = result.size ? rangeOf(result) : rangeOf(new Set(nodes));
        const hit: MergeFieldHit = { name, start: s, end: result.size ? e : s, nodes };
        const firstResult = [...result][0];
        const rPr = wChild(firstResult, 'rPr');
        if (rPr) hit.resultRPr = rPr;
        out.push(hit);
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

function assignIds(raws: RawSlot[]): Array<{ slot: DocxSlot; target: SlotTarget }> {
  const counters = new Map<string, number>();
  const groupOrdinal = new Map<string, number>();
  const groupCount = new Map<string, number>();
  const groupSeen = new Map<string, number>();
  for (const r of raws) if (r.group) groupCount.set(r.group, (groupCount.get(r.group) ?? 0) + 1);
  const out: Array<{ slot: DocxSlot; target: SlotTarget }> = [];
  for (const r of raws) {
    const labelSlug = r.kind === 'table' || r.kind === 'paragraphs' ? (r.kind === 'paragraphs' ? 'paragraphs' : r.label) : slugify(r.label);
    const key = `${r.sectionPath.join('/')}|${r.qualifier ?? ''}|${labelSlug}`;
    let ordinal: number;
    if (r.group && groupOrdinal.has(r.group)) ordinal = groupOrdinal.get(r.group)!;
    else {
      ordinal = (counters.get(key) ?? 0) + 1;
      counters.set(key, ordinal);
      if (r.group) groupOrdinal.set(r.group, ordinal);
    }
    let sub: string | undefined;
    if (r.group && (groupCount.get(r.group) ?? 0) > 1) {
      const n = (groupSeen.get(r.group) ?? 0) + 1;
      groupSeen.set(r.group, n);
      sub = String(n);
    }
    let id = r.sectionPath.join('/');
    if (r.qualifier) id += `/@${r.qualifier}`;
    id += `/${labelSlug}`;
    if (ordinal > 1) id += `#${ordinal}`;
    if (sub) id += `:${sub}`;
    const slot: DocxSlot = {
      id,
      kind: r.kind,
      part: r.part,
      sectionPath: r.sectionPath,
      sectionTitles: r.sectionTitles,
      label: r.label,
      labelSlug,
      ordinal,
      preview: r.preview,
      signature: r.signature,
      hint: r.hint,
      multiline: r.multiline
    };
    if (r.qualifier) slot.qualifier = r.qualifier;
    if (r.qualifierTitle) slot.qualifierTitle = r.qualifierTitle;
    if (sub) slot.sub = sub;
    if (r.blank) slot.blank = r.blank;
    if (r.options) slot.options = r.options;
    if (r.columns) slot.columns = r.columns;
    if (r.rowCount !== undefined) slot.rowCount = r.rowCount;
    if (r.fixedLead !== undefined) slot.fixedLead = r.fixedLead;
    if (r.token) slot.token = r.token;
    if (r.widthTwips !== undefined) slot.widthTwips = r.widthTwips;
    if (r.blockId) slot.blockId = r.blockId;
    out.push({ slot, target: r.target });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function partNumber(name: string): number {
  const mm = /(\d+)\.xml$/.exec(name);
  return mm ? Number(mm[1]) : 0;
}

export function headerFooterParts(pkg: DocxPackage): string[] {
  const hdr = listParts(pkg, /^word\/header\d*\.xml$/).sort((a, b) => partNumber(a) - partNumber(b));
  const ftr = listParts(pkg, /^word\/footer\d*\.xml$/).sort((a, b) => partNumber(a) - partNumber(b));
  return [...hdr, ...ftr];
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function scanPackage(pkg: DocxPackage, opts?: { limits?: Partial<DocxLimits>; sha256?: string; warnings?: DocxIssue[] }): ScanResult {
  const t0 = Date.now();
  const limits = resolveLimits(opts?.limits);
  const styles = readStyles(hasPart(pkg, 'word/styles.xml') ? partDom(pkg, 'word/styles.xml') : undefined);
  const walker = new Walker(styles, limits);
  const doc = partDom(pkg, 'word/document.xml');
  walker.walkDocument(bodyOf(doc));
  const bodyRaw = walker.slots.length;

  // Header/footer parts; byte-identical parts merge their slots (02 header1/3/4 → header/ref).
  const hf = headerFooterParts(pkg);
  const primaryOf = new Map<string, string>();
  for (const part of hf) {
    const twin = hf.find((other) => other !== part && primaryOf.get(other) === undefined && hf.indexOf(other) < hf.indexOf(part) && bytesEqual(pkg.entries.get(other), pkg.entries.get(part)));
    if (twin) primaryOf.set(part, twin);
  }
  const twinsOf = new Map<string, string[]>();
  for (const [part, primary] of primaryOf) twinsOf.set(primary, [...(twinsOf.get(primary) ?? []), part]);
  const hfStart = new Map<string, [number, number]>();
  for (const part of hf) {
    if (primaryOf.has(part)) continue;
    const root = partDom(pkg, part).documentElement as unknown as Element;
    const before = walker.slots.length;
    walker.walkHeaderFooter(part, root);
    hfStart.set(part, [before, walker.slots.length]);
  }
  void bodyRaw;

  const assigned = assignIds(walker.slots);
  const slots: DocxSlot[] = [];
  const targets = new Map<string, SlotTarget[]>();
  assigned.forEach(({ slot, target }, idx) => {
    slots.push(slot);
    targets.set(slot.id, [target]);
    // Merge twins: same structure → same slot index within the twin part.
    for (const [primary, [s, e]] of hfStart) {
      if (idx < s || idx >= e) continue;
      const twins = twinsOf.get(primary);
      if (!twins?.length) continue;
      slot.parts = [primary, ...twins];
    }
  });
  // Re-walk twin parts to collect their targets in the same order.
  for (const [primary, twins] of twinsOf) {
    const range = hfStart.get(primary);
    if (!range) continue;
    for (const twin of twins) {
      const w = new Walker(styles, limits);
      w.walkHeaderFooter(twin, partDom(pkg, twin).documentElement as unknown as Element);
      w.slots.forEach((raw, k) => {
        const slot = slots[range[0] + k];
        if (slot) targets.get(slot.id)!.push(raw.target);
      });
    }
  }

  const scan: DocxScan = {
    scannerVersion: SCANNER_VERSION,
    sha256: opts?.sha256 ?? '',
    slots,
    blocks: walker.blocks,
    outline: walker.outline,
    warnings: opts?.warnings ?? [],
    text: docxPlainTextFromPackage(pkg),
    stats: { paragraphs: walker.paragraphs, tables: walker.tables, parts: 1 + hf.length, ms: 0 }
  };
  scan.stats.ms = Date.now() - t0;
  const blockNodes = walker.blockNodes;
  return { scan, targets, blockNodes };
}

export function scanDocx(bytes: Uint8Array, opts?: { limits?: Partial<DocxLimits> }): DocxScan {
  const t0 = Date.now();
  const pkg = openDocx(bytes, opts?.limits);
  const safety = checkDocxSafety(bytes, opts?.limits);
  const warnings = [...safety.warnings];
  for (const e of safety.errors) warnings.push({ ...e, code: `UNSAFE_${e.code}` });
  const { scan } = scanPackage(pkg, { ...(opts?.limits ? { limits: opts.limits } : {}), sha256: sha256Hex(bytes), warnings });
  scan.stats.ms = Date.now() - t0;
  return scan;
}

/** Engine-internal: the paragraph that holds a target (for `remove` scopes). */
export function targetParagraph(t: SlotTarget): Element | undefined {
  switch (t.t) {
    case 'range':
    case 'glyphs':
    case 'empty':
    case 'field':
      return t.para;
    case 'paragraphs':
      return t.paras[0];
    case 'sdt':
      return closestW(t.sdt, 'p') ?? wDescendants(t.sdt, 'p')[0];
    case 'table':
      return undefined;
  }
}
