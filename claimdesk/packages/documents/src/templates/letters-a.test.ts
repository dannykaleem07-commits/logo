import { afterAll, describe, expect, it, vi } from 'vitest';
import { bannedPhraseCheck, type DraftContext, extractAmounts, extractDates, forumChecks, gtaChecks, legacyCheck } from '@ccguk/domain';
import { brand } from '../brand.js';
import { daysInclusive, formatGBP, sumPence } from '../format.js';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { DocumentDataError, getPath, getTemplate, hasTemplate, listTemplates, missingRequiredData, renderTemplate } from '../registry.js';
import { closeBrowser, renderPdf } from '../render.js';
import {
  chaser14Template,
  chaser21Template,
  chaser7Template,
  chaserSample,
  collectOrPayTemplate,
  delayNoticeTemplate,
  handlingRefRequestTemplate,
  interventionReplyTemplate,
  lettersATemplates,
  ncafTemplate,
  vendorVerificationPackTemplate
} from './letters-a.js';

/**
 * Perimeter phrases that must never appear in a letter to the at-fault insurer (perimeter.md, ARCHITECTURE
 * conventions 7–8): no FOS threat (DISP 2.7), no regulated-status wording, no GTA-as-entitlement wording, and no
 * solicitor–client phrasing ("our client" draws a REGULATED_STATUS_IMPLIED warning from the consistency engine).
 */
