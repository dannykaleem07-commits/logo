import { describe, expect, it } from 'vitest';
import { docxToPlainText } from '../preview.js';
import type { LetterContent } from '../types.js';
import { builtinAssetBytes, LETTERHEAD_TEMPLATE_ID } from './builtin/index.js';
import { composeLetterheadDocx } from './letterhead.js';

const NOW = new Date('2026-10-04T08:30:00Z');
const base = (over: Partial<LetterContent> = {}): LetterContent => ({
  recipient: { name: 'Example Insurance plc', addressLines: ['1 Example Way', 'Example Town EX1 1AA'] },
  refs: { ourRef: 'CCG-2026-00012', client: 'Priya Patel', vehicle: 'Volkswagen Golf — AB12 CDE', dateOfAccident: '9 August 2026', date: '4 October 2026' },
  salutation: 'Sir or Madam',
  subject: 'CREDIT HIRE CHARGES',
  subjectClient: 'Priya Patel',
  subjectReg: 'AB12 CDE',
  paragraphs: ['the vehicle was hired from 11 August 2026.', 'Our invoice is enclosed.', 'Please pay by 18 October 2026.'],
  replaceFixedOpening: false,
  signatory: { name: 'D. Kaleem' },
  ...over
});
const compose = (c: LetterContent) => composeLetterheadDocx(builtinAssetBytes(LETTERHEAD_TEMPLATE_ID), c, { now: NOW, reference: 'CCG-2026-00012', title: 'Letter — CCG-2026-00012' });

describe('composeLetterheadDocx (§A.10)', () => {
  it('fills the letterhead and removes unused address lines, BY EMAIL, Your Ref / Claim No. rows, reply-by, Enc. and Cc.', () => {
    const { docx, report, sha256 } = compose(base());
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.skipped).toEqual([]);
    const text = docxToPlainText(docx);
    expect(text).toContain('Example Insurance plc');
    expect(text).toContain('1 Example Way');
    expect(text).toContain('Example Town EX1 1AA');
    expect(text).not.toMatch(/\[(Address line|Town|Name of handler|Department|recipient@)/);
    expect(text).not.toContain('BY EMAIL');
    expect(text).not.toContain('Your Ref');
    expect(text).not.toContain('Claim No.');
    expect(text).not.toContain('We look forward to your reply by');
    expect(text).not.toMatch(/^Enc\./m);
    expect(text).not.toMatch(/^Cc\./m);
    expect(text).toContain('CCG-2026-00012');
    expect(text).toContain('Dear Sir or Madam');
    expect(text).toMatch(/RE:\s+CREDIT HIRE CHARGES\s+—\s+Priya Patel · AB12 CDE/);
    expect(text).toContain('Yours faithfully');
    expect(text).toContain('D. Kaleem');
    expect(text).toContain('Claims Manager'); // pre-printed role never changed
    expect(text).not.toMatch(/\[[^\]]+\]/); // no placeholder left
  });

  it('numbers the paragraphs 1..n and keeps the printed opening sentence in paragraph 1', () => {
    const text = docxToPlainText(compose(base()).docx);
    expect(text).toMatch(/1\.\tWe act on behalf of our client in respect of the vehicle losses arising from the above accident\. the vehicle was hired from 11 August 2026\./);
    expect(text).toMatch(/2\.\tOur invoice is enclosed\./);
    expect(text).toMatch(/3\.\tPlease pay by 18 October 2026\./);
    expect(text).not.toMatch(/^4\./m);
    const five = docxToPlainText(compose(base({ paragraphs: ['a.', 'b.', 'c.', 'd.', 'e.'] })).docx);
    expect(five).toMatch(/5\.\te\./);
  });

  it('replaceFixedOpening drops the printed opening sentence', () => {
    const text = docxToPlainText(compose(base({ replaceFixedOpening: true, paragraphs: ['We write about our client Priya Patel.', 'Second.'] })).docx);
    expect(text).toMatch(/1\.\tWe write about our client Priya Patel\./);
    expect(text).not.toContain('in respect of the vehicle losses arising from the above accident');
  });

  it('keeps every element that has a value: attention, department, three address lines, email, refs, reply-by, enclosures, cc', () => {
    const text = docxToPlainText(
      compose(
        base({
          recipient: { attention: 'Ms Jones', department: 'Third Party Claims Team', name: 'Example Insurance plc', addressLines: ['Claims Department', '1 Example Way', 'Floor 2', 'Example Town EX1 1AA'], email: 'claims@example-insurance.co.uk' },
          refs: { ourRef: 'CCG-2026-00012', yourRef: 'EXI/778/2026', claimNo: 'TP-1', client: 'Priya Patel', vehicle: 'Volkswagen Golf — AB12 CDE', dateOfAccident: '9 August 2026', date: '4 October 2026' },
          salutation: 'Ms Jones',
          replyBy: '18 October 2026',
          enclosures: ['Invoice INV-HIRE-0012', 'Engineer report'],
          cc: ['Priya Patel (client)']
        })
      ).docx
    );
    expect(text).toContain('Ms Jones');
    expect(text).toContain('Third Party Claims Team');
    expect(text).toContain('Claims Department');
    expect(text).toContain('1 Example Way, Floor 2');
    expect(text).toContain('claims@example-insurance.co.uk');
    expect(text).toContain('EXI/778/2026');
    expect(text).toContain('TP-1');
    expect(text).toContain('We look forward to your reply by 18 October 2026.');
    expect(text).toContain('Yours sincerely');
    expect(text).toContain('1. Invoice INV-HIRE-0012; 2. Engineer report');
    expect(text).toContain('Priya Patel (client)');
  });

  it('is deterministic for the same inputs', () => {
    expect(compose(base()).sha256).toBe(compose(base()).sha256);
  });
});
