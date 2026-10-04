import { describe, expect, it } from 'vitest';
import { brand } from '../brand.js';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { DocumentDataError, getTemplate, hasTemplate, listTemplates, missingRequiredData, renderTemplate } from '../registry.js';
import { PACK_COMPONENTS, PackDataError, endTriggerLabel, gtaPaymentPackTemplate, litigationBundleIndexTemplate, packsBundlesTemplates } from './packs-bundles.js';

const BANNED = [
  'FOS',
  'Ombudsman',
  'our client',
  'our solicitors',
  'we act for',
  'legal advice',
  'our lawyers',
  'under the GTA you',
  'entitled under the GTA',
  'GTA entitles',
  'required by the GTA',
  'Invalid Date',
  'NaN',
  'undefined',
  '[object Object]'
];

function textOf(id: string): string {
  return htmlToText(renderTemplate(id, getTemplate(id).sample()).html);
}

describe('packs-bundles: registration', () => {
  it('registers pack.gta_payment (1.1.0) and bundle.litigation_index (1.0.0)', () => {
    expect(packsBundlesTemplates.map((t) => t.id)).toEqual(['pack.gta_payment', 'bundle.litigation_index']);
    expect(hasTemplate('pack.gta_payment')).toBe(true);
    expect(hasTemplate('bundle.litigation_index')).toBe(true);
    expect(listTemplates().find((m) => m.id === 'pack.gta_payment')).toMatchObject({ kind: 'pack', version: '1.1.0', recipientRole: 'at_fault_insurer' });
    expect(listTemplates().find((m) => m.id === 'bundle.litigation_index')).toMatchObject({ kind: 'bundle', version: '1.0.0', recipientRole: 'court' });
  });

  for (const template of packsBundlesTemplates) {
    it(`${template.id}: sample satisfies requiredData, renders deterministically, no legacy/banned/forum content`, () => {
      const data = template.sample();
      expect(missingRequiredData(template, data)).toEqual([]);
      const first = renderTemplate(template.id, data);
      expect(renderTemplate(template.id, template.sample()).html).toBe(first.html);
      const html = first.html;
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('class="logo-lockup"');
      expect(html).toContain(`Our ref</th><td>${data.claim.ourReference}`);
      expect(html).toContain(brand.company.statusLine);
      expect(html).toContain('company number 17430389');
      expect(findProhibitedContent(html)).toEqual([]);
      const text = htmlToText(html);
      for (const needle of BANNED) expect(text, `"${needle}" must not appear in ${template.id}`).not.toContain(needle);
      for (const legacy of brand.legacy.blockedStrings) expect(text.toLowerCase()).not.toContain(legacy.toLowerCase());
      if (/\bGTA\b/.test(text)) expect(text).toContain('industry benchmark');
      expect(text).not.toMatch(/\bentitled?\b/i);
    });
  }
});

