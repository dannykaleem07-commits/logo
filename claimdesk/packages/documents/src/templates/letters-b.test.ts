import { afterAll, describe, expect, it, vi } from 'vitest';
import { bannedPhraseCheck, type DraftContext, extractAmounts, extractDates, forumChecks, gtaChecks, legacyCheck } from '@ccguk/domain';
import { brand } from '../brand.js';
import { daysInclusive, formatGBP, sumPence } from '../format.js';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { type AnyTemplate, DocumentDataError, getPath, getTemplate, listTemplates, missingRequiredData, renderTemplate } from '../registry.js';
import { closeBrowser, renderPdf } from '../render.js';
import {
  cctvPreservationTemplate,
  clientUpdateTemplate,
  complaintDispTemplate,
  dsarTemplate,
  engineerInstructionTemplate,
  letterBeforeClaimTemplate,
  PART36_MINIMUM_PERIOD_DAYS,
  part36OfferTemplate,
  particularisationDemandTemplate,
  pavChallengeTemplate
} from './letters-b.js';

const ALL: AnyTemplate[] = [
  complaintDispTemplate,
  dsarTemplate,
  cctvPreservationTemplate,
  pavChallengeTemplate,
  particularisationDemandTemplate,
  letterBeforeClaimTemplate,
  part36OfferTemplate,
  clientUpdateTemplate,
  engineerInstructionTemplate
];

/** Letters the CLAIMANT signs as litigant in person; CCGUK's signature block must never appear on them. */
const CLAIMANT_SIGNED_IDS = [letterBeforeClaimTemplate.id, part36OfferTemplate.id];

/** Letters addressed to someone who is not the insurer; the insurer's reference must never be shown to them. */
const NON_INSURER = [cctvPreservationTemplate, engineerInstructionTemplate, clientUpdateTemplate];

/**
 * Phrases that must never appear in any sample of this group (perimeter.md; ARCHITECTURE conventions 7–8): no FOS to
 * a third-party claimant's at-fault insurer (DISP 2.7), no regulated-status wording, no GTA-as-entitlement wording,
 * no solicitor–client phrasing ("our client" is a REGULATED_STATUS_IMPLIED warning in the consistency engine).
 */
const BANNED_EVERYWHERE = [
  'FOS',
  'Ombudsman',
  'our client',
  'Our client',
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

/** Rendered text (tags stripped) so phrases split across markup are still found. */
function text(html: string): string {
  return htmlToText(html);
}

function textOf<T>(template: { id: string; sample: () => T }, data?: T): string {
  return text(renderTemplate(template.id, data ?? template.sample()).html);
}

function consistencyContext(templateId: string, recipientRole: string): DraftContext {
  return {
    bundle: { claim: { id: 'claim-1', gtaSubscriber: false }, documents: [], clocks: [] },
    priorOutgoing: [],
    draftCreatedAt: '2026-10-04T09:00:00Z',
    templateId,
    recipientRole
  } as unknown as DraftContext;
}

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

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}

const MARKUP = '<script>alert("x")</script> & <b>bold</b>';

/** Free-text fields per template that an insurer, a claimant or a handler types (never trusted). Every one is rendered. */
const FREE_TEXT: Record<string, string[]> = {
  'letter.complaint_disp': ['claim.claimantName', 'recipient.name', 'recipient.attention', 'complaintSummary', 'chronology.0.description', 'heads.0.label', 'heads.0.note', 'signatory.name'],
  'letter.dsar': ['claim.claimantName', 'recipient.name', 'dataSubject.name', 'dataSubject.addressLines.0', 'references.0', 'deliverTo', 'signatory.name'],
  'letter.cctv_preservation': ['claim.claimantName', 'recipient.name', 'recipient.attention', 'location', 'cameraDescription', 'retentionNote', 'signatory.name'],
  'letter.pav_challenge': ['claim.claimantName', 'recipient.name', 'offer.basis', 'offer.reference', 'inputsChallenged.0.theirValue', 'inputsChallenged.0.evidence', 'assessment.reasoning', 'assessment.exclusions.0', 'comparables.0.source', 'enclosures.0'],
  'letter.particularisation_demand': ['claim.claimantName', 'recipient.name', 'allegationQuoted', 'allegationLetter.author', 'allegationLetter.reference', 'registerPosition'],
  'letter.letter_before_claim': ['claimant.name', 'claimant.addressLines.0', 'recipient.name', 'accident.location', 'accident.circumstances', 'liabilityBasis', 'schedule.0.description', 'schedule.0.source', 'track.note', 'enclosures.0', 'insurer.name'],
  'letter.part36_offer': ['claimant.name', 'claimant.addressLines.0', 'claim.claimantName', 'recipient.name'],
  'letter.client_update': ['salutationName', 'recipient.name', 'whereWeAre', 'whatThisMeans', 'needFromYou.0.action', 'whatHappensNext.text', 'handler.name', 'figures.0.label'],
  'letter.supplier_instruction_engineer': ['claim.claimantName', 'recipient.name', 'recipient.attention', 'vehicle.description', 'vehicle.location', 'vehicle.locationContact', 'vehicle.keysWith', 'accidentCircumstances', 'damageReported', 'questions.0', 'enclosures.0', 'signatory.name']
};

afterAll(async () => {
  await closeBrowser();
});

// ---------------------------------------------------------------------------
// Registration and the common contract
// ---------------------------------------------------------------------------

