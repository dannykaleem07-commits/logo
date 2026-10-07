import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convertDocxToPdf } from '../docx/convert/index.js';
import { createLibreOfficeConverter } from '../docx/convert/libreoffice.js';
import { listDocxPictures, readImageInfo } from '../docx/images.js';
import { docxToPlainText } from '../docx/preview.js';
import { scanDocx } from '../docx/scan.js';
import { normaliseText } from '../docx/text.js';
import { openDocx } from '../docx/zip.js';
import { partDom, wAttr, wChild, wChildren, wDescendants } from '../docx/xml.js';
import {
  buildCarflexFillInstructions,
  CARFLEX_SIGNATURE_SLOTS,
  CARFLEX_VALUE_TAGS,
  loadCarflexTemplate,
  renderCarflexReport,
  scheduleOf,
  section08Values,
  section09Values,
  type EngineerReportData
} from './carflexReport.js';
import { ESTIMATE_MARK, reconciliationRows } from './itemisedSchedule.js';
import { sampleEngineerReport, samplePhotos } from './__fixtures__/sample.js';

const now = new Date('2026-10-07T09:00:00Z');
const template = loadCarflexTemplate();
const scan = scanDocx(template);

function sample(photoCount = 2): EngineerReportData {
  const d = sampleEngineerReport();
  const base = samplePhotos();
  d.photos = Array.from({ length: photoCount }, (_, i) => ({ ...base[i % 2]!, description: `Photo ${i + 1}: ${base[i % 2]!.description}` }));
  return d;
}

function sdtText(bytes: Uint8Array, tag: string, occurrence = 0): string | undefined {
  const doc = partDom(openDocx(bytes), 'word/document.xml');
  const sdt = wDescendants(doc, 'sdt').filter((s) => wAttr(wChild(wChild(s, 'sdtPr'), 'tag')) === tag)[occurrence];
  return sdt ? wDescendants(sdt, 't').map((t) => t.textContent ?? '').join('') : undefined;
}

/** Cell texts of the table row whose first cell is `label`. */
function rowCells(bytes: Uint8Array, label: string): string[] {
  const doc = partDom(openDocx(bytes), 'word/document.xml');
  for (const tr of wDescendants(doc, 'tr')) {
    const cells = wChildren(tr, 'tc').map((tc) => normaliseText(wDescendants(tc, 't').map((t) => t.textContent ?? '').join('')));
    if (cells[0] === label) return cells;
  }
  return [];
}

const pounds = (s: string): number => Math.round(Number(s.replace(/[£,\s]/g, '')) * 100);

