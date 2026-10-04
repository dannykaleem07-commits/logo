import { describe, expect, it } from 'vitest';
import { scanDocx } from './scan.js';
import type { DocxScan, DocxSlot } from './types.js';
import { docx, emptyRun, heading, labelCell, p, pt, r, tbl, tc, tr, valueCell } from './__fixtures__/build.js';

const ids = (s: DocxScan): string[] => s.slots.map((x) => x.id);
const slot = (s: DocxScan, id: string): DocxSlot => {
  const found = s.slots.find((x) => x.id === id);
  if (!found) throw new Error(`no slot ${id} in\n${ids(s).join('\n')}`);
  return found;
};

const DARK = '0D1C50';
const darkCell = (text: string, w = 2400): string => tc(p(r(text, { b: true, color: 'FFFFFF' })), { w, fill: DARK });

describe('headings and sections (§A.5)', () => {
  it('level 1: numbered CCGUK headings, Part A–C, named headings, Title/Heading1 styles; text before is `title`', () => {
    const s = scanDocx(
      docx(
        [
          pt('Form title', { b: true, sz: 34 }),
          tbl([tr([labelCell('Reference'), valueCell('CCG-                    -            ')])], [2300, 2500]),
          heading('01', 'Customer & claim details'),
          tbl([tr([labelCell('Full name'), valueCell()])], [2300, 2500]),
          p(r('Part B  The agreement', { b: true })),
          tbl([tr([labelCell('Signed on'), valueCell()])], [2300, 2500]),
          p(r('Cancellation form', { b: true })),
          tbl([tr([labelCell('Name'), valueCell()])], [2300, 2500]),
          p(r('Styled heading'), { style: 'Heading1' }),
          tbl([tr([labelCell('Colour'), valueCell()])], [2300, 2500])
        ].join('')
      )
    );
    expect(ids(s)).toEqual([
      'title/reference',
      '01-customer-and-claim-details/full-name',
      'part-b-the-agreement/signed-on',
      'cancellation-form/name',
      'styled-heading/colour'
    ]);
    expect(s.outline.map((o) => [o.level, o.slug])).toEqual([
      [1, '01-customer-and-claim-details'],
      [1, 'part-b-the-agreement'],
      [1, 'cancellation-form'],
      [1, 'styled-heading']
    ]);
  });

  it('level 2: A1.1 codes, bold N.N, Heading2 and short bold lines followed by a table; a new level 1 clears level 2', () => {
    const s = scanDocx(
      docx(
        [
          heading('02', 'Driver & insurance'),
          p(r('Replacement vehicle insurance', { b: true, color: '04347F', sz: 18 })),
          tbl([tr([labelCell('Insurance provider'), valueCell()])], [2300, 2500]),
          p(r('A1.1  THE SERVICES', { b: true })),
          tbl([tr([labelCell('Instructed'), valueCell()])], [2300, 2500]),
          p(r('3.2 Bold numbered', { b: true })),
          tbl([tr([labelCell('Item'), valueCell()])], [2300, 2500]),
          p(r('Not a heading, it ends with a full stop.', { b: true })),
          tbl([tr([labelCell('Other'), valueCell()])], [2300, 2500]),
          heading('03', 'Next'),
          tbl([tr([labelCell('Make'), valueCell()])], [2300, 2500])
        ].join('')
      )
    );
    expect(ids(s)).toEqual([
      '02-driver-and-insurance/replacement-vehicle-insurance/insurance-provider',
      '02-driver-and-insurance/a1-1-the-services/instructed',
      '02-driver-and-insurance/3-2-bold-numbered/item',
      '02-driver-and-insurance/3-2-bold-numbered/other',
      '03-next/make'
    ]);
    const sl = slot(s, '02-driver-and-insurance/replacement-vehicle-insurance/insurance-provider');
    expect(sl.sectionTitles).toEqual(['02 Driver & insurance', 'Replacement vehicle insurance']);
  });

  it('CCGUK-02 banner tables are level-1 headings and never yield slots', () => {
    const banner = (code: string, title: string): string =>
      tbl([tr([tc('', { w: 130, fill: 'B8901F' }), tc([pt('PART', { b: true }), pt(code, { b: true })], { w: 1350, fill: DARK }), tc([p(r(title, { b: true })), pt('subtitle')], { w: 5886, fill: DARK })])], [130, 1350, 5886]);
    const codeBanner = (code: string, title: string): string => tbl([tr([tc(pt(code, { b: true }), { w: 1250, fill: DARK }), tc(p([r(title, { b: true }), r('     Initial each service')]), { w: 8616, fill: 'F4F6FA' })])], [1250, 8616]);
    const s = scanDocx(
      docx([banner('A', 'CLIENT AUTHORITY'), codeBanner('A1', 'CLIENT AUTHORISATION'), tbl([tr([labelCell('Full name'), valueCell()])], [2300, 2500]), codeBanner('A2', 'CLIENT, VEHICLE & CLAIM'), tbl([tr([labelCell('Mobile'), valueCell()])], [2300, 2500])].join(''))
    );
    expect(s.outline.map((o) => o.slug)).toEqual(['part-a-client-authority', 'a1-client-authorisation', 'a2-client-vehicle-and-claim']);
    expect(ids(s)).toEqual(['a1-client-authorisation/full-name', 'a2-client-vehicle-and-claim/mobile']);
  });
});

