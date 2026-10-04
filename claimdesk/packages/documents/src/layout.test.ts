import { describe, expect, it } from 'vitest';
import { brand, formatRegisteredOffice } from './brand.js';
import { sampleBaseData, sampleClaim, sampleRecipient, sampleSettings } from './common.js';
import { findBannedPhrases, findBlockedStrings, findProhibitedContent, htmlToText } from './guards.js';
import {
  baseLayout,
  ccList,
  chronologyTable,
  contactStrip,
  enclosuresList,
  figuresTable,
  footerTemplate,
  headerTemplate,
  letterBlock,
  partnerMarkSlot,
  readDocumentMeta,
  replyByLine,
  reLine,
  scheduleTable,
  signatureBlock,
  standardOpener,
  statementOfTruth,
  subjectBlock
} from './layout.js';
import { logoSvg, minifySvg } from './logo.js';

const base = sampleBaseData();

function renderLetter(): string {
  return baseLayout({
    title: 'Test letter',
    kind: 'letter',
    reference: base.claim.ourReference,
    theirReference: base.claim.theirReference,
    date: base.date,
    recipient: base.recipient,
    settings: base.settings,
    signatory: base.signatory,
    bodyHtml: `${subjectBlock(base.claim)}<p>Dear Sirs,</p>${standardOpener(base.claim)}`
  });
}

describe('logo', () => {
  it('inlines the SVG once, scaled by CSS, without the XML header', () => {
    const svg = logoSvg();
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('<?xml');
    expect(svg).not.toMatch(/<svg[^>]*\swidth=/);
    expect(svg).toContain('viewBox="0 0 2000 396"');
    expect(svg).toContain('#1466D2'); // logo colours untouched
    expect(logoSvg()).toBe(svg); // cached
  });

  it('rounds only path data', () => {
    const out = minifySvg('<?xml version="1.0"?>\n<svg width="10" height="5" viewBox="0 0 1 1"><stop offset="0.45"/><path d="M1.234 5.678 L0.05 2.96"/></svg>');
    expect(out).toBe('<svg viewBox="0 0 1 1"><stop offset="0.45"/><path d="M1.2 5.7 L0.1 3"/></svg>');
  });
});

describe('baseLayout', () => {
  const html = renderLetter();

  it('is a complete document with the mandatory elements', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>Test letter — CCG-2026-00012</title>');
    expect(html).toContain('class="logo-lockup"');
    expect(html).toContain('<svg');
    expect(html).toContain('Our ref</th><td>CCG-2026-00012');
    expect(html).toContain('Your ref</th><td>EXI/TP/4471920');
    expect(html).toContain('Date</th><td>4 October 2026');
    expect(html).toContain('Example Insurance plc');
    expect(html).toContain('By email: thirdpartyclaims@example-insurer.test');
    expect(html).toContain('AB12 CDE');
    expect(html).toContain('9 August 2026');
    expect(html).toContain(brand.company.statusLine);
    expect(html).toContain(brand.tradingDisclosure('44 Syon Lane, Isleworth, London TW7 5NQ'));
    expect(html).not.toMatch(/\[registered office\]/);
    expect(html).toContain(brand.typography.fontStack);
    expect(html).toContain('Yours faithfully');
    expect(html).toContain('for and on behalf of Courtesy Cars Group UK Ltd');
    expect(html).toContain('We are instructed to correspond on behalf of Ms Jane Example');
  });

  it('shows the contact strip on letters and the company block on invoices', () => {
    expect(html).toContain('class="contact-strip"');
    expect(html).not.toContain('class="company-block"');
    const invoice = baseLayout({
      title: 'Invoice',
      kind: 'invoice',
      reference: 'INV-0001',
      date: '2026-10-04',
      settings: sampleSettings({ vatNumber: 'GB000000000' }),
      meta: [{ label: 'Due date', value: '18 October 2026' }],
      bodyHtml: '<p>x</p>'
    });
    expect(invoice).toContain('class="company-block"');
    expect(invoice).toContain('Company no. 17430389');
    expect(invoice).toContain('VAT number GB000000000');
    expect(invoice).toContain('44 Syon Lane, Isleworth, London TW7 5NQ');
    expect(invoice).not.toMatch(/\[registered office\]/);
    expect(invoice).toContain('<h1>Invoice</h1>');
    expect(invoice).toContain('Due date</th><td>18 October 2026');
    expect(invoice).not.toContain('Yours faithfully');
  });

  it('embeds meta the renderer can read back', () => {
    expect(readDocumentMeta(html)).toEqual({ kind: 'letter', reference: 'CCG-2026-00012', date: '2026-10-04', registeredOffice: '44 Syon Lane, Isleworth, London TW7 5NQ' });
  });

  it('contains no legacy strings or banned phrases', () => {
    expect(findBlockedStrings(html)).toEqual([]);
    expect(findBannedPhrases(html)).toEqual([]);
    expect(findProhibitedContent(headerTemplate('CCG-2026-00012') + footerTemplate())).toEqual([]);
  });

  it('escapes data', () => {
    const out = baseLayout({
      title: 'T',
      kind: 'notice',
      reference: 'R<1>',
      date: '2026-10-04',
      recipient: sampleRecipient({ name: 'Acme & <Sons>' }),
      bodyHtml: ''
    });
    expect(out).toContain('R&lt;1&gt;');
    expect(out).toContain('Acme &amp; &lt;Sons&gt;');
  });
});

