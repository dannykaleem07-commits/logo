/**
 * Itemised repair schedule — the appendix the CarFlex report template lacks.
 *
 * `computeSchedule()` turns repair lines (part numbers, operations, labour hours, part prices, paint materials, the
 * source of every figure) into the totals printed in sections 08 (repair estimate) and 09 (repair costs summary), so
 * the appendix and those sections reconcile by construction:
 *
 *   labour (08 Labour Cost = 09 Labour)        Σ labour of body / mechanical / auxiliary lines
 *   parts  (08 Parts Cost)                     Σ part prices of body / mechanical / auxiliary lines
 *   paint  (08 Paint Cost = 09 Paint)          Σ labour + parts of paint lines + Σ paint materials of every line
 *   other  (08 Other Cost)                     Σ other items (sublet, calibration, consumables …)
 *   09 Material                                parts + other
 *   subtotal − discount = net (08 Net Cost = 09 Total excl. VAT); VAT on net; total = net + VAT
 *
 * Money is integer pence throughout; labour hours are kept to 0.01 h and each line's labour is rounded to the penny
 * (category and grand totals are sums of the printed line figures, never re-derived from hours).
 *
 * `appendScheduleAppendix()` writes the schedule into an open DOCX package as "APPENDIX A  ITEMISED REPAIR SCHEDULE"
 * on a landscape page after the last section, styled like the CarFlex tables (navy header row, light rules, Arial).
 * Every line that is not verified is printed "Estimate — needs confirmation" on an amber row.
 */
import type { Document, Element } from '@xmldom/xmldom';
import { formatMoney } from '../format.js';
import type { DocxPackage } from '../docx/types.js';
import { childElements, createT, createW, isW, markDirty, partDom, setWAttr, wAttr, wChild, wChildren, wDescendants } from '../docx/xml.js';

export const DEFAULT_LABOUR_RATE_PENCE = 7250;
export const DEFAULT_VAT_RATE_PERCENT = 20;
export const ESTIMATE_MARK = 'Estimate — needs confirmation';

export type RepairOperation = 'repair' | 'replace' | 'paint' | 'blend' | 'R&I' | 'check';
export type LabourCategory = 'body' | 'mechanical' | 'auxiliary' | 'paint';
export type FigureSource = 'audatex_estimate' | 'owner_library' | 'ai_estimate' | 'manual';

export const REPAIR_OPERATIONS: readonly RepairOperation[] = ['repair', 'replace', 'paint', 'blend', 'R&I', 'check'];
export const LABOUR_CATEGORIES: readonly LabourCategory[] = ['body', 'mechanical', 'auxiliary', 'paint'];
export const FIGURE_SOURCES: readonly FigureSource[] = ['audatex_estimate', 'owner_library', 'ai_estimate', 'manual'];

export const OPERATION_LABEL: Record<RepairOperation, string> = { repair: 'Repair', replace: 'Replace', paint: 'Paint', blend: 'Blend', 'R&I': 'R&I', check: 'Check' };
export const CATEGORY_LABEL: Record<LabourCategory, string> = { body: 'Body', mechanical: 'Mechanical', auxiliary: 'Auxiliary', paint: 'Painting' };
export const SOURCE_LABEL: Record<FigureSource, string> = { audatex_estimate: 'Audatex estimate', owner_library: 'Owner library', ai_estimate: 'AI estimate', manual: 'Manual' };

export interface ScheduleLine {
  /** OEM part number (from an Audatex/Qapter estimate export or the owner's library). */
  partNumber?: string;
  description: string;
  /** 3D damage model zone id (e.g. `front_bumper`). */
  zoneId?: string;
  operation: RepairOperation;
  labourCategory: LabourCategory;
  /** Hours (decimal); kept to 0.01 h. */
  labourHours: number;
  /** Manufacturer / supplier price, pence, excl. VAT. */
  partPricePence: number;
  /** Paint materials, pence, excl. VAT. */
  paintMaterialsPence: number;
  source: FigureSource;
  /** Confirmed by the engineer; anything else prints as an estimate needing confirmation. */
  verified: boolean;
}