describe('CarFlex template mapping', () => {
  it('every instruction targets a real slot of the owner’s file (scanner v1); signature slots exist and are never targeted', () => {
    const ids = new Set(scan.slots.map((s) => s.id));
    const ins = buildCarflexFillInstructions(sample());
    expect(ins.length).toBeGreaterThan(100);
    for (const i of ins) expect(ids.has(i.slotId), i.slotId).toBe(true);
    for (const sig of CARFLEX_SIGNATURE_SLOTS) {
      expect(scan.slots.find((s) => s.id === sig)?.signature, sig).toBe(true);
      expect(ins.some((i) => i.slotId === sig)).toBe(false);
    }
    // spacer-column "cell" slots and the image box cells are never filled
    expect(ins.some((i) => /#2$/.test(i.slotId) && /\/(own-insurer|registration|make|date-of-loss)#2$/.test(i.slotId))).toBe(false);
    expect(ins.some((i) => /insert-photograph/.test(i.slotId))).toBe(false);
  });

  it('the value controls the post-pass writes are present in the template', () => {
    const doc = partDom(openDocx(template), 'word/document.xml');
    const tags = new Set(wDescendants(doc, 'sdt').map((s) => wAttr(wChild(wChild(s, 'sdtPr'), 'tag'))));
    for (const t of [...CARFLEX_VALUE_TAGS.repair, ...CARFLEX_VALUE_TAGS.summary, ...Object.values(CARFLEX_VALUE_TAGS.valuation), CARFLEX_VALUE_TAGS.assessed, 'Assessor_Signature', 'Assessor_Signed_Date']) expect(tags.has(t), t).toBe(true);
  });
});

describe('renderCarflexReport (real template, realistic sample, two photos)', () => {
  const data = sample(2);
  const res = renderCarflexReport(template, data, { now });
  const text = normaliseText(docxToPlainText(res.docx));

  it('fills every slot it targets and reports nothing missing', () => {
    expect(res.fill.skipped).toEqual([]);
    expect(res.missing).toEqual([]);
    expect(res.photos).toEqual({ placed: 2, rowsAdded: 0, rowsRemoved: 2 });
  });

  it('prints the claim, vehicle, inspection, assessment, valuation and customer values', () => {
    for (const v of [
      'CFX-ENG-2026-0142',
      'LD19 XKP',
      'Ford Focus ST-Line 1.0 EcoBoost 125',
      '28 September 2026',
      'Mr Daniel Ashworth',
      'AVI/MTR/5520193',
      'YF68 KLM',
      'WF0NXXGCHNKJ12345',
      '41,286 miles',
      'Hatchback, 5-door',
      '999 cc',
      'Magnetic Grey / JAYC',
      '02/10/2026',
      'Autel MaxiSys MS906',
      'Front offside corner',
      'No structural damage seen.',
      'Not roadworthy until the offside headlamp is replaced',
      '5 October 2026',
      '£22,495.00',
      'AutoTrader — advert AT-202610-55821',
      '£13,650.00',
      'Economic repair',
      'J. Patel IEng MIMI',
      'Vehicle Damage Assessor',
      'd.ashworth@example.co.uk',
      'The damage is consistent with the reported low-speed angled impact'
    ]) {
      expect(text, v).toContain(v);
    }
    // the template's sample figures never survive
    for (const s of ['£12345678', '00000mi', 'DD/MM/YYYY', '01/01/2026', 'SATISFACTORY', '[Registration]', '[Report reference]']) expect(text, s).not.toContain(s);
  });

  it('section 07 evidence values, highest valuation and repair/value percentage', () => {
    expect(sdtText(res.docx, 'Valuation_Date')).toBe('5 October 2026');
    expect(sdtText(res.docx, 'Valuation_Mileage')).toBe('41,286 miles');
    expect(sdtText(res.docx, CARFLEX_VALUE_TAGS.valuation.glass)).toBe('£13,450.00');
    expect(rowCells(res.docx, 'CAP HPI')).toEqual(['CAP HPI', '05/10/2026', '£13,200.00']);
    expect(rowCells(res.docx, 'HIGHEST VALUATION')).toEqual(['HIGHEST VALUATION', '04/10/2026', '£13,995.00']);
    expect(sdtText(res.docx, CARFLEX_VALUE_TAGS.assessed)).toBe('£13,650.00');
    expect(sdtText(res.docx, 'Repair_Value_Percentage')).toBe('17.8%');
  });

  it('sections 08, 09 and Appendix A reconcile', () => {
    const s = res.schedule;
    const v08 = CARFLEX_VALUE_TAGS.repair.map((t) => sdtText(res.docx, t)!);
    const v09 = CARFLEX_VALUE_TAGS.summary.map((t) => sdtText(res.docx, t)!);
    expect(v08).toEqual(section08Values(s));
    expect(v09).toEqual(section09Values(s));
    expect(v08).toEqual(['£992.07', '£406.00', '£467.20', '£163.50', '£0.00', '£2,028.77', '£405.75', '£2,434.52']);
    const [parts, labour, paint, other, discount, net, vat, total] = v08.map(pounds);
    expect(parts! + labour! + paint! + other! - discount!).toBe(net);
    expect(net! + vat!).toBe(total);
    const [l09, m09, p09, d09, net09, vat09, total09] = v09.map(pounds);
    expect(l09).toBe(labour);
    expect(p09).toBe(paint);
    expect(m09).toBe(parts! + other!);
    expect(l09! + m09! + p09! - d09!).toBe(net09);
    expect([net09, vat09, total09]).toEqual([net, vat, total]);
    // 09 category rows
    expect(rowCells(res.docx, 'Body')).toEqual(['Body', '£72.50', '3.50 hrs', '£253.75', '£304.85']);
    expect(rowCells(res.docx, 'Mechanical')).toEqual(['Mechanical', '£72.50', '1.10 hrs', '£79.75', '£0.00']);
    expect(rowCells(res.docx, 'Auxiliary Work')).toEqual(['Auxiliary Work', '£72.50', '1.00 hrs', '£72.50', '£687.22']);
    expect(rowCells(res.docx, 'Painting')).toEqual(['Painting', '£72.50', '4.20 hrs', '£304.50', '£162.70']);
    expect(rowCells(res.docx, 'Other Items')).toEqual(['Other Items', '—', '—', '—', '£163.50']);
    // appendix: every line, the estimate marks and the reconciliation table
    expect(text).toContain('ITEMISED REPAIR SCHEDULE');
    for (const l of data.repair.lines) expect(text).toContain(l.description);
    expect(text.split(ESTIMATE_MARK).length - 1).toBeGreaterThanOrEqual(3);
    for (const [label, amount] of reconciliationRows(s)) {
      expect(rowCells(res.docx, label)).toEqual([label, amount]);
    }
    expect(rowCells(res.docx, 'Totals (excl. VAT, before discount)')).toEqual(['Totals (excl. VAT, before discount)', '9.80', '£710.50', '£992.07', '£162.70', '£2,028.77', '', '3 to confirm']);
    expect(rowCells(res.docx, '7')).toContain(ESTIMATE_MARK);
    expect(rowCells(res.docx, '1').at(-1)).toBe('Verified');
    expect(sdtText(res.docx, 'Estimate_Notes')).toMatch(/3 figures in the itemised repair schedule \(Appendix A\) are estimates — needs confirmation/);
    // the appendix is its own landscape section; the previous last section keeps its portrait page
    const doc = partDom(openDocx(res.docx), 'word/document.xml');
    const body = wDescendants(doc, 'body')[0]!;
    const finalSect = wChildren(body, 'sectPr')[0]!;
    expect(wAttr(wChild(finalSect, 'pgSz'), 'orient')).toBe('landscape');
    const sects = wDescendants(body, 'sectPr');
    expect(sects).toHaveLength(4);
    expect(wAttr(wChild(sects[2]!, 'pgSz'), 'orient')).toBeUndefined();
  });

  it('photos sit in the IMAGE 01 / 02 boxes, sized to the box, orientation respected; unused rows removed', () => {
    const pkg = openDocx(res.docx);
    const pics = listDocxPictures(pkg).filter((p) => p.mediaPart.includes('cd-photo-'));
    expect(pics).toHaveLength(2);
    expect(pics.map((p) => p.descr)).toEqual(data.photos!.map((p) => p.description));
    expect(pics[0]!.rot).toBe(0);
    expect(pics[1]!.rot).toBe(5_400_000); // stored sideways, EXIF 6
    expect(pics[0]!.cx / pics[0]!.cy).toBeCloseTo(4 / 3, 3);
    expect(pics[1]!.cy / pics[1]!.cx).toBeCloseTo(4 / 3, 2);
    for (const p of pics) {
      expect(p.cx).toBeLessThanOrEqual((4592 - 200) * 635);
      expect(p.cy).toBeLessThanOrEqual((3685 - 140) * 635);
      // inside the shaded photo box (the box keeps its borders and fill)
      expect(wAttr(wChild(wChild(p.cell!, 'tcPr'), 'shd'), 'fill')).toBe('F2F6FA');
    }
    const files = unzipSync(res.docx);
    for (const p of pics) expect(readImageInfo(files[p.mediaPart]!).orientation).toBe(1);
    expect(new TextDecoder().decode(files['[Content_Types].xml']!)).toContain('Extension="jpeg"');
    expect(text).not.toMatch(/IMAGE 0\d/);
    expect(text).not.toContain('Insert photograph');
    expect(text).toContain('01 Photo 1: Front offside');
    expect(text).toContain('02 Photo 2: Rear nearside');
  });

  it('never fills the assessor signature or date signed', () => {
    expect(normaliseText(sdtText(res.docx, 'Assessor_Signature') ?? 'x')).toBe('');
    expect(normaliseText(sdtText(res.docx, 'Assessor_Signed_Date') ?? 'x')).toBe('');
    expect(sdtText(res.docx, 'Assessor_Report_Status')).toBe('v1 — Draft — awaiting engineer review and signature');
  });

  it('header carries the registration and reference', () => {
    const files = unzipSync(res.docx);
    for (const h of ['word/header1.xml', 'word/header2.xml', 'word/header3.xml']) {
      const xml = new TextDecoder().decode(files[h]!);
      expect(xml, h).toContain('LD19 XKP');
      expect(xml, h).toContain('CFX-ENG-2026-0142');
    }
  });

  it('is deterministic', () => {
    expect(renderCarflexReport(template, sample(2), { now }).sha256).toBe(res.sha256);
  });
});

describe('renderCarflexReport variants', () => {
  it('eight photos add a row (IMAGE 07 / 08 with captions 07 / 08)', () => {
    const r = renderCarflexReport(template, sample(8), { now });
    expect(r.photos).toEqual({ placed: 8, rowsAdded: 1, rowsRemoved: 0 });
    expect(listDocxPictures(openDocx(r.docx)).filter((p) => p.mediaPart.includes('cd-photo-'))).toHaveLength(8);
    const t = normaliseText(docxToPlainText(r.docx));
    expect(t).toContain('07 Photo 7:');
    expect(t).toContain('08 Photo 8:');
    expect(t).not.toContain('[Image description]');
  });

  it('three photos: the fourth box and caption are left empty, the 05/06 row goes', () => {
    const r = renderCarflexReport(template, sample(3), { now });
    expect(r.photos).toEqual({ placed: 3, rowsAdded: 0, rowsRemoved: 1 });
    const t = normaliseText(docxToPlainText(r.docx));
    expect(t).not.toContain('IMAGE 04');
    expect(t).not.toMatch(/\b04 \[Image description\]/);
    expect(t).not.toContain('05 [Image description]');
  });

  it('a different labour rate, discount and VAT rate rewrite the printed figures', () => {
    const d = sample(1);
    d.repair.labourRatePence = 6_500;
    d.repair.discountPercent = 5;
    const r = renderCarflexReport(template, d, { now });
    expect(rowCells(r.docx, 'Body')[1]).toBe('£65.00');
    expect(rowCells(r.docx, 'Overall Discount (5.00%)')).toHaveLength(2);
    expect(sdtText(r.docx, 'Repair_Line_5_1')).toBe(`-£${(r.schedule.totals.discountPence / 100).toFixed(2)}`);
    expect(scheduleOf(d).totals.totalPence).toBe(r.schedule.totals.totalPence);
  });

  it('minimal data still renders; the template prompts stay and the gaps are listed', () => {
    const d: EngineerReportData = { reference: 'CFX-ENG-2026-0001', reportDate: '2026-10-07', instruction: {}, vehicle: { registration: 'ab12cde' }, inspection: {}, circumstances: {}, assessment: {}, repair: { lines: [] } };
    const r = renderCarflexReport(template, d, { now });
    expect(r.fill.skipped).toEqual([]);
    expect(r.missing).toEqual(expect.arrayContaining(['Make', 'Inspection date', 'Photographs', 'Repair lines', "Engineer's opinion"]));
    const t = normaliseText(docxToPlainText(r.docx));
    expect(t).toContain('AB12 CDE');
    expect(t).toContain('[Summarise the observations');
    expect(t).toContain('IMAGE 01');
    expect(sdtText(r.docx, 'Repair_Line_8_1')).toBe('£0.00');
  });

  it('refuses a report without a reference or registration', () => {
    expect(() => renderCarflexReport(template, { ...sample(0), reference: ' ' }, { now })).toThrow(/reference/);
  });
});

// Visual check with a Writer-enabled LibreOffice (SOFFICE_PATH): the filled report converts and keeps its layout
// (13 template pages + the landscape appendix). Page images are written to CARFLEX_VISUAL_DIR when set.
const soffice = process.env['SOFFICE_PATH'];
describe.skipIf(!soffice || !existsSync(soffice))('LibreOffice render', () => {
  it(
    'converts the filled sample to PDF',
    async () => {
      const work = mkdtempSync(join(tmpdir(), 'carflex-lo-'));
      const r = renderCarflexReport(template, sample(2), { now });
      const pdf = await convertDocxToPdf(r.docx, { workDir: work, metadata: { title: 'CarFlex engineer report' }, converters: [createLibreOfficeConverter({ workDir: work })], preference: 'libreoffice' });
      expect(pdf.converter).toBe('libreoffice');
      expect(pdf.pages).toBeGreaterThanOrEqual(13);
      expect(pdf.pages).toBeLessThanOrEqual(16);
      const out = process.env['CARFLEX_VISUAL_DIR'];
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'carflex-sample.pdf'), pdf.pdf);
        writeFileSync(join(out, 'carflex-sample.docx'), r.docx);
      }
    },
    240_000
  );
});