const BANNED_IN_LETTERS_A = [
  'FOS',
  'Ombudsman',
  'our client',
  'our solicitors',
  'we act for',
  'legal advice',
  'our lawyers',
  'our legal team',
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

describe('letters-a: registration', () => {
  it('registers all nine templates with version 1.0.0 and the at-fault insurer as recipient', () => {
    const ids = [
      'letter.ncaf',
      'letter.handling_ref_request',
      'letter.intervention_reply',
      'letter.collect_or_pay',
      'letter.delay_notice_gta_4_10',
      'letter.chaser_7',
      'letter.chaser_14',
      'letter.chaser_21',
      'letter.vendor_verification_pack'
    ];
    expect(lettersATemplates.map((t) => t.id)).toEqual(ids);
    for (const id of ids) {
      expect(hasTemplate(id)).toBe(true);
      const meta = listTemplates().find((m) => m.id === id);
      expect(meta).toMatchObject({ id, version: '1.0.0', kind: 'letter', recipientRole: 'at_fault_insurer' });
      expect(meta?.requiredData).toContain('claim.ourReference');
      expect(meta?.requiredData).toContain('date');
    }
  });
});

describe('letters-a: every template renders its sample cleanly', () => {
  for (const template of lettersATemplates) {
    it(`${template.id}: sample satisfies requiredData, renders deterministically, no legacy/banned/forum content`, () => {
      const data = template.sample();
      expect(missingRequiredData(template, data)).toEqual([]);
      const first = renderTemplate(template.id, data);
      const second = renderTemplate(template.id, template.sample());
      expect(second.html).toBe(first.html); // pure: same data, same html
      const html = first.html;
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('class="logo-lockup"');
      expect(html).toContain(`Our ref</th><td>${data.claim.ourReference}`);
      expect(html).toContain(brand.company.statusLine); // screen footer; the PDF footer repeats it
      expect(html).toContain('company number 17430389');
      expect(html).toContain('We are instructed to correspond on behalf of');
      expect(html).toContain('Yours faithfully');
      expect(html).toContain('<ol class="numbered">'); // every request is numbered
      expect(html).toContain('for and on behalf of Courtesy Cars Group UK Ltd');
      expect(findProhibitedContent(html)).toEqual([]);
      const text = htmlToText(html);
      for (const needle of BANNED_IN_LETTERS_A) {
        expect(text, `"${needle}" must not appear in ${template.id}`).not.toContain(needle);
      }
      for (const legacy of brand.legacy.blockedStrings) {
        expect(text.toLowerCase()).not.toContain(legacy.toLowerCase());
      }
      // Every GTA mention is accompanied by the benchmark sentence; never "entitled".
      if (/\bGTA\b/.test(text)) expect(text).toContain('industry benchmark');
      expect(text).not.toMatch(/\bentitled?\b/i);
    });
  }

  it('refuses to render without the required data', () => {
    const data = ncafTemplate.sample();
    const broken = { ...data, handlingRefDueAt: '', services: undefined as never };
    let err: unknown;
    try {
      renderTemplate('letter.ncaf', broken);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['services', 'handlingRefDueAt']);
  });
});

describe('letter.ncaf', () => {
  const text = textOf('letter.ncaf');

  it('sets out the form, the hire group as a benchmark, and the five-working-day request', () => {
    expect(text).toContain('New Claim Advice Form');
    expect(text).toContain('Ms Jane Example');
    expect(text).toContain('AB12 CDE');
    expect(text).toContain('9 August 2026, 14:35');
    expect(text).toContain('Junction of High Street and Station Road');
    expect(text).toContain('Mr John Sample');
    expect(text).toContain('XY65 ZZZ');
    expect(text).toContain('GTA group (industry benchmark) M');
    expect(text).toContain('£49.80 per day excluding VAT');
    expect(text).toContain('10 August 2026, 09:30'); // hire started
    expect(text).toContain('within five working days, that is by Monday 17 August 2026');
    expect(text).toContain('GTA paragraph 4.2 reflects this as industry practice');
    expect(text).toContain('GTA paragraph 3.6 reflects this as industry practice');
    expect(text).toContain('We are not a GTA subscriber');
    expect(text).toContain('Please reply by 5pm on Monday 17 August 2026');
    expect(text).not.toContain('Your ref'); // no insurer reference yet
  });

  it('lists every agreed service with its start date', () => {
    expect(text).toContain('Recovery 9 August 2026 9 August 2026, 16:10');
    expect(text).toContain('Storage 9 August 2026 9 August 2026');
    expect(text).toContain('inspection and report 10 August 2026 Not yet started');
    expect(text).toContain('Replacement vehicle (credit hire) 10 August 2026 10 August 2026, 09:30');
  });
});

describe('letter.handling_ref_request', () => {
  const text = textOf('letter.handling_ref_request');

  it('chases the form by date, states the running services and sets a dated consequence', () => {
    expect(text).toContain('On 10 August 2026 we sent you our New Claim Advice Form by email to thirdpartyclaims@example-insurer.test');
    expect(text).toContain('that is by 17 August 2026. We have had no reply.');
    expect(text).toContain('£49.80 per day has run since 10 August 2026');
    expect(text).toContain('in storage at Example Yard, Example Town since 9 August 2026 at £45.00 per day');
    expect(text).toContain('The office handling this claim');
    expect(text).toContain('Your claim reference');
    expect(text).toContain('We require this information by 5pm on Monday 24 August 2026');
    expect(text).toContain('record the period from 17 August 2026 as delay attributable to you');
  });
});

describe('letter.intervention_reply', () => {
  const text = textOf('letter.intervention_reply');

  it('records the offer exactly and the Copley point where terms were not explained', () => {
    expect(text).toContain('within one working day of your offer of a replacement vehicle, received on 12 August 2026, 10:40');
    expect(text).toContain('Received 12 August 2026, 10:40');
    expect(text).toContain('Channel by telephone, to the claimant directly');
    expect(text).toContain('Made by A claims handler of Example Insurance plc (name not given)');
    expect(text).toContain('Rate quoted £20.37 per day');
    expect(text).toContain('Excess Not stated');
    expect(text).toContain('Copley v Lawn [2009] EWCA Civ 580');
    expect(text).toContain('The claimant declined the offer on 12 August 2026, 18:05');
    expect(text).toContain('Volkswagen Golf 1.5 TSI Life (GTA group M, industry benchmark) at £49.80 per day continues from 10 August 2026');
    expect(text).toContain('I was telephoned at work');
    expect(text).toContain('Written confirmation of the terms of the offer');
    expect(text).toContain('Please reply by 5pm on Thursday 20 August 2026');
    expect(text).not.toContain('ignore');
  });

  it('on acceptance confirms hire ends on delivery', () => {
    const data = interventionReplyTemplate.sample();
    const accepted = {
      ...data,
      offer: {
        ...data.offer,
        termsExplained: true,
        suitable: true,
        suitabilityReasons: ['A like-for-like vehicle with delivery to the claimant’s address.'],
        clientDecision: 'accepted' as const,
        clientReasons: 'The car offered is the same size as mine and will be delivered to my home.'
      },
      deliveryAt: '2026-08-14T10:00:00+01:00'
    };
    const html = renderTemplate('letter.intervention_reply', accepted).html;
    const t = htmlToText(html);
    expect(t).toContain('The claimant accepted the offer on 12 August 2026, 18:05');
    expect(t).toContain('will end on delivery of your vehicle, which you have told us will be at 14 August 2026, 10:00');
    expect(t).toContain('were explained when it was made');
    expect(t).not.toContain('Copley');
    expect(findProhibitedContent(html)).toEqual([]);
  });
});

describe('letter.collect_or_pay', () => {
  const text = textOf('letter.collect_or_pay');

  it('states the yard, the rate, the report date, a 48-hour deadline and the attribution of later storage', () => {
    expect(text).toContain('is held at Example Yard, Unit 4, Example Industrial Estate, Example Town, EX3 3CC');
    expect(text).toContain('Storage has run from 9 August 2026 at £45.00 per day excluding VAT');
    expect(text).toContain('9 days, £405.00');
    expect(text).toContain('Example Assessors Ltd issued its report on 17 August 2026 (reference EA/26/3310)');
    expect(text).toContain('The report and photographs are sent to you with this notice.');
    expect(text).toContain('assesses the vehicle as a total loss, with a pre-accident value of £8,650.00');
    expect(text).toContain('within 48 hours of this notice, that is by 17:00 on Wednesday 19 August 2026');
    expect(text).toContain('Collection is arranged with: Yard office, Courtesy Cars Group UK Ltd, 020 7052 5403, claims@courtesycars.net, Monday to Friday, 08:30 to 17:00');
    expect(text).toContain('storage continues at £45.00 per day and is claimed from you');
    expect(text).toContain('the storage period is attributable to your delay, not to the claimant');
    expect(text).toContain('Copy sent to the claimant, Ms Jane Example');
  });
});

describe('letter.delay_notice_gta_4_10', () => {
  const text = textOf('letter.delay_notice_gta_4_10');

  it('cites GTA 4.10–4.11 as industry practice, gives the estimate, the delay, the cause and hire to date', () => {
    expect(text).toContain('GTA paragraphs 4.10–4.11 reflect industry practice');
    expect(text).toContain('We are not a GTA subscriber and refer to the GTA as an industry benchmark only');
    expect(text).toContain('Example Bodyshop Ltd issued its estimate on 14 August 2026. The estimated repair time was 5 working days.');
    expect(text).toContain('Repair authorisation remains outstanding. The delay to the date of this notice is 5 working days.');
    expect(text).toContain('We record this period as attributable to you');
    expect(text).toContain('has run since 10 August 2026: 12 days to date, £597.60');
    expect(text).toContain('Authorise the repair on the estimate of 14 August 2026, or tell us why you will not, by 5pm on Tuesday 25 August 2026');
    expect(text).toContain('We will check progress again on Friday 28 August 2026');
    expect(text).toContain('Attributable to'); // chronology column
  });
});

describe('letters-a: chaser ladder', () => {
  const t7 = textOf('letter.chaser_7');
  const t14 = textOf('letter.chaser_14');
  const t21 = textOf('letter.chaser_21');

  it('shares the ledger position: pack date, payment received, outstanding by head', () => {
    for (const t of [t7, t14, t21]) {
      expect(t).toContain('Hire ran from 10 August 2026 to 2 September 2026 (24 days) at £49.80 per day (GTA group M, industry benchmark)');
      expect(t).toContain('Our payment pack was sent to you by email to thirdpartyclaims@example-insurer.test on 5 September 2026');
      expect(t).toContain('a clean pack is settled within one calendar month (GTA 6.7); that month ended on 5 October 2026');
      expect(t).toContain('We received £1,112.00 on 25 September 2026 (BACS, your reference EXI/TP/4471920). No other payment has been received.');
      expect(t).toContain('Claimed in the pack of 5 September 2026 £1,796.20');
      expect(t).toContain('Received -£1,112.00');
      expect(t).toContain('Outstanding £684.20');
      expect(t).toContain('Hire, 24 days at £49.80 per day (invoice INV-0044) Claimed £1,195.20; received £511.00 £684.20');
      expect(t).toContain('Recovery (invoice INV-0041) Claimed £151.00; paid in full £0.00');
      expect(t).toContain('Total outstanding £684.20');
      expect(t).toContain('We understand that ICOBS 8.2.6R requires a motor vehicle liability insurer');
      expect(t).toContain('The claim was notified to you on 10 August 2026; the three-month period ends on 10 November 2026');
      expect(t).toContain('On 25 September 2026 you stated:');
      expect(t).not.toContain('£1,287'); // lesson a: the figure stated is the figure received
    }
  });

  it('day 7 is an enquiry with a date and the next rung named', () => {
    expect(t7).toContain('37 days have passed since the pack was sent');
    expect(t7).toContain('Confirm that the pack of 5 September 2026 was received and is complete');
    expect(t7).toContain('Confirm the date on which the outstanding £684.20 will be paid');
    expect(t7).toContain('Please reply by 5pm on Monday 19 October 2026');
    expect(t7).toContain('we will write to your team leader without further notice');
    expect(t7).not.toContain('DISP');
  });

  it('day 14 goes to the team leader and requires payment or a reasoned reply', () => {
    expect(t14).toContain('Team Leader, Third Party Claims');
    expect(t14).toContain('addressed to the team leader because our letter of 12 October 2026 has not been answered');
    expect(t14).toContain('44 days have passed since the pack was sent');
    expect(t14).toContain('A part payment without reasons for the balance is not, as we understand it, a reasoned reply');
    expect(t14).toContain('Payment of £684.20 by 5pm on Monday 26 October 2026');
    expect(t14).toContain('a formal notice will go to your claims manager without further notice');
    expect(t14).not.toContain('DISP');
  });

  it('day 21 goes to the claims manager, names the DISP complaint date and interest, and never names a forum not open', () => {
    expect(t21).toContain('Claims Manager, Third Party Claims');
    expect(t21).toContain('This is a formal notice');
    expect(t21).toContain('our letters of 12 October 2026 and 19 October 2026 have not been answered');
    expect(t21).toContain('51 days have passed since the pack was sent');
    expect(t21).toContain('by 5pm on Friday 30 October 2026');
    expect(t21).toContain('on Monday 2 November 2026 we will submit a formal complaint to your complaints team under DISP 1, referring to ICOBS 8.1 and 8.2.6R, and ask for your final response within eight weeks (DISP 1.6)');
    expect(t21).toContain('Interest on the outstanding sum will be claimed from 5 October 2026 to the date of payment');
    expect(t21).toContain('section 69 of the County Courts Act 1984');
    expect(t21).toContain('Each step is taken on the date stated, without a further warning');
    expect(t21).not.toContain('FOS');
    expect(t21).not.toContain('Ombudsman');
  });

  it('day 21 requires the complaint date and interest start; the earlier rungs do not', () => {
    const d = chaserSample(21);
    const { complaintDate: _c, interestFromAt: _i, ...without } = d;
    expect(missingRequiredData(chaser21Template, without)).toEqual(['complaintDate', 'interestFromAt']);
    expect(missingRequiredData(chaser7Template, without)).toEqual([]);
    expect(missingRequiredData(chaser14Template, without)).toEqual([]);
    const { previousLetters: _p, ...noPrevious } = chaserSample(14);
    expect(missingRequiredData(chaser7Template, noPrevious)).toEqual([]);
    expect(missingRequiredData(chaser14Template, noPrevious)).toEqual(['previousLetters']);
    expect(missingRequiredData(chaser21Template, { ...chaserSample(21), previousLetters: undefined })).toEqual(['previousLetters']);
  });

  it('prints "No payment has been received" and "no position" when the ledger and register are empty', () => {
    const d = chaserSample(7);
    const html = renderTemplate('letter.chaser_7', { ...d, payments: [], insurerPosition: undefined }).html;
    const t = htmlToText(html);
    expect(t).toContain('No payment has been received.');
    expect(t).toContain('You have not stated a position on the outstanding £684.20');
    expect(findProhibitedContent(html)).toEqual([]);
  });
});

describe('letter.vendor_verification_pack', () => {
  const text = textOf('letter.vendor_verification_pack');

  it('prints the exact registered account name, company number, enclosures and the payment date request', () => {
    expect(text).toContain('Registered name Courtesy Cars Group UK Ltd');
    expect(text).toContain('Company number 17430389');
    expect(text).toContain('Account name (exact) Courtesy Cars Group UK Ltd');
    expect(text).toContain('Sort code 00-00-00');
    expect(text).toContain('The account is held in the exact registered name “Courtesy Cars Group UK Ltd”');
    expect(text).toContain('Confirmation of Payee');
    expect(text).toContain('We will never change them by email');
    expect(text).toContain('Bank letter on the bank’s letterhead confirming the account name, sort code and account number, dated 16 September 2026');
    expect(text).toContain('Certificate of incorporation, company number 17430389');
    expect(text).toContain('Proof of registered office, dated 1 September 2026');
    expect(text).toContain('Director identity document');
    expect(text).toContain('INV-0044 — Hire, 24 days at £49.80 per day Dated 3 September 2026 £1,195.20');
    expect(text).toContain('Total awaiting payment £1,796.20');
    expect(text).toContain('The date on which payment of £1,796.20 will clear to the account above');
    expect(text).toContain('Please reply by 5pm on Friday 25 September 2026');
  });

  it('never carries a legacy name, number, address or domain', () => {
    for (const legacy of ['Car Flex', 'Carflex', '17360033', 'Paul Street', 'EC2A', 'courtesycarsuk']) {
      expect(text.toLowerCase()).not.toContain(legacy.toLowerCase());
    }
  });
});

describe('letters-a: templates read nothing but their data', () => {
  it('collect_or_pay and delay notice expose the exported template objects', () => {
    expect(collectOrPayTemplate.id).toBe('letter.collect_or_pay');
    expect(delayNoticeTemplate.id).toBe('letter.delay_notice_gta_4_10');
    expect(handlingRefRequestTemplate.id).toBe('letter.handling_ref_request');
    expect(vendorVerificationPackTemplate.id).toBe('letter.vendor_verification_pack');
  });
});


// ---------------------------------------------------------------------------
// Adversarial checks: the things that go wrong when the API feeds a template real, imperfect data
// ---------------------------------------------------------------------------

type Plain = Record<string, unknown>;

function deletePath(obj: Plain, path: string): Plain {
  const keys = path.split('.');
  let cur: unknown = obj;
  for (const k of keys.slice(0, -1)) cur = (cur as Plain)[k];
  delete (cur as Plain)[keys[keys.length - 1]!];
  return obj;
}

function setPath(obj: Plain, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Plain = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Plain;
  }
  cur[keys[keys.length - 1]!] = value;
}

