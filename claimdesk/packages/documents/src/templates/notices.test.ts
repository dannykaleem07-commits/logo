import { describe, expect, it } from 'vitest';
import { brand } from '../brand.js';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { DocumentDataError, getTemplate, hasTemplate, listTemplates, missingRequiredData, renderTemplate } from '../registry.js';
import { statementOfLiabilityText } from './agreements-forms.js';
import { DriverNominationError, LiabilityTransferError, hireCoversInstant, noticeTemplates, pcnLiabilityTransferTemplate, s172ResponseTemplate, type S172ResponseData } from './notices.js';

const BANNED = ['our client', 'our solicitors', 'we act for', 'legal advice', 'our lawyers', 'Invalid Date', 'NaN', 'undefined', '[object Object]'];

function textOf(id: string): string {
  return htmlToText(renderTemplate(id, getTemplate(id).sample()).html);
}

describe('notices: registration', () => {
  it('registers both notices with kind notice (pcn 1.1.0, s172 1.0.0)', () => {
    expect(noticeTemplates.map((t) => t.id)).toEqual(['notice.pcn_liability_transfer', 'notice.s172_response']);
    for (const [id, version] of [['notice.pcn_liability_transfer', '1.1.0'], ['notice.s172_response', '1.0.0']] as const) {
      expect(hasTemplate(id)).toBe(true);
      expect(listTemplates().find((m) => m.id === id)).toMatchObject({ id, kind: 'notice', version });
      expect(listTemplates().find((m) => m.id === id)?.requiredData).toContain('ourReference');
    }
  });

  for (const template of noticeTemplates) {
    it(`${template.id}: sample satisfies requiredData, renders deterministically, carries the furniture and no banned content`, () => {
      const data = template.sample();
      expect(missingRequiredData(template, data)).toEqual([]);
      const first = renderTemplate(template.id, data);
      expect(renderTemplate(template.id, template.sample()).html).toBe(first.html);
      const html = first.html;
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('class="logo-lockup"');
      expect(html).toContain(`Our ref</th><td>${data.ourReference}`);
      expect(html).toContain(brand.company.statusLine);
      expect(html).toContain('company number 17430389');
      expect(html).toContain('for and on behalf of Courtesy Cars Group UK Ltd'); // the keeper signs
      expect(html).toContain('<ol class="numbered">');
      expect(findProhibitedContent(html)).toEqual([]);
      const text = htmlToText(html);
      for (const needle of BANNED) expect(text, `"${needle}" must not appear in ${template.id}`).not.toContain(needle);
      for (const legacy of brand.legacy.blockedStrings) expect(text.toLowerCase()).not.toContain(legacy.toLowerCase());
    });
  }
});

describe('notice.pcn_liability_transfer (council)', () => {
  const text = textOf('notice.pcn_liability_transfer');

  it('makes representations on the vehicle-hire ground with the Owner Liability Regulations Schedule 2 particulars', () => {
    expect(text).toContain('Notice to Owner EX12345678 — Volkswagen Golf 1.5 TSI Life, registration LK26 CCG');
    expect(text).toContain('We are the registered keeper of the vehicle and the recipient of the Notice to Owner.');
    expect(text).toContain('the hirer signed a statement of liability acknowledging liability for any penalty charge notice served during the hire');
    expect(text).toContain('Road Traffic (Owner Liability) Regulations 2000');
    expect(text).toContain('so it is a hiring agreement for the purposes of section 66 of the Road Traffic Offenders Act 1988');
    expect(text).toContain('Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022');
    expect(text).toContain('Hirer’s full name Ms Jane Example');
    expect(text).toContain('Date of birth 14 May 1988');
    expect(text).toContain('Permanent address 1 Example Street, Example Town, EX2 2BB');
    expect(text).toContain('Driving licence number EXAMP805148JE9AB');
    expect(text).toContain('Licence country of issue United Kingdom');
    expect(text).toContain('Licence expiry date 13 May 2031');
    expect(text).toContain('Vehicle registration mark LK26 CCG');
    expect(text).toContain('Hire began 10 August 2026, 09:30');
    expect(text).toContain('Hire ended 2 September 2026, 16:40');
    expect(text).toContain('Authorised extensions None');
  });

  it('dates the facts, quotes the signed statement of liability and encloses the agreement', () => {
    expect(text).toContain('The alleged contravention occurred at 21 August 2026, 11:42 at Market Street, Example Town, within the hire period.');
    expect(text).toContain(statementOfLiabilityText('Ms Jane Example', ['1 Example Street', 'Example Town', 'EX2 2BB']));
    expect(text).toContain('Signed by Ms Jane Example on 10 August 2026, 09:41.');
    expect(text).toContain('Copy of hire agreement CHA-2026-00012 containing the Schedule 2 particulars');
    expect(text).toContain('Amount stated £70.00');
  });

  it('numbers the requests, sets a date, and states the next step', () => {
    expect(text).toContain('Accept these representations and cancel the Notice to Owner EX12345678 as against Courtesy Cars Group UK Ltd.');
    expect(text).toContain('Serve any further notice on the hirer, Ms Jane Example, at the permanent address given in the particulars above.');
    expect(text).toContain('by Thursday 8 October 2026');
    expect(text).toContain('We will appeal to the adjudicator within 28 days of any notice of rejection');
    expect(text).not.toContain('Protection of Freedoms');
  });
});

