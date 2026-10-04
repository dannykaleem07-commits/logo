import { describe, expect, it } from 'vitest';
import { brand } from '../brand.js';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { DocumentDataError, getTemplate, hasTemplate, listTemplates, missingRequiredData, renderTemplate } from '../registry.js';
import {
  SignatureDateError,
  agreementsFormsTemplates,
  art60fFinalPaymentLimit,
  assertNotBeforeCreation,
  cancellationSch3Template,
  creditHireAgreementTemplate,
  expressRequestToStartTemplate,
  mitigationQuestionnaireTemplate,
  statementOfLiabilityText,
  statementOfMeansTemplate,
  statementOfNeedTemplate,
  witnessStatementTemplate
} from './agreements-forms.js';

/**
 * Perimeter phrases that must never appear in a client-facing agreement or form (perimeter.md): nothing implying
 * regulated status, nothing telling the client to ignore an offer, nothing asserting the GTA as an entitlement.
 */
const BANNED = [
  'our solicitors',
  'we act for',
  'we act as',
  'legal advice',
  'our lawyers',
  'our legal team',
  'ignore',
  'do not accept',
  'entitled under the GTA',
  'under the GTA you',
  'GTA entitles',
  'Invalid Date',
  'NaN',
  'undefined',
  '[object Object]'
];

const CONTEMPT = 'I understand that proceedings for contempt of court may be brought against anyone who makes, or causes to be made, a false statement in a document verified by a statement of truth without an honest belief in its truth.';

function textOf(id: string): string {
  return htmlToText(renderTemplate(id, getTemplate(id).sample()).html);
}

describe('agreements-forms: registration', () => {
  it('registers the seven templates with the right ids, kinds and versions', () => {
    const expected: Array<[string, string, string]> = [
      ['agreement.credit_hire', 'agreement', '1.1.0'],
      ['form.cancellation_sch3', 'form', '1.0.0'],
      ['form.express_request_to_start', 'form', '1.0.0'],
      ['form.mitigation_questionnaire', 'form', '1.0.0'],
      ['form.statement_of_means', 'form', '1.0.0'],
      ['form.statement_of_need', 'form', '1.0.0'],
      ['statement.witness', 'statement', '1.0.0']
    ];
    expect(agreementsFormsTemplates.map((t) => t.id)).toEqual(expected.map(([id]) => id));
    for (const [id, kind, version] of expected) {
      expect(hasTemplate(id)).toBe(true);
      const meta = listTemplates().find((m) => m.id === id);
      expect(meta).toMatchObject({ id, kind, version });
      expect(meta?.requiredData).toContain('claim.ourReference');
      expect(meta?.requiredData).toContain('date');
    }
  });
});

describe('agreements-forms: every template renders its sample cleanly', () => {
  for (const template of agreementsFormsTemplates) {
    it(`${template.id}: sample satisfies requiredData, renders deterministically, carries the mandatory furniture and no banned content`, () => {
      const data = template.sample();
      expect(missingRequiredData(template, data)).toEqual([]);
      const first = renderTemplate(template.id, data);
      const second = renderTemplate(template.id, template.sample());
      expect(second.html).toBe(first.html);
      const html = first.html;
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('class="logo-lockup"');
      expect(html).toContain(`Our ref</th><td>${data.claim.ourReference}`);
      expect(html).toContain(brand.company.statusLine);
      expect(html).toContain('company number 17430389');
      expect(html).toContain(brand.typography.fontStack);
      expect(findProhibitedContent(html)).toEqual([]);
      const text = htmlToText(html);
      for (const needle of BANNED) {
        expect(text, `"${needle}" must not appear in ${template.id}`).not.toContain(needle);
      }
      for (const legacy of brand.legacy.blockedStrings) {
        expect(text.toLowerCase()).not.toContain(legacy.toLowerCase());
      }
      if (/\bGTA\b/.test(text)) expect(text).toContain('industry benchmark');
      // CCGUK staff never sign a statement of truth; the claimant/witness does.
      if (text.includes('Statement of truth')) expect(text).not.toContain('for and on behalf of Courtesy Cars Group UK Ltd Statement of truth');
    });
  }

  it('refuses to render without the required data and reports every missing key', () => {
    const data = creditHireAgreementTemplate.sample();
    const broken = { ...data, agreementNumber: '', credit: undefined as never };
    let err: unknown;
    try {
      renderTemplate('agreement.credit_hire', broken);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['agreementNumber', 'credit.maxInstalments', 'credit.finalPaymentDueBy']);
  });
});