/** The sample with every key that is not in requiredData removed (whole subtrees for object/array keys). */
function requiredOnly(sample: unknown, requiredData: string[]): Plain {
  const out: Plain = {};
  for (const key of requiredData) setPath(out, key, structuredClone(getPath(sample, key)));
  return out;
}

/** Every number (as pence candidates) and every string in a data object. */
function flatten(obj: unknown, numbers = new Set<number>(), strings: string[] = []): { numbers: Set<number>; strings: string[] } {
  if (obj === null || obj === undefined) return { numbers, strings };
  if (typeof obj === 'number') numbers.add(obj);
  else if (typeof obj === 'string') strings.push(obj);
  else if (Array.isArray(obj)) for (const v of obj) flatten(v, numbers, strings);
  else if (typeof obj === 'object') for (const v of Object.values(obj as Plain)) flatten(v, numbers, strings);
  return { numbers, strings };
}

const MARKUP = '<script>alert("x")</script> & <b>bold</b>';

/** Free-text fields per template that the insurer, the claimant or a handler types (never trusted). */
const FREE_TEXT: Record<string, string[]> = {
  'letter.ncaf': ['claimant.name', 'accident.circumstances', 'thirdParty.driverName', 'services.0.detail', 'vehicle.damageSummary'],
  'letter.handling_ref_request': ['ncaf.sentTo', 'storage.location', 'hire.vehicleDescription'],
  'letter.intervention_reply': ['offer.offerorName', 'offer.clientReasons', 'offer.suitabilityReasons.0', 'offer.vehicleClassOffered'],
  'letter.collect_or_pay': ['report.engineerName', 'report.summary', 'storage.location', 'collectionContact.name'],
  'letter.delay_notice_gta_4_10': ['delay.cause', 'repair.repairerName', 'chronology.0.description'],
  'letter.chaser_7': ['heads.0.label', 'insurerPosition.summary', 'insurerPosition.response.0', 'pack.contents.0', 'payments.0.reference'],
  'letter.chaser_14': ['heads.0.label', 'insurerPosition.summary', 'pack.sentTo'],
  'letter.chaser_21': ['heads.0.label', 'insurerPosition.summary'],
  'letter.vendor_verification_pack': ['request.summary', 'enclosures.0.title', 'invoices.0.head', 'director.name', 'request.theirVendorRef']
};