describe('notice.pcn_liability_transfer (private parking, POFA Sch 4)', () => {
  const data = {
    ...pcnLiabilityTransferTemplate.sample(),
    kind: 'private' as const,
    recipient: { name: 'Example Parking Ltd', addressLines: ['PO Box 400', 'Example Town', 'EX5 5EE'] },
    notice: { ...pcnLiabilityTransferTemplate.sample().notice, noticeType: 'Notice to Keeper', issuer: 'Example Parking Ltd', number: 'EPL/0099123', amountPence: 10000 }
  };
  const text = htmlToText(renderTemplate('notice.pcn_liability_transfer', data).html);

  it('gives the paragraph 13 statement, agreement and statement of liability, and points the creditor to paragraph 14', () => {
    expect(text).toContain('under paragraph 13 of Schedule 4 to the Protection of Freedoms Act 2012');
    expect(text).toContain('We are therefore not liable for the parking charge as keeper.');
    expect(text).toContain('by a notice to hirer under paragraph 14');
    expect(text).toContain('as paragraph 13 of Schedule 4 requires');
    expect(text).not.toContain('13(2)');
    expect(text).toContain('Record that Courtesy Cars Group UK Ltd is not liable for the parking charge as keeper, and close the notice to keeper against us.');
    expect(text).toContain('Direct any notice to hirer to Ms Jane Example at the address for service above');
    expect(text).toContain('Amount stated £100.00');
    expect(text).not.toContain('adjudicator');
  });
});

describe('notice.pcn_liability_transfer: the hire must cover the contravention', () => {
  const sample = pcnLiabilityTransferTemplate.sample();

  it('refuses to transfer liability for a contravention outside the hire period', () => {
    const before = { ...sample, notice: { ...sample.notice, contraventionAt: '2026-08-10T09:00:00+01:00' } }; // 30 minutes before delivery
    expect(() => renderTemplate('notice.pcn_liability_transfer', before)).toThrow(LiabilityTransferError);
    const after = { ...sample, notice: { ...sample.notice, contraventionAt: '2026-09-02T17:00:00+01:00' } }; // 20 minutes after collection
    expect(() => renderTemplate('notice.pcn_liability_transfer', after)).toThrow(/falls outside hire CHA-2026-00012/);
  });

  it('accepts an open-ended hire and an authorised extension that covers the day', () => {
    const openEnded = { ...sample, hire: { ...sample.hire, endAt: undefined }, notice: { ...sample.notice, contraventionAt: '2026-11-30T08:00:00+00:00' } };
    const t = htmlToText(renderTemplate('notice.pcn_liability_transfer', openEnded).html);
    expect(t).toContain('Expected end of hire until the hirer’s own vehicle was repaired or a total-loss settlement was paid');
    const extended = { ...sample, hire: { ...sample.hire, extensions: [{ from: '2026-09-03', to: '2026-09-05' }] }, notice: { ...sample.notice, contraventionAt: '2026-09-04T12:00:00+01:00' } };
    expect(htmlToText(renderTemplate('notice.pcn_liability_transfer', extended).html)).toContain('Authorised extensions 3 September 2026 to 5 September 2026');
  });

  it('hireCoversInstant follows the record exactly', () => {
    const hire = sample.hire;
    expect(hireCoversInstant(hire, '2026-08-10T09:30:00+01:00')).toBe(true); // the first minute
    expect(hireCoversInstant(hire, '2026-09-02T16:40:00+01:00')).toBe(true); // the last minute
    expect(hireCoversInstant(hire, '2026-09-02T16:41:00+01:00')).toBe(false);
    expect(hireCoversInstant(hire, '2026-08-10T09:29:00+01:00')).toBe(false);
    expect(hireCoversInstant({ ...hire, endAt: undefined }, '2030-01-01T00:00:00Z')).toBe(true);
    expect(hireCoversInstant(hire, 'not a date')).toBe(false);
  });
});