/** Costs that are neither parts, labour nor paint (sublet, ADAS calibration, consumables, …). */
export interface OtherItem {
  description: string;
  amountPence: number;
  source: FigureSource;
  verified: boolean;
}

export interface ScheduleOptions {
  /** Default £72.50 (7250). */
  labourRatePence?: number;
  /** Default 20. */
  vatRatePercent?: number;
  /** Overall discount on the subtotal, percent (default 0). */
  discountPercent?: number;
}

export interface ComputedLine extends ScheduleLine {
  /** 1-based line number. */
  no: number;
  labourPence: number;
  lineTotalPence: number;
  needsConfirmation: boolean;
}

export interface ComputedOtherItem extends OtherItem {
  no: number;
  needsConfirmation: boolean;
}

export interface CategoryTotals {
  hours: number;
  labourPence: number;
  /** Section 09 "Material costs" for the row (parts; paint materials + paint-line parts on the Painting row). */
  materialPence: number;
}

export interface RepairTotals {
  /** 08 Parts Cost. */
  partsPence: number;
  /** 08 Labour Cost = 09 Labour. */
  labourPence: number;
  /** 08 Paint Cost = 09 Paint. */
  paintPence: number;
  /** 08 Other Cost. */
  otherPence: number;
  /** 09 Material (= parts + other). */
  materialPence: number;
  /** Σ paint materials (part of paint). */
  paintMaterialsPence: number;
  subtotalPence: number;
  /** Positive amount taken off. */
  discountPence: number;
  /** 08 Net Cost = 09 Total excl. VAT. */
  netPence: number;
  vatPence: number;
  /** 08 Total Repair Cost = 09 TOTAL incl. VAT. */
  totalPence: number;
}

export interface ComputedSchedule {
  lines: ComputedLine[];
  otherItems: ComputedOtherItem[];
  categories: Record<LabourCategory, CategoryTotals>;
  /** Section 09 "Other Items" row. */
  other: { materialPence: number };
  totals: RepairTotals;
  /** Σ line hours. */
  totalHours: number;
  labourRatePence: number;
  vatRatePercent: number;
  discountPercent: number;
  /** Lines + other items not verified. */
  unverifiedCount: number;
}

export class ScheduleError extends Error {
  readonly code = 'SCHEDULE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

function pence(v: number, what: string): number {
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) throw new ScheduleError(`${what} must be a whole number of pence, 0 or more`);
  return v;
}

function percent(v: number | undefined, def: number, what: string): number {
  const x = v ?? def;
  if (!Number.isFinite(x) || x < 0 || x > 100) throw new ScheduleError(`${what} must be between 0 and 100`);
  return x;
}

/** Hours to the nearest 0.01 h, as hundredths (integer). */
function hundredths(h: number, what: string): number {
  if (!Number.isFinite(h) || h < 0 || h > 1000) throw new ScheduleError(`${what} must be between 0 and 1000 hours`);
  return Math.round(h * 100);
}

