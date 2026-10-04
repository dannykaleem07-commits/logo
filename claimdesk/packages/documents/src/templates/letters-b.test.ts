import { describe, expect, it } from 'vitest';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { DocumentDataError, getTemplate, listTemplates, missingRequiredData, renderTemplate } from '../registry.js';
import {
  cctvPreservationTemplate,
  clientUpdateTemplate,
  complaintDispTemplate,
  dsarTemplate,
  engineerInstructionTemplate,
  letterBeforeClaimTemplate,
  part36OfferTemplate,
  particularisationDemandTemplate,
  pavChallengeTemplate
} from './letters-b.js';

const ALL = [
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

/** Rendered text (tags stripped) so phrases split across markup are still found. */
function text(html: string): string {
  return htmlToText(html);
}

describe('letters-b registration', () => {
  it('registers all nine templates with semver versions and the expected recipient roles', () => {
    const ids = listTemplates().map((t) => t.id);
    for (const t of ALL) {
      expect(ids).toContain(t.id);
      expect(getTemplate(t.id)).toBe(t);
      expect(t.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(t.kind).toBe('letter');
    }
    expect(complaintDispTemplate.recipientRole).toBe('at_fault_insurer');
    expect(cctvPreservationTemplate.recipientRole).toBe('other');
    expect(clientUpdateTemplate.recipientRole).toBe('client');
    expect(engineerInstructionTemplate.recipientRole).toBe('supplier');
  });

  for (const t of ALL) {
    it(`${t.id}: sample satisfies requiredData, renders purely, and carries no legacy, banned or perimeter-breaching text`, () => {
      const data = t.sample();
      expect(missingRequiredData(t, data)).toEqual([]);
      const a = renderTemplate(t.id, data);
      const b = renderTemplate(t.id, t.sample());
      expect(a.html).toBe(b.html); // pure function of the data
      expect(a.templateVersion).toBe(t.version);
      const txt = text(a.html);
      expect(findProhibitedContent(a.html)).toEqual([]);
      expect(txt).not.toMatch(/our solicitors/i);
      expect(txt).not.toMatch(/we act (for|as your solicitors)/i);
      expect(txt).not.toMatch(/legal advice/i);
      expect(txt).not.toMatch(/under the GTA you must/i);
      expect(txt).not.toMatch(/Financial Ombudsman/); // every sample is a third-party claimant letter
      expect(txt).not.toMatch(/ignore/i);
      expect(a.html).not.toContain('Invalid Date');
      expect(a.html).not.toContain('undefined');
      expect(a.html).not.toContain('NaN');
      expect(a.html).toContain('class="logo-lockup"');
      expect(a.html).toContain('Our ref');
      expect(a.html).toContain('CCG-2026-00012');
    });
  }

  it('refuses to render without required data', () => {
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

describe('letter.complaint_disp', () => {
  it('cites ICOBS 8.1 and 8.2.6R, the DISP 1.6 eight-week window, the chronology and the ledger figures', () => {
    const txt = text(renderTemplate(complaintDispTemplate.id, complaintDispTemplate.sample()).html);
    expect(txt).toContain('formal complaint');
    expect(txt).toContain('ICOBS 8.1.1R');
    expect(txt).toContain('ICOBS 8.2.6R');
    expect(txt).toContain('DISP 1.6.2R');
    expect(txt).toContain('eight weeks');
    expect(txt).toContain('complaint reference');
    expect(txt).toContain('notified on 10 August 2026');
    expect(txt).toContain('expires on 10 November 2026');
    expect(txt).toContain('55 days have passed');
    expect(txt).toContain('Chaser (day 7)');
    expect(txt).toContain('£1,195.20');
    expect(txt).toContain('£2,078.20');
    expect(txt).toContain('by Friday 9 October 2026');
    expect(txt).toContain('final response by Sunday 29 November 2026');
    expect(txt).toContain('Practice Direction on Pre-Action Conduct');
    expect(txt).toContain('section 69 of the County Courts Act 1984');
    expect(txt).not.toContain('Financial Ombudsman');
    expect(txt).not.toContain('policyholder');
  });

  it('switches to the expired ICOBS wording when the three months have passed', () => {
    const d = { ...complaintDispTemplate.sample(), icobsDeadlinePassed: true, daysSinceNotification: 101, date: '2026-11-19' };
    const txt = text(renderTemplate(complaintDispTemplate.id, d).html);
    expect(txt).toContain('That period expired on 10 November 2026. Neither has been received. 101 days have now passed');
  });

  it('adds the FOS referral paragraph only when the complaint is against the client’s own insurer', () => {
    const d = { ...complaintDispTemplate.sample(), againstOwnInsurer: true };
    d.claim = { ...d.claim, policyNumber: 'POL-000123' };
    const txt = text(renderTemplate(complaintDispTemplate.id, d).html);
    expect(txt).toContain('Financial Ombudsman Service');
    expect(txt).toContain('within six months of your final response');
    expect(txt).toContain('your policyholder under policy number POL-000123');
    expect(txt).not.toContain('letter of claim under the Practice Direction');
  });
});

describe('letter.dsar', () => {
  it('is an Article 15 request with the authority enclosed, the alleged offer dates, the one-month deadline and the ICO route on day 31', () => {
    const txt = text(renderTemplate(dsarTemplate.id, dsarTemplate.sample()).html);
    expect(txt).toContain('Article 15 of the UK GDPR');
    expect(txt).toContain('signed authority dated 2 October 2026');
    expect(txt).toContain('on 11 August 2026 and 13 August 2026');
    expect(txt).toContain('call log');
    expect(txt).toContain('fraud prevention agency');
    expect(txt).toContain('CIFAS');
    expect(txt).toContain('rationale for every decision');
    expect(txt).toContain('Article 12(3)');
    expect(txt).toContain('No fee is payable');
    expect(txt).toContain('original audio files');
    expect(txt).toContain('Wednesday 4 November 2026');
    expect(txt).toContain('Information Commissioner’s Office on 5 November 2026');
    expect(txt).toContain('Enclosures');
    expect(txt).toContain('14 March 1988');
    expect(txt).toContain('EXI/TP/4471920');
  });
});

describe('letter.cctv_preservation', () => {
  it('asks to preserve and provide footage for the window, gives the data-protection basis and a dated deadline', () => {
    const txt = text(renderTemplate(cctvPreservationTemplate.id, cctvPreservationTemplate.sample()).html);
    expect(txt).toContain('preserve');
    expect(txt).toContain('Junction of High Street and Station Road');
    expect(txt).toContain('9 August 2026, 14:20');
    expect(txt).toContain('9 August 2026, 14:05 to 9 August 2026, 14:35');
    expect(txt).toContain('AB12 CDE');
    expect(txt).toContain('XY65 ZZZ');
    expect(txt).toContain('Article 6(1)(f)');
    expect(txt).toContain('paragraph 5 of Schedule 2 to the Data Protection Act 2018');
    expect(txt).toContain('retention period is 31 days');
    expect(txt).toContain('original file format');
    expect(txt).toContain('Monday 17 August 2026');
    expect(txt).toContain('If a fee is payable, state the amount');
    expect(txt).toContain('CPR 31.17');
    expect(txt).not.toContain('Your insured');
  });

  it('prints the known fee and the police wording when given', () => {
    const d = { ...cctvPreservationTemplate.sample(), operatorType: 'police' as const, feePence: 21510, policeReference: 'CAD 1234/09AUG26', retentionNote: undefined };
    const txt = text(renderTemplate(cctvPreservationTemplate.id, d).html);
    expect(txt).toContain('your fee for this service is £215.10');
    expect(txt).toContain('CAD 1234/09AUG26');
    expect(txt).toContain('collision investigation');
    expect(txt).toContain('retained for a short period');
  });
});

describe('letter.pav_challenge', () => {
  it('declines the offer, corrects the inputs, states the Darbishire measure and prints the comparables summary and figures', () => {
    const txt = text(renderTemplate(pavChallengeTemplate.id, pavChallengeTemplate.sample()).html);
    expect(txt).toContain('Your offer of £6,250.00 dated 15 September 2026');
    expect(txt).toContain('is declined');
    expect(txt).toContain('Darbishire v Warran [1963] 1 WLR 1067');
    expect(txt).toContain('retail price');
    expect(txt).toContain('Golf 1.5 TSI Match');
    expect(txt).toContain('38,420 miles');
    expect(txt).toContain('9 (2 excluded: one Category S vehicle and one price-on-application advert)');
    expect(txt).toContain('50 miles');
    expect(txt).toContain('£0.07 per mile (regression across the comparables)');
    expect(txt).toContain('£7,450.00');
    expect(txt).toContain('£7,100.00 to £7,800.00');
    expect(txt).toContain('£1,200.00');
    expect(txt).toContain('Dealer advert A');
    expect(txt).toContain('20 September 2026, 10:05');
    expect(txt).toContain('Sunday 18 October 2026');
    expect(txt).toContain('on account and without prejudice');
    expect(txt).not.toContain('Financial Ombudsman');
  });

  it('cites the FOS valuation approach only against the client’s own insurer', () => {
    const txt = text(renderTemplate(pavChallengeTemplate.id, { ...pavChallengeTemplate.sample(), againstOwnInsurer: true }).html);
    expect(txt).toContain('Financial Ombudsman Service');
    expect(txt).toContain('trade guides are a starting point');
    expect(txt).toContain('your policyholder');
  });
});

describe('letter.particularisation_demand', () => {
  it('uses the voice.md opener, quotes the allegation and numbers the demands for an irregularity allegation', () => {
    const txt = text(renderTemplate(particularisationDemandTemplate.id, particularisationDemandTemplate.sample()).html);
    expect(txt).toContain('We note the allegation in your letter of 28 September 2026');
    expect(txt).toContain('Before our client responds further, we require you to particularise it. Specifically:');
    expect(txt).toContain('Our enquiries have identified irregularities');
    expect(txt).toContain('"Irregularities" is not an allegation');
    expect(txt).toContain('inference chain');
    expect(txt).toContain('CIFAS');
    expect(txt).toContain('Insurance Fraud Bureau');
    expect(txt).toContain('nothing capable of being answered');
    expect(txt).toContain('Our intervention register holds no offer');
    expect(txt).toContain('Sunday 18 October 2026');
    expect(txt).toContain('no particularised allegation is made');
  });

  it('changes the demands by allegation kind', () => {
    const base = particularisationDemandTemplate.sample();
    const offer = text(renderTemplate(particularisationDemandTemplate.id, { ...base, allegationKind: 'offer_ignored' }).html);
    expect(offer).toContain('Copley v Lawn [2009] EWCA Civ 580');
    expect(offer).toContain('vehicle class offered, the daily rate');
    const fraud = text(renderTemplate(particularisationDemandTemplate.id, { ...base, allegationKind: 'fraud' }).html);
    expect(fraud).toContain('staged collision');
    expect(fraud).toContain('avoided, cancelled or void');
  });
});

describe('letter.letter_before_claim', () => {
  it('is PD Pre-Action Conduct compliant, in the claimant’s name, with schedule, s.69 interest, 14 days, enclosures and a track note', () => {
    const html = renderTemplate(letterBeforeClaimTemplate.id, letterBeforeClaimTemplate.sample()).html;
    const txt = text(html);
    expect(txt).toContain('From: Ms Jane Example, 1 Example Street');
    expect(txt).toContain('Letter of claim — Practice Direction on Pre-Action Conduct and Protocols');
    expect(txt).toContain('I am the claimant');
    expect(txt).toContain('supplied the replacement vehicle, recovery and storage');
    expect(txt).toContain('is not a firm of solicitors and does not act for me');
    expect(txt).toContain('9 August 2026, 14:20');
    expect(txt).toContain('Rules 126 and 146 of the Highway Code');
    expect(txt).toContain('section 38(7)');
    expect(txt).toContain('Schedule of loss');
    expect(txt).toContain('Hire of a replacement vehicle');
    expect(txt).toContain('£1,195.20');
    expect(txt).toContain('£2,613.20');
    expect(txt).toContain('section 69 of the County Courts Act 1984 at 8% a year from 3 September 2026 to 4 October 2026, which is £18.33');
    expect(txt).toContain('£0.57 per day');
    expect(txt).toContain('£2,631.53');
    expect(txt).toContain('14 days is a reasonable time');
    expect(txt).toContain('Sunday 18 October 2026');
    expect(txt).toContain('issue proceedings in the County Court without further notice');
    expect(txt).toContain('paragraphs 13 to 16');
    expect(txt).toContain('alternative dispute resolution');
    expect(txt).toContain('small claims track');
    expect(txt).toContain('CPR 27.14');
    expect(txt).toContain('Enclosures');
    expect(txt).toContain('Mitigation questionnaire');
    // signed by the claimant, never by CCGUK
    expect(txt).toContain('Yours faithfully');
    expect(txt).toContain('Ms Jane Example Claimant');
    expect(txt).not.toContain('for and on behalf of Courtesy Cars Group UK Ltd');
    expect(txt).not.toContain('D. Kaleem');
    expect(txt).not.toContain('We are instructed');
  });

  it('uses the longer period for a business claimant', () => {
    const d = letterBeforeClaimTemplate.sample();
    d.claimant = { ...d.claimant, isBusiness: true };
    d.responseDays = 30;
    d.responseDeadline = '2026-11-03';
    const txt = text(renderTemplate(letterBeforeClaimTemplate.id, d).html);
    expect(txt).toContain('30 days is a reasonable time');
    expect(txt).toContain('Tuesday 3 November 2026');
  });
});

describe('letter.part36_offer', () => {
  it('carries the CPR 36 essentials and is signed by the claimant', () => {
    const txt = text(renderTemplate(part36OfferTemplate.id, part36OfferTemplate.sample()).html);
    expect(txt).toContain('WITHOUT PREJUDICE SAVE AS TO COSTS');
    expect(txt).toContain('made pursuant to Part 36 of the Civil Procedure Rules');
    expect(txt).toContain('consequences of Section I of Part 36');
    expect(txt).toContain('claimant’s offer');
    expect(txt).toContain('whole of my claim');
    expect(txt).toContain('£2,400.00 in full and final settlement');
    expect(txt).toContain('inclusive of interest');
    expect(txt).toContain('21 days from the date this offer is served');
    expect(txt).toContain('Sunday 25 October 2026');
    expect(txt).toContain('CPR 36.14(6)');
    expect(txt).toContain('CPR 36.17(4)');
    expect(txt).toContain('indemnity basis');
    expect(txt).toContain('additional amount of 10%');
    expect(txt).toContain('CPR 36.11(1)');
    expect(txt).toContain('CPR 27.2(1)(g)');
    expect(txt).toContain('my letter of claim dated 4 October 2026');
    expect(txt).toContain('£2,631.53');
    expect(txt).toContain('Ms Jane Example Claimant');
    expect(txt).not.toContain('for and on behalf of Courtesy Cars Group UK Ltd');
    expect(txt).not.toContain('We are instructed');
  });

  it('refers to the claim number once proceedings are issued and drops the small claims caveat on the fast track', () => {
    const d = { ...part36OfferTemplate.sample(), proceedings: { claimNumber: 'K1AB2345', court: 'County Court at Example' }, expectedTrack: 'fast' as const };
    const txt = text(renderTemplate(part36OfferTemplate.id, d).html);
    expect(txt).toContain('claim number K1AB2345 in the County Court at Example');
    expect(txt).not.toContain('CPR 27.2(1)(g)');
    expect(txt).not.toContain('letter of claim dated');
  });
});

describe('letter.client_update', () => {
  it('follows the client-communications shape with dated requirements and never tells the client to ignore an offer', () => {
    const txt = text(renderTemplate(clientUpdateTemplate.id, clientUpdateTemplate.sample()).html);
    expect(txt).toContain('Dear Ms Example,');
    expect(txt).toContain('Where we are');
    expect(txt).toContain('What this means');
    expect(txt).toContain('What I need from you');
    expect(txt).toContain('Please do this by Friday 9 October 2026');
    expect(txt).toContain('Please do this by Friday 16 October 2026');
    expect(txt).toContain('What happens next');
    expect(txt).toContain('write to you again by Sunday 29 November 2026');
    expect(txt).toContain('£2,078.20');
    expect(txt).toContain('Tell me the same day what was offered');
    expect(txt).toContain('Yours sincerely');
    expect(txt).toContain('D. Kaleem');
    expect(txt).not.toMatch(/ignore/i);
    expect(txt).not.toMatch(/guarantee/i);
  });
});

describe('letter.supplier_instruction_engineer', () => {
  it('instructs the inspection with the §4.6 report contents, the fee and dated deadlines', () => {
    const txt = text(renderTemplate(engineerInstructionTemplate.id, engineerInstructionTemplate.sample()).html);
    expect(txt).toContain('Dear Mr A. Assessor MIMI,');
    expect(txt).toContain('AB12 CDE');
    expect(txt).toContain('WVWZZZAUZLW000000');
    expect(txt).toContain('38,420 miles');
    expect(txt).toContain('inspect the vehicle physically by Friday 9 October 2026');
    expect(txt).toContain('by Wednesday 14 October 2026');
    expect(txt).toContain('ADAS calibration');
    expect(txt).toContain('salvage category under the ABI Code of Practice');
    expect(txt).toContain('consistent with the circumstances');
    expect(txt).toContain('agreed at £285.00');
    expect(txt).toContain('rear parking sensors and any rear camera');
    expect(txt).toContain('independent opinion');
    expect(txt).not.toContain('CPR Part 35');
  });

  it('adds the CPR 35 / PD 35 requirements and the small claims cap when the report is for court', () => {
    const txt = text(renderTemplate(engineerInstructionTemplate.id, { ...engineerInstructionTemplate.sample(), forCourt: true }).html);
    expect(txt).toContain('CPR Part 35 and Practice Direction 35');
    expect(txt).toContain('duty to the court');
    expect(txt).toContain('PD 35 paragraph 3.3');
    expect(txt).toContain('CPR 27.5');
    expect(txt).toContain('£750 per expert');
  });
});