describe('notice.s172_response', () => {
  const sample = s172ResponseTemplate.sample();

  it('will not nominate the hirer for an offence outside the hire period, but still gives the s.172(4) account for it', () => {
    const outside = { ...sample, notice: { ...sample.notice, offenceAt: '2026-09-03T08:14:00+01:00' } };
    expect(() => renderTemplate('notice.s172_response', outside)).toThrow(DriverNominationError);
    expect(() => renderTemplate('notice.s172_response', outside)).toThrow(/falls outside hire CHA-2026-00012/);
    const honest: S172ResponseData = {
      ...outside,
      cannotIdentify: true,
      driver: undefined,
      hire: undefined,
      recordsSearched: [{ record: 'Hire agreements for LK26 CCG', searchedOn: '2026-09-04', result: 'The last hire ended on 2 September 2026 at 16:40; no agreement covered 3 September 2026.' }]
    };
    const t = htmlToText(renderTemplate('notice.s172_response', honest).html);
    expect(t).toContain('We are unable to identify the driver');
    expect(t).not.toContain('Jane Example');
  });

  it('refuses a nameless driver record', () => {
    expect(() => renderTemplate('notice.s172_response', { ...sample, driver: { ...sample.driver!, name: '  ' } })).toThrow(DriverNominationError);
  });

  it('identifies the hirer from the hire records with the supporting agreement and the 28-day position', () => {
    const text = textOf('notice.s172_response');
    expect(text).toContain('section 172 of the Road Traffic Act 1988');
    expect(text).toContain('It is sent within the 28 days allowed, which end on Thursday 1 October 2026.');
    expect(text).toContain('the vehicle was on hire under agreement CHA-2026-00012, signed on 10 August 2026, 09:41');
    expect(text).toContain('Our records identify the following person as the hirer');
    expect(text).toContain('Full name Ms Jane Example');
    expect(text).toContain('Basis of identification The hirer under agreement CHA-2026-00012');
    expect(text).toContain('The hire agreement also permits Mr Tom Example to drive the vehicle. We have no record of which permitted driver was at the wheel');
    expect(text).toContain('We did not have possession of the vehicle at the time and have no direct knowledge of who was driving.');
    expect(text).toContain('Records searched');
    expect(text).toContain('Copy of hire agreement CHA-2026-00012');
    expect(text).not.toContain('reasonable diligence');
  });

  it('gives the s.172(4) reasonable-diligence account when the records do not identify the driver, naming no one', () => {
    const data: S172ResponseData = {
      ...sample,
      cannotIdentify: true,
      driver: undefined,
      hire: undefined,
      recordsSearched: [
        { record: 'Hire agreements for LK26 CCG', searchedOn: '2026-09-04', searchedBy: 'D. Kaleem', result: 'No hire agreement covered 25 August 2026; the vehicle was between hires and held at our yard.' },
        { record: 'Yard key log', searchedOn: '2026-09-04', result: 'Keys signed out at 07:50 on 25 August 2026 for a service run; the signature is illegible and no name was printed.' },
        { record: 'Telematics tracker', searchedOn: '2026-09-04', result: 'The unit was not fitted with a tracker in August 2026.' },
        { record: 'Agency driver timesheets', searchedOn: '2026-09-05', result: 'Two agency drivers were on site that morning; neither timesheet records the vehicle used.' }
      ],
      diligenceNote: 'Since 1 September 2026 every key movement is logged against a named driver and the unit has a tracker fitted, so the question is answerable for any future notice.',
      enclosures: ['Extract from the yard key log for 25 August 2026', 'Agency timesheets for 25 August 2026 (names redacted where not relevant)']
    };
    const text = htmlToText(renderTemplate('notice.s172_response', data).html);
    expect(text).toContain('We are unable to identify the driver of the vehicle at the time of the alleged offence.');
    expect(text).toContain('could not with reasonable diligence have ascertained who the driver was (section 172(4) of the Road Traffic Act 1988)');
    expect(text).toContain('Yard key log 4 September 2026');
    expect(text).toContain('Telematics tracker');
    expect(text).toContain('Agency driver timesheets 5 September 2026');
    expect(text).toContain('We have not named any person, because our records do not identify the driver');
    expect(text).toContain('Since 1 September 2026 every key movement is logged');
    expect(text).not.toContain('Jane Example');
    expect(text).not.toContain('Person identified');
  });

  it('refuses to render a driver name when cannotIdentify is true', () => {
    expect(() => renderTemplate('notice.s172_response', { ...sample, cannotIdentify: true })).toThrow(DriverNominationError);
    expect(() => renderTemplate('notice.s172_response', { ...sample, cannotIdentify: true })).toThrow(/may not nominate a person the records do not identify/);
  });

  it('refuses a nomination without the hire record, an identification without a driver, and a diligence account without records', () => {
    expect(() => renderTemplate('notice.s172_response', { ...sample, hire: undefined })).toThrow(DriverNominationError);
    expect(() => renderTemplate('notice.s172_response', { ...sample, driver: undefined })).toThrow(DriverNominationError);
    expect(() => renderTemplate('notice.s172_response', { ...sample, cannotIdentify: true, driver: undefined, hire: undefined, recordsSearched: [] })).toThrow(/records searched/);
  });

  it('treats cannotIdentify: false as present, not missing', () => {
    expect(missingRequiredData(s172ResponseTemplate, sample)).toEqual([]);
    let err: unknown;
    try {
      renderTemplate('notice.s172_response', { ...sample, cannotIdentify: undefined as never, responseDueBy: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['responseDueBy', 'cannotIdentify']);
  });
});