export function computeSchedule(lines: readonly ScheduleLine[], otherItems: readonly OtherItem[] = [], opts: ScheduleOptions = {}): ComputedSchedule {
  const rate = pence(opts.labourRatePence ?? DEFAULT_LABOUR_RATE_PENCE, 'The labour rate');
  const vatRate = percent(opts.vatRatePercent, DEFAULT_VAT_RATE_PERCENT, 'The VAT rate');
  const discountRate = percent(opts.discountPercent, 0, 'The discount');
  const categories = Object.fromEntries(LABOUR_CATEGORIES.map((c) => [c, { hours: 0, labourPence: 0, materialPence: 0 }])) as Record<LabourCategory, CategoryTotals>;
  const hoursByCat: Record<LabourCategory, number> = { body: 0, mechanical: 0, auxiliary: 0, paint: 0 };
  let partsPence = 0;
  let labourPence = 0;
  let paintPence = 0;
  let paintMaterialsPence = 0;
  let totalHundredths = 0;
  const computed: ComputedLine[] = lines.map((line, i) => {
    const what = `Line ${i + 1}`;
    const description = (line.description ?? '').trim();
    if (!description) throw new ScheduleError(`${what} has no description`);
    if (!REPAIR_OPERATIONS.includes(line.operation)) throw new ScheduleError(`${what} has an unknown operation`);
    if (!LABOUR_CATEGORIES.includes(line.labourCategory)) throw new ScheduleError(`${what} has an unknown labour category`);
    if (!FIGURE_SOURCES.includes(line.source)) throw new ScheduleError(`${what} has an unknown source`);
    const hh = hundredths(line.labourHours, `${what} labour time`);
    const part = pence(line.partPricePence, `${what} part price`);
    const paintMat = pence(line.paintMaterialsPence, `${what} paint materials`);
    const labour = Math.round((hh * rate) / 100);
    const cat = line.labourCategory;
    hoursByCat[cat] += hh;
    totalHundredths += hh;
    categories[cat].labourPence += labour;
    categories.paint.materialPence += paintMat;
    paintMaterialsPence += paintMat;
    if (cat === 'paint') {
      categories.paint.materialPence += part;
      paintPence += labour + part;
    } else {
      categories[cat].materialPence += part;
      partsPence += part;
      labourPence += labour;
    }
    paintPence += paintMat;
    const out: ComputedLine = {
      ...line,
      description,
      labourHours: hh / 100,
      no: i + 1,
      labourPence: labour,
      lineTotalPence: labour + part + paintMat,
      needsConfirmation: line.verified !== true
    };
    return out;
  });
  for (const c of LABOUR_CATEGORIES) categories[c].hours = hoursByCat[c] / 100;
  let otherPence = 0;
  const others: ComputedOtherItem[] = otherItems.map((o, i) => {
    const description = (o.description ?? '').trim();
    if (!description) throw new ScheduleError(`Other item ${i + 1} has no description`);
    if (!FIGURE_SOURCES.includes(o.source)) throw new ScheduleError(`Other item ${i + 1} has an unknown source`);
    otherPence += pence(o.amountPence, `Other item ${i + 1} amount`);
    return { ...o, description, no: computed.length + i + 1, needsConfirmation: o.verified !== true };
  });
  const subtotalPence = partsPence + labourPence + paintPence + otherPence;
  const discountPence = Math.round((subtotalPence * discountRate) / 100);
  const netPence = subtotalPence - discountPence;
  const vatPence = Math.round((netPence * vatRate) / 100);
  return {
    lines: computed,
    otherItems: others,
    categories,
    other: { materialPence: otherPence },
    totals: {
      partsPence,
      labourPence,
      paintPence,
      otherPence,
      materialPence: partsPence + otherPence,
      paintMaterialsPence,
      subtotalPence,
      discountPence,
      netPence,
      vatPence,
      totalPence: netPence + vatPence
    },
    totalHours: totalHundredths / 100,
    labourRatePence: rate,
    vatRatePercent: vatRate,
    discountPercent: discountRate,
    unverifiedCount: computed.filter((l) => l.needsConfirmation).length + others.filter((o) => o.needsConfirmation).length
  };
}

// ---------------------------------------------------------------------------
// Display helpers (shared with carflexReport.ts)
// ---------------------------------------------------------------------------

export function money(p: number): string {
  return formatMoney(p);
}

/** `-£12.34` for a discount (`£0.00` when none). */
export function discountMoney(p: number): string {
  return p > 0 ? `-${formatMoney(p)}` : formatMoney(0);
}

export function hoursText(h: number): string {
  return h.toFixed(2);
}

/** `20.00%` */
export function percentText(p: number): string {
  return `${p.toFixed(2)}%`;
}

export function zoneLabel(zoneId: string | undefined): string {
  if (!zoneId) return '';
  return zoneId.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
}

/** Rows (header + lines + other items + totals) as plain strings — the DOCX table and tests both use it. */
export const SCHEDULE_COLUMNS = ['No.', 'Part number', 'Description', 'Zone', 'Operation', 'Labour', 'Hours', 'Labour £', 'Part price £', 'Paint mat. £', 'Line total £', 'Source', 'Status'] as const;

