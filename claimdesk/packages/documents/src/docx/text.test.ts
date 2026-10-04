import { describe, expect, it } from 'vitest';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { normaliseText, paragraphText, replaceRange, slugify } from './text.js';
import { NS } from './xml.js';
import { NS_ATTRS } from './__fixtures__/build.js';

function para(inner: string): Element {
  const doc = new DOMParser().parseFromString(`<w:document ${NS_ATTRS}><w:body><w:p>${inner}</w:p></w:body></w:document>`, 'text/xml');
  return doc.getElementsByTagNameNS(NS.w, 'p')[0] as Element;
}

const xml = (el: Element): string => new XMLSerializer().serializeToString(el);

describe('slugify (normative §A.4)', () => {
  it('turns numbered CCGUK headings into section slugs', () => {
    expect(slugify('01     Customer & claim details')).toBe('01-customer-and-claim-details');
    expect(slugify('Replacement vehicle — credit hire')).toBe('replacement-vehicle-credit-hire');
  });
  it('maps £ to gbp, + to plus and drops apostrophes and curly quotes', () => {
    expect(slugify('Amount £')).toBe('amount-gbp');
    expect(slugify('£500 + VAT')).toBe('gbp-500-plus-vat');
    expect(slugify('Hirer’s own')).toBe('hirers-own');
    expect(slugify("Client's decision")).toBe('clients-decision');
    expect(slugify('“Quoted” label')).toBe('quoted-label');
  });
  it('strips accents, cuts at max without a trailing dash, and never returns empty', () => {
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify('Enforceability check — internal use, not for the hirer')).toBe('enforceability-check-internal-use-not-for-the-hi');
    expect(slugify('aaaa bbbb', 5)).toBe('aaaa');
    expect(slugify('—')).toBe('x');
    expect(slugify('')).toBe('x');
  });
});

describe('normaliseText', () => {
  it('NFC, non-breaking spaces, curly quotes, trimming and collapsed spaces', () => {
    expect(normaliseText('  Hirer’s own   car  ')).toBe("Hirer's own car");
    expect(normaliseText('“A”')).toBe('"A"');
    expect(normaliseText('é')).toBe('é');
  });
});

describe('paragraph text model', () => {
  it('joins runs, maps tabs and breaks, and records a piece per text node', () => {
    const p = para('<w:r><w:t>1.</w:t></w:r><w:r><w:tab/><w:t>Hello</w:t><w:br/><w:t>world</w:t></w:r>');
    const pt = paragraphText(p);
    expect(pt.text).toBe('1.\tHello\nworld');
    expect(pt.pieces.map((x) => [x.start, x.end])).toEqual([
      [0, 2],
      [2, 3],
      [3, 8],
      [8, 9],
      [9, 14]
    ]);
  });
  it('maps Wingdings checkbox symbols to ☐ / ☒', () => {
    const p = para('<w:r><w:sym w:font="Wingdings" w:char="F0A8"/></w:r><w:r><w:sym w:font="Wingdings" w:char="F0FE"/></w:r>');
    expect(paragraphText(p).text).toBe('☐☒');
  });
});

describe('replaceRange', () => {
  it('replaces a {{token}} split across three runs with proofErr, keeping the first run style', () => {
    const p = para(
      '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Ref: {{claim.</w:t></w:r><w:proofErr w:type="spellStart"/>' +
        '<w:r><w:rPr><w:i/></w:rPr><w:t>refer</w:t></w:r><w:proofErr w:type="spellEnd"/><w:r><w:t xml:space="preserve">ence}} end</w:t></w:r>'
    );
    const pt = paragraphText(p);
    expect(pt.text).toBe('Ref: {{claim.reference}} end');
    const s = pt.text.indexOf('{{');
    const e = pt.text.indexOf('}}') + 2;
    replaceRange(pt, s, e, 'CCG-2026-00012');
    expect(paragraphText(p).text).toBe('Ref: CCG-2026-00012 end');
    const out = xml(p);
    expect(out).not.toContain('proofErr');
    expect(out).not.toContain('<w:i/>');
    expect(out).toContain('<w:b/>');
    expect(out).toContain('xml:space="preserve"');
  });
  it('turns newlines into <w:br/> in one run', () => {
    const p = para('<w:r><w:t>[Address]</w:t></w:r>');
    const pt = paragraphText(p);
    replaceRange(pt, 0, 9, '12 High Street\nHounslow');
    expect(paragraphText(p).text).toBe('12 High Street\nHounslow');
    expect(xml(p).match(/<w:r>/g)).toHaveLength(1);
    expect(xml(p)).toContain('<w:br/>');
  });
  it('isolates and restyles a grey italic hint value without touching the printed text around it', () => {
    const p = para('<w:r><w:rPr><w:i/><w:color w:val="9AA3B2"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">Dear [Sir or Madam],</w:t></w:r>');
    const pt = paragraphText(p);
    replaceRange(pt, 5, 19, 'Ms Patel', { restyleHint: true });
    expect(paragraphText(p).text).toBe('Dear Ms Patel,');
    const runs = p.getElementsByTagNameNS(NS.w, 'r');
    expect(runs.length).toBe(3);
    const value = xml(runs[1] as Element);
    expect(value).toContain('Ms Patel');
    expect(value).not.toContain('<w:i/>');
    expect(value).toContain('w:val="3F4552"');
    expect(value).toContain('<w:sz w:val="20"/>');
    expect(xml(runs[0] as Element)).toContain('<w:i/>');
  });
  it('escapes markup characters through DOM text nodes', () => {
    const p = para('<w:r><w:t>____</w:t></w:r>');
    replaceRange(paragraphText(p), 0, 4, 'Smith & Co <Ltd> "A"');
    expect(xml(p)).toContain('Smith &amp; Co &lt;Ltd&gt; "A"');
  });
});
