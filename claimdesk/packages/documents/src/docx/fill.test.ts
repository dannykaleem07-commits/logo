import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fillDocx } from './fill.js';
import { docxToPlainText } from './preview.js';
import { scanDocx } from './scan.js';
import type { FillInstruction, FillOptions } from './types.js';
import { docx, emptyRun, heading, labelCell, p, pt, r, tbl, tc, tr, valueCell } from './__fixtures__/build.js';
import { rescanPreviews } from './__fixtures__/readback.js';

const now = new Date('2026-10-04T09:30:00Z');
const opts: FillOptions = { coreProps: { title: 'Vehicle Credit Hire Agreement — CCG-2026-00012', subject: 'Vehicle Credit Hire Agreement', keywords: ['CCG-2026-00012', 'agreement.ccguk_03_credit_hire'], created: now, modified: now }, now };
const text = (t: string) => ({ type: 'text', text: t }) as const;
const xmlOf = (bytes: Uint8Array, part = 'word/document.xml'): string => new TextDecoder().decode(unzipSync(bytes)[part]);
const asset = (file: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../assets/docx/${file}`, import.meta.url)));

/** Every word of the template's printed text must survive, in order (filling never rewrites printed wording). */
function expectSubsequence(template: string, filled: string): void {
  const printed = template.replace(/\[[^\]\n]*\]/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ');
  const words = printed.split(/\s+/).filter((w) => w.length > 0 && !/[_☐☒]/.test(w));
  let pos = 0;
  const hay = filled.replace(/\s+/g, ' ');
  for (const w of words) {
    const at = hay.indexOf(w, pos);
    expect(at, `"${w}" missing after position ${pos}`).toBeGreaterThanOrEqual(0);
    pos = at + w.length;
  }
}

const FORM = docx(
  [
    pt('Form', { b: true, sz: 34 }),
    tbl([tr([labelCell('Reference'), valueCell('CCG-                    -            ')]), tr([labelCell('Date'), valueCell('        /         /              ')])], [2300, 2500]),
    heading('01', 'Customer details'),
    tbl(
      [
        tr([labelCell('Full name'), valueCell()]),
        tr([labelCell('Address'), tc(p('', { markRPr: { color: '3F4552', sz: 19 } }), { w: 2500 })]),
        tr([labelCell('Postcode'), tc('<w:p/>', { w: 2500 })]),
        tr([labelCell('Date of birth'), valueCell('____ / ____ / ______')]),
        tr([labelCell('Excess'), valueCell('£______________')]),
        tr([labelCell('Charge'), valueCell('£')]),
        tr([labelCell('Agreement ref.'), valueCell('CCG-HIRE-____________')]),
        tr([labelCell('Odometer'), valueCell('__________ miles')]),
        tr([labelCell('Fuel'), tc(p(r('☐ Petrol   ☐ Diesel   ☐ Other: ______________')), { w: 2500 })])
      ],
      [2300, 2500]
    ),
    p([r('☐', { color: '0D1C50' }), r('  '), r('I agree to the terms')]),
    p([r('Dear '), r('[Sir or Madam]', { i: true, color: '9AA3B2', sz: 20 }), r(',')]),
    pt('Reference {{claim.reference}} printed.'),
    tbl([tr([tc([pt('CLIENT', { b: true }), pt('Full name', { b: true, color: '8A8F9B' }), p(emptyRun(), { bottomBorder: true }), pt('Signature', { b: true, color: '8A8F9B' }), p(emptyRun(), { bottomBorder: true })], { w: 4600, fill: 'F4F6FA' })])], [4600]),
    pt('Describe the accident'),
    tbl([tr([tc(p(emptyRun()), { w: 9000, mar: { top: 2400, bottom: 2400 } })])], [9000])
  ].join('')
);

describe('fillDocx round-trips (fill → re-scan → previews show the values)', () => {
  const scan = scanDocx(FORM);
  const ins: FillInstruction[] = [
    { slotId: 'title/reference', value: text('CCG-2026-00012') },
    { slotId: 'title/date', value: text('04 / 10 / 2026') },
    { slotId: '01-customer-details/full-name', value: text('Smith & Co <Ltd> "A"') },
    { slotId: '01-customer-details/address', value: text('12 High Street\nHounslow TW3 1AB') },
    { slotId: '01-customer-details/postcode', value: text('TW3 1AB') },
    { slotId: '01-customer-details/date-of-birth', value: text('01 / 02 / 1990') },
    { slotId: '01-customer-details/excess', value: text('£250.00') },
    { slotId: '01-customer-details/charge', value: text('1,234.56') },
    { slotId: '01-customer-details/agreement-ref', value: text('CCG-H-000123') },
    { slotId: '01-customer-details/odometer', value: text('45,210') },
    { slotId: '01-customer-details/fuel', value: { type: 'choice', selected: ['other'], blanks: { other: 'LPG' } } },
    { slotId: '01-customer-details/i-agree-to-the-terms', value: { type: 'check', checked: true } },
    { slotId: '01-customer-details/sir-or-madam', value: text('Ms Patel') },
    { slotId: '01-customer-details/claim-reference', value: text('CCG-2026-00012') },
    { slotId: '01-customer-details/@client/full-name', value: text('Jane Smith') },
    { slotId: '01-customer-details/@client/signature', value: text('forged') },
    { slotId: '01-customer-details/describe-the-accident', value: text('The other car pulled out.') },
    { slotId: 'nope/missing', value: text('x') }
  ];
  const out = fillDocx(FORM, ins, opts);
  const previews = rescanPreviews(FORM, out.docx);
  const xml = xmlOf(out.docx);

  it('scans the fixture as expected', () => {
    expect(scan.slots.map((s) => `${s.id}:${s.kind}`)).toEqual([
      'title/reference:blank',
      'title/date:blank',
      '01-customer-details/full-name:cell',
      '01-customer-details/address:cell',
      '01-customer-details/postcode:cell',
      '01-customer-details/date-of-birth:blank',
      '01-customer-details/excess:blank',
      '01-customer-details/charge:blank',
      '01-customer-details/agreement-ref:blank',
      '01-customer-details/odometer:blank',
      '01-customer-details/fuel:choice',
      '01-customer-details/i-agree-to-the-terms:checkbox',
      '01-customer-details/sir-or-madam:bracket',
      '01-customer-details/claim-reference:token',
      '01-customer-details/@client/full-name:line',
      '01-customer-details/@client/signature:line',
      '01-customer-details/describe-the-accident:block'
    ]);
  });

  it('reports filled, skipped (signature, not found) and hashes the bytes', () => {
    expect(out.report.skipped).toEqual([
      { slotId: '01-customer-details/@client/signature', reason: 'SIGNATURE_SLOT' },
      { slotId: 'nope/missing', reason: 'NOT_FOUND' }
    ]);
    expect(out.report.filled).toHaveLength(16);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cells, lines, blocks and multi-line values', () => {
    expect(previews.get('01-customer-details/full-name')).toBe('Smith & Co <Ltd> "A"');
    expect(previews.get('01-customer-details/address')).toBe('12 High Street\nHounslow TW3 1AB');
    expect(previews.get('01-customer-details/@client/full-name')).toBe('Jane Smith');
    expect(previews.get('01-customer-details/describe-the-accident')).toBe('The other car pulled out.');
    expect(previews.get('01-customer-details/@client/signature')).toBe('');
    expect(xml).toContain('Smith &amp; Co &lt;Ltd&gt; "A"');
    expect(xml).toMatch(/12 High Street<\/w:t><w:br\/><w:t xml:space="preserve">Hounslow TW3 1AB/);
    // Block with a big tcMar shrinks to 120 twips once filled.
    expect(xml).toMatch(/<w:tcMar><w:top w:w="120" w:type="dxa"\/><w:bottom w:w="120" w:type="dxa"\/><\/w:tcMar>/);
  });

  it('run-less cells take the paragraph-mark style, else the default Calibri 1A1A1A 9 pt, never the label style', () => {
    const address = /<w:r><w:rPr><w:color w:val="3F4552"\/><w:sz w:val="19"\/><\/w:rPr><w:t xml:space="preserve">12 High Street/.test(xml);
    expect(address).toBe(true);
    expect(xml).toMatch(/<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"\/><w:color w:val="1A1A1A"\/><w:sz w:val="18"\/><w:szCs w:val="18"\/><\/w:rPr><w:t xml:space="preserve">TW3 1AB/);
    expect(xml).not.toMatch(/8A8F9B"\/><w:sz w:val="14"\/><\/w:rPr><w:t xml:space="preserve">TW3 1AB/);
  });

  it('blanks: whole reference match (never CCG-CCG-), space boxes replaced whole, money digits after a printed £, units kept', () => {
    expect(previews.get('title/reference')).toBe('CCG-2026-00012');
    expect(previews.get('title/date')).toBe('04 / 10 / 2026');
    expect(previews.get('01-customer-details/agreement-ref')).toBe('CCG-H-000123');
    expect(xml).not.toContain('CCG-CCG-');
    expect(xml).not.toContain('CCG-HIRE-CCG');
    expect(previews.get('01-customer-details/excess')).toBe('250.00');
    expect(xml).toContain('£250.00');
    expect(xml).not.toContain('££');
    expect(xml).toContain('£1,234.56');
    expect(previews.get('01-customer-details/odometer')).toBe('45,210');
    expect(xml).toContain('45,210 miles');
  });

  it('checkbox swap, choice with a blank inside an option', () => {
    expect(previews.get('01-customer-details/i-agree-to-the-terms')).toBe('☒');
    expect(previews.get('01-customer-details/fuel')).toBe('☐☐☒');
    expect(xml).toContain('Other: LPG');
  });

  it('hint brackets are restyled (no italics, colour 3F4552, size kept); tokens replaced', () => {
    expect(previews.get('01-customer-details/sir-or-madam')).toBe('Ms Patel');
    expect(xml).toMatch(/<w:r><w:rPr><w:color w:val="3F4552"\/><w:sz w:val="20"\/><\/w:rPr><w:t xml:space="preserve">Ms Patel<\/w:t><\/w:r>/);
    expect(previews.get('01-customer-details/claim-reference')).toBe('CCG-2026-00012');
  });

  it('keeps every printed word, in order', () => {
    expectSubsequence(scan.text, docxToPlainText(out.docx));
  });

  it('writes core and app properties', () => {
    const core = xmlOf(out.docx, 'docProps/core.xml');
    expect(core).toContain('<dc:creator>Courtesy Cars Group UK Ltd</dc:creator>');
    expect(core).toContain('<cp:lastModifiedBy>Courtesy Cars Group UK Ltd</cp:lastModifiedBy>');
    expect(core).toContain('<dc:title>Vehicle Credit Hire Agreement — CCG-2026-00012</dc:title>');
    expect(core).toContain('<cp:keywords>CCG-2026-00012; agreement.ccguk_03_credit_hire</cp:keywords>');
    expect(core).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-04T09:30:00Z</dcterms:modified>');
    expect(core).not.toContain('cp:revision');
    const app = xmlOf(out.docx, 'docProps/app.xml');
    expect(app).toContain('<Application>ClaimDesk</Application><Company>Courtesy Cars Group UK Ltd</Company>');
    expect(app).not.toContain('AppVersion');
    expect(xmlOf(out.docx, '[Content_Types].xml')).toContain('/docProps/app.xml');
  });

  it('type mismatches, unknown options and empty values are skipped, never guessed', () => {
    const r2 = fillDocx(
      FORM,
      [
        { slotId: 'title/reference', value: { type: 'check', checked: true } },
        { slotId: '01-customer-details/fuel', value: { type: 'choice', selected: ['lpg'] } },
        { slotId: '01-customer-details/full-name', value: text('   ') }
      ],
      opts
    );
    expect(r2.report.skipped.map((s) => s.reason)).toEqual(['TYPE_MISMATCH', 'OPTION_NOT_FOUND', 'EMPTY_VALUE']);
    expect(r2.report.filled).toEqual([]);
  });
});

describe('fillDocx structural kinds', () => {
  const np = (n: string, t: string): string => p([r(n, { b: true }), r(`\t${t}`)]);
  const LETTER = docx(
    [
      heading('01', 'Letter'),
      pt('[Address line 2]'),
      np('1.', 'We act on behalf of our client. [Open with who we are.]'),
      np('2.', '[Set out the facts.]'),
      np('3.', '[State the request.]'),
      pt('Enc. [list every enclosure]'),
      tbl([tr([labelCell('Your Ref'), valueCell('[insurer reference]')]), tr([labelCell('Client'), valueCell('[full name of client]')])], [2300, 2500])
    ].join('')
  );

  it('paragraphs: more items clone the last paragraph and renumber; fixedLead kept', () => {
    const out = fillDocx(LETTER, [{ slotId: '01-letter/paragraphs', value: { type: 'paragraphs', items: ['First.', 'Second.', 'Third.', 'Fourth.', 'Fifth.'] } }], opts);
    const t = docxToPlainText(out.docx);
    expect(t).toContain('1.\tWe act on behalf of our client. First.');
    expect(t).toContain('5.\tFifth.');
    expect(t).not.toMatch(/Open with|Set out|State the request/);
  });

  it('paragraphs: fewer items remove the surplus; replaceFixedLead replaces the opening; empty item 1 removes the bracket', () => {
    const a = docxToPlainText(fillDocx(LETTER, [{ slotId: '01-letter/paragraphs', value: { type: 'paragraphs', items: ['Only one.'], replaceFixedLead: true } }], opts).docx);
    expect(a).toContain('1.\tOnly one.');
    expect(a).not.toContain('We act on behalf');
    expect(a).not.toMatch(/2\.\t/);
    const b = docxToPlainText(fillDocx(LETTER, [{ slotId: '01-letter/paragraphs', value: { type: 'paragraphs', items: ['', 'Facts.'] } }], opts).docx);
    expect(b).toContain('1.\tWe act on behalf of our client.\n2.\tFacts.');
  });

  it('remove scope: paragraph and table row', () => {
    const out = fillDocx(
      LETTER,
      [
        { slotId: '01-letter/address-line-2', value: { type: 'remove', scope: 'paragraph' } },
        { slotId: '01-letter/list-every-enclosure', value: { type: 'remove', scope: 'paragraph' } },
        { slotId: '01-letter/insurer-reference', value: { type: 'remove', scope: 'row' } },
        { slotId: '01-letter/full-name-of-client', value: text('Jane Smith') }
      ],
      opts
    );
    const t = docxToPlainText(out.docx);
    expect(t).not.toContain('Address line 2');
    expect(t).not.toContain('Enc.');
    expect(t).not.toContain('Your Ref');
    expect(t).toContain('Client\nJane Smith');
    expect(out.report.removed).toEqual(['01-letter/address-line-2', '01-letter/list-every-enclosure', '01-letter/insurer-reference']);
  });

  it('table: fills rows top-down and clones rows (alternating shading) before the Total row', () => {
    const dark = (t: string, w = 2400): string => tc(p(r(t, { b: true, color: 'FFFFFF' })), { w, fill: '0D1C50' });
    const row = (n: string, fill?: string): string => tr([tc(pt(n), { w: 900, ...(fill ? { fill } : {}) }), tc(p(emptyRun()), { w: 2400, ...(fill ? { fill } : {}) }), tc(p(emptyRun()), { w: 2400, ...(fill ? { fill } : {}) })]);
    const T = docx(heading('06', 'Chronology') + tbl([tr([dark('No.', 900), dark('Date'), dark('Who')], { header: true }), row('1'), row('2', 'F4F6FA'), tr([tc(pt('Total', { b: true }), { w: 900 }), valueCell('', 2400), valueCell('', 2400)])], [900, 2400, 2400]));
    const rows = Array.from({ length: 5 }, (_, i) => ({ date: `0${i + 1}/10/2026`, who: `Person ${i + 1}` }));
    const out = fillDocx(T, [{ slotId: '06-chronology/table-date-who', value: { type: 'rows', rows } }], opts);
    const t = docxToPlainText(out.docx);
    expect(t).toMatch(/1\n01\/10\/2026\nPerson 1\n2\n02\/10\/2026\nPerson 2\n3\n03\/10\/2026\nPerson 3\n4\n04\/10\/2026\nPerson 4\n5\n05\/10\/2026\nPerson 5\nTotal/);
    const xml = xmlOf(out.docx);
    expect((xml.match(/w:fill="F4F6FA"/g) ?? []).length).toBe(6); // rows 2 and 4 shaded, 3 cells each
  });

  it('removeBlocks removes a variant block by id prefix', () => {
    const B = docx([heading('01', 'Agreement'), pt('Main text'), p('', { pageBreakBefore: true }), p(r('Enforceability check — internal use', { b: true })), pt('Office only text'), p('', { pageBreakBefore: true }), p(r('Cancellation form', { b: true })), pt('Cancel here')].join(''));
    const out = fillDocx(B, [], { ...opts, removeBlocks: ['enforceability-check'] });
    const t = docxToPlainText(out.docx);
    expect(t).not.toContain('Office only text');
    expect(t).toContain('Cancel here');
    expect(out.report.removed).toEqual(['block:enforceability-check-internal-use']);
  });

  it('content controls keep the sdt wrapper; merge fields become plain runs', () => {
    const D = docx(
      heading('01', 'Upload') +
        p('<w:sdt><w:sdtPr><w:alias w:val="Client name"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr><w:t>Click here</w:t></w:r></w:sdtContent></w:sdt>') +
        p('<w:fldSimple w:instr=" MERGEFIELD VehicleReg "><w:r><w:rPr><w:b/></w:rPr><w:t>«VehicleReg»</w:t></w:r></w:fldSimple>')
    );
    const out = fillDocx(D, [{ slotId: '01-upload/client-name', value: text('Jane Smith') }, { slotId: '01-upload/vehiclereg', value: text('AB12 CDE') }], opts);
    const xml = xmlOf(out.docx);
    expect(xml).toContain('<w:sdt>');
    expect(xml).not.toContain('showingPlcHdr');
    expect(xml).not.toContain('PlaceholderText');
    expect(xml).not.toContain('fldSimple');
    expect(xml).toMatch(/<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">AB12 CDE<\/w:t><\/w:r>/);
    expect(docxToPlainText(out.docx)).toContain('Jane Smith');
  });
});

describe('fillDocx on the real assets', () => {
  it('01: reference and dates fill the printed boxes; signature slots are always skipped', () => {
    const bytes = asset('CCGUK-01-Customer-Agreement-and-Letter-of-Authority.docx');
    const out = fillDocx(
      bytes,
      [
        { slotId: 'title/reference', value: text('CCG-2026-00012') },
        { slotId: '01-customer-and-claim-details/customer-full-name', value: text('Jane Smith') },
        { slotId: '01-customer-and-claim-details/date-of-birth', value: text('01 / 02 / 1990') },
        { slotId: '05-vehicle-services-authority/vehicle-recovery-vehicle-recovery-storage-and-en', value: { type: 'check', checked: true } },
        { slotId: '13-client-authorisation/@client/full-name', value: text('Jane Smith') },
        { slotId: '13-client-authorisation/@client/signature', value: text('X') },
        { slotId: '13-client-authorisation/@client/date-signed', value: text('04/10/2026') }
      ],
      opts
    );
    expect(out.report.skipped).toEqual([
      { slotId: '13-client-authorisation/@client/signature', reason: 'SIGNATURE_SLOT' },
      { slotId: '13-client-authorisation/@client/date-signed', reason: 'SIGNATURE_SLOT' }
    ]);
    const previews = rescanPreviews(bytes, out.docx);
    expect(previews.get('title/reference')).toBe('CCG-2026-00012');
    expect(previews.get('01-customer-and-claim-details/date-of-birth')).toBe('01 / 02 / 1990');
    expect(previews.get('05-vehicle-services-authority/vehicle-recovery-vehicle-recovery-storage-and-en')).toBe('☒');
    const plain = docxToPlainText(out.docx);
    expect(plain).not.toContain('CCG-CCG');
    expectSubsequence(scanDocx(bytes).text, plain);
  });

  it('02: header/ref is filled in all three header parts', () => {
    const bytes = asset('CCGUK-02_Recovery_Storage_Engineering_Pack_TEMPLATE_v5.docx');
    const out = fillDocx(bytes, [{ slotId: 'header/ref', value: text('CCG-AGR-0042') }], opts);
    for (const part of ['word/header1.xml', 'word/header3.xml', 'word/header4.xml']) {
      const x = xmlOf(out.docx, part);
      expect(x).toContain('Ref CCG-AGR-0042');
      expect(x).not.toContain('CCG-______');
    }
    expect(xmlOf(out.docx, 'word/header2.xml')).toBe(xmlOf(bytes, 'word/header2.xml'));
  });

  it('03: removing the enforceability block keeps the cancellation form', () => {
    const bytes = asset('CCGUK-03-Vehicle-Credit-Hire-Agreement.docx');
    const out = fillDocx(bytes, [], { ...opts, removeBlocks: ['enforceability-check'] });
    const t = docxToPlainText(out.docx);
    expect(t).not.toContain('Enforceability check');
    expect(t).toContain('Cancellation form');
  });
});