export function scheduleRows(s: ComputedSchedule): { header: string[]; lines: Array<{ cells: string[]; estimate: boolean }>; totals: string[] } {
  const lines = s.lines.map((l) => ({
    estimate: l.needsConfirmation,
    cells: [
      String(l.no),
      l.partNumber?.trim() || '—',
      l.description,
      zoneLabel(l.zoneId) || '—',
      OPERATION_LABEL[l.operation],
      CATEGORY_LABEL[l.labourCategory],
      hoursText(l.labourHours),
      money(l.labourPence),
      money(l.partPricePence),
      money(l.paintMaterialsPence),
      money(l.lineTotalPence),
      SOURCE_LABEL[l.source],
      l.needsConfirmation ? ESTIMATE_MARK : 'Verified'
    ]
  }));
  for (const o of s.otherItems) {
    lines.push({
      estimate: o.needsConfirmation,
      cells: [String(o.no), '—', o.description, '—', 'Other', '—', '—', '—', '—', '—', money(o.amountPence), SOURCE_LABEL[o.source], o.needsConfirmation ? ESTIMATE_MARK : 'Verified']
    });
  }
  const sumLabour = s.lines.reduce((a, l) => a + l.labourPence, 0);
  const sumParts = s.lines.reduce((a, l) => a + l.partPricePence, 0);
  const sumLines = s.lines.reduce((a, l) => a + l.lineTotalPence, 0) + s.other.materialPence;
  const totals = ['', '', 'Totals (excl. VAT, before discount)', '', '', '', hoursText(s.totalHours), money(sumLabour), money(sumParts), money(s.totals.paintMaterialsPence), money(sumLines), '', s.unverifiedCount ? `${s.unverifiedCount} to confirm` : 'All verified'];
  return { header: [...SCHEDULE_COLUMNS], lines, totals };
}

/** The reconciliation rows printed under the schedule (label, amount). */
export function reconciliationRows(s: ComputedSchedule): Array<[string, string]> {
  const t = s.totals;
  return [
    ['Parts (section 08 Parts Cost)', money(t.partsPence)],
    ['Labour — body, mechanical, auxiliary (section 08 Labour Cost / 09 Labour)', money(t.labourPence)],
    ['Paint — paint labour and materials (section 08 Paint Cost / 09 Paint)', money(t.paintPence)],
    ['Other items (section 08 Other Cost)', money(t.otherPence)],
    [`Discount (${percentText(s.discountPercent)})`, discountMoney(t.discountPence)],
    ['Net cost (section 08 Net Cost / 09 Total excl. VAT)', money(t.netPence)],
    [`VAT (${percentText(s.vatRatePercent)})`, money(t.vatPence)],
    ['TOTAL REPAIR COST incl. VAT', money(t.totalPence)]
  ];
}

// ---------------------------------------------------------------------------
// DOCX appendix
// ---------------------------------------------------------------------------

const NAVY = '102B46';
const BLUE = '0865BF';
const GREY = '5D6E7F';
const RULE = 'D5DFE8';
const BAND = 'F2F6FA';
const AMBER_FILL = 'FFF4E0';
const AMBER_TEXT = 'A34B00';
const GREEN_TEXT = '1E6B3A';

type Attrs = Record<string, string>;

function w(doc: Document, name: string, attrs: Attrs = {}, kids: Element[] = []): Element {
  const e = createW(doc, name);
  for (const [k, v] of Object.entries(attrs)) setWAttr(e, k, v);
  for (const k of kids) e.appendChild(k);
  return e;
}

interface RunOpts {
  bold?: boolean;
  color?: string;
  size?: number;
}