describe('header and footer templates', () => {
  it('carry the reference, page numbering and disclosures', () => {
    const h = headerTemplate('CCG-2026-00012');
    expect(h).toContain('CCG-2026-00012');
    expect(h).toContain('<span class="pageNumber"></span>');
    expect(h).toContain('<span class="totalPages"></span>');
    const f = footerTemplate(brand.company.statusLine, brand.tradingDisclosure('1 Example Street, Example Town, EX1 1AA'));
    expect(f).toContain('not a firm of solicitors');
    expect(f).toContain('Registered office: 1 Example Street, Example Town, EX1 1AA');
    expect(f).toContain('company number 17430389');
  });

  it('mirror the letterhead: registered name and our ref left, PAGE n OF N right; contact line in the footer', () => {
    const text = htmlToText(headerTemplate('CCG-2026-00012'));
    expect(text).toMatch(/COURTESY CARS GROUP UK LTD \| Our ref CCG-2026-00012/);
    expect(text).toMatch(/PAGE\s+OF/);
    const f = htmlToText(footerTemplate());
    expect(f).toContain('Registered in England and Wales, company number 17430389');
    expect(f).toContain('Registered office: 44 Syon Lane, Isleworth, London TW7 5NQ');
    expect(f).toContain('Case handler 07425 475922 · Office 020 7052 5403 · claims@courtesycars.net · www.courtesycars.net');
    expect(footerTemplate() + headerTemplate('X')).not.toMatch(/accreditation|<img/i);
  });
});

describe('company details (design doc §H)', () => {
  it('formatRegisteredOffice joins the parts and falls back to the brand default', () => {
    expect(formatRegisteredOffice()).toBe('44 Syon Lane, Isleworth, London TW7 5NQ');
    expect(formatRegisteredOffice(brand.company.registeredOfficeAddress)).toBe('44 Syon Lane, Isleworth, London TW7 5NQ');
    expect(formatRegisteredOffice({ line1: '1 Example Way', town: 'Leeds', county: 'West Yorkshire', postcode: 'LS1 1AA' })).toBe('1 Example Way, Leeds, West Yorkshire LS1 1AA');
    expect(formatRegisteredOffice({ line1: '', postcode: '' })).toBe('44 Syon Lane, Isleworth, London TW7 5NQ');
    expect(brand.company.registeredOffice).toBe(formatRegisteredOffice());
    expect(brand.company.accidentLine24h).toBe(brand.company.officePhone);
  });

  it('the masthead prints the letterhead first-page block', () => {
    const text = htmlToText(contactStrip());
    for (const line of ['COURTESY CARS GROUP UK LTD', '44 Syon Lane, Isleworth, London TW7 5NQ', 'Case handler 07425 475922 · Office 020 7052 5403', 'claims@courtesycars.net · www.courtesycars.net', 'Company no. 17430389']) {
      expect(text).toContain(line);
    }
    expect(htmlToText(contactStrip({ registeredOffice: '1 Example Way, Leeds LS1 1AA' }))).toContain('1 Example Way, Leeds LS1 1AA');
  });
});

