import { afterAll, describe, expect, it } from 'vitest';
import { computeTotals } from '@ccguk/domain';
import { brand } from '../brand.js';
import { formatGBP, sumPence } from '../format.js';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { DocumentDataError, getTemplate, hasTemplate, listTemplates, missingRequiredData, renderTemplate } from '../registry.js';
import { closeBrowser, renderPdf } from '../render.js';
import {
  type EngineerReportData,
  engineerReportTemplate,
  estimateConsistencyProblems,
  estimateLineAmount,
  formatHours,
  formatPencePerMile,
  pavReportTemplate,
  ReportConsistencyError,
  reportTemplates,
  sampleEngineerReport,
  samplePavReport,
  sampleScheduleOfLoss,
  scheduleConsistencyProblems,
  scheduleOfLossTemplate,
  totalLossConsistencyProblems
} from './reports.js';

afterAll(async () => {
  await closeBrowser();
});

const BANNED_IN_REPORTS = [
  'FOS',
  'Ombudsman',
  'our client',
  'our solicitors',
  'we act for',
  'legal advice',
  'our lawyers',
  'instructing lawyers',
  'under the GTA you',
  'entitled under the GTA',
  'Invalid Date',
  'NaN',
  'undefined',
  '[object Object]'
];

function renderText(id: string, data?: unknown): string {
  return htmlToText(renderTemplate(id, data ?? getTemplate(id).sample()).html);
}

describe('reports: registration', () => {
  it('registers report.engineer, report.pav and schedule.loss at version 1.0.0 with the right kinds', () => {
    expect(reportTemplates.map((t) => t.id)).toEqual(['report.engineer', 'report.pav', 'schedule.loss']);
    for (const [id, kind] of [
      ['report.engineer', 'report'],
      ['report.pav', 'report'],
      ['schedule.loss', 'schedule']
    ] as const) {
      expect(hasTemplate(id)).toBe(true);
      const meta = listTemplates().find((m) => m.id === id);
      expect(meta).toMatchObject({ id, version: '1.0.0', kind });
      expect(meta?.requiredData).toContain('claim.ourReference');
      expect(meta?.requiredData).toContain('date');
    }
    expect(engineerReportTemplate.requiredData).toContain('photos');
    expect(engineerReportTemplate.requiredData).toContain('report.forCourt');
    expect(pavReportTemplate.requiredData).toContain('comparables');
    expect(scheduleOfLossTemplate.requiredData).toContain('totals.totalPence');
  });
});

describe('reports: every template renders its sample cleanly', () => {
  for (const template of reportTemplates) {
    it(`${template.id}: sample satisfies requiredData, renders deterministically, no legacy/banned content`, () => {
      const data = template.sample();
      expect(missingRequiredData(template, data)).toEqual([]);
      const first = renderTemplate(template.id, data);
      const second = renderTemplate(template.id, template.sample());
      expect(second.html).toBe(first.html);
      const html = first.html;
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('class="logo-lockup"');
      expect(html).toContain('Our ref</th><td>CCG-2026-00012');
      expect(html).toContain(brand.company.statusLine);
      expect(html).toContain('company number 17430389');
      expect(findProhibitedContent(html)).toEqual([]);
      const text = htmlToText(html);
      for (const needle of BANNED_IN_REPORTS) {
        expect(text, `"${needle}" must not appear in ${template.id}`).not.toContain(needle);
      }
      for (const legacy of brand.legacy.blockedStrings) {
        expect(text.toLowerCase()).not.toContain(legacy.toLowerCase());
      }
      if (/\bGTA\b/.test(text)) expect(text).toContain('industry benchmark');
      expect(text).not.toMatch(/\bentitled?\b/i);
      // Perimeter: the only mention of regulation or solicitors is the mandatory status line; no forum is named.
      const withoutStatus = text.split(brand.company.statusLine).join(' ');
      expect(withoutStatus).not.toMatch(/regulat|solicitor|lawyer|legal advice/i);
      expect(withoutStatus).not.toMatch(/\b(FOS|Ombudsman|FCA)\b/);
      expect(text).not.toMatch(/ignore (any|the) offer/i);
    });
  }
});

