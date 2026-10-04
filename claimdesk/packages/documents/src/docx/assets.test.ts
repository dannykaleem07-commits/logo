import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkDocxSafety } from './safety.js';
import { scanDocx, scanPackage, targetParagraph } from './scan.js';
import { hasPageBreakBefore } from './context.js';
import { openDocx } from './zip.js';
import type { DocxScan, DocxSlot } from './types.js';

const FILES = {
  '01': 'CCGUK-01-Customer-Agreement-and-Letter-of-Authority.docx',
  '02': 'CCGUK-02_Recovery_Storage_Engineering_Pack_TEMPLATE_v5.docx',
  '03': 'CCGUK-03-Vehicle-Credit-Hire-Agreement.docx',
  '04': 'CCGUK-04-Witness-Statement.docx',
  '05': 'CCGUK-05-Payment-Authorisation-and-Settlement-Direction.docx',
  '06': 'CCGUK-06-Vehicle-Handover-and-Condition-Report.docx',
  '07': 'CCGUK-07-Statement-of-Means.docx',
  '08': 'CCGUK-08-Intervention-and-Mitigation-Record.docx',
  '09': 'CCGUK-09-Accident-Report-Form.docx',
  letterhead: 'CCGUK-Letterhead-Formal.docx'
} as const;

const bytesOf = (key: keyof typeof FILES): Uint8Array => new Uint8Array(readFileSync(new URL(`../../assets/docx/${FILES[key]}`, import.meta.url)));
const cache = new Map<string, DocxScan>();
const scanOf = (key: keyof typeof FILES): DocxScan => {
  let s = cache.get(key);
  if (!s) {
    s = scanDocx(bytesOf(key));
    cache.set(key, s);
  }
  return s;
};
const get = (s: DocxScan, id: string): DocxSlot => {
  const found = s.slots.find((x) => x.id === id);
  if (!found) throw new Error(`no slot ${id}`);
  return found;
};