describe('agreement.credit_hire', () => {
  const text = textOf('agreement.credit_hire');

  it('names the parties with the Schedule 2 particulars and the vehicle with its GTA group as a benchmark', () => {
    expect(text).toContain('Courtesy Cars Group UK Ltd, company number 17430389');
    expect(text).toContain('Ms Jane Example');
    expect(text).toContain('Date of birth 14 May 1988');
    expect(text).toContain('EXAMP805148JE9AB (United Kingdom; expires 13 May 2031)');
    expect(text).toContain('LK26 CCG');
    expect(text).toContain('GTA group (industry benchmark) M');
    expect(text).toContain('We are not a GTA subscriber');
    expect(text).toContain('Odometer at delivery 18,452 miles');
  });

  it('is open-ended until repair or settlement and says why the right to cancel applies', () => {
    expect(text).toContain('The hire is open-ended. It does not provide for a specific date or period of performance.');
    expect(text).toContain('your own vehicle is repaired and returned to you');
    expect(text).toContain('total-loss settlement');
    expect(text).toContain('not excluded from the right to cancel by regulation 28(1)(h)');
  });

  it('prints every charge from the data through the formatters', () => {
    expect(text).toContain('£49.80 per day excluding VAT');
    expect(text).toContain('VAT 20%');
    expect(text).toContain('£750.00 per incident');
    expect(text).toContain('Excess waiver (offered, not taken) £12.00 per day excluding VAT; not charged; your excess applies in full');
    expect(text).toContain('You have not taken the excess waiver offered at £12.00 per day excluding VAT, so the excess above applies in full.');
    expect(text).toContain('£5.50 per day excluding VAT, capped at £110.00 for the hire (GTA 5.4, industry benchmark)');
  });

  it('states what is owed for the excess waiver in each of the three states (taken, not taken, not yet chosen)', () => {
    const data = creditHireAgreementTemplate.sample();
    const taken = htmlToText(renderTemplate('agreement.credit_hire', { ...data, charges: { ...data.charges, excessWaiverSelected: true } }).html);
    expect(taken).toContain('Excess waiver (taken) £12.00 per day excluding VAT; charged for each day of hire; your excess is nil');
    expect(taken).toContain('You have taken the excess waiver at £12.00 per day excluding VAT, charged for each day of hire, so your excess is nil.');
    const undecided = htmlToText(renderTemplate('agreement.credit_hire', { ...data, charges: { ...data.charges, excessWaiverSelected: undefined } }).html);
    expect(undecided).toContain('Excess waiver (optional) £12.00 per day excluding VAT; if taken, reduces your excess to nil');
    expect(undecided).toContain('If you take the excess waiver at £12.00 per day excluding VAT, your excess is reduced to nil.');
    const none = htmlToText(renderTemplate('agreement.credit_hire', { ...data, charges: { ...data.charges, excessWaiverDailyPence: undefined, excessWaiverSelected: undefined } }).html);
    expect(none).toContain('No excess waiver is included in this agreement.');
    expect(none).not.toContain('Excess waiver (');
  });

  it('refuses a final payment date outside twelve months beginning with the agreement date (art 60F(2)(c))', () => {
    const data = creditHireAgreementTemplate.sample();
    expect(art60fFinalPaymentLimit('2026-08-10')).toBe('2027-08-09');
    expect(art60fFinalPaymentLimit('2026-01-31')).toBe('2027-01-30');
    expect(art60fFinalPaymentLimit('2026-08-10T09:05:00+01:00')).toBe('2027-08-09');
    expect(() => renderTemplate('agreement.credit_hire', { ...data, credit: { ...data.credit, finalPaymentDueBy: '2027-08-10' } })).toThrow(/60F\(2\)\(c\)/);
    expect(() => renderTemplate('agreement.credit_hire', { ...data, credit: { ...data.credit, finalPaymentDueBy: '2026-08-09' } })).toThrow(/60F\(2\)\(c\)/);
    expect(() => renderTemplate('agreement.credit_hire', { ...data, credit: { ...data.credit, finalPaymentDueBy: '2027-08-09' } })).not.toThrow();
    expect(() => renderTemplate('agreement.credit_hire', { ...data, credit: { ...data.credit, finalPaymentDueBy: '2026-12-31' } })).not.toThrow();
    expect(() => renderTemplate('agreement.credit_hire', { ...data, credit: { ...data.credit, maxInstalments: 1.5 } })).toThrow(/60F\(2\)\(b\)/);
    expect(() => renderTemplate('agreement.credit_hire', { ...data, credit: { ...data.credit, maxInstalments: 0 } })).toThrow(/60F\(2\)\(b\)/);
  });

  it('requires the Schedule 2 particulars (date of birth and licence) before it will render', () => {
    const data = creditHireAgreementTemplate.sample();
    const { dateOfBirth: _dob, licence: _lic, ...hirer } = data.hirer;
    let err: unknown;
    try {
      renderTemplate('agreement.credit_hire', { ...data, hirer });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['hirer.dateOfBirth', 'hirer.licence.number', 'hirer.licence.countryOfIssue']);
  });

  it('says plainly when the licence expiry date is not on record instead of asserting the particulars are complete', () => {
    expect(text).toContain('This agreement contains the particulars required by Schedule 2 to the Road Traffic (Owner Liability) Regulations 2000');
    const data = creditHireAgreementTemplate.sample();
    const noExpiry = { ...data, hirer: { ...data.hirer, licence: { number: 'EXAMP805148JE9AB', countryOfIssue: 'United Kingdom' } } };
    const t = htmlToText(renderTemplate('agreement.credit_hire', noExpiry).html);
    expect(t).toContain('EXAMP805148JE9AB (United Kingdom; expiry date not recorded)');
    expect(t).toContain('except your driving licence expiry date, which was not recorded when this agreement was generated. You must give it to us before the vehicle is delivered');
    expect(t).not.toContain('This agreement contains the particulars required by Schedule 2');
  });

  it('prints its own registered version in the integrity line (no literal that a bump would leave behind)', () => {
    const html = renderTemplate('agreement.credit_hire', creditHireAgreementTemplate.sample()).html;
    expect(html).toContain(`Template agreement.credit_hire version ${creditHireAgreementTemplate.version}.`);
    expect(html).not.toContain('Template agreement.credit_hire version 1.0.0');
    for (const t of agreementsFormsTemplates) {
      const h = renderTemplate(t.id, t.sample()).html;
      if (h.includes(`Template ${t.id} version`)) expect(h).toContain(`Template ${t.id} version ${t.version}.`);
    }
  });

  it('states the RAO art 60F credit terms plainly', () => {
    expect(text).toContain('payable in not more than 12 payments');
    expect(text).toContain('Every payment falls due within twelve months beginning with the date of this agreement, and in any event no later than 9 August 2027');
    expect(text).toContain('The credit is provided without interest or other charges.');
    expect(text).toContain('article 60F(2) of the Financial Services and Markets Act 2000 (Regulated Activities) Order 2001');
    expect(text).toContain('not a regulated consumer credit agreement under the Consumer Credit Act 1974');
  });

  it('carries the statement of liability with the hirer’s name and address for service, and the Owner Liability Regulations and POFA references', () => {
    expect(text).toContain('Road Traffic (Owner Liability) Regulations 2000');
    expect(text).toContain('paragraph 13 of Schedule 4 to the Protection of Freedoms Act 2012');
    expect(text).toContain(statementOfLiabilityText('Ms Jane Example', ['1 Example Street', 'Example Town', 'EX2 2BB']));
    expect(text).toContain('My address for service is 1 Example Street, Example Town, EX2 2BB.');
  });

  it('has the recovery clause with the hirer pursuing the at-fault party, CCGUK assisting, and the litigant-in-person position', () => {
    expect(text).toContain('You will pursue recovery of them, with your other losses, from the party at fault and their insurer.');
    expect(text).toContain('You instruct us to correspond on your behalf');
    expect(text).toContain('You act in person or instruct a solicitor of your choice. We do not conduct litigation');
    expect(text).toContain('If you receive an offer of a suitable replacement vehicle on reasonable terms you must consider it and tell us about it.');
    expect(text).toContain('We will help you assess the offer and will reply to it in writing on your behalf.');
  });

  it('includes the Schedule 3 Part A cancellation instructions and refers to the Schedule 3 form', () => {
    expect(text).toContain('You have the right to cancel this contract within 14 days without giving any reason.');
    expect(text).toContain('The cancellation period will expire after 14 days from the day of the conclusion of the contract');
    expect(text).toContain('You may use the model cancellation form (Schedule 3 to the 2013 Regulations), which we gave you with this agreement on 10 August 2026, but it is not obligatory.');
    expect(text).toContain('in proportion to what has been performed until you have communicated to us your cancellation');
    expect(text).toContain('durable medium on 10 August 2026, 09:05');
  });

  it('renders both signature blocks with electronic signing times and the hash placeholder', () => {
    const html = renderTemplate('agreement.credit_hire', creditHireAgreementTemplate.sample()).html;
    expect(html).toContain('Signed electronically 10 August 2026, 09:41');
    expect(html).toContain('Signed electronically 10 August 2026, 09:42');
    expect(html).toContain('D. Kaleem, Claims Manager');
    expect(html).toContain('{{SHA256}}');
    expect(html).toContain('generated from ledger data on 10 August 2026, 09:05');
    expect(html).toContain('class="company-block"'); // trader identity and address alongside the logo (Sch 2)
    expect(html).not.toContain('Re-executed on');
  });

  it('renders the re-execution line when reExecutedOn is present', () => {
    const data = { ...creditHireAgreementTemplate.sample(), reExecutedOn: '2026-08-14', supersedesVersion: '1.0.0' };
    const html = renderTemplate('agreement.credit_hire', data).html;
    expect(html).toContain('Re-executed on 14 August 2026; supersedes version 1.0.0.');
  });

  it('refuses a signature dated before the document was created', () => {
    const data = creditHireAgreementTemplate.sample();
    const early = { ...data, signatures: { ...data.signatures, hirerSignedAt: '2026-08-10T09:04:59+01:00' } };
    expect(() => renderTemplate('agreement.credit_hire', early)).toThrow(SignatureDateError);
    const earlyCcguk = { ...data, signatures: { ...data.signatures, ccgukSignedAt: '2026-08-09T18:00:00+01:00' } };
    expect(() => renderTemplate('agreement.credit_hire', earlyCcguk)).toThrow(/ccgukSignedAt/);
    const earlyRe = { ...data, reExecutedOn: '2026-08-09' };
    expect(() => renderTemplate('agreement.credit_hire', earlyRe)).toThrow(SignatureDateError);
    // same instant is allowed
    expect(() => renderTemplate('agreement.credit_hire', { ...data, signatures: { ...data.signatures, hirerSignedAt: data.createdAt } })).not.toThrow();
  });

  it('refuses more than twelve instalments (art 60F(2)(b))', () => {
    const data = creditHireAgreementTemplate.sample();
    expect(() => renderTemplate('agreement.credit_hire', { ...data, credit: { ...data.credit, maxInstalments: 13 } })).toThrow(/60F/);
  });

  it('assertNotBeforeCreation compares calendar days when a plain date is involved', () => {
    expect(() => assertNotBeforeCreation('x', '2026-08-10', '2026-08-10T23:59:00+01:00')).not.toThrow();
    expect(() => assertNotBeforeCreation('x', '2026-08-09', '2026-08-10T00:01:00+01:00')).toThrow(SignatureDateError);
    expect(() => assertNotBeforeCreation('x', '2026-08-10T09:00:00Z', '2026-08-10T09:00:01Z')).toThrow(SignatureDateError);
  });
});