describe('pack.gta_payment', () => {
  const html = renderTemplate('pack.gta_payment', gtaPaymentPackTemplate.sample()).html;
  const text = htmlToText(html);

  it('is a covering letter to the insurer that lists the GTA 6.1–6.3 contents with ticks, crosses and not-applicable from the data', () => {
    expect(text).toContain('We are instructed to correspond on behalf of Ms Jane Example');
    expect(text).toContain('The contents follow GTA paragraphs 6.1 to 6.3');
    expect(text).toContain('We are not a GTA subscriber');
    for (const c of PACK_COMPONENTS) expect(text).toContain(c.label);
    expect(html).toContain('<span class="tick">✓</span> Enclosed');
    expect(html).toContain('<span class="cross">✗</span> Not enclosed'); // photographs not in present[]
    expect(html).toContain('<span class="na">— Not applicable</span>'); // repair account
    expect(text).toContain('Hire Period Validation Form GTA 6.2 (Appendix B) ✓ Enclosed');
    expect(text).toContain('Photographs of the damage, delivery and collection Supporting ✗ Not enclosed');
    expect(text).toContain('Repair account approved by the engineer GTA 6.3 — Not applicable');
  });

  it('prints the heads of claim and ledger totals through the formatters, each with its invoice as source', () => {
    expect(text).toContain('Hire charges');
    expect(text).toContain('24 days');
    expect(text).toContain('£49.80');
    expect(text).toContain('£1,195.20 £239.04 £1,434.24 INV-H-0042');
    expect(text).toContain('Recovery');
    expect(text).toContain('£151.00 £30.20 £181.20 INV-R-0042');
    expect(text).toContain('£360.00 £72.00 £432.00 INV-S-0042');
    expect(text).toContain('£180.00 £36.00 £216.00 INV-E-0042');
    expect(text).toContain('Total payable £1,886.20 £377.24 £2,263.44');
  });

  it('requests settlement within one calendar month as the industry benchmark (GTA 6.7) and payment of undisputed heads now', () => {
    expect(text).toContain('Payment of £2,263.44 to the account below by Sunday 4 October 2026, one calendar month from dispatch of this pack. GTA paragraph 6.7 reflects this as the industry benchmark for settlement of a clean pack.');
    expect(text).toContain('pay the undisputed heads now. A dispute about one head is not a reason to withhold payment of the others.');
    expect(text).toContain('Account name: Courtesy Cars Group UK Ltd');
    expect(text).toContain('Sort code 00-00-00');
    expect(text).toContain('Confirmation of Payee returns a full match');
    expect(text).toContain('If payment or a reasoned response is not received by Sunday 4 October 2026');
    expect(html).toContain('<ol class="numbered">');
    expect(text).toContain('Yours faithfully');
  });

  it('includes the Hire Period Validation Form on its own pages with dates, trigger, roadworthiness, milestones and monitoring calls', () => {
    expect(html).toContain('<div class="page-break"></div>');
    expect(text).toContain('Hire Period Validation Form');
    expect(text).toContain('Hire started 10 August 2026, 09:30');
    expect(text).toContain('Hire ended 2 September 2026, 16:40');
    expect(text).toContain('Days billed (inclusive) 24 days');
    expect(text).toContain('End trigger Repair completed; hire ended within 24 hours (GTA 4.8)');
    expect(text).toContain('Roadworthy after the accident No');
    expect(text).toContain('Route Repair');
    expect(text).toContain('Odometer out / in 18,452 / 19,261 miles (809 miles driven)');
    expect(text).toContain('Repair authorised by you Your email of 28 August 2026');
    expect(text).toContain('Monitoring checks (GTA 4.10 and 4.11 cadence as industry practice)');
    expect(text).toContain('19 August 2026, 10:05 Repairer (Example Bodyshop)');
    expect(text).toContain('Delay notices sent to you: 24 August 2026');
    expect(text).toContain('Hire charges are claimed for 24 days, from 10 August 2026 to 2 September 2026 inclusive, and for no other period.');
    expect(text).toContain('Completed by');
  });

  it('labels every end trigger', () => {
    expect(endTriggerLabel('tl_payment_5wd')).toContain('five working days (GTA 4.14)');
    expect(endTriggerLabel('insurer_termination_1wd')).toContain('GTA 4.9');
    expect(endTriggerLabel('cash_in_lieu')).toContain('GTA 4.7');
    expect(endTriggerLabel('client_returned')).toBe('Vehicle returned by the claimant');
  });

  it('says the pack is complete only when it is, and otherwise says what follows', () => {
    expect(text).toContain('The hire has ended. We enclose the payment pack for hire charges, recovery, storage and independent engineer’s fee; the items marked below as not enclosed will follow under separate cover, quoting our reference.');
    expect(text).not.toContain('the documentation is complete');
    const data = gtaPaymentPackTemplate.sample();
    const complete = htmlToText(renderTemplate('pack.gta_payment', { ...data, present: [...data.present, 'photographs'] }).html);
    expect(complete).toContain('The hire has ended and the documentation is complete. We enclose the payment pack for hire charges, recovery, storage and independent engineer’s fee.');
    expect(complete).not.toContain('Not enclosed');
  });

  it('always marks the covering letter and the Hire Period Validation Form as enclosed, because this document is them', () => {
    const data = gtaPaymentPackTemplate.sample();
    const t = htmlToText(renderTemplate('pack.gta_payment', { ...data, present: ['hire_invoice'], notApplicable: ['covering_letter', 'hire_period_validation', 'repair_account'] }).html);
    expect(t).toContain('Covering letter detailing the payments required and the documents submitted GTA 6.2 (Appendix D) ✓ Enclosed');
    expect(t).toContain('Hire Period Validation Form GTA 6.2 (Appendix B) ✓ Enclosed');
    expect(t).toContain('Hire account (invoice) GTA 6.1 ✓ Enclosed');
    expect(t).toContain('Repair account approved by the engineer GTA 6.3 — Not applicable');
    expect(t).toContain('Mitigation Questionnaire and Statement of Truth signed by the hirer GTA 6.2 (Appendix C) ✗ Not enclosed');
  });

  it('refuses to render when the heads do not reconcile with the totals, a head’s gross is wrong, or the day count disagrees with the period', () => {
    const data = gtaPaymentPackTemplate.sample();
    expect(() => renderTemplate('pack.gta_payment', { ...data, totals: { ...data.totals, grossPence: data.totals.grossPence + 1 } })).toThrow(PackDataError);
    expect(() => renderTemplate('pack.gta_payment', { ...data, totals: { ...data.totals, netPence: 128700 } })).toThrow(/heads sum to £1,886\.20 \/ £377\.24 \/ £2,263\.44 but totals say £1,287\.00/);
    const badHead = data.heads.map((h, i) => (i === 0 ? { ...h, grossPence: h.grossPence - 100 } : h));
    expect(() => renderTemplate('pack.gta_payment', { ...data, heads: badHead })).toThrow(/does not equal gross/);
    expect(() => renderTemplate('pack.gta_payment', { ...data, hire: { ...data.hire, days: 23 } })).toThrow(/inclusive day count/);
    expect(() => renderTemplate('pack.gta_payment', { ...data, heads: [], totals: { netPence: 0, vatPence: 0, grossPence: 0 } })).toThrow(/no heads of claim/);
    expect(() => renderTemplate('pack.gta_payment', data)).not.toThrow();
  });

  it('refuses to render without the ledger totals or the settlement date', () => {
    const data = gtaPaymentPackTemplate.sample();
    let err: unknown;
    try {
      renderTemplate('pack.gta_payment', { ...data, totals: undefined as never, settlementDueBy: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['totals.netPence', 'totals.vatPence', 'totals.grossPence', 'settlementDueBy']);
  });
});

describe('bundle.litigation_index', () => {
  const html = renderTemplate('bundle.litigation_index', litigationBundleIndexTemplate.sample()).html;
  const text = htmlToText(html);

  it('has a cover sheet naming the court, the parties and the claimant as litigant in person', () => {
    expect(text).toContain('In the County Court at Example');
    expect(text).toContain('Claim No. K00EX123');
    expect(text).toContain('Ms Jane Example Claimant and Mr John Sample Defendant');
    expect(text).toContain('Claimant’s hearing bundle');
    expect(text).toContain('The Claimant, Ms Jane Example, acts in person (litigant in person).');
    expect(text).toContain('Small claims hearing');
    expect(text).toContain('18 November 2026, 10:00');
    expect(text).toContain('paginated consecutively from page 1 to page 97');
    expect(text).toContain('is not a firm of solicitors. The Claimant is responsible for the conduct of the claim.');
    expect(text).not.toContain('for and on behalf of Courtesy Cars Group UK Ltd');
  });

  it('indexes every section with page references from the data', () => {
    expect(html).toContain('<div class="page-break"></div>');
    expect(text).toContain('1 Claim form and particulars of claim 1–10');
    expect(text).toContain('1.1 Claim form N1 28 September 2026 1–3');
    expect(text).toContain('2 Schedule of loss 11–12');
    expect(text).toContain('3 Witness statements 13–18');
    expect(text).toContain('4 Hire agreement and forms 19–62');
    expect(text).toContain('4.3 Express request to begin the hire 10 August 2026 29');
    expect(text).toContain('5 Invoices 63–67');
    expect(text).toContain('6 Engineer’s report 68–79');
    expect(text).toContain('7 Correspondence (chronological) 80–95');
    expect(text).toContain('8 Part 36 offers 96–97');
  });

  it('refuses page references that run backwards, overlap, or fall outside the bundle', () => {
    const data = litigationBundleIndexTemplate.sample();
    expect(() => renderTemplate('bundle.litigation_index', { ...data, totalPages: 96 })).toThrow(RangeError);
    expect(() => renderTemplate('bundle.litigation_index', { ...data, totalPages: 0 })).toThrow(/totalPages/);
    const overlapping = data.sections.map((s, i) => (i === 1 ? { ...s, documents: [{ ...s.documents[0]!, startPage: 10 }] } : s));
    expect(() => renderTemplate('bundle.litigation_index', { ...data, sections: overlapping })).toThrow(/out of sequence/);
    const inverted = data.sections.map((s, i) => (i === 1 ? { ...s, documents: [{ ...s.documents[0]!, startPage: 12, endPage: 11 }] } : s));
    expect(() => renderTemplate('bundle.litigation_index', { ...data, sections: inverted })).toThrow(RangeError);
    expect(() => renderTemplate('bundle.litigation_index', { ...data, totalPages: 120 })).not.toThrow(); // blank pages at the end are allowed
  });

  it('names the instructed solicitor instead when the claimant is represented', () => {
    const data = { ...litigationBundleIndexTemplate.sample(), claimantActsInPerson: false, solicitorName: 'Example Solicitors LLP' };
    const t = htmlToText(renderTemplate('bundle.litigation_index', data).html);
    expect(t).toContain('The Claimant is represented by Example Solicitors LLP.');
    expect(t).not.toContain('acts in person');
  });
});