describe('letter parts (data-letter-part, design doc §H.3)', () => {
  const html = baseLayout({
    title: 'Parts',
    kind: 'letter',
    reference: 'CCG-2026-00012',
    theirReference: 'EXI/TP/4471920',
    date: '2026-10-04',
    recipient: sampleRecipient(),
    settings: sampleSettings(),
    signatory: { name: 'D. Kaleem', role: 'Claims Manager' },
    meta: [{ label: 'Claim number', value: 'CL-99' }],
    enclosures: ['Invoice INV-0042'],
    cc: ['Ms Jane Example'],
    bodyHtml: `${subjectBlock(sampleClaim())}${reLine('Credit hire charges')}<p>Dear Sirs,</p><p>Body text.</p>${replyByLine('Please reply by 5pm on 18 October 2026.')}`
  });
  const part = (name: string): string | undefined => new RegExp(`<[a-z]+[^>]*data-letter-part="${name}"[^>]*>([\\s\\S]*?)</`).exec(html)?.[1];

  it('marks every part the letterhead composer reads', () => {
    for (const name of ['recipient', 'ref-our', 'ref-your', 'ref-claim', 'ref-client', 'ref-vehicle', 'ref-accident', 'ref-date', 'subject', 'salutation', 'body', 'reply-by', 'valediction', 'signatory-name', 'enclosures', 'cc']) {
      expect(html, name).toContain(`data-letter-part="${name}"`);
    }
    expect(part('salutation')).toBe('Dear Sirs,');
    expect(part('valediction')).toBe('Yours faithfully');
    expect(html).toContain('<tr data-letter-part="ref-claim"><th>Claim number</th><td>CL-99</td></tr>');
    expect(html).toContain('<tr data-letter-part="ref-our"><th>Our ref</th><td>CCG-2026-00012</td></tr>');
    expect(html).toContain('<p class="re" data-letter-part="subject">Credit hire charges</p>');
    expect(html).toMatch(/<address class="recipient" data-letter-part="recipient" data-email="thirdpartyclaims@example-insurer.test"/);
    expect(html).toContain('<div class="name" data-line="name">Example Insurance plc</div>');
    expect(html).toContain('<div data-line="attention">Third Party Claims Team</div>');
    expect(html).toContain('<div data-line="address">PO Box 100</div>');
    expect(html).toContain('<main class="body" data-letter-part="body">');
    expect(html).toContain('data-letter-part="signatory-name"><strong>D. Kaleem</strong>');
  });

  it('only marks the first salutation and leaves non-letters alone', () => {
    const notice = baseLayout({ title: 'N', kind: 'notice', reference: 'R', date: '2026-10-04', bodyHtml: '<p>Dear Sirs,</p>' });
    expect(notice).not.toContain('data-letter-part="salutation"');
    expect(enclosuresList([])).toBe('');
    expect(ccList(['  '])).toBe('');
  });
});