describe('form.cancellation_sch3', () => {
  const text = textOf('form.cancellation_sch3');

  it('reproduces the Schedule 3 Part B model form pre-filled with our details and the hire', () => {
    expect(text).toContain('Schedule 3, Part B');
    expect(text).toContain('To: Courtesy Cars Group UK Ltd, [registered office]. Email: claims@courtesycars.net.');
    expect(text).toContain('I hereby give notice that I cancel my contract for the supply of the following service:');
    expect(text).toContain('Credit hire of a replacement vehicle, Volkswagen Golf 1.5 TSI Life, registration LK26 CCG, under agreement CHA-2026-00012');
    expect(text).toContain('Ordered on: 10 August 2026');
    expect(text).toContain('Name of consumer: Ms Jane Example');
    expect(text).toContain('Address of consumer: 1 Example Street, Example Town, EX2 2BB');
    expect(text).toContain('Signature of consumer (only if this form is notified on paper)');
    expect(text).toContain('You do not have to use this form.');
  });

  it('leaves the signature and date blank for the consumer', () => {
    const html = renderTemplate('form.cancellation_sch3', cancellationSch3Template.sample()).html;
    expect(html).toContain('<span class="blank"></span>');
    expect(html).toContain('Date: <span class="fill">&nbsp;</span>');
  });
});