describe('tables (§A.5)', () => {
  it('header rows give column qualifiers (tblHeader, or every non-empty row-0 cell dark) and label columns give labels', () => {
    const s = scanDocx(
      docx(
        heading('03', 'Condition matrix') +
          tbl(
            [
              tr([darkCell('Panel / item', 2600), darkCell('Out', 780), darkCell('In', 780), tc(pt(''), { w: 1318 }), darkCell('Panel / item', 2600), darkCell('Out', 780), darkCell('In', 780)]),
              tr([tc(pt('Front bumper'), { w: 2600 }), tc(p(emptyRun()), { w: 780 }), tc(p(emptyRun()), { w: 780 }), tc(p(emptyRun()), { w: 1318 }), tc(pt('Bonnet'), { w: 2600 }), tc(p(emptyRun()), { w: 780 }), tc(p(emptyRun()), { w: 780 })]),
              tr([tc(pt('Roof'), { w: 2600 }), tc(p(emptyRun()), { w: 780 }), tc(p(emptyRun()), { w: 780 }), tc(p(emptyRun()), { w: 1318 }), tc(pt('Windscreen'), { w: 2600 }), tc(p(emptyRun()), { w: 780 }), tc(p(emptyRun()), { w: 780 })])
            ],
            [2600, 780, 780, 1318, 2600, 780, 780]
          )
      )
    );
    expect(ids(s)).toEqual([
      '03-condition-matrix/@out/front-bumper',
      '03-condition-matrix/@in/front-bumper',
      '03-condition-matrix/@out/bonnet',
      '03-condition-matrix/@in/bonnet',
      '03-condition-matrix/@out/roof',
      '03-condition-matrix/@in/roof',
      '03-condition-matrix/@out/windscreen',
      '03-condition-matrix/@in/windscreen'
    ]);
    expect(slot(s, '03-condition-matrix/@in/bonnet').qualifierTitle).toBe('In');
  });

  it('excludes narrow cells, spacer rows, vMerge continuations and static text', () => {
    const s = scanDocx(
      docx(
        heading('01', 'Details') +
          tbl(
            [
              tr([labelCell('Name'), valueCell(), tc(p(emptyRun()), { w: 200 }), labelCell('Account name'), valueCell('COURTESY CARS GROUP UK LTD')]),
              tr([tc(p(emptyRun()), { w: 2300 }), tc(p(emptyRun()), { w: 2500 }), tc(p(emptyRun()), { w: 200 }), tc(p(emptyRun()), { w: 2300 }), tc(p(emptyRun()), { w: 2500 })], { height: 120 }),
              tr([tc(p(r('Address', { b: true })), { w: 2300, fill: 'F4F6FA', vMerge: 'restart' }), valueCell(), tc(p(emptyRun()), { w: 200 }), labelCell('Phone'), valueCell()]),
              tr([tc(p(emptyRun()), { w: 2300, vMerge: 'continue' }), valueCell(), tc(p(emptyRun()), { w: 200 }), labelCell('Email'), valueCell()])
            ],
            [2300, 2500, 200, 2300, 2500]
          )
      )
    );
    expect(ids(s)).toEqual(['01-details/name', '01-details/address', '01-details/phone', '01-details/email']);
  });

  it('cell headings qualify the slots of signature blocks; `line` slots after label paragraphs; signatures flagged', () => {
    const block = (head: string, name: string): string =>
      tc([pt(head, { b: true, color: DARK }), pt('Full name', { b: true, color: '8A8F9B' }), p(name ? r(name, { b: true }) : emptyRun(), { bottomBorder: true }), pt('Signature', { b: true, color: '8A8F9B' }), p(emptyRun(), { bottomBorder: true }), pt('Date signed', { b: true, color: '8A8F9B' }), p(emptyRun(), { bottomBorder: true })], { w: 4669, fill: 'F4F6FA' });
    const s = scanDocx(docx(heading('13', 'Client authorisation') + tbl([tr([block('CLIENT', ''), block('FOR COURTESY CARS GROUP UK LTD', 'Shahzaib Ahmed Bari — Director')])], [4969, 4669])));
    expect(s.slots.map((x) => [x.id, x.kind, x.signature])).toEqual([
      ['13-client-authorisation/@client/full-name', 'line', false],
      ['13-client-authorisation/@client/signature', 'line', true],
      ['13-client-authorisation/@client/date-signed', 'line', true],
      ['13-client-authorisation/@for-courtesy-cars-group-uk-ltd/signature', 'line', true],
      ['13-client-authorisation/@for-courtesy-cars-group-uk-ltd/date-signed', 'line', true]
    ]);
  });

  it('a value cell with only a bottom border is a `line`; a one-cell empty box after a label paragraph is a `block`', () => {
    const s = scanDocx(
      docx(
        heading('04', 'Account') +
          tbl([tr([labelCell('Full name'), tc(p(emptyRun()), { w: 4000, bottomOnly: true })])], [2300, 4000]) +
          pt('Describe what happened in your own words') +
          tbl([tr([tc(p(emptyRun()), { w: 9000, mar: { top: 2400, bottom: 2400 } })])], [9000])
      )
    );
    expect(s.slots.map((x) => [x.id, x.kind, x.multiline])).toEqual([
      ['04-account/full-name', 'line', false],
      ['04-account/describe-what-happened-in-your-own-words', 'block', true]
    ]);
  });

  it('`table` slots: header row + ≥ 2 empty data rows, numbering column excluded, Total row kept as cells', () => {
    const s = scanDocx(
      docx(
        heading('07', 'Police, witnesses & injury') +
          tbl(
            [
              tr([darkCell('No.', 900), darkCell('Name'), darkCell('Contact'), darkCell('Days')], { header: true }),
              tr([tc(pt('1'), { w: 900 }), valueCell(), valueCell(), valueCell()]),
              tr([tc(pt('2'), { w: 900 }), valueCell(), valueCell(), valueCell()]),
              tr([tc(pt('Total', { b: true }), { w: 900 }), valueCell(), valueCell(), valueCell()])
            ],
            [900, 2400, 2400, 2400]
          )
      )
    );
    const t = slot(s, '07-police-witnesses-and-injury/table-name-contact');
    expect(t.kind).toBe('table');
    expect(t.rowCount).toBe(2);
    expect(t.columns?.map((c) => c.slug)).toEqual(['name', 'contact', 'days']);
    expect(ids(s)).toContain('07-police-witnesses-and-injury/@days/total');
  });
});