describe('letters-b registration', () => {
  it('registers all nine templates with semver versions and the expected recipient roles', () => {
    const ids = listTemplates().map((t) => t.id);
    for (const t of ALL) {
      expect(ids).toContain(t.id);
      expect(getTemplate(t.id)).toBe(t);
      expect(t.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(t.kind).toBe('letter');
      expect(t.description).toBeTruthy();
      expect(t.requiredData).toContain('claim.ourReference');
      expect(t.requiredData).toContain('date');
    }
    expect(complaintDispTemplate.recipientRole).toBe('at_fault_insurer');
    expect(dsarTemplate.recipientRole).toBe('at_fault_insurer');
    expect(pavChallengeTemplate.recipientRole).toBe('at_fault_insurer');
    expect(particularisationDemandTemplate.recipientRole).toBe('at_fault_insurer');
    expect(letterBeforeClaimTemplate.recipientRole).toBe('at_fault_insurer');
    expect(part36OfferTemplate.recipientRole).toBe('at_fault_insurer');
    expect(cctvPreservationTemplate.recipientRole).toBe('other');
    expect(clientUpdateTemplate.recipientRole).toBe('client');
    expect(engineerInstructionTemplate.recipientRole).toBe('supplier');
  });

  for (const t of ALL) {
    it(`${t.id}: sample satisfies requiredData, renders purely, carries the layout furniture and no legacy, banned or perimeter-breaching text`, () => {
      const data = t.sample();
      expect(missingRequiredData(t, data)).toEqual([]);
      const a = renderTemplate(t.id, data);
      const b = renderTemplate(t.id, t.sample());
      expect(a.html).toBe(b.html); // pure function of the data
      expect(a.templateVersion).toBe(t.version);
      const html = a.html;
      const txt = text(html);
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('class="logo-lockup"');
      expect(html).toContain('<svg');
      expect(html).toContain(`Our ref</th><td>${data.claim.ourReference}`);
      expect(html).toContain(`<meta name="ccguk:reference" content="${data.claim.ourReference}">`);
      expect(html).toContain(brand.company.statusLine); // screen footer; the PDF footer repeats it on every page
      expect(html).toContain('company number 17430389');
      expect(html).toContain(brand.typography.fontStack.split(',')[0]!);
      expect(html).toContain('<ol class="numbered">'); // every request is numbered (voice.md)
      expect(findProhibitedContent(html)).toEqual([]);
      for (const needle of BANNED_EVERYWHERE) expect(txt, `"${needle}" must not appear in ${t.id}`).not.toContain(needle);
      for (const legacy of brand.legacy.blockedStrings) expect(txt.toLowerCase()).not.toContain(legacy.toLowerCase());
      expect(txt).not.toMatch(/\bignor/i); // never tell anyone to ignore an offer
      expect(txt).not.toMatch(/\bGTA\b/); // nothing in this group needs the GTA at all
      expect(txt).not.toMatch(/\bentitled?\b/i);
      expect(txt).not.toMatch(/we act (for|as)/i);
      // The subject block / parties label is "Claimant", never "Our client"; the client's own letter has no subject block.
      if (t.recipientRole !== 'client') expect(txt).toContain('Claimant');
    });
  }

  it('refuses to render without required data, naming every missing key', () => {
    const data = complaintDispTemplate.sample();
    const broken = { ...data, finalResponseDeadline: '', heads: undefined as unknown as typeof data.heads };
    expect(() => renderTemplate(complaintDispTemplate.id, broken)).toThrow(DocumentDataError);
    try {
      renderTemplate(complaintDispTemplate.id, broken);
    } catch (e) {
      expect((e as DocumentDataError).missing).toEqual(['heads', 'finalResponseDeadline']);
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial: what goes wrong when the API feeds a template real, imperfect data
// ---------------------------------------------------------------------------

describe('letters-b: adversarial', () => {
  for (const template of ALL) {
    describe(template.id, () => {
      it('passes the domain consistency engine: no legacy detail, banned phrase, regulated-status wording, forum not open or GTA-as-law', () => {
        const txt = textOf(template);
        const ctx = consistencyContext(template.id, template.recipientRole ?? 'at_fault_insurer');
        expect(legacyCheck(txt)).toEqual([]);
        expect(bannedPhraseCheck(txt)).toEqual([]); // BANNED_PHRASE + REGULATED_STATUS_IMPLIED (incl. the "our client" warning)
        expect(forumChecks(txt, ctx)).toEqual([]); // FORUM_NOT_OPEN (DISP 2.7)
        expect(forumChecks(txt, consistencyContext(template.id, 'at_fault_insurer'))).toEqual([]); // even if the API mis-labels the role
        expect(gtaChecks(txt, ctx)).toEqual([]); // GTA_CITED_AS_LAW (GTA 2.7(j))
      });

      it('prints no amount and no date that is not in its data object', () => {
        const data = template.sample();
        const txt = textOf(template);
        const { numbers, strings } = flatten(data);
        const amounts = extractAmounts(txt);
        for (const a of amounts) {
          const fromLedger = numbers.has(a.pence) || numbers.has(-a.pence);
          // A rate inside a free-text label ("Storage, 15 days at £45.00 per day") is API-supplied text, not a template figure.
          const insideDataText = strings.some((s) => s.includes(formatGBP(a.pence)));
          expect(fromLedger || insideDataText, `${formatGBP(a.pence)} :: ${a.excerpt}`).toBe(true);
        }
        const dates = extractDates(txt);
        expect(dates.length).toBeGreaterThan(0);
        for (const d of dates) {
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

      it('treats an empty string as missing, not as a value to print', () => {
        const data = structuredClone(template.sample()) as Plain;
        setPath(data, 'claim.ourReference', '   ');
        expect(() => renderTemplate(template.id, data)).toThrow(DocumentDataError);
      });

      it('renders from the required keys alone (every optional key stripped) without gaps or "undefined"', () => {
        const data = requiredOnly(template.sample(), template.requiredData);
        expect(missingRequiredData(template, data)).toEqual([]);
        const html = renderTemplate(template.id, data).html;
        const txt = text(html);
        for (const bad of ['undefined', 'null', 'NaN', '[object Object]', 'Invalid Date', ' .', ' ,', ' ;', '()', '( ', ' )', '“”']) {
          expect(txt, `"${bad}" in ${template.id} with optional keys stripped`).not.toContain(bad);
        }
        expect(findProhibitedContent(html)).toEqual([]);
        for (const needle of BANNED_EVERYWHERE) expect(txt).not.toContain(needle);
        expect(html).not.toContain('Your ref</th>'); // claim.theirReference is optional and was stripped
        expect(txt).toMatch(/Yours (faithfully|sincerely)/);
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

      it('escapes free-text fields, so markup typed by a handler, a claimant or an insurer never reaches the HTML', () => {
        const data = structuredClone(template.sample()) as Plain;
        const fields = FREE_TEXT[template.id] ?? [];
        expect(fields.length).toBeGreaterThan(3);
        let injected = 0;
        for (const f of fields) {
          const current = getPath(data, f);
          expect(typeof current, `${template.id}: ${f} should be a string in the sample`).toBe('string');
          setPath(data, f, `${current as string} ${MARKUP}`);
          injected += 1;
        }
        const html = renderTemplate(template.id, data).html;
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>bold</b>');
        expect(html).toContain('&lt;script&gt;');
        expect((html.match(/&lt;script&gt;/g) ?? []).length).toBeGreaterThanOrEqual(injected);
      });
    });
  }

  it('renders every template to an A4 PDF with the running header and footer, at a sensible length', async () => {
    for (const template of ALL) {
      const data = template.sample();
      const { html } = renderTemplate(template.id, data);
      const { pdf, pages, sha256 } = await renderPdf(html, { reference: data.claim.ourReference });
      expect(pdf.subarray(0, 5).toString('latin1'), template.id).toBe('%PDF-');
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pages, `${template.id} pages`).toBeGreaterThanOrEqual(1);
      expect(pages, `${template.id} pages`).toBeLessThanOrEqual(4);
    }
  }, 180_000);

  it('never shows the insurer’s reference to a council, the police, an engineer or the client', () => {
    for (const t of NON_INSURER) {
      const data = t.sample();
      expect(data.claim.theirReference).toBe('EXI/TP/4471920'); // the sample claim carries it…
      const html = renderTemplate(t.id, data).html;
      expect(text(html), t.id).not.toContain('EXI/TP/4471920'); // …and the letter must not
      expect(html, t.id).not.toContain('Your ref</th>');
      expect(text(html), t.id).not.toContain('Your insured');
    }
  });

  it('letters the claimant signs carry the claimant’s signature only; every other letter is signed for CCGUK', () => {
    for (const t of ALL) {
      const txt = textOf(t);
      if (CLAIMANT_SIGNED_IDS.includes(t.id)) {
        expect(txt, t.id).toContain('Ms Jane Example Claimant');
        expect(txt, t.id).not.toContain('for and on behalf of Courtesy Cars Group UK Ltd');
        expect(txt, t.id).not.toContain('D. Kaleem');
        expect(txt, t.id).not.toContain('We are instructed');
        expect(txt, t.id).toContain('From: Ms Jane Example, 1 Example Street, Example Town, EX2 2BB');
      } else {
        expect(txt, t.id).toContain('for and on behalf of Courtesy Cars Group UK Ltd');
        expect(txt, t.id).not.toContain('Ms Jane Example Claimant');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Arithmetic and clock fidelity of the fixtures (the template never computes these; the fixtures must still be right)
// ---------------------------------------------------------------------------

describe('letters-b: arithmetic and ledger fidelity', () => {
  it('complaint: heads sum to the outstanding total; the ICOBS and DISP clocks match the document date', () => {
    const d = complaintDispTemplate.sample();
    expect(sumPence(d.heads.map((h) => h.valuePence))).toBe(d.outstandingPence);
    expect(d.icobsDeadline).toBe(addMonths(d.notificationDate, 3));
    expect(d.daysSinceNotification).toBe(daysInclusive(d.notificationDate, d.date) - 1);
    expect(d.icobsDeadlinePassed).toBe(d.icobsDeadline < d.date);
    expect(d.finalResponseDeadline).toBe(addDays(d.date, 56)); // eight weeks (DISP 1.6.2R)
    expect(d.acknowledgementDeadline > d.date).toBe(true);
    expect(d.acknowledgementDeadline < d.finalResponseDeadline).toBe(true);
    expect(d.chronology.map((e) => e.date)).toEqual([...d.chronology.map((e) => e.date)].sort());
  });

  it('dsar: one month to respond (art 12(3)) and the ICO complaint on day 31', () => {
    const d = dsarTemplate.sample();
    expect(d.responseDeadline).toBe(addMonths(d.date, 1));
    expect(d.icoComplaintDate).toBe(addDays(d.responseDeadline, 1));
    expect(d.authorityDate <= d.date).toBe(true);
  });

  it('cctv: the footage window brackets the incident and the request goes out the day after the accident', () => {
    const d = cctvPreservationTemplate.sample();
    expect(d.windowStart < d.incidentAt && d.incidentAt < d.windowEnd).toBe(true);
    expect(d.date).toBe(addDays(d.claim.accidentDate, 1));
    expect(d.responseDeadline).toBe(addDays(d.date, 7));
  });

  it('pav: every comparable is normalised by the stated per-mile factor; median, IQR, PAV and difference agree', () => {
    const d = pavChallengeTemplate.sample();
    const a = d.assessment;
    for (const c of d.comparables) {
      expect(c.normalisedPricePence, c.source).toBe(c.pricePence + (c.mileage - a.subject.odometerAtLoss) * a.perMilePence);
    }
    expect(d.comparables.length).toBe(a.comparablesCount);
    expect(a.exclusions.length).toBe(a.excludedCount);
    const sorted = d.comparables.map((c) => c.normalisedPricePence).sort((x, y) => x - y);
    const median = (xs: number[]): number => (xs.length % 2 === 1 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2);
    const mid = Math.floor(sorted.length / 2);
    expect(median(sorted)).toBe(a.medianPence);
    expect(median(sorted.slice(0, mid))).toBe(a.iqrLowPence);
    expect(median(sorted.slice(sorted.length % 2 === 1 ? mid + 1 : mid))).toBe(a.iqrHighPence);
    expect(a.pavPence).toBe(a.medianPence);
    expect(a.pavPence - d.offer.amountPence).toBe(d.differencePence);
    expect(d.offer.date < d.date && d.date < d.responseDeadline).toBe(true);
  });

  it('letter of claim: schedule lines sum to the total; s.69 interest is daily rate × days; total with interest adds up', () => {
    const d = letterBeforeClaimTemplate.sample();
    expect(sumPence(d.schedule.map((l) => l.netPence))).toBe(d.scheduleTotalPence);
    expect(d.interest.dailyPence).toBe(Math.round((d.scheduleTotalPence * d.interest.rate) / 365));
    const days = daysInclusive(d.interest.fromDate, d.interest.toDate);
    expect(d.interest.accruedPence).toBe(Math.round((d.scheduleTotalPence * d.interest.rate * days) / 365));
    expect(d.scheduleTotalPence + d.interest.accruedPence).toBe(d.totalWithInterestPence);
    expect(d.responseDeadline).toBe(addDays(d.date, d.responseDays));
    expect(d.interest.toDate).toBe(d.date);
    expect(d.totalWithInterestPence).toBeLessThanOrEqual(1_000_000); // small claims track fixture
    expect(d.track.expected).toBe('small_claims');
  });

  it('part 36: the relevant period is 21 days from the letter date and the offer sits below the sum claimed', () => {
    const d = part36OfferTemplate.sample();
    expect(d.relevantPeriodDays).toBe(PART36_MINIMUM_PERIOD_DAYS);
    expect(d.relevantPeriodEnd).toBe(addDays(d.date, d.relevantPeriodDays));
    expect(d.offerPence).toBeLessThan(d.claimedPence!);
    expect(d.claimedPence).toBe(letterBeforeClaimTemplate.sample().totalWithInterestPence);
  });

  it('client update: the figures snapshot balances and every date asked of the client is in the future', () => {
    const d = clientUpdateTemplate.sample();
    const [claimed, received, outstanding] = d.figures!;
    expect(claimed!.valuePence! - received!.valuePence!).toBe(outstanding!.valuePence);
    expect(claimed!.valuePence).toBe(complaintDispTemplate.sample().outstandingPence);
    for (const n of d.needFromYou) expect(n.byDate > d.date).toBe(true);
    expect(d.whatHappensNext.date > d.date).toBe(true);
  });

  it('engineer: inspection precedes the report date; the fee is the agreed £285', () => {
    const d = engineerInstructionTemplate.sample();
    expect(d.date < d.inspectionBy && d.inspectionBy < d.reportBy).toBe(true);
    expect(d.feePence).toBe(28500);
  });
});

// ---------------------------------------------------------------------------
// Per-template content
// ---------------------------------------------------------------------------

describe('letter.complaint_disp', () => {
  it('cites ICOBS 8.1.1R and 8.2.6R, the DISP 1.6 eight-week window, the chronology and the ledger figures', () => {
    const txt = textOf(complaintDispTemplate);
    expect(txt).toContain('This letter is a formal complaint');
    expect(txt).toContain('under DISP 1 of the FCA Handbook');
    expect(txt).toContain('ICOBS 8.1.1R requires you to handle claims promptly and fairly and not to reject a claim unreasonably');
    expect(txt).not.toContain('reasonable guidance'); // ICOBS 8.1.1R(2) is owed to a policyholder, not a third-party claimant
    expect(txt).toContain('ICOBS 8.2.6R requires a reasoned offer of settlement, or a reasoned reply, within three months of the claim being presented');
    expect(txt).toContain('The claim was presented to you on 10 August 2026; that period expires on 10 November 2026');
    expect(txt).toContain('55 days have passed since the claim was presented');
    expect(txt).toContain('DISP 1.6.2R');
    expect(txt).toContain('eight weeks');
    expect(txt).toContain('complaint reference');
    expect(txt).toContain('Chaser (day 7)');
    expect(txt).toContain('Hire charges, 24 days at £49.80 per day Invoice CCG-INV-0042 £1,195.20');
    expect(txt).toContain('Total outstanding £2,078.20');
    expect(txt).toContain('by Friday 9 October 2026');
    expect(txt).toContain('final response by Sunday 29 November 2026');
    expect(txt).toContain('Pay every head that is not disputed now, on account');
    expect(txt).toContain('letter of claim under the Practice Direction on Pre-Action Conduct');
    expect(txt).toContain('section 69 of the County Courts Act 1984');
    expect(txt).not.toContain('Financial Ombudsman');
    expect(txt).not.toContain('policyholder');
  });

  it('switches to the expired ICOBS wording when the three months have passed', () => {
    const d = { ...complaintDispTemplate.sample(), icobsDeadlinePassed: true, daysSinceNotification: 101, date: '2026-11-19' };
    const txt = textOf(complaintDispTemplate, d);
    expect(txt).toContain('That period expired on 10 November 2026. Neither has been received. 101 days have now passed');
    expect(txt).not.toContain('that period expires on');
  });

  it('adds the FOS referral paragraph only against the client’s own insurer, and the engine accepts it only with that role', () => {
    const d = { ...complaintDispTemplate.sample(), againstOwnInsurer: true };
    d.claim = { ...d.claim, policyNumber: 'POL-000123' };
    const txt = textOf(complaintDispTemplate, d);
    expect(txt).toContain('Financial Ombudsman Service');
    expect(txt).toContain('within six months of your final response');
    expect(txt).toContain('your policyholder under policy number POL-000123');
    expect(txt).toContain('Policy number POL-000123');
    expect(txt).not.toContain('letter of claim under the Practice Direction');
    expect(forumChecks(txt, consistencyContext(complaintDispTemplate.id, 'own_insurer'))).toEqual([]);
    // The API must label the draft own_insurer: against the at-fault insurer the same text is a FORUM_NOT_OPEN block.
    expect(forumChecks(txt, consistencyContext(complaintDispTemplate.id, 'at_fault_insurer')).map((f) => f.code)).toContain('FORUM_NOT_OPEN');
    expect(bannedPhraseCheck(txt)).toEqual([]);
  });
});

describe('letter.dsar', () => {
  it('is an Article 15 request with the authority enclosed, the alleged offer dates, the one-month deadline and the ICO route on day 31', () => {
    const txt = textOf(dsarTemplate);
    expect(txt).toContain('Article 15 of the UK GDPR made on behalf of Ms Jane Example, the data subject');
    expect(txt).toContain('signed authority dated 2 October 2026');
    expect(txt).toContain('on 11 August 2026 and 13 August 2026');
    expect(txt).toContain('call log');
    expect(txt).toContain('fraud prevention agency');
    expect(txt).toContain('CIFAS');
    expect(txt).toContain('Insurance Fraud Bureau');
    expect(txt).toContain('rationale for every decision');
    expect(txt).toContain('Article 15(1)(c)');
    expect(txt).toContain('Article 15(1)(g)');
    expect(txt).toContain('Article 15(1)(h)');
    expect(txt).toContain('Article 12(3)');
    expect(txt).toContain('No fee is payable (Article 12(5))');
    expect(txt).toContain('commonly used electronic form (Article 15(3))');
    expect(txt).not.toContain('original audio files'); // art 15(3) does not require originals; do not overclaim
    expect(txt).toContain('Schedule 2 to the Data Protection Act 2018');
    expect(txt).toContain('Wednesday 4 November 2026');
    expect(txt).toContain('Information Commissioner’s Office on 5 November 2026');
    expect(txt).toContain('Enclosures');
    expect(txt).toContain('14 March 1988');
    expect(txt).toContain('EXI/TP/4471920');
    expect(txt).toContain('sent to claims@courtesycars.net');
  });

  it('asks for all call recordings when no offer date is alleged, and prints no empty "on" clause', () => {
    const txt = textOf(dsarTemplate, { ...dsarTemplate.sample(), allegedOfferDates: [], references: [] });
    expect(txt).toContain('Recordings of every telephone call with, or about, Ms Jane Example, together with the call log');
    expect(txt).not.toContain('Ms Jane Example on ,');
    expect(txt).not.toContain('Your references');
  });
});

describe('letter.cctv_preservation', () => {
  it('asks a council to preserve and provide footage for the window, on the Schedule 2 para 5 basis (no legitimate-interests claim against a public authority)', () => {
    const txt = textOf(cctvPreservationTemplate);
    expect(txt).toContain('Preserve now all recorded footage');
    expect(txt).toContain('Junction of High Street and Station Road');
    expect(txt).toContain('Council camera on the lamp column');
    expect(txt).toContain('9 August 2026, 14:20');
    expect(txt).toContain('9 August 2026, 14:05 to 9 August 2026, 14:35');
    expect(txt).toContain('AB12 CDE');
    expect(txt).toContain('XY65 ZZZ');
    expect(txt).toContain('paragraph 5 of Schedule 2 to the Data Protection Act 2018');
    expect(txt).not.toContain('Article 6(1)(f)'); // UK GDPR art 6(1), last sentence: not available to a public authority in its tasks
    expect(txt).toContain('retention period is 31 days');
    expect(txt).toContain('original file format');
    expect(txt).toContain('Monday 17 August 2026');
    expect(txt).toContain('If a fee is payable, state the amount');
    expect(txt).toContain('CPR 31.17');
    expect(txt).toContain('Signed authority of Ms Jane Example dated 10 August 2026');
    expect(txt).not.toContain('Your insured');
    expect(txt).not.toContain('EXI/TP/4471920');
  });

  it('cites Article 6(1)(f) for a private premises operator, and the Schedule 2 basis alone for TfL', () => {
    const premises = textOf(cctvPreservationTemplate, { ...cctvPreservationTemplate.sample(), operatorType: 'premises' as const });
    expect(premises).toContain('Article 6(1)(f) of the UK GDPR (legitimate interests)');
    expect(premises).toContain('paragraph 5 of Schedule 2');
    const tfl = textOf(cctvPreservationTemplate, { ...cctvPreservationTemplate.sample(), operatorType: 'tfl' as const });
    expect(tfl).not.toContain('Article 6(1)(f)');
    expect(tfl).toContain('paragraph 5 of Schedule 2');
  });

  it('prints the known fee, the police reference and the collision-report wording for the police', () => {
    const d = { ...cctvPreservationTemplate.sample(), operatorType: 'police' as const, feePence: 21510, policeReference: 'CAD 1234/09AUG26', retentionNote: undefined };
    const txt = textOf(cctvPreservationTemplate, d);
    expect(txt).toContain('your fee for this service is £215.10');
    expect(txt).toContain('Police reference CAD 1234/09AUG26');
    expect(txt).toContain('collision investigation');
    expect(txt).not.toContain('CPR 31.17');
    expect(txt).toContain('retained for a short period');
  });

  it('shows the operator’s own reference as "Your ref" and never the insurer’s', () => {
    const html = renderTemplate(cctvPreservationTemplate.id, { ...cctvPreservationTemplate.sample(), operatorReference: 'CCTV/2026/0456' }).html;
    expect(html).toContain('Your ref</th><td>CCTV/2026/0456');
    expect(text(html)).not.toContain('EXI/TP/4471920');
  });

  it('treats a zero fee as "no fee known"', () => {
    const txt = textOf(cctvPreservationTemplate, { ...cctvPreservationTemplate.sample(), feePence: 0 });
    expect(txt).toContain('If a fee is payable, state the amount');
    expect(txt).not.toContain('£0.00');
  });
});

describe('letter.pav_challenge', () => {
  it('declines the offer, corrects the inputs, states the Darbishire measure and prints the comparables summary and figures', () => {
    const txt = textOf(pavChallengeTemplate);
    expect(txt).toContain('Your offer of £6,250.00 dated 15 September 2026 (your reference EXI/TL/88213) on the basis of trade guide figure, condition "average" is declined');
    expect(txt).toContain('Ms Jane Example’s position is £7,450.00');
    expect(txt).toContain('Darbishire v Warran [1963] 1 WLR 1067');
    expect(txt).toContain('retail price');
    expect(txt).toContain('Golf 1.5 TSI Match');
    expect(txt).toContain('V5C and DVLA vehicle enquiry');
    expect(txt).toContain('2020 Volkswagen Golf 1.5 TSI Life, 38,420 miles (projected from the MOT history to the date of loss), condition good, service history full');
    expect(txt).toContain('9 (2 excluded: one Category S vehicle and one price-on-application advert)');
    expect(txt).toContain('Search radius 50 miles');
    expect(txt).toContain('£0.07 per mile (regression across the comparables)');
    expect(txt).toContain('Median adjusted price £7,450.00');
    expect(txt).toContain('Interquartile range £7,387.10 to £7,511.10');
    expect(txt).toContain('Dealer advert A Dealer, 12 miles away 2020 41,200 £7,390.00 £7,584.60 20 September 2026, 10:05');
    expect(txt).toContain('Your offer 15 September 2026 £6,250.00');
    expect(txt).toContain('Difference £1,200.00');
    expect(txt).toContain('A revised offer of £7,450.00 for the pre-accident value of the vehicle, by Sunday 18 October 2026');
    expect(txt).toContain('Payment now of the £6,250.00 you have already offered, on account and without prejudice to the balance of £1,200.00');
    expect(txt).toContain('ICOBS 8.1');
    expect(txt).toContain('Comparables schedule with dated screenshots (11 adverts)');
    expect(txt).not.toContain('Financial Ombudsman');
    expect(txt).not.toContain('trade guides are a starting point');
  });

  it('cites the FOS valuation approach only against the client’s own insurer', () => {
    const txt = textOf(pavChallengeTemplate, { ...pavChallengeTemplate.sample(), againstOwnInsurer: true });
    expect(txt).toContain('Financial Ombudsman Service');
    expect(txt).toContain('trade guides are a starting point, not a ceiling');
    expect(txt).toContain('your policyholder');
    expect(forumChecks(txt, consistencyContext(pavChallengeTemplate.id, 'own_insurer'))).toEqual([]);
    expect(forumChecks(txt, consistencyContext(pavChallengeTemplate.id, 'at_fault_insurer')).map((f) => f.code)).toContain('FORUM_NOT_OPEN');
  });

  it('labels an odometer reading and the fallback per-mile band, and omits empty tables', () => {
    const base = pavChallengeTemplate.sample();
    const d = {
      ...base,
      inputsChallenged: [],
      comparables: [],
      assessment: { ...base.assessment, subject: { ...base.assessment.subject, odometerBasis: 'reading' as const, serviceHistory: undefined, trim: undefined }, perMileSource: 'fallback_band' as const, exclusions: [], excludedCount: 0, reasoning: undefined }
    };
    const html = renderTemplate(pavChallengeTemplate.id, d).html;
    const txt = text(html);
    expect(txt).toContain('38,420 miles (odometer reading), condition good');
    expect(txt).toContain('£0.07 per mile (fallback band)');
    expect(txt).toContain('9 (0 excluded: none)');
    expect(html).not.toContain('<caption>Comparables');
    expect(html).not.toContain('<th>Input</th>');
  });
});

describe('letter.particularisation_demand', () => {
  it('uses the voice.md opener (perimeter-safe), quotes the allegation and numbers the demands for an irregularity allegation', () => {
    const txt = textOf(particularisationDemandTemplate);
    expect(txt).toContain('We note the allegation in your letter of 28 September 2026 from your Claims Validation Team, reference EXI/TP/4471920/CF');
    expect(txt).toContain('Before the claimant responds further, we require you to particularise it. Specifically:');
    expect(txt).toContain('Our enquiries have identified irregularities');
    expect(txt).toContain('"Irregularities" is not an allegation');
    expect(txt).toContain('inference chain');
    expect(txt).toContain('CIFAS');
    expect(txt).toContain('Insurance Fraud Bureau');
    expect(txt).toContain('The claimant will address the allegation once it is properly set out. Until then there is nothing capable of being answered');
    expect(txt).toContain('Our intervention register holds no offer');
    expect(txt).toContain('not a reasoned reply for the purposes of ICOBS 8.2.6R');
    expect(txt).toContain('Sunday 18 October 2026');
    expect(txt).toContain('no particularised allegation is made');
    expect(txt).not.toContain('our client');
  });

  it('changes the demands by allegation kind, and an unmapped kind falls back to the generic demand rather than crashing', () => {
    const base = particularisationDemandTemplate.sample();
    const offer = textOf(particularisationDemandTemplate, { ...base, allegationKind: 'offer_ignored' });
    expect(offer).toContain('Copley v Lawn [2009] EWCA Civ 580');
    expect(offer).toContain('vehicle class offered, the daily rate');
    const fraud = textOf(particularisationDemandTemplate, { ...base, allegationKind: 'fraud' });
    expect(fraud).toContain('staged collision');
    expect(fraud).toContain('avoided, cancelled or void');
    const other = textOf(particularisationDemandTemplate, { ...base, allegationKind: 'other' });
    expect(other).toContain('The precise allegation, in terms capable of being answered');
    const unmapped = textOf(particularisationDemandTemplate, { ...base, allegationKind: 'exaggeration' as unknown as 'other' });
    expect(unmapped).toContain('The precise allegation, in terms capable of being answered');
  });
});

describe('letter.letter_before_claim', () => {
  it('is PD Pre-Action Conduct compliant, in the claimant’s name, with schedule, s.69 interest, 14 days, ADR, enclosures and a track note', () => {
    const txt = textOf(letterBeforeClaimTemplate);
    expect(txt).toContain('From: Ms Jane Example, 1 Example Street, Example Town, EX2 2BB, jane@example.test');
    expect(txt).toContain('Dear Sir or Madam');
    expect(txt).toContain('Letter of claim — Practice Direction on Pre-Action Conduct and Protocols');
    expect(txt).toContain('Proposed defendant Mr John Sample');
    expect(txt).toContain('Defendant’s insurer Example Insurance plc, reference EXI/TP/4471920');
    expect(txt).toContain('I am the claimant');
    expect(txt).toContain('Courtesy Cars Group UK Ltd supplied the replacement vehicle, recovery and storage whose charges form part of my loss');
    expect(txt).toContain('It is not a firm of solicitors and does not act for me in any proceedings');
    expect(txt).toContain('9 August 2026, 14:20');
    expect(txt).toContain('Rules 126 and 146 of the Highway Code');
    expect(txt).toContain('Road Traffic Act 1988, section 38(7)');
    expect(txt).toContain('I hold you liable in negligence');
    expect(txt).toContain('Schedule of loss');
    expect(txt).toContain('Hire of a replacement vehicle 10 August 2026 to 2 September 2026, 24 days at £49.80 per day £1,195.20 Hire agreement; invoice CCG-INV-0042');
    expect(txt).toContain('Total loss £2,613.20');
    expect(txt).toContain('section 69 of the County Courts Act 1984 at 8% a year from 3 September 2026 to 4 October 2026, which is £18.33');
    expect(txt).toContain('£0.57 per day');
    expect(txt).toContain('Total claimed £2,631.53');
    expect(txt).toContain('(Practice Direction, paragraph 6(b))');
    expect(txt).toContain('(Practice Direction, paragraph 6(c))');
    expect(txt).not.toContain('paragraph 6(d)'); // PD Pre-Action Conduct para 6 has (a) to (c) only
    expect(txt).not.toContain('6(c) and (d)');
    expect(txt).toContain('14 days is a reasonable time for a straightforward claim of this kind (Practice Direction, paragraph 6(b))');
    expect(txt).toContain('Sunday 18 October 2026');
    expect(txt).toContain('issue proceedings in the County Court without further notice');
    expect(txt).toContain('paragraphs 8 to 11');
    expect(txt).toContain('paragraphs 13 to 16');
    expect(txt).toContain('alternative dispute resolution');
    expect(txt).toContain('allocated to the small claims track');
    expect(txt).toContain('CPR 27.14');
    expect(txt).toContain('Enclosures');
    expect(txt).toContain('Mitigation questionnaire');
    expect(txt).toContain('Yours faithfully');
    expect(txt).toContain('Ms Jane Example Claimant');
  });

  it('uses the longer period for a business claimant and the right label for each track', () => {
    const d = letterBeforeClaimTemplate.sample();
    d.claimant = { ...d.claimant, isBusiness: true };
    d.responseDays = 30;
    d.responseDeadline = '2026-11-03';
    d.track = { expected: 'fast', note: 'Fixed recoverable costs apply (CPR Part 45).' };
    const txt = textOf(letterBeforeClaimTemplate, d);
    expect(txt).toContain('30 days is a reasonable time for a claim of this kind');
    expect(txt).not.toContain('paragraph 6(b)). I require'); // the 14-day straightforward-case citation is not made for 30 days
    expect(txt).toContain('Tuesday 3 November 2026');
    expect(txt).toContain('allocated to the fast track. Fixed recoverable costs apply');
  });

  it('handles a single Highway Code rule, no rules, and no third-party registration without gaps', () => {
    const base = letterBeforeClaimTemplate.sample();
    const one = textOf(letterBeforeClaimTemplate, { ...base, accident: { ...base.accident, highwayCodeRules: [126] } });
    expect(one).toContain('Rule 126 of the Highway Code applied');
    const none = textOf(letterBeforeClaimTemplate, { ...base, accident: { ...base.accident, highwayCodeRules: [] }, claim: { ...base.claim, thirdPartyRegistration: undefined } });
    expect(none).not.toContain('Highway Code');
    expect(none).toContain('and the vehicle you were driving.');
    expect(none).not.toContain('Defendant’s vehicle');
  });
});

describe('letter.part36_offer', () => {
  it('carries the CPR 36.5(1) essentials, the 36.17(4) consequences and is signed by the claimant', () => {
    const txt = textOf(part36OfferTemplate);
    expect(txt).toContain('WITHOUT PREJUDICE SAVE AS TO COSTS');
    expect(txt).toContain('Claimant’s offer to settle under CPR Part 36');
    expect(txt).toContain('made pursuant to Part 36 of the Civil Procedure Rules');
    expect(txt).toContain('consequences of Section I of Part 36 (CPR 36.5(1)(b))');
    expect(txt).toContain('It is a claimant’s offer.');
    expect(txt).toContain('It relates to the whole of my claim (CPR 36.5(1)(d)).');
    expect(txt).toContain('It does not take into account any counterclaim (CPR 36.5(1)(e)).');
    expect(txt).toContain('I will accept £2,400.00 in full and final settlement of the whole of my claim');
    expect(txt).toContain('inclusive of interest to the end of the relevant period (CPR 36.5(4))');
    expect(txt).toContain('The relevant period is 21 days from the date this offer is served on you, ending on Sunday 25 October 2026 (CPR 36.5(1)(c))');
    expect(txt).toContain('payable within 14 days of acceptance (CPR 36.14(6))');
    expect(txt).toContain('CPR 36.13');
    expect(txt).toContain('CPR 36.17(4)');
    expect(txt).toContain('indemnity basis');
    expect(txt).toContain('additional amount of 10% of the sum awarded');
    expect(txt).toContain('serve written notice of acceptance on me at the address above (CPR 36.11(1))');
    expect(txt).toContain('withdrawn or changed only by written notice (CPR 36.9)');
    expect(txt).toContain('Part 36 does not apply to it (CPR 27.2(1)(g))');
    expect(txt).toContain('CPR 27.14(2)(g)');
    expect(txt).toContain('my letter of claim dated 4 October 2026');
    expect(txt).toContain('Proceedings have not yet been issued');
    expect(txt).toContain('Amount claimed, including interest to date £2,631.53');
    expect(txt).toContain('costs consequences in paragraph 7 run from that date'); // the costs term is the seventh numbered term
    expect(txt).toContain('Ms Jane Example Claimant');
    expect(txt).not.toContain('Your insured');
  });

  it('refers to the claim number once proceedings are issued, notes a counterclaim, and drops the small claims caveat on the fast track', () => {
    const d = {
      ...part36OfferTemplate.sample(),
      proceedings: { claimNumber: 'K1AB2345', court: 'County Court at Example' },
      expectedTrack: 'fast' as const,
      takesAccountOfCounterclaim: true,
      claimedPence: undefined
    };
    const html = renderTemplate(part36OfferTemplate.id, d).html;
    const txt = text(html);
    expect(txt).toContain('claim number K1AB2345 in the County Court at Example');
    expect(txt).toContain('It takes into account the counterclaim you have intimated (CPR 36.5(1)(e)).');
    expect(txt).not.toContain('CPR 27.2(1)(g)');
    expect(txt).not.toContain('letter of claim dated');
    expect(html).not.toContain('class="data figures"');
  });

  it('refuses a relevant period shorter than 21 days or not a whole number of days (CPR 36.5(1)(c))', () => {
    for (const bad of [14, 20, 20.5, 0, -1, Number.NaN]) {
      expect(() => renderTemplate(part36OfferTemplate.id, { ...part36OfferTemplate.sample(), relevantPeriodDays: bad }), String(bad)).toThrow(RangeError);
      expect(() => renderTemplate(part36OfferTemplate.id, { ...part36OfferTemplate.sample(), relevantPeriodDays: bad }), String(bad)).toThrow(/CPR 36\.5\(1\)\(c\)/);
    }
    expect(textOf(part36OfferTemplate, { ...part36OfferTemplate.sample(), relevantPeriodDays: 28, relevantPeriodEnd: '2026-11-01' })).toContain('The relevant period is 28 days');
  });
});

describe('letter.client_update', () => {
  it('follows the client-communications shape with dated requirements and never tells the client to ignore an offer', () => {
    const txt = textOf(clientUpdateTemplate);
    expect(txt).toContain('Dear Ms Example,');
    expect(txt).toContain('Your claim — AB12 CDE, accident on 9 August 2026');
    expect(txt.indexOf('Where we are')).toBeLessThan(txt.indexOf('What this means'));
    expect(txt.indexOf('What this means')).toBeLessThan(txt.indexOf('What I need from you'));
    expect(txt.indexOf('What I need from you')).toBeLessThan(txt.indexOf('What happens next'));
    expect(txt).toContain('Please do this by Friday 9 October 2026');
    expect(txt).toContain('Please do this by Friday 16 October 2026');
    expect(txt).toContain('write to you again by Sunday 29 November 2026');
    expect(txt).toContain('Outstanding £2,078.20');
    expect(txt).toContain('you do not have to decide on the spot. Tell me the same day what was offered, by whom and when');
    expect(txt).toContain('Yours sincerely');
    expect(txt).toContain('D. Kaleem Claims Manager for and on behalf of Courtesy Cars Group UK Ltd');
    expect(txt).toContain('call me on 020 7052 5403 and email claims@courtesycars.net');
    expect(txt).not.toMatch(/\bignor/i);
    expect(txt).not.toMatch(/guarantee/i);
    expect(txt).not.toMatch(/\bwill win\b/i);
    expect(txt).not.toContain('We are instructed');
  });

  it('omits the figures table and the contact line when not supplied', () => {
    const d = { ...clientUpdateTemplate.sample(), figures: undefined, handler: { name: 'A. Handler', role: 'Claims Handler' } };
    const html = renderTemplate(clientUpdateTemplate.id, d).html;
    expect(html).not.toContain('class="data figures"');
    expect(text(html)).not.toContain('If anything in this letter is unclear');
    expect(text(html)).toContain('A. Handler Claims Handler');
  });
});

describe('letter.supplier_instruction_engineer', () => {
  it('instructs the inspection with the §4.6 report contents in order, the fee and dated deadlines', () => {
    const txt = textOf(engineerInstructionTemplate);
    expect(txt).toContain('Dear Mr A. Assessor MIMI,');
    expect(txt).toContain('Registration AB12 CDE');
    expect(txt).toContain('VIN WVWZZZAUZLW000000');
    expect(txt).toContain('Last recorded odometer 38,420 miles');
    expect(txt).toContain('MOT expiry 1 March 2027');
    expect(txt).toContain('Keys With the yard office');
    expect(txt).toContain('The client states that she was stationary');
    expect(txt).toContain('inspect the vehicle physically by Friday 9 October 2026');
    expect(txt).toContain('by Wednesday 14 October 2026');
    const order = [
      'Your instructions and the instructing party',
      'IAEA, IMI or equivalent',
      'physical or desktop',
      'registration, VIN, odometer reading and MOT status',
      'Pre-accident condition',
      'photographs of each damaged area',
      'ADAS calibration is required',
      'roadworthy or unroadworthy',
      'Repair duration in working days',
      'salvage category under the ABI Code of Practice',
      'battery and high-voltage system checks',
      'consistent with the circumstances described'
    ];
    let last = -1;
    for (const s of order) {
      const i = txt.indexOf(s);
      expect(i, s).toBeGreaterThan(last);
      last = i;
    }
    expect(txt).toContain('rear parking sensors and any rear camera');
    expect(txt).toContain('agreed at £285.00');
    expect(txt).toContain('quoting our reference CCG-2026-00012');
    expect(txt).toContain('independent opinion');
    expect(txt).toContain('Do not omit a finding because it does not assist the claim');
    expect(txt).not.toContain('CPR Part 35');
    expect(txt).not.toContain('EXI/TP/4471920');
    expect(txt).not.toContain('Your insured');
  });

  it('adds the CPR 35 / PD 35 requirements and the small claims cap when the report is for court', () => {
    const txt = textOf(engineerInstructionTemplate, { ...engineerInstructionTemplate.sample(), forCourt: true });
    expect(txt).toContain('CPR Part 35 and Practice Direction 35');
    expect(txt).toContain('duty to the court');
    expect(txt).toContain('CPR 35.3 and 35.10');
    expect(txt).toContain('PD 35 paragraph 3.3');
    expect(txt).toContain('Guidance for the Instruction of Experts in Civil Claims');
    expect(txt).toContain('CPR 27.5');
    expect(txt).toContain('capped at £750.00 per expert by PD 27A paragraph 7.3(2)');
  });

  it('cites PD 27A without a figure when the cap is not supplied by the knowledge base', () => {
    const txt = textOf(engineerInstructionTemplate, { ...engineerInstructionTemplate.sample(), forCourt: true, smallClaimsExpertFeeCapPence: undefined });
    expect(txt).toContain('is capped by PD 27A paragraph 7.3(2)');
    expect(txt).not.toContain('£750');
  });

  it('numbers specific questions on from the standard report contents', () => {
    const html = renderTemplate(engineerInstructionTemplate.id, engineerInstructionTemplate.sample()).html;
    expect(html).toContain('<ol class="numbered" start="13">');
  });
});