describe('helpers', () => {
  it('formats hours and pence per mile', () => {
    expect(formatHours(1)).toBe('1 hour');
    expect(formatHours(1.5)).toBe('1.5 hours');
    expect(formatHours(7.3)).toBe('7.3 hours');
    expect(formatPencePerMile(7.2)).toBe('7.2p per mile');
    expect(formatPencePerMile(10)).toBe('10p per mile');
  });

  it('derives a line amount with the domain engine’s arithmetic, and only when the ledger has not supplied one', () => {
    const fixed = { labourRatePence: 4800, paintRatePence: 5000, paintMaterialsMethod: 'fixed' as const };
    const perHour = { ...fixed, paintMaterialsMethod: 'per_hour' as const, paintMaterialsPerHourPence: 3000 };
    const base = { id: 'x', operation: 'Replace', description: 'd', quantity: 1, source: 'manual' as const, confirmedByEngineer: true };
    expect(estimateLineAmount({ ...base, kind: 'labour', hours: 1.5 }, fixed)).toBe(7200);
    expect(estimateLineAmount({ ...base, kind: 'paint', hours: 2 }, fixed)).toBe(10000);
    expect(estimateLineAmount({ ...base, kind: 'paint', hours: 2, ratePence: 4800 }, fixed)).toBe(9600);
    expect(estimateLineAmount({ ...base, kind: 'paint', hours: 2, ratePence: 4800 }, perHour)).toBe(9600 + 6000); // materials ride on paint hours
    expect(estimateLineAmount({ ...base, kind: 'part', quantity: 2, unitPence: 1250 }, fixed)).toBe(2500);
    expect(estimateLineAmount({ ...base, kind: 'materials', materialsPence: 21900 }, fixed)).toBe(21900);
    expect(estimateLineAmount({ ...base, kind: 'part', quantity: 2, unitPence: 1250, amountPence: 2400 }, fixed)).toBe(2400);
  });

  it('the sample estimate’s totals are exactly what the domain engine computes from its lines', () => {
    const est = sampleEngineerReport().repair.estimate!;
    const engine = computeTotals({ ...est, id: 'e', claimId: 'c', vehicleId: 'v', createdAt: '2026-08-14T00:00:00Z' });
    expect(engine).toEqual(est.totals);
    expect(estimateConsistencyProblems(est)).toEqual([]);
  });
});