describe('form.express_request_to_start', () => {
  const text = textOf('form.express_request_to_start');

  it('is the regulation 36 express request with the proportionate-payment acknowledgement', () => {
    expect(text).toContain('regulation 36');
    expect(text).toContain('I expressly request that Courtesy Cars Group UK Ltd begins supplying the hire vehicle under agreement CHA-2026-00012 at 10 August 2026, 09:30, which is before the end of the 14-day cancellation period.');
    expect(text).toContain('if I cancel the agreement within the cancellation period I must pay for the hire supplied up to the time I tell Courtesy Cars Group UK Ltd that I am cancelling');
    expect(text).toContain('£49.80 per day plus VAT at 20% and the excess waiver at £12.00 per day excluding VAT if I have chosen it');
    expect(text).toContain('I received the information about my right to cancel, and the model cancellation form, on 10 August 2026, 09:05');
    expect(text).toContain('once the hire has been fully performed I will lose my right to cancel');
    expect(text).toContain('Signed electronically 10 August 2026, 09:43');
  });

  it('refuses a signature before creation', () => {
    const data = { ...expressRequestToStartTemplate.sample(), signedAt: '2026-08-10T09:00:00+01:00' };
    expect(() => renderTemplate('form.express_request_to_start', data)).toThrow(SignatureDateError);
  });
});

