import { describe, expect, it } from 'vitest';
import { brand } from '../brand.js';
import { formatGBP } from '../format.js';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { DocumentDataError, getTemplate, hasTemplate, listTemplates, missingRequiredData, renderTemplate } from '../registry.js';
import {
  engineerFeeInvoiceTemplate,
  hireInvoiceTemplate,
  type InvoiceBaseData,
  invoiceTemplates,
  isVatRegistered,
  recoveryInvoiceTemplate,
  storageInvoiceTemplate
} from './invoices.js';

/** Perimeter phrases that must never appear on an account sent to the at-fault insurer (perimeter.md). */
const BANNED_IN_INVOICES = [
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

function renderText(id: string, data?: unknown): string {
  return htmlToText(renderTemplate(id, data ?? getTemplate(id).sample()).html);
}

/** Every amount in the ledger totals must be printed exactly as formatGBP prints it. */
function expectTotalsPrinted(text: string, totals: InvoiceBaseData['totals']): void {
  expect(text).toContain(`Net total ${formatGBP(totals.netPence)}`);
  expect(text).toContain(`Total due ${formatGBP(totals.grossPence)}`);
  expect(text).toContain(formatGBP(totals.vatPence));
}

describe('invoices: registration', () => {
  it('registers the four payment-pack accounts with version 1.0.0, kind invoice and the at-fault insurer as recipient', () => {
    const ids = ['invoice.hire', 'invoice.storage', 'invoice.recovery', 'invoice.engineer_fee'];
    expect(invoiceTemplates.map((t) => t.id)).toEqual(ids);
    for (const id of ids) {
      expect(hasTemplate(id)).toBe(true);
      const meta = listTemplates().find((m) => m.id === id);
      expect(meta).toMatchObject({ id, version: '1.0.0', kind: 'invoice', recipientRole: 'at_fault_insurer' });
      for (const key of ['invoiceNumber', 'taxPointDate', 'vatRate', 'totals.netPence', 'totals.vatPence', 'totals.grossPence', 'settings.bank.accountName', 'date']) {
        expect(meta?.requiredData, `${id} requires ${key}`).toContain(key);
      }
    }
  });
});

describe('invoices: every template renders its sample cleanly', () => {
  for (const template of invoiceTemplates) {
    it(`${template.id}: company block, invoice number, tax point, payee block, VAT position, totals; no legacy or banned content`, () => {
      const data = template.sample() as InvoiceBaseData;
      expect(missingRequiredData(template, data)).toEqual([]);
      const first = renderTemplate(template.id, data);
      const second = renderTemplate(template.id, template.sample());
      expect(second.html).toBe(first.html); // pure: same data, same html
      const html = first.html;
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('class="logo-lockup"');
      expect(html).toContain('class="company-block"'); // full company details alongside the logo on every invoice
      expect(html).toContain('<meta name="ccguk:kind" content="invoice">');
      expect(html).toContain(`Invoice number</th><td>${data.invoiceNumber}`);
      expect(html).toContain('Tax point</th><td>');
      expect(html).toContain(`Our ref</th><td>${data.claim.ourReference}`);
      expect(html).toContain(brand.company.statusLine);
      expect(html).toContain('company number 17430389');
      expect(findProhibitedContent(html)).toEqual([]);

      const text = htmlToText(html);
      // Payee block: the exact registered name, from settings.bank, for Confirmation of Payee.
      expect(text).toContain('Account name Courtesy Cars Group UK Ltd');
      expect(text).toContain(`Sort code ${data.settings.bank.sortCode}`);
      expect(text).toContain(`Account number ${data.settings.bank.accountNumber}`);
      expect(text).toContain(`Payment reference ${data.invoiceNumber}`);
      expect(text).toContain('Confirmation of Payee');
      // VAT position: the sample settings carry no VAT number.
      expect(isVatRegistered(data)).toBe(false);
      expect(text).toContain('VAT not applicable');
      expect(text).not.toContain('VAT at ');
      expectTotalsPrinted(text, data.totals);
      // Claimant and accident identified; "Claimant", never "our client".
      expect(text).toContain(`Claimant ${data.claim.claimantName}`);
      expect(text).toContain('Basis of charge');
      for (const needle of BANNED_IN_INVOICES) {
        expect(text, `"${needle}" must not appear in ${template.id}`).not.toContain(needle);
      }
      for (const legacy of brand.legacy.blockedStrings) {
        expect(text.toLowerCase()).not.toContain(legacy.toLowerCase());
      }
      if (/\bGTA\b/.test(text)) expect(text).toContain('industry benchmark');
      expect(text).not.toMatch(/\bentitled?\b/i);
    });
  }

  it('shows VAT at the data rate with the VAT number when the company is VAT registered', () => {
    const data = hireInvoiceTemplate.sample();
    const registered = {
      ...data,
      settings: { ...data.settings, vatNumber: 'GB123456789' },
      totals: { netPence: 119520, vatPence: 23904, grossPence: 143424 }
    };
    expect(isVatRegistered(registered)).toBe(true);
    const text = renderText('invoice.hire', registered);
    expect(text).toContain('VAT at 20% VAT number GB123456789 £239.04');
    expect(text).toContain('Total due £1,434.24');
    expect(text).not.toContain('VAT not applicable');
    expect(text).toContain('VAT number GB123456789'); // company block too
  });

  it('prints receipts and the balance when the ledger holds a part payment', () => {
    const data = hireInvoiceTemplate.sample();
    const text = renderText('invoice.hire', { ...data, receivedPence: 111200, balancePence: 8320 });
    expect(text).toContain('Received to date -£1,112.00');
    expect(text).toContain('Balance outstanding £83.20');
  });

  it('refuses to render without the required data and names every missing key', () => {
    const data = storageInvoiceTemplate.sample();
    const broken = { ...data, invoiceNumber: '', totals: undefined as never, storage: { ...data.storage, dailyRatePence: undefined as never } };
    let err: unknown;
    try {
      renderTemplate('invoice.storage', broken);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['invoiceNumber', 'totals.netPence', 'totals.vatPence', 'totals.grossPence', 'storage.dailyRatePence']);
  });
});

describe('invoice.hire', () => {
  const data = hireInvoiceTemplate.sample();
  const text = renderText('invoice.hire');

  it('identifies the agreement, vehicle and GTA group as a benchmark, and states the day-count convention', () => {
    expect(text).toContain('Agreement HA-2026-0042');
    expect(text).toContain('Hire agreement HA-2026-0042, signed 10 August 2026');
    expect(text).toContain('Vehicle supplied Volkswagen Golf 1.5 TSI Life, CC26 HIR');
    expect(text).toContain('GTA group M (industry benchmark; CCGUK is not a GTA subscriber)');
    expect(text).toContain('Hire started 10 August 2026, 09:30');
    expect(text).toContain('Hire ended 2 September 2026, 11:00');
    expect(text).toContain('each 24-hour period, or part of one, from the start of hire counts as one day');
    expect(text).toContain('10 August 2026 to 2 September 2026 (24 days)');
    expect(text).toContain('24 days £49.80 £1,195.20');
    expect(text).toContain('Daily rate £49.80 per day excluding VAT');
  });

  it('prints the totals from the ledger and the basis of charge on credit terms under the agreement', () => {
    expect(text).toContain(`Total due ${formatGBP(data.totals.grossPence)}`);
    expect(text).toContain('supplied to Ms Jane Example on credit terms under hire agreement HA-2026-0042');
    expect(text).toContain('claimed from you as the insurer of the party at fault');
    expect(text).toContain('Repair of the claimant’s vehicle was completed on 2 September 2026');
    expect(text).not.toContain('Additional driver');
    expect(text).not.toContain('Excess reduction');
  });

  it('adds the additional-driver and excess-waiver lines when the ledger holds them', () => {
    const withExtras = {
      ...data,
      hire: {
        ...data.hire,
        additionalDriver: { name: 'Mr Alex Example', nonStandardRisk: true, days: 24, dailyRatePence: 550, amountPence: 11000, capApplied: true },
        excessWaiver: { excessPence: 100000, reducedExcessPence: 25000, days: 24, dailyRatePence: 1000, amountPence: 24000 }
      },
      totals: { netPence: 154520, vatPence: 0, grossPence: 154520 }
    };
    const t = renderText('invoice.hire', withExtras);
    expect(t).toContain('Additional driver (non-standard risk) Driver: Mr Alex Example · Charged at the capped amount 24 days £5.50 £110.00');
    expect(t).toContain('Excess reduction (collision damage waiver) Reduces the hirer’s excess from £1,000.00 to £250.00 24 days £10.00 £240.00');
    expect(t).toContain('Net total £1,545.20');
    expect(t).toContain('Total due £1,545.20');
  });
});

describe('invoice.storage', () => {
  const text = renderText('invoice.storage');

  it('states location, period, days, rate and totals from the ledger', () => {
    expect(text).toContain('Location Example Yard, Unit 1, Example Industrial Estate, Example Town, EX2 2BB');
    expect(text).toContain('Storage from 9 August 2026, 16:40');
    expect(text).toContain('Storage to 16 August 2026');
    expect(text).toContain('Daily rate £45.00 per day excluding VAT');
    expect(text).toContain('9 August 2026 to 16 August 2026 (8 days) 8 days £45.00 £360.00');
    expect(text).toContain('Total due £360.00');
  });

  it('shows the collect-or-pay chronology so a report+48h cap can be answered', () => {
    expect(text).toContain('Engineer’s report issued 14 August 2026');
    expect(text).toContain('Collect-or-pay notice sent to you 14 August 2026; collection or authority to dispose requested by 16 August 2026, 17:00');
    expect(text).toContain('On 14 August 2026 we gave you written notice to collect the vehicle or authorise its disposal by 16 August 2026, 17:00');
    expect(text).toContain('Storage after that notice continued at your election and is attributable to you');
    expect(text).toContain('The vehicle was recovered from the scene of the accident to Example Yard on 9 August 2026');
  });

  it('omits the notice line when no notice was sent', () => {
    const data = storageInvoiceTemplate.sample();
    const t = renderText('invoice.storage', { ...data, collectOrPayNoticeSentAt: undefined, collectByAt: undefined, reportIssuedAt: undefined });
    expect(t).not.toContain('Collect-or-pay');
    expect(t).not.toContain('Engineer’s report issued');
    expect(t).toContain('Total due £360.00');
  });
});

describe('invoice.recovery', () => {
  const text = renderText('invoice.recovery');

  it('prints the rate card lines — call-out, loaded miles × per-mile rate, administration — and the total', () => {
    expect(text).toContain('Date and time 9 August 2026, 16:10');
    expect(text).toContain('From Junction of High Street and Station Road, Example Town');
    expect(text).toContain('To Example Yard, Unit 1, Example Industrial Estate, Example Town, EX2 2BB');
    expect(text).toContain('Recovery call-out 9 August 2026, 16:10 — attendance and loading at the scene 1 £90.00 £90.00');
    expect(text).toContain('31 miles £3.00 £93.00');
    expect(text).toContain('Administration Booking, recovery paperwork and condition photographs 1 £25.00 £25.00');
    expect(text).toContain('Net total £208.00');
    expect(text).toContain('Total due £208.00');
    expect(text).toContain('Condition at the scene Unroadworthy');
  });
});

describe('invoice.engineer_fee', () => {
  const data = engineerFeeInvoiceTemplate.sample();
  const text = renderText('invoice.engineer_fee');

  it('is a fee note that answers a "fee not recoverable" refusal: dates, work done, qualifications, basis', () => {
    expect(text).toContain('Engineer Mr Sam Example');
    expect(text).toContain('Qualifications IMI Accredited Vehicle Damage Assessor');
    expect(text).toContain('Instructed by Courtesy Cars Group UK Ltd on behalf of the claimant, 10 August 2026');
    expect(text).toContain('Inspection Physical inspection on 12 August 2026, 10:30 at Example Yard, Example Town');
    expect(text).toContain('Report issued 14 August 2026 (reference ER-2026-0042)');
    expect(text).toContain('Instructed 10 August 2026; physical inspection on 12 August 2026, 10:30 at Example Yard, Example Town; report issued 14 August 2026 1 £285.00 £285.00');
    expect(text).toContain('Total due £285.00');
    expect(text).toContain('Work done');
    for (const item of data.workDone) expect(text).toContain(item);
    expect(text).toContain('If you say the fee is not recoverable, identify which item of work above you dispute and on what basis');
    expect(text).toContain('Prepared for court No');
    expect(text).not.toContain('CPR');
  });

  it('adds the CPR 35 and small-claims note when the report was prepared for court', () => {
    const t = renderText('invoice.engineer_fee', { ...data, forCourt: true, court: { smallClaimsExpertFeeCapPence: 75000 } });
    expect(t).toContain('Prepared for court Yes — CPR Part 35 and PD 35 content included');
    expect(t).toContain('expert’s duty to the court (CPR 35.3)');
    expect(t).toContain('PD 35 paragraph 3.3');
    expect(t).toContain('Guidance for the Instruction of Experts in Civil Claims');
    expect(t).toContain('court’s permission (CPR 27.5)');
    expect(t).toContain('limited to £750.00 by PD 27A paragraph 7.3(2). This fee is £285.00.');
  });

  it('exposes the recovery template for the pack order', () => {
    expect(recoveryInvoiceTemplate.id).toBe('invoice.recovery');
  });
});