describe('partials', () => {
  it('figuresTable prints money through formatGBP and marks totals', () => {
    const t = figuresTable([
      { label: 'Hire', valuePence: 119520 },
      { label: 'Received', valuePence: -111200, note: 'remittance 12 Sep' },
      { label: 'Outstanding', valuePence: 8320, emphasis: true },
      { label: 'Basis', text: 'GTA group S1 (industry benchmark)' }
    ]);
    expect(t).toContain('£1,195.20');
    expect(t).toContain('-£1,112.00');
    expect(t).toContain('<tr class="total"><td class="label">Outstanding</td><td class="num">£83.20</td></tr>');
    expect(t).toContain('<span class="note">remittance 12 Sep</span>');
    expect(t).toContain('industry benchmark');
    expect(figuresTable([])).toBe('');
  });

  it('chronologyTable shows dates and the attribution column only when used', () => {
    const plain = chronologyTable([{ date: '2026-08-09', description: 'Accident' }]);
    expect(plain).toContain('9 August 2026');
    expect(plain).not.toContain('Attributable to');
    const attr = chronologyTable([{ date: '2026-08-14T10:30:00+01:00', description: 'Inspection', attributableTo: 'insurer' }]);
    expect(attr).toContain('Attributable to');
    expect(attr).toContain('<td>Insurer</td>');
    expect(attr).toContain('14 August 2026, 10:30');
    expect(chronologyTable([{ date: '2026-08-09', description: 'Accident', attributableTo: 'none' }])).toContain('<td>\u2014</td>');
  });

  it('scheduleTable sums lines in pence or uses ledger totals', () => {
    const lines = [
      { description: 'Hire', quantity: '24 days', ratePence: 4980, netPence: 119520, vatPence: 23904 },
      { description: 'Recovery', detail: '£90 call-out + 31 loaded miles + admin', netPence: 20800, vatPence: 4160 }
    ];
    const summed = scheduleTable(lines);
    expect(summed).toContain('£1,403.20'); // net total
    expect(summed).toContain('£280.64'); // vat total
    expect(summed).toContain('£1,683.84'); // gross total
    expect(summed).toContain('Quantity');
    expect(summed).toContain('24 days');
    const ledger = scheduleTable(lines, { totals: { netPence: 140320, vatPence: 28064, grossPence: 168384 }, totalLabel: 'Total due' });
    expect(ledger).toContain('Total due');
    expect(ledger).toContain('£1,683.84');
    const noVat = scheduleTable([{ description: 'PAV', netPence: 850000 }]);
    expect(noVat).toContain('<th class="num">Amount</th>');
    expect(noVat).not.toContain('VAT');
  });

  it('signatureBlock and statementOfTruth', () => {
    const s = signatureBlock({ name: 'D. Kaleem', role: 'Claims Manager' }, '2026-10-04', { closing: 'Yours faithfully' });
    expect(s).toContain('Yours faithfully');
    expect(s).toContain('Date: 4 October 2026');
    const claimant = statementOfTruth({ kind: 'claimant', signatoryName: 'Ms Jane Example', documentNoun: 'questionnaire' });
    expect(claimant).toContain('I believe that the facts stated in this questionnaire are true.');
    expect(claimant).toContain('proceedings for contempt of court');
    expect(claimant).toContain('Ms Jane Example');
    expect(statementOfTruth({ kind: 'witness' })).toContain('this witness statement are true');
    expect(statementOfTruth({ kind: 'expert' })).toContain('true and complete professional opinions');
  });

  it('letterBlock without a recipient still prints the references', () => {
    const lb = letterBlock({ reference: 'CCG-1', date: '2026-10-04' });
    expect(lb).toContain('CCG-1');
    expect(lb).not.toContain('Your ref');
  });

  it('partnerMarkSlot renders nothing while disabled', () => {
    expect(brand.partnerMarkEnabled).toBe(false);
    expect(partnerMarkSlot()).toBe('');
  });

  it('subjectBlock lists the claim facts', () => {
    const sb = subjectBlock(sampleClaim());
    expect(sb).toContain('Our client</th><td>Ms Jane Example');
    expect(sb).toContain('Your insured</th><td>Mr John Sample (XY65 ZZZ)');
    expect(sb).toContain('Your reference</th><td>EXI/TP/4471920');
  });
});

describe('guards', () => {
  it('catch legacy strings case-insensitively but allow the exact CARFLEX LTD', () => {
    expect(findBlockedStrings('<p>Trading as car flex</p>').map((h) => h.needle)).toEqual(['Car Flex']);
    expect(findBlockedStrings('Carflex Ltd supplied the vehicle')).toHaveLength(1);
    expect(findBlockedStrings('CARFLEX LTD (12640635) supplied the vehicle')).toEqual([]);
    expect(findBlockedStrings('66 Paul Street, London EC2A 4PX').map((h) => h.needle)).toEqual(['66 Paul Street', 'EC2A 4PX']);
    expect(findBlockedStrings('company 17360033')).toHaveLength(1);
    expect(findBlockedStrings('www.courtesycarsuk.co.uk')).toHaveLength(1);
  });

  it('catch banned phrases but tolerate the mandatory status line', () => {
    expect(findBannedPhrases(brand.company.statusLine)).toEqual([]);
    expect(findBannedPhrases('We are regulated by the SRA.')).toHaveLength(1);
    expect(findBannedPhrases('Please ignore any offer of a courtesy car.')).toHaveLength(1);
    expect(findBannedPhrases('<p>our <b>solicitors</b> will write</p>')).toHaveLength(1);
    expect(htmlToText('<p>a&amp;b</p> <svg>x</svg>')).toBe('a&b');
  });
});