describe('paragraph detection (§A.6)', () => {
  it('every blank pattern, longest first, with units and currency', () => {
    const rows = [
      ['Date & time', '____ / ____ / ______  at  ____ : ____'],
      ['Date of birth', '____ / ____ / ______'],
      ['First registered', '____ / ______'],
      ['Time', '____ : ____'],
      ['Agreement ref.', 'CCG-HIRE-____________'],
      ['CCGUK reference', 'CCG-____________-________'],
      ['Excess', '£______________'],
      ['Exhibit page', '______ of ______'],
      ['Fuel', '______ / 8'],
      ['Battery', '______ %'],
      ['Odometer', '__________ miles'],
      ['Sort code', '____  —  ____  —  ____'],
      ['Notes', '______________'],
      ['Date', '        /         /              '],
      ['Reference', 'CCG-                    -            ']
    ];
    const s = scanDocx(docx(heading('01', 'Blanks') + tbl(rows.map(([l, v]) => tr([labelCell(l!), valueCell(v)])), [2300, 2500])));
    expect(s.slots.map((x) => [x.labelSlug, x.blank?.pattern, x.blank?.unit ?? x.blank?.prefix ?? (x.blank?.hasCurrency ? '£' : '')])).toEqual([
      ['date-and-time', 'datetime', ''],
      ['date-of-birth', 'date', ''],
      ['first-registered', 'month-year', ''],
      ['time', 'time', ''],
      ['agreement-ref', 'reference', 'CCG-HIRE-'],
      ['ccguk-reference', 'reference', 'CCG-'],
      ['excess', 'money', '£'],
      ['exhibit-page', 'page-of', ''],
      ['fuel', 'eighths', ''],
      ['battery', 'percent', ''],
      ['odometer', 'number', 'miles'],
      ['sort-code', 'text', ''],
      ['notes', 'text', ''],
      ['date', 'date', ''],
      ['reference', 'reference', 'CCG-']
    ]);
  });

  it('`£`-only and `CCG-`-only value cells are blanks; several blanks in one cell get subs', () => {
    const s = scanDocx(docx(heading('01', 'Account') + tbl([tr([labelCell('Charge'), valueCell('£')]), tr([labelCell('Agreement ref'), valueCell('CCG-')]), tr([labelCell('Limit / balance'), valueCell('£________ / £________')])], [2300, 2500])));
    expect(s.slots.map((x) => [x.id, x.blank?.pattern, x.blank?.hasCurrency, x.blank?.prefix])).toEqual([
      ['01-account/charge', 'money', true, undefined],
      ['01-account/agreement-ref', 'reference', false, 'CCG-'],
      ['01-account/limit-balance:1', 'money', true, undefined],
      ['01-account/limit-balance:2', 'money', true, undefined]
    ]);
  });

  it('labels from prose: last ≤ 6 words before the blank, separators cut, else the words after', () => {
    const s = scanDocx(
      docx(
        heading('02', 'Appointment') +
          p([r('☐', { color: DARK }), r('  '), r('Where this agreement is signed after CCGUK began acting for me, I confirm that I first appointed CCGUK on ____ / ____ / ______ and that CCGUK has acted since.')]) +
          pt('Recovery · Storage   ·   Ref CCG-______________     Page') +
          pt('______________ to be completed')
      )
    );
    expect(ids(s)).toEqual([
      '02-appointment/where-this-agreement-is-signed-after-ccguk-began',
      '02-appointment/that-i-first-appointed-ccguk-on',
      '02-appointment/ref',
      '02-appointment/to-be-completed'
    ]);
    expect(slot(s, '02-appointment/where-this-agreement-is-signed-after-ccguk-began').signature).toBe(false);
  });

  it('checkbox glyph grouping: paragraph checkboxes, choices, options with blanks, and two groups split by · and prose', () => {
    const s = scanDocx(
      docx(
        [
          heading('05', 'Services'),
          p([r('☐', { color: DARK }), r('  '), r('Vehicle recovery')]),
          p([r('☒', { color: DARK }), r('  '), r('Secure storage')]),
          tbl([tr([labelCell('Liability'), tc(p([r('☐'), r(' Admitted  '), r('☐'), r(' Disputed  '), r('☐'), r(' Awaited     Date: ___ / ___ / ______')]), { w: 5000 })]), tr([labelCell('Carried out by'), tc(p(r('☐ CCGUK    ☐ Other: ______________')), { w: 5000 })])], [2300, 5000]),
          tbl([tr([tc([p([r('Was anyone injured?   ', { b: true }), r('☐ NO        ☐ YES', { b: true })]), pt('Client told on ____ / ____ / ______   ·   by ☐ telephone ☐ email ☐ in person   ·   confirmed in writing ☐ YES ☐ NO')], { w: 9000, fill: 'FBF2EF' })])], [9000])
        ].join('')
      )
    );
    const byId = Object.fromEntries(s.slots.map((x) => [x.id, x]));
    expect(byId['05-services/vehicle-recovery']?.kind).toBe('checkbox');
    expect(byId['05-services/secure-storage']?.preview).toBe('☒');
    expect(byId['05-services/liability']?.options?.map((o) => o.slug)).toEqual(['admitted', 'disputed', 'awaited']);
    expect(byId['05-services/date']?.blank?.pattern).toBe('date');
    const carried = byId['05-services/carried-out-by'];
    expect(carried?.kind).toBe('choice');
    expect(carried?.options?.[1]).toMatchObject({ slug: 'other', blank: { pattern: 'text' } });
    expect(byId['05-services/was-anyone-injured']?.options?.map((o) => o.slug)).toEqual(['no', 'yes']);
    expect(byId['05-services/client-told-on']?.kind).toBe('blank');
    expect(byId['05-services/by']?.options?.map((o) => o.slug)).toEqual(['telephone', 'email', 'in-person']);
    expect(byId['05-services/confirmed-in-writing']?.options?.map((o) => o.slug)).toEqual(['yes', 'no']);
  });

  it('Wingdings w:sym checkboxes and w14:checkbox content controls', () => {
    const sym = (c: string): string => `<w:r><w:sym w:font="Wingdings" w:char="${c}"/></w:r>`;
    const s = scanDocx(
      docx(
        heading('06', 'Documents') +
          p([sym('F0A8'), r(' Bank statements')]) +
          p([sym('F0FE'), r(' Payslips')]) +
          p(
            '<w:sdt><w:sdtPr><w:tag w:val="consent"/><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt>' +
              r(' I consent')
          )
      )
    );
    expect(s.slots.map((x) => [x.id, x.kind, x.preview])).toEqual([
      ['06-documents/bank-statements', 'checkbox', '☐'],
      ['06-documents/payslips', 'checkbox', '☒'],
      ['06-documents/consent', 'checkbox', '☐']
    ]);
  });

  it('brackets (hint styling, citations excluded), tokens with formats, content controls and MERGEFIELDs', () => {
    const s = scanDocx(
      docx(
        [
          heading('01', 'Letter'),
          p([r('Dear '), r('[Sir or Madam]', { i: true, color: '9AA3B2' })]),
          pt('Lagden v O’Connor [2003] UKHL 64 and [see note 3]'),
          pt('Reference {{claim.reference}} dated {{doc.date|date-long}}'),
          p('<w:sdt><w:sdtPr><w:alias w:val="Client name"/><w:tag w:val="claimant.name"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:r><w:t>Click to enter</w:t></w:r></w:sdtContent></w:sdt>'),
          p('<w:fldSimple w:instr=" MERGEFIELD  ClientName \\* MERGEFORMAT "><w:r><w:t>«ClientName»</w:t></w:r></w:fldSimple>'),
          p(
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> MERGEFIELD VehicleReg </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>«VehicleReg»</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
          ),
          p('<w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>')
        ].join('')
      )
    );
    expect(s.slots.map((x) => [x.id, x.kind])).toEqual([
      ['01-letter/sir-or-madam', 'bracket'],
      ['01-letter/see-note-3', 'bracket'],
      ['01-letter/claim-reference', 'token'],
      ['01-letter/doc-date', 'token'],
      ['01-letter/client-name', 'control'],
      ['01-letter/clientname', 'mergefield'],
      ['01-letter/vehiclereg', 'mergefield']
    ]);
    expect(slot(s, '01-letter/sir-or-madam').hint).toBe(true);
    expect(slot(s, '01-letter/doc-date').token).toEqual({ key: 'doc.date', format: 'date-long' });
    expect(s.slots.some((x) => x.preview.includes('2003'))).toBe(false);
  });

  it('`inline` label run + empty value run, qualified by the column header', () => {
    const cellInline = (label: string): string => tc(p([r(`${label}  `, { b: true, color: '8A8F9B', sz: 14 }), emptyRun({ color: DARK, sz: 18 })]), { w: 4819 });
    const cellStatic = (label: string, value: string): string => tc(p([r(`${label}  `, { b: true, color: '8A8F9B', sz: 14 }), r(value, { b: true, color: DARK })]), { w: 4819 });
    const s = scanDocx(
      docx(
        heading('03', 'Incident & vehicle particulars') +
          tbl(
            [tr([darkCell('Original vehicle — pending assessment', 4819), darkCell('Replacement vehicle — credit hire', 4819)], { header: true }), tr([cellInline('Registration'), cellInline('Registration')]), tr([cellStatic('Company', 'Courtesy Cars Group UK Ltd'), cellInline('Hire start')])],
            [4819, 4819]
          )
      )
    );
    expect(s.slots.map((x) => [x.id, x.kind])).toEqual([
      ['03-incident-and-vehicle-particulars/@original-vehicle-pending-assessment/registration', 'inline'],
      ['03-incident-and-vehicle-particulars/@replacement-vehicle-credit-hire/registration', 'inline'],
      ['03-incident-and-vehicle-particulars/@replacement-vehicle-credit-hire/hire-start', 'inline']
    ]);
  });

  it('`paragraphs`: ≥ 2 numbered paragraphs with a bracket; fixedLead is the printed opening', () => {
    const np = (n: string, text: string): string => p([r(n, { b: true }), r(`\t${text}`)]);
    const s = scanDocx(docx(heading('01', 'Body') + np('1.', 'We act on behalf of our client. [Open with who we are.]') + np('2.', '[Set out the facts.]') + np('3.', '[State the request.]')));
    const ps = slot(s, '01-body/paragraphs');
    expect(ps.kind).toBe('paragraphs');
    expect(ps.rowCount).toBe(3);
    expect(ps.fixedLead).toBe('We act on behalf of our client.');
    expect(s.slots).toHaveLength(1);
  });
});