describe('form.mitigation_questionnaire', () => {
  const text = textOf('form.mitigation_questionnaire');

  it('records every offer from the register with who, when, how, what, terms and the client’s own reasons', () => {
    expect(text).toContain('1. Before you agreed to hire a vehicle from us');
    expect(text).toContain('No'); // no offer before the hire
    expect(text).toContain('2. Since the hire started, has anyone offered you a replacement vehicle? Yes');
    expect(text).toContain('12 August 2026, 15:20');
    expect(text).toContain('Example Insurance plc (third-party claims handler)');
    expect(text).toContain('Telephone call');
    expect(text).toContain('Small hatchback (group B)');
    expect(text).toContain('£20.37 per day excluding VAT');
    expect(text).toContain('Excess of £1,000; 100 miles per day');
    expect(text).toContain('Declined');
    expect(text).toContain('The call came two days after my hire had already started.');
  });

  it('records the duty-to-mitigate advice without telling the client to refuse offers', () => {
    expect(text).toContain('On 10 August 2026 we explained to you that you must keep your losses as low as is reasonable');
    expect(text).toContain('you should consider any suitable offer made on reasonable terms');
    expect(text).not.toMatch(/ignore/i);
  });

  it('carries the GTA Appendix C statement of truth wording, the contempt warning and the e-signature date', () => {
    expect(text).toContain('I believe that the facts stated in this mitigation statement are true.');
    expect(text).toContain(CONTEMPT);
    const html = renderTemplate('form.mitigation_questionnaire', mitigationQuestionnaireTemplate.sample()).html;
    expect(html).toContain('<div class="field-line field-value">Ms Jane Example</div><div class="field-label">Full name</div>');
    expect(html).toContain('<div class="field-line field-value">3 September 2026</div><div class="field-label">Date</div>');
    expect(text).toContain('industry benchmark');
  });

  it('says plainly when no offer was received, matching the register', () => {
    const data = { ...mitigationQuestionnaireTemplate.sample(), offers: [] };
    const t = htmlToText(renderTemplate('form.mitigation_questionnaire', data).html);
    expect(t).toContain('No offer of a replacement vehicle was received from anyone. This matches our intervention register for this claim.');
    expect(t).toContain('2. Since the hire started, has anyone offered you a replacement vehicle? No');
  });
});