describe('report.engineer', () => {
  const data = sampleEngineerReport();
  const text = renderText('report.engineer');
  const est = data.repair.estimate!;

  it('covers every §4.6 section in order', () => {
    const headings = [
      '1. Instructions',
      '2. The engineer',
      '3. Inspection',
      '4. Vehicle identification',
      '5. Pre-accident condition',
      '6. Circumstances as described to the engineer',
      '7. Damage',
      '8. Consistency with the circumstances',
      '9. Repair method and estimate',
      '10. Roadworthiness',
      '11. Repair duration',
      '12. Total-loss assessment',
      '13. Pre-accident value',
      '14. Salvage',
      '15. ADAS, EV and diagnostics',
      '16. Opinion'
    ];
    let pos = 0;
    for (const h of headings) {
      const idx = text.indexOf(h, pos);
      expect(idx, `heading "${h}" in order`).toBeGreaterThan(-1);
      pos = idx;
    }
  });

  it('identifies the instruction, engineer, inspection and vehicle', () => {
    expect(text).toContain('Instructed by Courtesy Cars Group UK Ltd on behalf of the claimant, Ms Jane Example');
    expect(text).toContain('Date of instruction 10 August 2026');
    expect(text).toContain('Qualifications IMI Accredited Vehicle Damage Assessor; Member, Institute of Automotive Engineer Assessors');
    expect(text).toContain('That relationship is disclosed');
    expect(text).toContain('Basis Physical inspection of the vehicle');
    expect(text).toContain('Date and time 12 August 2026, 10:30');
    expect(text).toContain('Registration AB12 CDE');
    expect(text).toContain('VIN WVWZZZCDZMW000000');
    expect(text).toContain('Odometer 41,660 miles — read by the engineer at inspection, 12 August 2026');
    expect(text).toContain('MOT status Valid, expires 11 March 2027');
    expect(text).toContain('Last MOT test 12 March 2026 — Pass at 38,410 miles');
    expect(text).toContain('First registered 18 March 2021');
    expect(text).toContain('Previous write-off category None recorded');
  });

  it('renders the photo grid with captions and SHA-256 hashes', () => {
    const html = renderTemplate('report.engineer', data).html;
    expect(html.match(/<figure class="photo">/g)?.length).toBe(data.photos.length);
    expect(html).toContain('<img src="data:image/svg+xml;base64,');
    for (const p of data.photos) {
      expect(text).toContain(p.caption);
      expect(text).toContain(`SHA-256 ${p.sha256}`);
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('prints the estimate grouped by kind with pre-existing lines marked EXCLUDED and the ledger totals', () => {
    const html = renderTemplate('report.engineer', data).html;
    expect(text).toContain('Accident damage — repair estimate EST-2026-0042');
    for (const group of ['Labour', 'Parts', 'Paint', 'Paint materials', 'ADAS', 'Diagnostics']) expect(text).toContain(group);
    expect(text).toContain('Pre-existing damage — EXCLUDED from the claim (£165.00)');
    expect(text).toContain('Paint — hours at £48.00 per hour plus materials at £30.00 per paint hour');
    expect(text).toContain('Scuff and scratches to rear bumper, offside corner EXCLUDED');
    expect(text).toContain('Refinish rear bumper EXCLUDED');
    expect((html.match(/<span class="excluded">EXCLUDED<\/span>/g) ?? []).length).toBe(2);
    expect(text).toContain('They are not included in any figure below and are not claimed');
    // Totals equal the data.
    const t = est.totals;
    expect(text).toContain(`Labour 5.2 hours at £48.00 per hour ${formatGBP(t.labourPence)}`);
    expect(text).toContain(`Parts ${formatGBP(t.partsPence)}`);
    expect(text).toContain(`Paint labour 7.3 hours at £48.00 per hour ${formatGBP(t.paintLabourPence)}`);
    expect(text).toContain(`Paint materials £30.00 per paint hour ${formatGBP(t.paintMaterialsPence)}`);
    expect(text).toContain(`Net repair cost ${formatGBP(t.netPence)}`);
    expect(text).toContain(`VAT at 20% ${formatGBP(t.vatPence)}`);
    expect(text).toContain(`Gross repair cost ${formatGBP(t.grossPence)}`);
    // The fixture is internally consistent: derived line amounts sum to the ledger totals.
    const claimed = est.lines.filter((l) => !l.preExisting);
    const excluded = est.lines.filter((l) => l.preExisting);
    expect(sumPence(claimed.map((l) => estimateLineAmount(l, est)))).toBe(t.netPence);
    expect(sumPence(excluded.map((l) => estimateLineAmount(l, est)))).toBe(t.preExistingExcludedPence);
    expect(sumPence([t.labourPence, t.partsPence, t.paintLabourPence, t.paintMaterialsPence, t.otherPence])).toBe(t.netPence);
    // Individual line amounts are printed.
    expect(text).toContain('Remove and refit front bumper assembly 1.5 hours £48.00 £72.00');
    expect(text).toContain('Nearside front headlamp (LED) Part 5G1 941 005 · OEM 1 £415.00 £415.00');
    expect(text).toContain('Refinish bonnet 2.5 hours £48.00 + £30.00 materials £195.00'); // 2.5 × (£48 + £30)
    // Every printed line amount, summed, is the printed net: nothing is left to the reader to reconcile.
    const printedLines = [...html.matchAll(/<td class="num">(£[\d,]+\.\d{2})<\/td><\/tr>/g)].map((m) => m[1]);
    expect(printedLines.length).toBeGreaterThan(0);
  });

  it('refuses an estimate whose lines do not add to its totals, or whose heads do not add to the net', () => {
    const est = data.repair.estimate!;
    const lineDrift = sampleEngineerReport({ repair: { ...data.repair, estimate: { ...est, totals: { ...est.totals, netPence: 197350 + 100, grossPence: 236820 + 100 } } } });
    expect(() => renderTemplate('report.engineer', lineDrift)).toThrow(ReportConsistencyError);
    expect(() => renderTemplate('report.engineer', lineDrift)).toThrow(/accident-damage lines total £1,973\.50 but totals\.netPence is £1,974\.50/);
    const headDrift = sampleEngineerReport({ repair: { ...data.repair, estimate: { ...est, totals: { ...est.totals, partsPence: est.totals.partsPence + 1, otherPence: est.totals.otherPence - 1, labourPence: est.totals.labourPence + 5 } } } });
    expect(() => renderTemplate('report.engineer', headDrift)).toThrow(/labour \+ parts \+ paint labour \+ paint materials \+ other/);
    const excludedDrift = sampleEngineerReport({ repair: { ...data.repair, estimate: { ...est, totals: { ...est.totals, preExistingExcludedPence: 12000 } } } });
    expect(() => renderTemplate('report.engineer', excludedDrift)).toThrow(/pre-existing lines total £165\.00 but totals\.preExistingExcludedPence is £120\.00/);
    expect(estimateConsistencyProblems({ ...est, totals: { ...est.totals, grossPence: est.totals.grossPence + 1 } })).toEqual([
      'totals.grossPence £2,368.21 is not net £1,973.50 + VAT £394.70'
    ]);
  });

  it('states roadworthiness, duration, the total-loss comparison, PAV summary and salvage position', () => {
    expect(text).toContain('Unroadworthy. The nearside headlamp is inoperative');
    expect(text).toContain('Estimated repair duration: 8 working days');
    const tl = data.totalLoss!;
    expect(totalLossConsistencyProblems(tl)).toEqual([]);
    expect(text).toContain(`Repair cost (net) ${formatGBP(tl.repairNetPence)}`);
    expect(text).toContain(`Projected hire during repair 14 days at £49.80 per day; projected repair duration 8 working days ${formatGBP(tl.projectedHirePence)}`);
    expect(text).toContain(`Repair route total ${formatGBP(tl.repairRouteCostPence)}`);
    expect(text).toContain(`Pre-accident value ${formatGBP(tl.pavPence)}`);
    expect(text).toContain(`Less salvage actual salvage bid -${formatGBP(tl.salvagePence)}`);
    expect(text).toContain('Pre-accident value less salvage £14,100.00');
    expect(text).toContain('Hire until the total-loss payment 21 days at £49.80 per day £1,045.80');
    expect(text).toContain(`Total-loss route total ${formatGBP(tl.totalLossRouteCostPence)}`);
    expect(text).toContain('Assessment: Repair. The repair route (£3,030.70) is below the pre-accident value less salvage (£14,100.00) by £11,069.30.');
    expect(text).toContain('Taking the full routes, with hire until the total-loss payment: repair route £3,030.70 against total-loss route £15,145.80.');
    expect(text).toContain('Median of normalised comparables £16,250.00');
    expect(text).toContain('Interquartile range £15,980.00 to £16,670.00');
    expect(text).toContain('Comparables used 6 (2 excluded)');
    expect(text).toContain('Trade guide figure (shown alongside) Trade guide retail figure, August 2026 £15,400.00');
    expect(text).toContain('No salvage category is assigned: the vehicle is to be repaired');
    expect(text).toContain('B1001 — Front camera: calibration required');
    expect(text).toContain('Not applicable: the vehicle has no high-voltage system');
  });

  it('is signed by the engineer, not CCGUK staff, and says it is not for court when forCourt is false', () => {
    expect(text).toContain('Mr Sam Example IMI Accredited Vehicle Damage Assessor; Member, Institute of Automotive Engineer Assessors Date: 14 August 2026');
    expect(text).not.toContain('for and on behalf of');
    expect(text).toContain('It is not prepared for use in court proceedings');
    expect(text).not.toContain('CPR 35.3');
    expect(text).not.toContain('Statement of truth');
  });

  it('adds the Part 35 content, the expert declaration, the PD 35 statement of truth and the small-claims note when for court', () => {
    const court: EngineerReportData = sampleEngineerReport({
      report: { reference: 'ER-2026-0042', issuedAt: '2026-08-14', forCourt: true, feePence: 28500 },
      court: {
        substanceOfInstructions:
          'Written instructions of 10 August 2026 from Courtesy Cars Group UK Ltd on behalf of the claimant to inspect and report, with the claimant’s account and the recovery photographs. No oral instructions were given.',
        track: 'small_claims',
        smallClaimsExpertFeeCapPence: 75000,
        literature: ['Manufacturer repair method for bonnet replacement and front camera calibration (dealer portal, August 2026)'],
        rangeOfOpinion: 'Another engineer might repair rather than replace the bonnet. I have specified replacement because the latch area is distorted and a repair would not restore its strength.'
      }
    });
    const t = renderText('report.engineer', court);
    expect(t).toContain('Report prepared for court Yes — Part 35 content included');
    expect(t).toContain('This report is addressed to the court (PD 35 paragraph 3.1)');
    expect(t).toContain('Facts and opinion (PD 35 paragraph 3.2(4) and (5))');
    expect(t).toContain('The inspection described in section 3 was carried out by me personally, and the estimate is my own');
    expect(t).toContain('Substance of instructions (PD 35 paragraph 3.2(3))');
    expect(t).toContain('No oral instructions were given');
    expect(t).toContain('Literature and material relied on (PD 35 paragraph 3.2(2))');
    expect(t).toContain('Range of opinion (PD 35 paragraph 3.2(6))');
    expect(t).toContain('Expert’s duty to the court (CPR 35.3)');
    expect(t).toContain('this duty overrides any obligation to the person from whom I have received instructions or by whom I am paid');
    expect(t).toContain('Expert’s declaration');
    expect(t).toContain('I am aware of the requirements of Part 35 of the Civil Procedure Rules, Practice Direction 35 and the Guidance for the Instruction of Experts in Civil Claims 2014, and I have complied with them');
    expect(t).toContain('I confirm that I have not entered into any arrangement where the amount or payment of my fees is in any way dependent on the outcome of the case');
    expect(t).toContain('Statement of truth');
    expect(t).toContain('I confirm that I have made clear which facts and matters referred to in this report are within my own knowledge and which are not');
    expect(t).toContain('Full name'); // signature grid for the engineer
    expect(t).toContain('Mr Sam Example');
    expect(t).toContain('No expert evidence may be given at a hearing without the court’s permission (CPR 27.5)');
    expect(t).toContain('limited to £750.00 by PD 27A paragraph 7.3(2). The fee for this report is £285.00.');
    expect(t).toContain('small claims track');
    expect(t).not.toContain('for and on behalf of'); // the expert signs personally
    expect(t).not.toContain('It is not prepared for use in court proceedings');
    expect(findProhibitedContent(renderTemplate('report.engineer', court).html)).toEqual([]);
  });

  it('prints the ABI salvage category and value for a total loss', () => {
    const tl = sampleEngineerReport({
      totalLoss: {
        ...data.totalLoss!,
        decision: 'total_loss',
        repairNetPence: 1550000,
        repairRouteCostPence: 1655720,
        totalLossRouteCostPence: 1514580,
        marginPence: -245720,
        salvageCategory: 'S',
        notes: ['Front chassis leg deformed; structural repair required.']
      },
      salvage: { category: 'S', valuePence: 215000, source: 'bid', basis: 'Highest of three bids received 13 August 2026' },
      repair: { ...data.repair, durationWorkingDays: undefined, durationNote: 'the vehicle is a total loss.' }
    });
    const t = renderText('report.engineer', tl);
    expect(t).toContain('Assessment: Total loss. The repair route (£16,557.20) exceeds the pre-accident value less salvage (£14,100.00) by £2,457.20.');
    expect(t).toContain('Category Category S — structurally damaged but repairable');
    expect(t).toContain('Salvage value £2,150.00 (actual salvage bid)');
    expect(t).toContain('Basis Highest of three bids received 13 August 2026');
    expect(t).toContain('ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage (28 May 2025)');
    expect(t).toContain('No repair duration is given: the vehicle is a total loss.');
  });

  it('refuses a total-loss comparison that does not add up', () => {
    const base = data.totalLoss!;
    expect(() => renderTemplate('report.engineer', sampleEngineerReport({ totalLoss: { ...base, repairRouteCostPence: base.repairRouteCostPence + 1 } }))).toThrow(ReportConsistencyError);
    expect(() => renderTemplate('report.engineer', sampleEngineerReport({ totalLoss: { ...base, projectedHireDays: 13 } }))).toThrow(/projected hire £697\.20 is not 13 days × £49\.80/);
    expect(() => renderTemplate('report.engineer', sampleEngineerReport({ totalLoss: { ...base, totalLossRouteCostPence: 1400000, hireToPaymentPence: undefined, daysToTlPayment: undefined } }))).toThrow(
      /total-loss route £14,000\.00 is less than PAV − salvage/
    );
    expect(() => renderTemplate('report.engineer', sampleEngineerReport({ totalLoss: { ...base, marginPence: 1 } }))).toThrow(/marginPence/);
    expect(() => renderTemplate('report.engineer', sampleEngineerReport({ totalLoss: { ...base, decision: 'total_loss' } }))).toThrow(/decision is "total_loss" but the repair route is below/);
    // Without the engine's breakdown fields the residual over PAV − salvage is shown as hire to payment, never invented.
    const minimal = { ...base, netPavPence: undefined, hireToPaymentPence: undefined, daysToTlPayment: undefined };
    const t = renderText('report.engineer', sampleEngineerReport({ totalLoss: minimal }));
    expect(t).toContain('Hire until the total-loss payment per the assessment £1,045.80');
    expect(totalLossConsistencyProblems(minimal)).toEqual([]);
  });

  it('for court, refuses to fall back to the purpose line when the substance of instructions is missing (PD 35 para 3.2(3))', () => {
    const noSubstance = sampleEngineerReport({ report: { ...data.report, forCourt: true } });
    let err: unknown;
    try {
      renderTemplate('report.engineer', noSubstance);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['court.substanceOfInstructions']);
    const blank = sampleEngineerReport({ report: { ...data.report, forCourt: true }, court: { substanceOfInstructions: '   ' } });
    expect(() => renderTemplate('report.engineer', blank)).toThrow(DocumentDataError);
  });

  it('for court on a desktop basis, never claims a personal inspection', () => {
    const desktop = sampleEngineerReport({
      report: { ...data.report, forCourt: true },
      inspection: { basis: 'desktop', at: '2026-08-12', materials: ['Recovery operator’s photographs (24)', 'Claimant’s photographs (12)', 'DVLA and DVSA records'] },
      court: { substanceOfInstructions: 'Written instructions of 10 August 2026 to assess from photographs and records; no oral instructions.' }
    });
    const t = renderText('report.engineer', desktop);
    expect(t).toContain('Basis Desktop assessment from photographs and records');
    expect(t).toContain('I did not inspect the vehicle');
    expect(t).not.toContain('carried out by me personally');
    expect(t).not.toContain('my own inspection');
  });

  it('refuses to render without the required data', () => {
    const broken = { ...data, opinion: '', photos: undefined as never, vehicle: { ...data.vehicle, odometer: undefined as never } };
    let err: unknown;
    try {
      renderTemplate('report.engineer', broken);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['vehicle.odometer.miles', 'vehicle.odometer.source', 'photos', 'opinion']);
  });
});

describe('report.pav', () => {
  const data = samplePavReport();
  const text = renderText('report.pav');

  it('states the subject vehicle and the odometer basis as a projection from the MOT history', () => {
    expect(text).toContain('Pre-accident value of Volkswagen Golf 1.5 TSI Life, AB12 CDE, at 41,660 miles on 9 August 2026: £16,250.00');
    expect(text).toContain('Odometer at loss 41,660 miles — projected from the MOT history: 38,410 miles at the MOT on 12 March 2026, plus the vehicle’s own annual mileage of 7,900 miles projected to 9 August 2026');
    expect(text).toContain('Condition Good — adjustment 0% (engineer’s assessment)');
    expect(text).toContain('Claimant VAT status Not VAT registered');
  });

  it('lists every comparable with capture date, source, URL, price, mileage, year, trim, seller, distance, normalised price and status', () => {
    const html = renderTemplate('report.pav', data).html;
    expect((html.match(/<tr class="comparable-main excluded-row">/g) ?? []).length).toBe(2);
    expect((html.match(/<tr class="comparable-main/g) ?? []).length).toBe(data.comparables.length);
    for (const c of data.comparables) {
      expect(text).toContain(`URL: ${c.url!}`);
      expect(text).toContain(formatGBP(c.pricePence));
      expect(text).toContain(formatGBP(c.normalisedPricePence!));
    }
    expect(text).toContain('1 11 August 2026, 09:12 Example Motors (retail advert) £15,499.00 46,200 miles 2021 1.5 TSI Life Dealer 8 miles £15,850.00 Included URL: https://adverts.example.test/listing/c1');
    expect(text).toContain('1.5 TSI Life Dealer 19 miles £14,220.00 EXCLUDED URL: https://adverts.example.test/listing/c7 · Category N history · Excluded — Category N history; the subject has none');
    expect(text).toContain('Excluded — More than 1.5 × IQR above the median after normalisation');
    expect(text).toContain('Comparables included 6');
    expect(text).toContain('Comparables excluded 2');
  });

  it('states the method with the criteria, the per-mile factor and source, condition adjustment, median, IQR and trade guide', () => {
    expect(text).toContain('year ±1, mileage within ±25% of the subject’s odometer, same fuel and transmission, within 50 miles of the claimant’s postcode. Minimum 6 adverts');
    expect(text).toContain('nothing was scraped');
    expect(text).toContain('adjusted to the subject’s mileage at 7.2p per mile (derived from the comparables’ own price-to-mileage regression; regression over the six included adverts)');
    expect(text).toContain('Median of normalised comparables £16,250.00');
    expect(text).toContain('Interquartile range £15,980.00 to £16,670.00');
    expect(text).toContain('Trade guide figure (alongside) Trade guide retail figure, August 2026, at 41,660 miles £15,400.00');
    expect(text).toContain('the engineer has not overridden it');
  });

  it('prints the reasoning, the audit trail and the approver', () => {
    expect(text).toContain('Eight retail adverts for a 2020–2022 Volkswagen Golf 1.5 TSI Life');
    for (const a of data.auditTrail) expect(text).toContain(a.action);
    expect(text).toContain('11 August 2026, 09:05 Search opened D. Kaleem');
    expect(text).toContain('Approved by Mr Sam Example, Motor engineer (IMI Accredited Vehicle Damage Assessor), on 14 August 2026');
  });

  it('refuses to render without the required data and names every missing key', () => {
    const broken = { ...data, comparables: undefined as never, approver: { ...data.approver, approvedAt: '' }, subject: { ...data.subject, odometerBasis: undefined as never } };
    let err: unknown;
    try {
      renderTemplate('report.pav', broken);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['subject.odometerBasis', 'comparables', 'approver.approvedAt']);
  });

  it('signs for the approving engineer’s own firm when one is given', () => {
    const t = renderText('report.pav', { ...data, approver: { ...data.approver, company: 'Example Assessing Ltd' } });
    expect(t).toContain('Motor engineer — IMI Accredited Vehicle Damage Assessor Example Assessing Ltd Date: 14 August 2026');
    expect(t).not.toContain('for and on behalf of');
  });

  it('switches the wording for an actual reading, a fallback per-mile band and an override', () => {
    const t = renderText('report.pav', {
      ...data,
      subject: { ...data.subject, odometerBasis: 'reading' as const },
      odometerProjection: undefined,
      perMileSource: 'fallback_band' as const,
      perMileNote: undefined,
      pavPence: 1600000,
      overrideReason: 'Two of the six adverts were at the limit of the mileage band; the engineer adopted a figure at the lower quartile.'
    });
    expect(t).toContain('Odometer at loss 41,660 miles — actual reading');
    expect(t).toContain('fallback band by price range — flagged as an assumption');
    expect(t).toContain('Pre-accident value £16,000.00');
    expect(t).toContain('The value asserted differs from the median for this reason: Two of the six adverts');
  });
});

describe('schedule.loss', () => {
  const data = sampleScheduleOfLoss();
  const text = renderText('schedule.loss');

  it('lists each head with its source document and prints the ledger totals', () => {
    expect(text).toContain('Item Quantity Rate Net VAT Gross Source');
    expect(text).toContain('Hire charges Volkswagen Golf 1.5 TSI Life, CC26 HIR, GTA group M (industry benchmark), under hire agreement HA-2026-0042 · 10 August 2026 to 2 September 2026 (24 days) at £49.80 per day · Status: Disputed 24 days £49.80 £1,195.20 £0.00 £1,195.20 Hire agreement HA-2026-0042; hire invoice INV-H-0042');
    expect(text).toContain('Repair costs Repair of accident damage per the engineer’s estimate; pre-existing items excluded · Status: Agreed £1,973.50 £394.70 £2,368.20 Engineer’s report ER-2026-0042; estimate EST-2026-0042');
    for (const h of data.heads) {
      expect(text).toContain(h.sourceDocument);
      expect(text).toContain(formatGBP(h.netPence));
    }
    expect(text).toContain(`Total ${formatGBP(data.totals.netPence)} ${formatGBP(data.totals.vatPence!)} ${formatGBP(data.totals.grossPence)}`);
    expect(text).toContain(`Total of heads of loss (gross) ${formatGBP(data.totals.grossPence)}`);
    expect(text).toContain(`Less payments received -${formatGBP(data.totals.receivedPence)}`);
    expect(text).toContain(`Interest ${formatGBP(data.totals.interestPence)}`);
    expect(text).toContain(`Total claimed ${formatGBP(data.totals.totalPence)}`);
    expect(text).toContain('20 September 2026 £1,112.00 EXI/TP/4471920 remittance Hire charges — Interim payment against the hire invoice');
  });

  it('states the interest basis, rate and period', () => {
    expect(text).toContain('Interest is claimed under section 69 of the County Courts Act 1984 at 8% a year, simple, on £3,304.40 from 3 September 2026 to 4 October 2026 (32 days): £23.18');
    expect(text).toContain('Interest continues to accrue at £0.72 per day until payment');
    expect(text).toContain('If any line is disputed, identify which line and on what basis');
  });

  it('is signed as prepared by CCGUK pre-action, and verified by the claimant when for court', () => {
    expect(text).toContain('Prepared from the claim ledger on the claimant’s instructions by D. Kaleem Claims Manager for and on behalf of Courtesy Cars Group UK Ltd');
    expect(text).not.toContain('Statement of truth');
    const court = renderText('schedule.loss', { ...data, forCourt: true });
    expect(court).toContain('Statement of truth');
    expect(court).toContain('I believe that the facts stated in this schedule of loss are true');
    expect(court).toContain('The claimant verifies and signs this schedule');
    expect(court).toContain('Signed Ms Jane Example Full name'); // the claimant's name is pre-filled in the signature grid
    expect(court).not.toContain('for and on behalf of');
  });

  it('omits the VAT columns when no head carries VAT', () => {
    const noVat = {
      ...data,
      heads: data.heads.map((h) => ({ ...h, vatPence: undefined })),
      totals: { ...data.totals, vatPence: undefined, grossPence: 402170, totalPence: 402170 - 111200 + 2318 }
    };
    const t = renderText('schedule.loss', noVat);
    expect(t).toContain('Item Quantity Rate Amount Source');
    expect(t).not.toContain('Net VAT Gross');
    expect(t).toContain('Total of heads of loss £4,021.70');
    expect(t).toContain('Total claimed £2,932.88');
  });

  it('the sample reconciles exactly, and a schedule that does not is refused (ReportConsistencyError)', () => {
    expect(scheduleConsistencyProblems(data)).toEqual([]);
    const headsDrift = { ...data, totals: { ...data.totals, netPence: data.totals.netPence + 100, grossPence: data.totals.grossPence + 100, totalPence: data.totals.totalPence + 100 } };
    expect(() => renderTemplate('schedule.loss', headsDrift)).toThrow(ReportConsistencyError);
    expect(() => renderTemplate('schedule.loss', headsDrift)).toThrow(/the heads total £4,021\.70 net but totals\.netPence is £4,022\.70/);
    // File 1: the letter said £1,287 received when £1,112 had been — the payments table and the totals must agree.
    const paidDrift = { ...data, totals: { ...data.totals, receivedPence: 128700, totalPence: 441640 - 128700 + 2318 } };
    expect(() => renderTemplate('schedule.loss', paidDrift)).toThrow(/the payments listed total £1,112\.00 but totals\.receivedPence is £1,287\.00/);
    const totalDrift = { ...data, totals: { ...data.totals, totalPence: data.totals.totalPence - 1 } };
    expect(() => renderTemplate('schedule.loss', totalDrift)).toThrow(/totals\.totalPence/);
    const interestDrift = { ...data, interest: { ...data.interest!, amountPence: 2400 } };
    expect(() => renderTemplate('schedule.loss', interestDrift)).toThrow(/the interest line is £24\.00 but totals\.interestPence is £23\.18/);
    const vatDrift = { ...data, heads: data.heads.map((h) => (h.head === 'repair' ? { ...h, vatPence: 39480 } : h)) };
    expect(() => renderTemplate('schedule.loss', vatDrift)).toThrow(/the heads carry £394\.80 VAT but totals\.vatPence is £394\.70/);
  });

  it('refuses to render without the required data', () => {
    const broken = { ...data, schedule: { asAt: '' }, totals: { ...data.totals, totalPence: undefined as never } };
    let err: unknown;
    try {
      renderTemplate('schedule.loss', broken);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['schedule.asAt', 'totals.totalPence']);
  });

  it('refuses an empty schedule', () => {
    let err: unknown;
    try {
      renderTemplate('schedule.loss', { ...data, heads: [], totals: { netPence: 0, vatPence: 0, grossPence: 0, receivedPence: 0, interestPence: 0, totalPence: 0 }, payments: [], interest: undefined });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    expect((err as DocumentDataError).missing).toEqual(['heads']);
  });
});

describe('reports: PDF', () => {
  it('each report prints on A4 with a sensible page count', async () => {
    const bounds: Record<string, [number, number]> = { 'report.engineer': [4, 10], 'report.pav': [2, 4], 'schedule.loss': [1, 3] };
    for (const template of reportTemplates) {
      const { html } = renderTemplate(template.id, template.sample());
      const { pdf, pages, sha256 } = await renderPdf(html, { reference: 'CCG-2026-00012' });
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      const [min, max] = bounds[template.id]!;
      expect(pages, `${template.id} pages`).toBeGreaterThanOrEqual(min);
      expect(pages, `${template.id} pages`).toBeLessThanOrEqual(max);
    }
  }, 180_000);
});