describe('real CCGUK assets', () => {
  it.each(Object.keys(FILES) as Array<keyof typeof FILES>)('%s scans safely, quickly, deterministically and yields > 20 slots', (key) => {
    const bytes = bytesOf(key);
    const safety = checkDocxSafety(bytes);
    expect(safety.errors).toEqual([]);
    const t0 = Date.now();
    const scan = scanDocx(bytes);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(scan.slots.length).toBeGreaterThan(20);
    expect(new Set(scan.slots.map((s) => s.id)).size).toBe(scan.slots.length);
    expect(scanDocx(bytes).slots.map((s) => s.id)).toEqual(scan.slots.map((s) => s.id));
    for (const s of scan.slots) expect(s.id).toMatch(/^[a-z0-9-]+(\/[a-z0-9-]+)*(\/@[a-z0-9-]+)?\/[a-z0-9-]+(#\d+)?(:\d+)?$/);
  });

  it('01: title reference/date, customer cells, date blanks, client authorisation lines', () => {
    const s = scanOf('01');
    const ref = get(s, 'title/reference');
    expect(ref.kind).toBe('blank');
    expect(ref.blank?.pattern).toBe('reference');
    expect(ref.blank?.text.replace(/[\sCG-]/g, '')).toBe(''); // space box
    expect(get(s, 'title/date').blank?.pattern).toBe('date');
    expect(get(s, '01-customer-and-claim-details/customer-full-name').kind).toBe('cell');
    const dob = get(s, '01-customer-and-claim-details/date-of-birth');
    expect(dob.kind).toBe('blank');
    expect(dob.blank?.pattern).toBe('date');
    expect(get(s, '13-client-authorisation/@client/full-name').kind).toBe('line');
    expect(get(s, '13-client-authorisation/@client/full-name').signature).toBe(false);
    expect(get(s, '13-client-authorisation/@client/signature').signature).toBe(true);
  });

  it('03: qualified vehicle registrations, handover registration, enforceability block, nothing in the page-break spacers', () => {
    const s = scanOf('03');
    expect(get(s, '03-incident-and-vehicle-particulars/@replacement-vehicle-credit-hire/registration').kind).toBe('inline');
    expect(get(s, '03-incident-and-vehicle-particulars/@original-vehicle-pending-assessment/registration').kind).toBe('inline');
    expect(get(s, '07-vehicle-handover-and-condition-summary/registration').kind).toBe('cell');
    expect(s.blocks.some((b) => b.id.startsWith('enforceability-check'))).toBe(true);
    // The four pageBreakBefore paragraphs are empty spacers: each block starts at one and no slot sits in it.
    expect(s.blocks.length).toBe(4);
    const { targets } = scanPackage(openDocx(bytesOf('03')));
    const slotParas = [...targets.values()].flat().map((t) => targetParagraph(t)).filter((x) => x !== undefined);
    expect(slotParas.length).toBeGreaterThan(50);
    expect(slotParas.filter((para) => hasPageBreakBefore(para!))).toEqual([]);
    expect(s.slots.filter((x) => x.kind === 'line' || x.kind === 'cell' || x.kind === 'inline').every((x) => x.label.length > 0)).toBe(true);
    expect(get(s, '01-parties-and-agreement-details/agreement-ref').blank?.prefix).toBe('CCG-HIRE-');
  });

  it('02: header/ref merged across header1/3/4 and level-1 sections from banner tables', () => {
    const s = scanOf('02');
    const ref = get(s, 'header/ref');
    expect(ref.parts).toEqual(['word/header1.xml', 'word/header3.xml', 'word/header4.xml']);
    const l1 = s.outline.filter((o) => o.level === 1).map((o) => o.slug);
    expect(l1).toEqual(expect.arrayContaining(['part-a-client-authority', 'a1-client-authorisation', 'a2-client-vehicle-and-claim', 'c1-service-record', 'c2-cancellation-form']));
    expect(s.slots.some((x) => x.sectionPath[0] === 'a1-client-authorisation')).toBe(true);
    expect(get(s, 'title/agreement-ref').blank).toMatchObject({ pattern: 'reference', prefix: 'CCG-' });
    expect(get(s, 'c1-service-record/c1-4-account/@charge/recovery').blank).toMatchObject({ pattern: 'money', hasCurrency: true });
  });

  it('06: condition matrix out/in qualifiers and no slot in the empty spacer column', () => {
    const s = scanOf('06');
    expect(get(s, '03-condition-matrix/@out/front-bumper').kind).toBe('cell');
    expect(get(s, '03-condition-matrix/@in/front-bumper').kind).toBe('cell');
    const matrix = s.slots.filter((x) => x.sectionPath[0] === '03-condition-matrix');
    expect(matrix.every((x) => x.qualifier === 'out' || x.qualifier === 'in')).toBe(true);
    expect(matrix.length).toBe(52);
  });

  it('07: the [2003] citation is not a slot', () => {
    const s = scanOf('07');
    expect(s.slots.some((x) => x.preview.includes('2003'))).toBe(false);
    expect(s.text).toContain('[2003] UKHL 64');
  });

  it('04: nine numbered witness paragraphs and the exhibit-sheet block', () => {
    const s = scanOf('04');
    const ps = s.slots.find((x) => x.kind === 'paragraphs');
    expect(ps?.rowCount).toBe(9);
    expect(s.blocks.map((b) => b.id)).toContain('exhibit-sheet');
    expect(s.slots.some((x) => x.blockId === 'exhibit-sheet')).toBe(true);
  });

  it('Letterhead: four body paragraphs with the printed opening as fixedLead, and recipient brackets', () => {
    const s = scanOf('letterhead');
    const ps = s.slots.find((x) => x.kind === 'paragraphs');
    expect(ps?.rowCount).toBe(4);
    expect(ps?.fixedLead?.startsWith('We act on behalf')).toBe(true);
    const brackets = s.slots.filter((x) => x.kind === 'bracket').map((x) => x.preview);
    expect(brackets).toEqual(expect.arrayContaining(['[Name of handler]', '[Insurer or company name]', '[Address line 1]', '[Town, POSTCODE]', '[Sir or Madam]']));
    expect(s.slots.filter((x) => x.preview === '[dd Month yyyy]').map((x) => x.ordinal)).toEqual([1, 2, 3]);
  });
});