describe('form.statement_of_means', () => {
  const text = textOf('form.statement_of_means');

  it('sets out income, outgoings, accounts, cards and credit with ledger-style totals through formatGBP', () => {
    expect(text).toContain('Net salary £2,145.00');
    expect(text).toContain('Total income £2,257.40');
    expect(text).toContain('Rent £950.00');
    expect(text).toContain('Total outgoings £2,271.00');
    expect(text).toContain('····4412 £86.30 Yes');
    expect(text).toContain('[Card provider] £1,200.00 £1,134.50 £65.50 Yes');
    expect(text).toContain('Hire purchase on own vehicle £4,860.00 £219.00 None');
  });

  it('asks the central questions and records the client’s own answers', () => {
    expect(text).toContain('could you have hired a replacement vehicle and paid the deposit and daily charges yourself, without borrowing and without going without essentials? No');
    expect(text).toContain('I had £86.30 in my current account and £150 in savings on the day of the accident.');
    expect(text).toContain('Could you have paid for a hire vehicle using a credit card, overdraft or loan? No');
  });

  it('carries the Diriye v Bojaj note, the three-months-statements checklist and a statement of truth', () => {
    expect(text).toContain('Diriye v Bojaj [2020] EWCA Civ 1400');
    expect(text).toContain('Your claim must say so and you must prove it with documents');
    expect(text).toContain('Three months’ statements enclosed');
    expect(text).toContain('Bank statements for both accounts, 9 May to 9 August 2026');
    expect(text).toContain('I believe that the facts stated in this statement of means are true.');
    expect(text).toContain(CONTEMPT);
  });

  it('sums the lines when the API passes no totals', () => {
    const data = { ...statementOfMeansTemplate.sample(), totals: undefined };
    const t = htmlToText(renderTemplate('form.statement_of_means', data).html);
    expect(t).toContain('Total income £2,257.40');
    expect(t).toContain('Total outgoings £2,271.00');
  });
});

describe('form.statement_of_need', () => {
  const text = textOf('form.statement_of_need');

  it('covers occupation, a week’s journeys with a mileage total, dependants, household vehicles and alternatives', () => {
    expect(text).toContain('Occupation Community nurse');
    expect(text).toContain('Employer Example NHS Community Trust');
    expect(text).toContain('3. A typical week’s journeys (268 miles in the week)');
    expect(text).toContain('Monday Home Health centre, then 9 patient visits Work 46 Me');
    expect(text).toContain('Total for the week 268');
    expect(text).toContain('Son 7 School is 2.5 miles away');
    expect(text).toContain('Ford Transit Connect van My partner No He uses it for his plumbing business');
    expect(text).toContain('The bus from my street runs hourly');
    expect(text).toContain('Roadworthy after the accident No');
    expect(text).toContain('I believe that the facts stated in this statement of need are true.');
    expect(text).toContain(CONTEMPT);
  });

  it('sums journey miles when no weekly total is passed', () => {
    const data = { ...statementOfNeedTemplate.sample(), weeklyMilesTotal: undefined };
    const t = htmlToText(renderTemplate('form.statement_of_need', data).html);
    expect(t).toContain('(268 miles in the week)');
  });
});

describe('statement.witness', () => {
  const text = textOf('statement.witness');

  it('has the PD 32 heading, the top-right block, the opening paragraph and numbered paragraphs in the witness’s words', () => {
    expect(text).toContain('In the County Court at Example');
    expect(text).toContain('Claim No. K00EX123');
    expect(text).toContain('BETWEEN Ms Jane Example Claimant and Mr John Sample Defendant');
    expect(text).toContain('First witness statement of Ms Jane Example');
    expect(text).toContain('On behalf of: the Claimant Witness: J. Example Statement: First Exhibits: JE1 and JE2');
    expect(text).toContain('I, Ms Jane Example, of 1 Example Street, Example Town, EX2 2BB, Community nurse, the Claimant in these proceedings, will say as follows:');
    expect(text).toContain('The facts in this statement are within my own knowledge unless I say otherwise.');
    expect(text).toContain('On 9 August 2026 at about 2.35pm I was driving my Volkswagen Golf');
    const html = renderTemplate('statement.witness', witnessStatementTemplate.sample()).html;
    expect(html.match(/<li><div>/g)?.length).toBe(8); // knowledge paragraph + 7 paragraphs
  });

  it('carries the PD 32 para 20.2 statement of truth and the CPR 32.14 contempt warning, signed by the witness not CCGUK', () => {
    expect(text).toContain('I believe that the facts stated in this witness statement are true.');
    expect(text).toContain(CONTEMPT);
    expect(text).not.toContain('for and on behalf of Courtesy Cars Group UK Ltd');
    expect(text).toContain('the witness signs in person');
  });

  it('marks a draft as such and drops the banner for the final version', () => {
    expect(text).toContain('Draft for the witness to check, amend and sign.');
    const final = { ...witnessStatementTemplate.sample(), isDraft: false, signedAt: '2026-10-05' };
    const html = renderTemplate('statement.witness', final).html;
    const t = htmlToText(html);
    expect(t).not.toContain('Draft for the witness');
    expect(t).toContain('Date: 5 October 2026'); // PD 32 para 17.2 block
    expect(html).toContain('<div class="field-line field-value">5 October 2026</div><div class="field-label">Date</div>'); // statement of truth
  });
});