const SHARED_FREE_TEXT = ['claim.claimantName', 'claim.vehicleDescription', 'recipient.name', 'recipient.attention', 'settings.signatoryName'];

function consistencyContext(templateId: string): DraftContext {
  return {
    bundle: { claim: { id: 'claim-1', gtaSubscriber: false }, documents: [], clocks: [] },
    priorOutgoing: [],
    draftCreatedAt: '2026-10-04T09:00:00Z',
    templateId,
    recipientRole: 'at_fault_insurer'
  } as unknown as DraftContext;
}

afterAll(async () => {
  await closeBrowser();
});

describe('letters-a: adversarial', () => {
  for (const template of lettersATemplates) {
    describe(template.id, () => {
      it('passes the domain consistency engine: no legacy detail, banned phrase, regulated-status wording, forum not open or GTA-as-law', () => {
        const text = textOf(template.id);
        const ctx = consistencyContext(template.id);
        expect(legacyCheck(text)).toEqual([]);
        expect(bannedPhraseCheck(text)).toEqual([]); // BANNED_PHRASE + REGULATED_STATUS_IMPLIED (incl. the "our client" warning)
        expect(forumChecks(text, ctx)).toEqual([]); // FORUM_NOT_OPEN (DISP 2.7)
        expect(gtaChecks(text, ctx)).toEqual([]); // GTA_CITED_AS_LAW (GTA 2.7(j))
      });

      it('prints no amount and no date that is not in its data object', () => {
        const data = template.sample();
        const text = textOf(template.id);
        const { numbers, strings } = flatten(data);
        for (const a of extractAmounts(text)) {
          const fromLedger = numbers.has(a.pence) || numbers.has(-a.pence);
          // A rate inside a free-text label ("Storage, 6 days at £45.00 per day") is API-supplied text, not a template figure.
          const insideDataText = a.perUnit !== undefined && strings.some((s) => s.includes(formatGBP(a.pence)));
          expect(fromLedger || insideDataText, `${formatGBP(a.pence)} :: ${a.excerpt}`).toBe(true);
        }
        for (const d of extractDates(text)) {
          const inData = strings.some((s) => s.startsWith(d.iso) || s.includes(d.raw));
          expect(inData, `${d.raw} :: ${d.excerpt}`).toBe(true);
        }
      });

      it('refuses to render when any one required key is missing, naming it', () => {
        for (const key of template.requiredData) {
          const data = deletePath(structuredClone(template.sample()) as Plain, key);
          let err: unknown;
          try {
            renderTemplate(template.id, data);
          } catch (e) {
            err = e;
          }
          expect(err, key).toBeInstanceOf(DocumentDataError);
          expect((err as DocumentDataError).missing, key).toContain(key);
        }
      });

      it('renders from the required keys alone (every optional key stripped) without gaps or "undefined"', () => {
        const data = requiredOnly(template.sample(), template.requiredData);
        expect(missingRequiredData(template, data)).toEqual([]);
        const html = renderTemplate(template.id, data).html;
        const text = htmlToText(html);
        for (const bad of ['undefined', 'null', 'NaN', '[object Object]', 'Invalid Date', ' .', ' ,', ' ;', '()', '( ', ' )', 'of  ', '“”']) {
          expect(text, `"${bad}" in ${template.id} with optional keys stripped`).not.toContain(bad);
        }
        expect(findProhibitedContent(html)).toEqual([]);
        for (const needle of BANNED_IN_LETTERS_A) expect(text).not.toContain(needle);
        expect(text).toContain('Yours faithfully');
      });

      it('is a pure function of its data: the system clock has no effect on the output', () => {
        const before = renderTemplate(template.id, template.sample()).html;
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2031-06-15T12:00:00Z'));
          expect(renderTemplate(template.id, template.sample()).html).toBe(before);
        } finally {
          vi.useRealTimers();
        }
      });

      it('escapes free-text fields, so markup typed by a handler or an insurer never reaches the HTML', () => {
        const data = structuredClone(template.sample()) as Plain;
        const fields = [...SHARED_FREE_TEXT, ...(FREE_TEXT[template.id] ?? [])];
        let injected = 0;
        for (const f of fields) {
          const current = getPath(data, f);
          if (typeof current !== 'string') continue;
          setPath(data, f, `${current} ${MARKUP}`);
          injected += 1;
        }
        expect(injected).toBeGreaterThan(3);
        const html = renderTemplate(template.id, data).html;
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>bold</b>');
        expect(html).toContain('&lt;script&gt;');
        expect((html.match(/&lt;script&gt;/g) ?? []).length).toBeGreaterThanOrEqual(injected);
      });
    });
  }

  it('renders every template to an A4 PDF with the running header and footer, at a sensible length', async () => {
    for (const template of lettersATemplates) {
      const data = template.sample();
      const { html } = renderTemplate(template.id, data);
      const { pdf, pages, sha256 } = await renderPdf(html, { reference: data.claim.ourReference });
      expect(pdf.subarray(0, 5).toString('latin1'), template.id).toBe('%PDF-');
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pages, `${template.id} pages`).toBeGreaterThanOrEqual(1);
      expect(pages, `${template.id} pages`).toBeLessThanOrEqual(4);
    }
  }, 120_000);
});

