import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { builtinAssetBytes, composeLetterheadDocx, docxToPlainText, LETTERHEAD_TEMPLATE_ID } from './index.js';
import { extractLetterContent, parseHtmlTree, elementText, decodeHtmlEntities } from './letterContent.js';
import { listTemplates, renderSample } from './registry.js';
import './templates/index.js';

const letterIds = () => listTemplates().filter((t) => t.kind === 'letter').map((t) => t.id);

describe('extractLetterContent', () => {
  it('reads every part of a rendered chaser exactly', () => {
    const c = extractLetterContent(renderSample('letter.chaser_7').html);
    expect(c).not.toBeNull();
    expect(c!.recipient).toEqual({ name: 'Example Insurance plc', attention: 'Third Party Claims Team', addressLines: ['PO Box 100', 'Example Town', 'EX1 1AA'], email: 'thirdpartyclaims@example-insurer.test' });
    expect(c!.refs).toMatchObject({ ourRef: 'CCG-2026-00012', yourRef: 'EXI/TP/4471920', client: 'Ms Jane Example', dateOfAccident: '9 August 2026', date: '12 October 2026' });
    expect(c!.refs.vehicle).toMatch(/^AB12 CDE/);
    expect(c!.salutation).toBe('Sirs');
    expect(c!.subjectClient).toBe('Ms Jane Example');
    expect(c!.subjectReg).toBe('AB12 CDE');
    expect(c!.valediction).toBe('faithfully');
    expect(c!.signatory.name).toBe('D. Kaleem');
    expect(c!.replaceFixedOpening).toBe(true);
    // the opening sentence is the letter's own; the salutation and the subject table are not repeated as paragraphs
    expect(c!.paragraphs[0]).toMatch(/^We are instructed to correspond on behalf of Ms Jane Example/);
    expect(c!.paragraphs.some((p) => /^Dear /.test(p))).toBe(false);
    expect(c!.paragraphs.some((p) => p.includes('Date of accident'))).toBe(false);
    // list items are paragraphs of their own; a table is a structured item (caption first, as a heading)
    expect(c!.paragraphs).toContain('Confirm the date on which the outstanding £684.20 will be paid.');
    const captionAt = c!.paragraphs.indexOf('Position');
    expect(captionAt).toBeGreaterThan(0);
    expect(c!.headings).toContain(captionAt);
    const table = c!.tables?.find((t) => t.index === captionAt + 1);
    expect(table).toBeDefined();
    expect(table!.rows.some((r) => r[0] === 'Outstanding' && r.includes('£684.20'))).toBe(true);
    expect(c!.paragraphs[captionAt + 1]).toContain('Outstanding\t£684.20');
    expect(c!.signatory.role).toBe('Claims Manager');
    // entities are decoded, never left as &amp; etc.
    expect(c!.paragraphs.join('\n')).not.toMatch(/&(amp|lt|gt|quot|#\d+);/);
  });

  it('extracts every HTML letter template (sample data) with a body, a recipient and our reference', () => {
    const ids = letterIds();
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      const c = extractLetterContent(renderSample(id).html);
      expect(c, id).not.toBeNull();
      expect(c!.paragraphs.length, id).toBeGreaterThan(0);
      expect(c!.recipient.name, id).not.toBe('');
      expect(c!.refs.ourRef, id).toMatch(/^CCG-/);
      expect(c!.refs.date, id).not.toBe('');
      expect(c!.subject, id).not.toBe('');
      expect(c!.signatory.name, id).not.toBe('');
    }
  });

  it('returns null for HTML without a letter body part', () => {
    expect(extractLetterContent('<html><body><p>Hello</p></body></html>')).toBeNull();
    expect(extractLetterContent('')).toBeNull();
  });

  it('handles reply-by, enclosures, cc, a Re: line and nested boxes', () => {
    const html = `<!DOCTYPE html><html><head><title>Letter &amp; more — CCG-2026-00099</title><meta name="ccguk:reference" content="CCG-2026-00099"></head><body>
      <address data-letter-part="recipient"><div data-line="name">A &amp; B Insurance</div><div data-line="address">1 Road</div><div data-line="address">Town AB1 2CD</div></address>
      <table><tr data-letter-part="ref-our"><th>Our ref</th><td>CCG-2026-00099</td></tr><tr data-letter-part="ref-claim"><th>Claim no.</th><td>X-1</td></tr><tr data-letter-part="ref-date"><th>Date</th><td>5 October 2026</td></tr></table>
      <main class="body" data-letter-part="body">
        <p class="re" data-letter-part="subject">Re: Storage charges &lt;urgent&gt;</p>
        <p data-letter-part="salutation">Dear Ms Patel,</p>
        <p>First line<br>second line.</p>
        <div class="callout"><div class="callout-title">Deadline</div><p>Inside the box.</p></div>
        <p data-letter-part="reply-by">Please reply by <strong>19 October 2026</strong>.</p>
      </main>
      <div class="signature"><p data-letter-part="valediction">Yours sincerely</p><p class="sig-name" data-letter-part="signatory-name"><strong>Jo Bloggs</strong><br>Claims Handler</p></div>
      <div data-letter-part="enclosures"><p>Enclosures</p><ul><li>Invoice</li><li>Photos</li></ul></div>
      <div data-letter-part="cc"><ul><li>Client</li></ul></div>
    </body></html>`;
    const c = extractLetterContent(html)!;
    expect(c.subject).toBe('Storage charges <urgent>');
    expect(c.salutation).toBe('Ms Patel');
    expect(c.valediction).toBe('sincerely');
    expect(c.replyBy).toBe('19 October 2026');
    expect(c.paragraphs).toEqual(['First line\nsecond line.', 'Deadline', 'Inside the box.']);
    expect(c.headings).toEqual([1]);
    expect(c.signatory.role).toBe('Claims Handler');
    expect(c.enclosures).toEqual(['Invoice', 'Photos']);
    expect(c.cc).toEqual(['Client']);
    expect(c.refs.claimNo).toBe('X-1');
    expect(c.recipient).toEqual({ name: 'A & B Insurance', addressLines: ['1 Road', 'Town AB1 2CD'] });
    expect(c.signatory.name).toBe('Jo Bloggs');
  });

  it('tag scanner basics: void elements, comments, raw text, entities', () => {
    const root = parseHtmlTree('<p>a<!-- x --><br/>b &pound;5 &#8212; &#x41;<img src="x"></p><style>p{}</style><svg><p>no</p></svg>');
    expect(elementText(root)).toBe('a\nb £5 — A');
    expect(decodeHtmlEntities('&unknown; &amp;amp;')).toBe('&unknown; &amp;');
  });

  it('composes onto the CCGUK letterhead with the claim reference and the letter text', () => {
    const c = extractLetterContent(renderSample('letter.chaser_7').html)!;
    const r = composeLetterheadDocx(builtinAssetBytes(LETTERHEAD_TEMPLATE_ID), c, { now: new Date('2026-10-05T09:00:00Z'), reference: 'CCG-2026-00012', title: 'Payment enquiry' });
    const text = docxToPlainText(r.docx);
    expect(text).toContain('CCG-2026-00012');
    expect(text).toContain('We write to ask where payment of our pack stands.');
    expect(text).toContain('Example Insurance plc');
    expect(r.report.skipped).toEqual([]);
  });

  it('headings print unnumbered, tables print as Word tables (no run-together money), and the signing role is kept', () => {
    const html = `<!DOCTYPE html><html><head><title>Chaser — CCG-2026-00001</title></head><body>
      <address data-letter-part="recipient"><div data-line="name">Example Insurance plc</div><div data-line="address">1 Road</div><div data-line="address">Town AB1 2CD</div></address>
      <table><tr data-letter-part="ref-our"><th>Our ref</th><td>CCG-2026-00001</td></tr><tr data-letter-part="ref-date"><th>Date</th><td>5 October 2026</td></tr></table>
      <main class="body" data-letter-part="body">
        <p>We write about the outstanding charges.</p>
        <h2>The facts</h2>
        <p>The vehicle was recovered on 10 August 2026.</p>
        <table class="data figures"><caption>Outstanding by head</caption><thead><tr><th>Head</th><th>Note</th><th>Outstanding</th></tr></thead>
          <tbody><tr><td>Recovery</td><td>Claimed £151.00; received £0.00</td><td>£151.00</td></tr><tr><td>Hire</td><td>Claimed £1,112.00</td><td>£1,112.00</td></tr></tbody></table>
        <div class="callout"><div class="callout-title">Deadline</div><p>Pay within 14 days.</p></div>
      </main>
      <div class="signature"><p data-letter-part="valediction">Yours faithfully</p><p class="sig-name" data-letter-part="signatory-name"><strong>Shahzaib Ahmed Bari</strong><br>Director</p></div>
    </body></html>`;
    const c = extractLetterContent(html)!;
    expect(c.paragraphs).toEqual(['We write about the outstanding charges.', 'The facts', 'The vehicle was recovered on 10 August 2026.', 'Outstanding by head', expect.stringContaining('Recovery\t'), 'Deadline', 'Pay within 14 days.']);
    expect(c.headings).toEqual([1, 3, 5]);
    expect(c.tables).toEqual([{ index: 4, headerRows: 1, rows: [['Head', 'Note', 'Outstanding'], ['Recovery', 'Claimed £151.00; received £0.00', '£151.00'], ['Hire', 'Claimed £1,112.00', '£1,112.00']] }]);
    const r = composeLetterheadDocx(builtinAssetBytes(LETTERHEAD_TEMPLATE_ID), c, { now: new Date('2026-10-05T09:00:00Z'), reference: 'CCG-2026-00001', title: 'Chaser' });
    const xml = new TextDecoder().decode(unzipSync(r.docx)['word/document.xml']!);
    const text = docxToPlainText(r.docx);
    // numbered body paragraphs only: 1, 2, 3 — the headings and the table take no number
    expect(text).toMatch(/1\.\s*We write about the outstanding charges\./);
    expect(text).toMatch(/2\.\s*The vehicle was recovered/);
    expect(text).toMatch(/3\.\s*Pay within 14 days\./);
    expect(text).not.toMatch(/\d\.\s*The facts/);
    expect(text).not.toMatch(/\d\.\s*Deadline/);
    // a real table: each figure in its own cell
    expect((xml.match(/<w:tbl>/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(xml).toMatch(/<w:t[^>]*>£151\.00<\/w:t>/);
    expect(xml).toMatch(/<w:t[^>]*>£1,112\.00<\/w:t>/);
    expect(text).not.toContain('£0.00£151.00');
    // the role the letter was signed in replaces the printed "Claims Manager"
    expect(text).toContain('Director');
    expect(text).not.toContain('Claims Manager');
    expect(r.report.skipped).toEqual([]);
  });
});