function run(doc: Document, text: string, o: RunOpts = {}): Element {
  const rPr = w(doc, 'rPr', {}, [w(doc, 'rFonts', { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Arial', cs: 'Arial' })]);
  if (o.bold) rPr.appendChild(w(doc, 'b'));
  if (o.color) rPr.appendChild(w(doc, 'color', { val: o.color }));
  const sz = String(o.size ?? 16);
  rPr.appendChild(w(doc, 'sz', { val: sz }));
  rPr.appendChild(w(doc, 'szCs', { val: sz }));
  rPr.appendChild(w(doc, 'lang', { val: 'en-GB' }));
  const r = w(doc, 'r', {}, [rPr]);
  r.appendChild(createT(doc, text));
  return r;
}

function para(doc: Document, runs: Element[], o: { jc?: string; after?: number; before?: number; keepNext?: boolean } = {}): Element {
  const pPr = w(doc, 'pPr');
  if (o.keepNext) pPr.appendChild(w(doc, 'keepNext'));
  pPr.appendChild(w(doc, 'spacing', { before: String(o.before ?? 0), after: String(o.after ?? 0), line: '240', lineRule: 'auto' }));
  if (o.jc) pPr.appendChild(w(doc, 'jc', { val: o.jc }));
  return w(doc, 'p', { }, [pPr, ...runs]);
}

function cell(doc: Document, width: number, content: Element[], o: { fill?: string; span?: number; bottom?: string; top?: string } = {}): Element {
  const tcPr = w(doc, 'tcPr', {}, [w(doc, 'tcW', { w: String(width), type: 'dxa' })]);
  if (o.span && o.span > 1) tcPr.appendChild(w(doc, 'gridSpan', { val: String(o.span) }));
  const borders = w(doc, 'tcBorders');
  borders.appendChild(o.top ? w(doc, 'top', { val: 'single', sz: '8', space: '0', color: o.top }) : w(doc, 'top', { val: 'nil' }));
  borders.appendChild(w(doc, 'left', { val: 'nil' }));
  borders.appendChild(w(doc, 'bottom', { val: 'single', sz: '4', space: '0', color: o.bottom ?? RULE }));
  borders.appendChild(w(doc, 'right', { val: 'nil' }));
  tcPr.appendChild(borders);
  if (o.fill) tcPr.appendChild(w(doc, 'shd', { val: 'clear', color: 'auto', fill: o.fill }));
  tcPr.appendChild(w(doc, 'tcMar', {}, [w(doc, 'top', { w: '50', type: 'dxa' }), w(doc, 'left', { w: '60', type: 'dxa' }), w(doc, 'bottom', { w: '50', type: 'dxa' }), w(doc, 'right', { w: '60', type: 'dxa' })]));
  tcPr.appendChild(w(doc, 'vAlign', { val: 'center' }));
  return w(doc, 'tc', {}, [tcPr, ...content]);
}

function table(doc: Document, widths: number[], rows: Element[]): Element {
  const total = widths.reduce((a, b) => a + b, 0);
  const tblPr = w(doc, 'tblPr', {}, [
    w(doc, 'tblW', { w: String(total), type: 'dxa' }),
    w(doc, 'jc', { val: 'center' }),
    w(doc, 'tblBorders', {}, ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => w(doc, s, { val: 'nil' }))),
    w(doc, 'tblLayout', { type: 'fixed' }),
    w(doc, 'tblLook', { val: '04A0', firstRow: '1', lastRow: '0', firstColumn: '1', lastColumn: '0', noHBand: '0', noVBand: '1' })
  ]);
  const grid = w(doc, 'tblGrid', {}, widths.map((x) => w(doc, 'gridCol', { w: String(x) })));
  return w(doc, 'tbl', {}, [tblPr, grid, ...rows]);
}

function row(doc: Document, cells: Element[], o: { header?: boolean; cantSplit?: boolean } = {}): Element {
  const trPr = w(doc, 'trPr');
  if (o.cantSplit !== false) trPr.appendChild(w(doc, 'cantSplit'));
  if (o.header) trPr.appendChild(w(doc, 'tblHeader'));
  return w(doc, 'tr', {}, [trPr, ...cells]);
}

/** Landscape text width 16838 − 2 × 1134. */
const LANDSCAPE_TEXT = 14570;
const COL_WIDTHS = [400, 1250, 2560, 1100, 1000, 980, 620, 940, 1040, 980, 1060, 1050, 1590];

/** Copy of the template's landscape section properties (section 08/09), or the last section turned landscape. */
function landscapeSectPr(body: Element, last: Element): Element {
  const all = wDescendants(body, 'sectPr');
  const land = all.find((s) => wAttr(wChild(s, 'pgSz'), 'orient') === 'landscape');
  if (land) return land.cloneNode(true) as Element;
  const copy = last.cloneNode(true) as Element;
  const pgSz = wChild(copy, 'pgSz');
  if (pgSz) {
    const pw = wAttr(pgSz, 'w') ?? '11906';
    const ph = wAttr(pgSz, 'h') ?? '16838';
    setWAttr(pgSz, 'w', ph);
    setWAttr(pgSz, 'h', pw);
    setWAttr(pgSz, 'orient', 'landscape');
  }
  return copy;
}

/** Text width of a section (twips). */
function sectTextWidth(sect: Element): number {
  const pw = Number(wAttr(wChild(sect, 'pgSz'), 'w') ?? 16838);
  const mar = wChild(sect, 'pgMar');
  const width = pw - Number(wAttr(mar, 'left') ?? 1134) - Number(wAttr(mar, 'right') ?? 1134);
  return Number.isFinite(width) && width > 4000 ? width : LANDSCAPE_TEXT;
}

/** A heading paragraph in the template's own section-heading style ("13  ASSESSOR …"), or a plain bold one. */
function headingParagraph(doc: Document, body: Element, number: string, title: string): Element {
  const template = childElements(body).find((p) => isW(p, 'p') && wAttr(wChild(wChild(p, 'pPr'), 'pStyle')) === 'Heading1');
  if (template) {
    const p = w(doc, 'p');
    const pPr = wChild(template, 'pPr')!.cloneNode(true) as Element;
    p.appendChild(pPr);
    const runs = wChildren(template, 'r').filter((r) => wChildren(r, 't').length > 0);
    const numRPr = runs[0] ? wChild(runs[0], 'rPr') : undefined;
    const textRPr = runs[1] ? wChild(runs[1], 'rPr') : numRPr;
    for (const [text, rPr] of [
      [`${number}  `, numRPr],
      [title, textRPr]
    ] as const) {
      const r = w(doc, 'r');
      if (rPr) r.appendChild(rPr.cloneNode(true));
      r.appendChild(createT(doc, text));
      p.appendChild(r);
    }
    return p;
  }
  return para(doc, [run(doc, `${number}  `, { color: BLUE, size: 29 }), run(doc, title, { bold: true, color: NAVY, size: 29 })], { after: 240, keepNext: true });
}

export interface AppendixOptions {
  /** Default 'A'. */
  letter?: string;
  /** Default 'ITEMISED REPAIR SCHEDULE'. */
  title?: string;
  /** Report reference printed in the intro line. */
  reference?: string;
}

/**
 * Append the schedule as a landscape appendix after the last section of word/document.xml. The previous last section
 * keeps its own properties (moved into a section-break paragraph); the appendix section uses the template's landscape
 * section properties (same header/footer as 08/09).
 */
export function appendScheduleAppendix(pkg: DocxPackage, s: ComputedSchedule, opts: AppendixOptions = {}): void {
  const part = 'word/document.xml';
  const doc = partDom(pkg, part);
  const body = wDescendants(doc, 'body')[0]!;
  const lastSect = wChildren(body, 'sectPr')[0];
  const nodes: Element[] = [];
  let width = LANDSCAPE_TEXT;
  if (lastSect) {
    // close the current last section with a section-break paragraph carrying its properties
    const breakPara = w(doc, 'p', {}, [w(doc, 'pPr', {}, [w(doc, 'spacing', { before: '0', after: '0', line: '240', lineRule: 'auto' }), lastSect.cloneNode(true) as Element])]);
    nodes.push(breakPara);
    const land = landscapeSectPr(body, lastSect);
    body.replaceChild(land, lastSect);
    width = sectTextWidth(land);
  }
  const scale = width / COL_WIDTHS.reduce((a, b) => a + b, 0);
  const widths = COL_WIDTHS.map((x) => Math.floor(x * scale));
  widths[2]! += width - widths.reduce((a, b) => a + b, 0);

  nodes.push(headingParagraph(doc, body, opts.letter ?? 'A', opts.title ?? 'ITEMISED REPAIR SCHEDULE'));
  const intro = [
    `Itemised parts and labour supporting sections 08 and 09${opts.reference ? ` of report ${opts.reference}` : ''}. Labour at ${money(s.labourRatePence)} per hour; prices exclude VAT.`,
    s.unverifiedCount > 0
      ? `${s.unverifiedCount} ${s.unverifiedCount === 1 ? 'figure is an estimate' : 'figures are estimates'} marked "${ESTIMATE_MARK}" (amber). They are not verified prices or times and must be confirmed by the engineer before this report is issued.`
      : 'Every figure has been verified by the engineer.'
  ];
  intro.forEach((t, i) => nodes.push(para(doc, [run(doc, t, { color: i === 1 && s.unverifiedCount ? AMBER_TEXT : GREY, size: 18, bold: i === 1 && s.unverifiedCount > 0 })], { after: i === intro.length - 1 ? 200 : 60 })));

  const rows = scheduleRows(s);
  const moneyCols = new Set([6, 7, 8, 9, 10]);
  const trs: Element[] = [];
  trs.push(row(doc, rows.header.map((h, i) => cell(doc, widths[i]!, [para(doc, [run(doc, h, { bold: true, color: 'FFFFFF', size: 16 })], { jc: moneyCols.has(i) ? 'right' : 'left' })], { fill: NAVY, bottom: NAVY })), { header: true }));
  rows.lines.forEach((ln, li) => {
    const fill = ln.estimate ? AMBER_FILL : li % 2 === 1 ? BAND : undefined;
    trs.push(
      row(
        doc,
        ln.cells.map((text, i) => {
          const status = i === 12;
          const o: RunOpts = { size: 16 };
          if (status) Object.assign(o, { bold: true, color: ln.estimate ? AMBER_TEXT : GREEN_TEXT });
          return cell(doc, widths[i]!, [para(doc, [run(doc, text, o)], { jc: moneyCols.has(i) ? 'right' : 'left' })], fill ? { fill } : {});
        })
      )
    );
  });
  const t = rows.totals;
  const totalCells: Element[] = [cell(doc, widths.slice(0, 6).reduce((a, b) => a + b, 0), [para(doc, [run(doc, t[2]!, { bold: true, color: NAVY, size: 16 })])], { span: 6, fill: BAND, top: NAVY })];
  for (let i = 6; i < 13; i++) {
    totalCells.push(cell(doc, widths[i]!, [para(doc, [run(doc, t[i]!, { bold: true, color: i === 12 && s.unverifiedCount ? AMBER_TEXT : NAVY, size: 16 })], { jc: moneyCols.has(i) ? 'right' : 'left' })], { fill: BAND, top: NAVY }));
  }
  trs.push(row(doc, totalCells));
  nodes.push(table(doc, widths, trs));

  // reconciliation with sections 08 / 09
  nodes.push(para(doc, [run(doc, 'Reconciliation with sections 08 and 09', { bold: true, color: NAVY, size: 20 })], { before: 240, after: 120, keepNext: true }));
  const recWidths = [Math.round(width * 0.72), width - Math.round(width * 0.72)];
  const rec = reconciliationRows(s);
  const recRows = rec.map(([label, amount], i) => {
    const last = i === rec.length - 1;
    const o: RunOpts = last ? { bold: true, color: 'FFFFFF', size: 18 } : { size: 18 };
    const fill = last ? NAVY : undefined;
    const keepNext = !last;
    return row(doc, [cell(doc, recWidths[0]!, [para(doc, [run(doc, label, o)], { keepNext })], fill ? { fill } : {}), cell(doc, recWidths[1]!, [para(doc, [run(doc, amount, o)], { jc: 'right', keepNext })], fill ? { fill } : {})]);
  });
  nodes.push(table(doc, recWidths, recRows));
  nodes.push(para(doc, [run(doc, 'Repair estimate only. This is not an invoice or an authorisation to start repairs. Sources: Audatex estimate = the per-job Audatex/Qapter estimate export supplied for this vehicle; Owner library = figures confirmed by CarFlex; AI estimate = a suggestion that needs confirmation; Manual = entered by the engineer.', { color: GREY, size: 16 })], { before: 160 }));

  const anchor = wChildren(body, 'sectPr')[0];
  for (const n of nodes) body.insertBefore(n, anchor ?? null);
  markDirty(pkg, part);
}