describe('letters-a: arithmetic and ledger fidelity', () => {
  it('chaser sample: heads sum to totals, each head balances, payments sum to received, hire days × rate = hire claimed', () => {
    const d = chaserSample(7);
    expect(sumPence(d.heads.map((h) => h.claimedPence))).toBe(d.totals.claimedPence);
    expect(sumPence(d.heads.map((h) => h.receivedPence))).toBe(d.totals.receivedPence);
    expect(sumPence(d.heads.map((h) => h.outstandingPence))).toBe(d.totals.outstandingPence);
    expect(d.totals.claimedPence - d.totals.receivedPence).toBe(d.totals.outstandingPence);
    for (const h of d.heads) expect(h.claimedPence - h.receivedPence, h.label).toBe(h.outstandingPence);
    expect(sumPence(d.payments.map((p) => p.amountPence))).toBe(d.totals.receivedPence);
    expect(d.hire.days * d.hire.dailyRatePence).toBe(d.heads[0]!.claimedPence);
    expect(daysInclusive(d.hire.startAt, d.hire.endAt)).toBe(d.hire.days);
    expect(d.totals.receivedPence).toBe(111200); // lesson a: £1,112 received, never £1,287
  });

  it('chaser prints the ledger hire-day count, not a count recomputed from the dates', () => {
    const base = chaserSample(7);
    const d = { ...base, hire: { ...base.hire, days: 23 } };
    const t = htmlToText(renderTemplate('letter.chaser_7', d).html);
    expect(t).toContain('Hire ran from 10 August 2026 to 2 September 2026 (23 days)');
    expect(t).not.toContain('(24 days)');
  });

  it('chaser never calls a head "paid in full" when the receipt was short of the claim', () => {
    const base = chaserSample(7);
    const d = {
      ...base,
      heads: [{ label: 'Engineer’s fee (invoice INV-0043)', claimedPence: 18000, receivedPence: 15000, outstandingPence: 0 }]
    };
    const t = htmlToText(renderTemplate('letter.chaser_7', d).html);
    expect(t).not.toContain('paid in full');
    expect(t).toContain('Claimed £180.00; received £150.00');
  });

  it('rungs 14 and 21 read correctly with an empty previous-letters list and supply the attention line when the API has not', () => {
    for (const [id, rung, attention] of [
      ['letter.chaser_14', 14, 'Team Leader, Third Party Claims'],
      ['letter.chaser_21', 21, 'Claims Manager, Third Party Claims']
    ] as const) {
      const base = chaserSample(rung);
      const d = { ...base, previousLetters: [], recipient: { ...base.recipient!, attention: undefined } };
      const html = renderTemplate(id, d).html;
      const t = htmlToText(html);
      expect(t).not.toContain('letters of  have');
      expect(t).not.toContain('letter of  has');
      expect(t).not.toContain('because our');
      expect(t).toContain(rung === 14 ? 'addressed to the team leader. It states' : 'addressed to the claims manager. It sets out');
      expect(html).toContain(`<div>${attention}</div>`);
      // one previous letter: singular
      const one = htmlToText(renderTemplate(id, { ...base, previousLetters: ['2026-10-12'] }).html);
      expect(one).toContain('because our letter of 12 October 2026 has not been answered');
    }
    // the API's own attention line wins
    const custom = chaserSample(14);
    expect(renderTemplate('letter.chaser_14', custom).html).toContain('<div>Team Leader, Third Party Claims</div>');
    const named = { ...custom, recipient: { ...custom.recipient!, attention: 'Ms A. Handler, Team Leader' } };
    expect(renderTemplate('letter.chaser_14', named).html).toContain('<div>Ms A. Handler, Team Leader</div>');
  });

  it('chaser day count reads grammatically for a single day', () => {
    const t = htmlToText(renderTemplate('letter.chaser_7', { ...chaserSample(7), daysSincePack: 1 }).html);
    expect(t).toContain('1 day has passed since the pack was sent');
  });

  it('vendor pack sample: invoices sum to the total awaiting payment', () => {
    const d = vendorVerificationPackTemplate.sample();
    expect(sumPence(d.invoices.map((i) => i.amountPence))).toBe(d.outstandingPence);
    expect(d.settings.bank.accountName).toBe(brand.company.registeredName);
  });

  it('collect-or-pay sample: notice on the report day, collect-by 48 hours later, storage to date = days × rate', () => {
    const d = collectOrPayTemplate.sample();
    expect(d.report.issuedAt).toBe(d.date);
    expect(daysInclusive(d.date, d.collectBy)).toBe(3); // today, tomorrow, the day after at 17:00
    expect(d.storage.daysToDate * d.storage.dailyRatePence).toBe(d.storage.accruedToDatePence);
    expect(daysInclusive(d.storage.startAt, d.date)).toBe(d.storage.daysToDate);
  });

  it('delay notice sample: hire to date = days × rate, and the day count matches the dates', () => {
    const d = delayNoticeTemplate.sample();
    expect(d.hire.daysToDate * d.hire.dailyRatePence).toBe(d.hire.chargesToDatePence);
    expect(daysInclusive(d.hire.startAt, d.date)).toBe(d.hire.daysToDate);
  });
});