describe('blocks, header/footer parts, ordinals', () => {
  it('pageBreakBefore paragraphs start blocks named by their first heading; empty spacers yield nothing', () => {
    const s = scanDocx(
      docx(
        [
          heading('01', 'Agreement'),
          tbl([tr([labelCell('Name'), valueCell()])], [2300, 2500]),
          p(r('', {}), { pageBreakBefore: true }),
          p(r('Enforceability check — internal use, not for the hirer', { b: true })),
          tbl([tr([labelCell('Checked by'), valueCell()])], [2300, 2500]),
          p('', { pageBreakBefore: true }),
          p(r('Exhibit  ', { b: true }), {}) .replace('</w:p>', `${r('[AB1]', { i: true, color: '9AA3B2' })}</w:p>`),
          tbl([tr([labelCell('Item'), valueCell()])], [2300, 2500])
        ].join('')
      )
    );
    expect(s.blocks.map((b) => b.id)).toEqual(['enforceability-check-internal-use-not-for-the-hi', 'exhibit-sheet']);
    expect(slot(s, 'enforceability-check-internal-use-not-for-the-hi/checked-by').blockId).toBe('enforceability-check-internal-use-not-for-the-hi');
    expect(slot(s, 'exhibit/item').blockId).toBe('exhibit-sheet');
    expect(slot(s, 'exhibit/ab1').kind).toBe('bracket');
    expect(slot(s, '01-agreement/name').blockId).toBeUndefined();
    expect(s.slots).toHaveLength(4);
  });

  it('header slots use section `header`; identical slots in byte-identical parts merge', () => {
    const hdr = p([r('COURTESY CARS GROUP UK LTD', { b: true }), r('\t'), r('Recovery · Storage   ·   Ref CCG-______________     '), r('Page')]);
    const s = scanDocx(docx(heading('01', 'Body'), { headers: { 'word/header1.xml': hdr, 'word/header2.xml': p(r('First page header')), 'word/header3.xml': hdr } }));
    const ref = slot(s, 'header/ref');
    expect(ref.parts).toEqual(['word/header1.xml', 'word/header3.xml']);
    expect(ref.blank?.pattern).toBe('reference');
    expect(s.slots.filter((x) => x.id.startsWith('header/'))).toHaveLength(1);
  });

  it('ordinals count repeats within a section; ids are stable across scans', () => {
    const bytes = docx(heading('05', 'Other transport') + tbl([tr([labelCell('Explanation'), valueCell()]), tr([labelCell('Explanation'), valueCell()])], [2300, 2500]));
    const a = scanDocx(bytes);
    expect(ids(a)).toEqual(['05-other-transport/explanation', '05-other-transport/explanation#2']);
    expect(a.slots[1]?.ordinal).toBe(2);
    expect(ids(scanDocx(bytes))).toEqual(ids(a));
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.scannerVersion).toBe(1);
  });

  it('refuses documents with more paragraphs than the scan guard', () => {
    const bytes = docx(Array.from({ length: 30 }, (_, i) => pt(`Line ${i}`)).join(''));
    expect(() => scanDocx(bytes, { limits: { maxParagraphs: 10 } })).toThrow(/paragraphs/);
  });
});
