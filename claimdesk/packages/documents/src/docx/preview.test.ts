import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDocumentMeta } from '../layout.js';
import { docxToPlainText, docxToPreviewHtml, extractHeaderFooter } from './preview.js';
import { setDocxProperties } from './props.js';
import { openDocx, writeDocx } from './zip.js';
import { unzipSync } from 'fflate';
import { docx, heading, labelCell, p, pt, r, tbl, tr, valueCell } from './__fixtures__/build.js';

const asset = (file: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../assets/docx/${file}`, import.meta.url)));

describe('docxToPlainText / docxToPreviewHtml', () => {
  const bytes = docx(heading('01', 'Customer & claim details') + tbl([tr([labelCell('Full name'), valueCell('Smith & Co')])], [2300, 2500]) + p([r('☐  '), r('I agree')]) + pt('Body text', { b: true }));

  it('plain text: paragraphs and cells in order, checkboxes kept', () => {
    expect(docxToPlainText(bytes)).toBe('01     Customer & claim details\nFull name\nSmith & Co\n☐  I agree\nBody text');
  });

  it('preview HTML starts with a doctype and carries the ccguk meta tags readDocumentMeta reads', () => {
    const html = docxToPreviewHtml(bytes, { title: 'Customer Agreement', kind: 'agreement', reference: 'CCG-2026-00012', date: '2026-10-04' });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(readDocumentMeta(html)).toMatchObject({ kind: 'agreement', reference: 'CCG-2026-00012', date: '2026-10-04' });
    expect(html).toContain('<h2><strong>01</strong>');
    expect(html).toContain('<td><strong>Full name</strong></td><td>Smith &amp; Co</td>');
    expect(html).toContain('<p>☐  I agree</p>');
  });
});

describe('extractHeaderFooter', () => {
  it('reads first/default headers and footers, strips PAGE x OF y scaffolding and flags page fields (CCGUK-05)', () => {
    const hf = extractHeaderFooter(asset('CCGUK-05-Payment-Authorisation-and-Settlement-Direction.docx'));
    expect(hf.titlePage).toBe(true);
    expect(hf.hasPageFields).toBe(true);
    expect(hf.header).toBe('COURTESY CARS GROUP UK LTD | PAYMENT AUTHORISATION');
    expect(hf.firstHeader).toContain('Case handler 07425 475922');
    expect(hf.footer).toContain('Registered in England & Wales No. 17430389');
    expect(hf.firstFooter).not.toMatch(/PAGE\s*OF/);
  });

  it('02 running header keeps its tab-separated parts', () => {
    const hf = extractHeaderFooter(asset('CCGUK-02_Recovery_Storage_Engineering_Pack_TEMPLATE_v5.docx'));
    expect(hf.header).toBe('COURTESY CARS GROUP UK LTD | Recovery · Storage · Engineering · Ref CCG-______________');
  });
});

describe('setDocxProperties', () => {
  it('creates core.xml / app.xml, their overrides and package relationships when missing', () => {
    const bytes = docx(pt('x'), { omit: ['docProps/core.xml'] });
    const pkg = openDocx(bytes);
    const when = new Date('2026-10-04T09:30:15.123Z');
    setDocxProperties(pkg, { title: 'T & <x>', subject: 'S', description: 'D', keywords: ['a', 'b'], created: when, modified: when });
    const z = unzipSync(writeDocx(pkg));
    const core = new TextDecoder().decode(z['docProps/core.xml']);
    expect(core).toContain('<dc:title>T &amp; &lt;x&gt;</dc:title>');
    expect(core).toContain('<dc:creator>Courtesy Cars Group UK Ltd</dc:creator>');
    expect(core).toContain('<cp:lastModifiedBy>Courtesy Cars Group UK Ltd</cp:lastModifiedBy>');
    expect(core).toContain('<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-04T09:30:15Z</dcterms:created>');
    expect(core).toContain('<dc:description>D</dc:description>');
    const ct = new TextDecoder().decode(z['[Content_Types].xml']);
    expect(ct).toContain('PartName="/docProps/core.xml"');
    expect(ct).toContain('PartName="/docProps/app.xml"');
    const rels = new TextDecoder().decode(z['_rels/.rels']);
    expect(rels).toContain('Target="docProps/app.xml"');
    expect((rels.match(/core-properties/g) ?? []).length).toBe(1);
  });
});