describe('letters-a: statements the template may not make on its own', () => {
  it('intervention reply only claims "within one working day" when the clocks engine says so; otherwise it dates the offer', () => {
    const base = interventionReplyTemplate.sample();
    const late = htmlToText(renderTemplate('letter.intervention_reply', { ...base, sentWithinOneWorkingDay: undefined, date: '2026-08-18' }).html);
    expect(late).not.toContain('within one working day');
    expect(late).toContain('This letter replies to your offer of a replacement vehicle, received on 12 August 2026, 10:40.');
    const onTime = htmlToText(renderTemplate('letter.intervention_reply', base).html);
    expect(onTime).toContain('This letter is sent within one working day of your offer of a replacement vehicle, received on 12 August 2026, 10:40.');
  });

  it('intervention reply with madeTo ccguk and an email channel records the channel without a dangling clause', () => {
    const base = interventionReplyTemplate.sample();
    const d = { ...base, offer: { ...base.offer, channel: 'email' as const, madeTo: 'ccguk' as const } };
    const t = htmlToText(renderTemplate('letter.intervention_reply', d).html);
    expect(t).toContain('Channel by email, to us');
    const via = { ...base, offer: { ...base.offer, channel: 'via_client' as const, madeTo: 'claimant' as const } };
    expect(htmlToText(renderTemplate('letter.intervention_reply', via).html)).toContain('Channel directly to the claimant, who reported it to us Made by');
  });

  it('delay notice names the party in a sentence for every attribution code', () => {
    const base = delayNoticeTemplate.sample();
    const cases: Array<[string, string]> = [
      ['insurer', 'attributable to you.'],
      ['repairer', 'attributable to the repairer.'],
      ['engineer', 'attributable to the engineer.'],
      ['third_party', 'attributable to the third party.'],
      ['Parts supplier', 'attributable to Parts supplier.']
    ];
    for (const [code, expected] of cases) {
      const d = { ...base, delay: { ...base.delay, kind: 'parts_delay' as const, attributableTo: code } };
      const t = htmlToText(renderTemplate('letter.delay_notice_gta_4_10', d).html);
      expect(t, code).toContain(`We record this period as ${expected}`);
      expect(t).not.toContain('attributable to Repairer');
      expect(t).toContain('Repair is held up for parts.');
    }
  });

  it('every GTA paragraph mentioned is framed as industry practice or benchmark, in the same sentence or the next', () => {
    for (const template of lettersATemplates) {
      const text = textOf(template.id);
      const sentences = text.split(/(?<=[.!?])\s+/);
      sentences.forEach((s, i) => {
        if (!/\bGTA\b/.test(s)) return;
        const window = `${s} ${sentences[i + 1] ?? ''} ${sentences[i - 1] ?? ''}`;
        expect(window, `${template.id}: "${s}"`).toMatch(/benchmark|industry practice|not a GTA subscriber/i);
      });
    }
  });

  it('no letter in the group tells the claimant to refuse or ignore an offer, or threatens a forum that is not open', () => {
    for (const template of lettersATemplates) {
      const text = textOf(template.id).toLowerCase();
      expect(text).not.toMatch(/\b(ignore|refuse|reject)\b[^.]*\boffer\b/);
      expect(text).not.toMatch(/financial ombudsman|\bfos\b|ombudsman/);
      expect(text).not.toMatch(/\bour (solicitors?|lawyers?|legal team|client)\b/);
      expect(text).not.toMatch(/\bwe act (for|as)\b/);
      expect(text).not.toMatch(/\blegal advice\b/);
    }
  });
});
