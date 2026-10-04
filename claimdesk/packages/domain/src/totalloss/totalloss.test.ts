import { describe, it, expect } from 'vitest';
import type { EngineerReport, TotalLossPredictionInput } from '../types.js';
import { assessTotalLoss, projectedHireDays, workingDaysToCalendarDays } from './assess.js';
import { predictTotalLoss, sigmoid, TL_PREDICTOR_WEIGHTS } from './predict.js';
import { SALVAGE_CODE_PRINCIPLES, SALVAGE_CODE_VERIFICATION, describeSalvageCategory, salvageCategories, salvageCategoryAffectsPav } from './salvage.js';
import { engineerReportChecklist, SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE } from './checklist.js';

describe('assessTotalLoss', () => {
  it('converts working days to calendar days (×7/5, rounded up) and adds two handover days', () => {
    expect(workingDaysToCalendarDays(0)).toBe(0);
    expect(workingDaysToCalendarDays(1)).toBe(2);
    expect(workingDaysToCalendarDays(3)).toBe(5);
    expect(workingDaysToCalendarDays(5)).toBe(7);
    expect(workingDaysToCalendarDays(10)).toBe(14);
    expect(workingDaysToCalendarDays(15)).toBe(21);
    expect(projectedHireDays(15)).toBe(23);
    expect(projectedHireDays(15, 0)).toBe(21);
  });

  it('S1 at £42.32/day, storage £45/day: 15 working days of repair → total loss', () => {
    const a = assessTotalLoss({
      repairNetPence: 450_000,
      repairWorkingDays: 15,
      hireDailyRatePence: 4_232,
      storageDailyRatePence: 4_500,
      pavPence: 600_000,
      salvage: { pence: 90_000, source: 'bid', category: 'S' },
    });
    expect(a.repairCalendarDays).toBe(21);
    expect(a.projectedHireDays).toBe(23);
    expect(a.projectedHirePence).toBe(97_336); // 23 × £42.32
    expect(a.projectedStoragePence).toBe(94_500); // 21 × £45
    expect(a.repairRouteCostPence).toBe(641_836);
    expect(a.netPavPence).toBe(510_000);
    expect(a.daysToTlPayment).toBe(21);
    expect(a.hireToPaymentPence).toBe(88_872); // 21 × £42.32
    expect(a.totalLossRouteCostPence).toBe(598_872);
    expect(a.marginPence).toBe(-131_836);
    expect(a.marginPct).toBe(-25.85);
    expect(a.decision).toBe('total_loss');
    expect(a.salvageSource).toBe('bid');
    expect(a.salvageCategory).toBe('S');
    expect(a.notes[0]).toBe(
      'Repair route: repair £4,500.00 net, plus projected hire of 23 days (15 working days of repair = 21 calendar days, plus 2 handover days) at £42.32 per day = £973.36, plus storage of 21 days at £45.00 per day = £945.00. Repair route total £6,418.36.',
    );
    expect(a.notes[1]).toBe(
      'Total-loss route: PAV £6,000.00 less salvage £900.00 (an actual salvage bid, Cat S) = £5,100.00, plus hire until the total-loss payment, estimated at 21 days at £42.32 per day = £888.72. Total-loss route total £5,988.72.',
    );
    expect(a.notes[2]).toContain('repair plus hire plus storage £6,418.36 against PAV less salvage £5,100.00');
    expect(a.notes[2]).toContain('The repair route is £1,318.36 (25.85%) dearer. Decision: total loss.');
    expect(a.notes.some((n) => n.includes('no fixed salvage percentage has been applied'))).toBe(true);
  });

  it('the decision flips from repair to borderline to total loss as the repair period grows', () => {
    const base = { repairNetPence: 600_000, hireDailyRatePence: 6_000, pavPence: 1_000_000, salvage: { pence: 200_000, source: 'bid' as const } };
    const ten = assessTotalLoss({ ...base, repairWorkingDays: 10 });
    expect(ten.projectedHireDays).toBe(16);
    expect(ten.projectedHirePence).toBe(96_000);
    expect(ten.repairRouteCostPence).toBe(696_000);
    expect(ten.marginPence).toBe(104_000); // 13% of £8,000
    expect(ten.marginPct).toBe(13);
    expect(ten.decision).toBe('repair');
    expect(ten.notes[2]).toContain('The repair route is £1,040.00 (13%) cheaper. Decision: repair.');

    const twentyFive = assessTotalLoss({ ...base, repairWorkingDays: 25 });
    expect(twentyFive.projectedHireDays).toBe(37);
    expect(twentyFive.repairRouteCostPence).toBe(822_000);
    expect(twentyFive.marginPence).toBe(-22_000); // 2.75% → borderline
    expect(twentyFive.decision).toBe('borderline');
    expect(twentyFive.notes[2]).toContain('within 10% of PAV less salvage, so the decision is borderline');

    const forty = assessTotalLoss({ ...base, repairWorkingDays: 40 });
    expect(forty.projectedHireDays).toBe(58);
    expect(forty.repairRouteCostPence).toBe(948_000);
    expect(forty.marginPence).toBe(-148_000); // 18.5%
    expect(forty.decision).toBe('total_loss');
  });

  it('storage defaults to nil and the note says so', () => {
    const a = assessTotalLoss({ repairNetPence: 100_000, repairWorkingDays: 5, hireDailyRatePence: 5_000, pavPence: 800_000, salvage: { pence: 100_000, source: 'offer' } });
    expect(a.projectedStoragePence).toBe(0);
    expect(a.notes[0]).toContain('with no storage charged');
    expect(a.notes[1]).toContain('an actual salvage offer');
  });

  it('a salvage estimate is flagged for bids; Cat A/B cannot return to the road', () => {
    const a = assessTotalLoss({ repairNetPence: 100_000, repairWorkingDays: 5, hireDailyRatePence: 5_000, pavPence: 800_000, salvage: { pence: 100_000, source: 'estimate', category: 'B' } });
    expect(a.notes.some((n) => n.includes('Salvage is an estimate only. Obtain actual bids'))).toBe(true);
    expect(a.notes.some((n) => n.includes('Cat B salvage cannot return to the road'))).toBe(true);
  });

  it('salvage at or above PAV is a total loss whatever the repair cost', () => {
    const a = assessTotalLoss({ repairNetPence: 1, repairWorkingDays: 0, hireDailyRatePence: 0, pavPence: 100_000, salvage: { pence: 100_000, source: 'bid' } });
    expect(a.decision).toBe('total_loss');
    expect(a.marginPct).toBeNull();
    expect(a.notes[2]).toContain('so any repair spend exceeds it');
  });

  it('honours custom days to payment, handover days and borderline band', () => {
    const a = assessTotalLoss({
      repairNetPence: 600_000,
      repairWorkingDays: 25,
      hireDailyRatePence: 6_000,
      pavPence: 1_000_000,
      salvage: { pence: 200_000, source: 'bid' },
      daysToTlPaymentEstimate: 30,
      handoverDays: 0,
      borderlinePct: 2,
    });
    expect(a.hireToPaymentPence).toBe(180_000);
    expect(a.projectedHireDays).toBe(35);
    expect(a.marginPence).toBe(-10_000); // 1.25% → inside a 2% band
    expect(a.decision).toBe('borderline');
    const tight = assessTotalLoss({
      repairNetPence: 600_000,
      repairWorkingDays: 25,
      hireDailyRatePence: 6_000,
      pavPence: 1_000_000,
      salvage: { pence: 200_000, source: 'bid' },
      handoverDays: 0,
      borderlinePct: 1, // 1.25% is now outside the band
    });
    expect(tight.decision).toBe('total_loss');
  });

  it('rejects negative or non-finite inputs', () => {
    expect(() => assessTotalLoss({ repairNetPence: -1, repairWorkingDays: 1, hireDailyRatePence: 1, pavPence: 1, salvage: { pence: 0, source: 'bid' } })).toThrow(RangeError);
    expect(() => assessTotalLoss({ repairNetPence: 1, repairWorkingDays: Number.NaN, hireDailyRatePence: 1, pavPence: 1, salvage: { pence: 0, source: 'bid' } })).toThrow(RangeError);
  });
});

describe('predictTotalLoss', () => {
  const base: TotalLossPredictionInput = {
    vehicleAgeYears: 5,
    pavBandPence: 1_000_000,
    damageZones: ['front'],
    airbagsDeployed: false,
    structuralIndicators: ['none'],
    driveable: true,
  };

  it('baseline is the intercept only: probability 0.1192, low', () => {
    const p = predictTotalLoss(base);
    expect(p.score).toBe(-2);
    expect(p.probability).toBe(0.1192);
    expect(p.band).toBe('low');
    expect(p.calibrated).toBe(false);
    expect(p.note).toContain('calibrate on CCGUK outcomes once ≥100 files');
    expect(p.factors.map((f) => f.factor)).toEqual(['intercept', 'repair_to_pav_ratio']);
    expect(p.factors[1]!.weight).toBe(0);
  });

  it('is monotonic in structural indicators and caps at 2.5', () => {
    const probs = [
      predictTotalLoss({ ...base, structuralIndicators: [] }).probability,
      predictTotalLoss({ ...base, structuralIndicators: ['wheel_displaced'] }).probability,
      predictTotalLoss({ ...base, structuralIndicators: ['wheel_displaced', 'suspension'] }).probability,
      predictTotalLoss({ ...base, structuralIndicators: ['wheel_displaced', 'suspension', 'pillar'] }).probability,
      predictTotalLoss({ ...base, structuralIndicators: ['wheel_displaced', 'suspension', 'pillar', 'chassis_leg'] }).probability,
    ];
    for (let i = 1; i < probs.length; i += 1) expect(probs[i]!).toBeGreaterThanOrEqual(probs[i - 1]!);
    expect(probs[1]).toBeGreaterThan(probs[0]!);
    expect(probs[2]).toBeGreaterThan(probs[1]!);
    expect(probs[3]).toBeGreaterThan(probs[2]!);
    expect(probs[4]).toBe(probs[3]); // cap
    const capped = predictTotalLoss({ ...base, structuralIndicators: ['wheel_displaced', 'suspension', 'pillar'] });
    expect(capped.factors.find((f) => f.factor === 'structural_indicators')?.weight).toBe(2.5);
    expect(capped.factors.find((f) => f.factor === 'structural_indicators')?.note).toContain('capped at 2.5');
    // duplicates count once
    expect(predictTotalLoss({ ...base, structuralIndicators: ['pillar', 'pillar'] }).factors.find((f) => f.factor === 'structural_indicators')?.weight).toBe(1);
  });

  it('repair-to-PAV ratio is tiered: ≤60% nothing, >60% +1.2, >90% +2.0', () => {
    const w = (ratio: number): number => predictTotalLoss({ ...base, roughRepairPence: ratio * 1_000_000 }).factors.find((f) => f.factor === 'repair_to_pav_ratio')!.weight;
    expect(w(0.5)).toBe(0);
    expect(w(0.6)).toBe(0);
    expect(w(0.7)).toBe(TL_PREDICTOR_WEIGHTS.repairRatioOver60);
    expect(w(0.95)).toBe(TL_PREDICTOR_WEIGHTS.repairRatioOver90);
    expect(predictTotalLoss({ ...base, roughRepairPence: 950_000 }).score).toBe(0); // −2 + 2
  });

  it('age bands: >7 +0.3, >10 +0.6', () => {
    const w = (age: number): number | undefined => predictTotalLoss({ ...base, vehicleAgeYears: age }).factors.find((f) => f.factor === 'vehicle_age')?.weight;
    expect(w(7)).toBeUndefined();
    expect(w(8)).toBe(0.3);
    expect(w(10)).toBe(0.3);
    expect(w(11)).toBe(0.6);
  });

  it('airbags, not driveable, multiple zones, fluid leaks: score 2.6 → 0.9309 high', () => {
    const p = predictTotalLoss({
      ...base,
      airbagsDeployed: true,
      driveable: false,
      damageZones: ['front', 'nearside'],
      fluidLeaks: true,
      structuralIndicators: ['wheel_displaced', 'suspension'],
    });
    expect(p.score).toBe(2.6); // −2 + 0.8 + 0.7 + 0.6 + 0.5 + 2.0
    expect(p.probability).toBe(0.9309);
    expect(p.band).toBe('high');
    expect(p.factors.map((f) => f.factor)).toContain('multiple_zones');
  });

  it("'multiple' zone alone counts as multiple zones", () => {
    expect(predictTotalLoss({ ...base, damageZones: ['multiple'] }).factors.some((f) => f.factor === 'multiple_zones')).toBe(true);
    expect(predictTotalLoss({ ...base, damageZones: ['rear'] }).factors.some((f) => f.factor === 'multiple_zones')).toBe(false);
  });

  it('low PAV band under £3,000 adds 0.8', () => {
    const p = predictTotalLoss({ ...base, pavBandPence: 299_999 });
    expect(p.factors.find((f) => f.factor === 'low_pav_band')?.weight).toBe(0.8);
    expect(predictTotalLoss({ ...base, pavBandPence: 300_000 }).factors.some((f) => f.factor === 'low_pav_band')).toBe(false);
  });

  it('EV/hybrid adds 0.5 only with front or underside damage', () => {
    expect(predictTotalLoss({ ...base, isEvOrHybrid: true, damageZones: ['front'] }).factors.find((f) => f.factor === 'ev_battery_exposure')?.weight).toBe(0.5);
    expect(predictTotalLoss({ ...base, isEvOrHybrid: true, damageZones: ['underside'] }).factors.some((f) => f.factor === 'ev_battery_exposure')).toBe(true);
    expect(predictTotalLoss({ ...base, isEvOrHybrid: true, damageZones: ['rear'] }).factors.some((f) => f.factor === 'ev_battery_exposure')).toBe(false);
    expect(predictTotalLoss({ ...base, isEvOrHybrid: false, damageZones: ['front'] }).factors.some((f) => f.factor === 'ev_battery_exposure')).toBe(false);
  });

  it('bands: <0.35 low, <0.65 medium, else high', () => {
    // −2 + 1.2 + 0.6 = −0.2 → 0.4502 medium
    const medium = predictTotalLoss({ ...base, roughRepairPence: 700_000, damageZones: ['front', 'rear'] });
    expect(medium.probability).toBe(0.4502);
    expect(medium.band).toBe('medium');
    // −2 + 0.8 + 0.7 + 2.0 = 1.5 → 0.8176 high
    const high = predictTotalLoss({ ...base, airbagsDeployed: true, driveable: false, structuralIndicators: ['pillar', 'floor'] });
    expect(high.probability).toBe(0.8176);
    expect(high.band).toBe('high');
    expect(sigmoid(0)).toBe(0.5);
  });
});

describe('salvageCategories (ABI Code, 28 May 2025)', () => {
  it('has the four categories with the right repairability', () => {
    expect(Object.keys(salvageCategories).sort()).toEqual(['A', 'B', 'N', 'S']);
    expect(salvageCategories.A).toMatchObject({ code: 'A', name: 'Scrap', repairable: false, canReturnToRoad: false });
    expect(salvageCategories.B).toMatchObject({ code: 'B', name: 'Break', repairable: false, canReturnToRoad: false });
    expect(salvageCategories.S).toMatchObject({ code: 'S', repairable: true, canReturnToRoad: true });
    expect(salvageCategories.N).toMatchObject({ code: 'N', repairable: true, canReturnToRoad: true });
    expect(salvageCategories.S.name).toContain('Structurally damaged');
    expect(salvageCategories.N.name).toContain('Non-structurally damaged');
    expect(salvageCategories.N.description).toContain('not cost');
    for (const c of Object.values(salvageCategories)) expect(c.evNote.length).toBeGreaterThan(40);
  });
  it('carries the Code principles and an unverified Verification (never upgraded by code)', () => {
    expect(SALVAGE_CODE_VERIFICATION.status).toBe('unverified');
    expect(SALVAGE_CODE_PRINCIPLES.some((p) => p.includes('Appropriately Qualified Person'))).toBe(true);
    expect(SALVAGE_CODE_PRINCIPLES.some((p) => p.includes('not on the cost of repair'))).toBe(true);
    expect(SALVAGE_CODE_PRINCIPLES.some((p) => p.includes('never a fixed percentage'))).toBe(true);
  });
  it('describes a category with the EV note on request', () => {
    expect(describeSalvageCategory('N')).toMatch(/^Cat N \(Non-structurally damaged, repairable\): /);
    expect(describeSalvageCategory('N')).not.toContain('EV/hybrid');
    expect(describeSalvageCategory('N', true)).toContain('EV/hybrid');
    expect(salvageCategoryAffectsPav('S')).toBe(true);
    expect(salvageCategoryAffectsPav('A')).toBe(false);
    expect(salvageCategoryAffectsPav(undefined)).toBe(false);
  });
});

describe('engineerReportChecklist', () => {
  const complete: EngineerReport = {
    id: 'rep-1',
    claimId: 'claim-1',
    vehicleId: 'veh-1',
    engineerPartyId: 'eng-1',
    engineerQualifications: 'IAEA, IMI Accredited',
    instructedBy: 'Courtesy Cars Group UK Ltd',
    instructedAt: '2026-09-28T09:00:00Z',
    inspectionAt: '2026-09-30T10:00:00Z',
    inspectionPlace: 'CCGUK yard, London',
    inspectionBasis: 'physical',
    inspectionConditions: 'Dry, daylight, vehicle on level ground',
    odometerMiles: 48_120,
    preAccidentCondition: 'Good; full service history; minor stone chips to bonnet',
    damageDescription: 'Front impact: bumper, bonnet, NSF wing, headlamps, radiator support',
    consistentWithCircumstances: true,
    consistencyNote: 'Frontal damage at bumper height consistent with the described rear-end collision into a stationary vehicle',
    repairMethod: 'Replace bumper, bonnet, NSF wing; refinish; calibrate front camera',
    estimateId: 'est-1',
    roadworthy: false,
    roadworthyReason: 'Headlamps inoperative and radiator support displaced',
    repairDurationWorkingDays: 12,
    adasNotes: 'Front camera calibration required after windscreen/bumper work',
    evNotes: 'Not applicable (petrol)',
    photoEvidenceIds: ['ev-1', 'ev-2'],
    forCourt: false,
    feePence: 28_500,
  };

  it('passes a complete non-court report with advisory notes only', () => {
    const r = engineerReportChecklist(complete, { vehicle: { registration: 'AB19CDE', vin: 'WVWZZZ1KZAW000001', motExpiryDate: '2027-03-01' } });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.courtItemsChecked).toEqual([]);
    expect(r.notes.some((n) => n.includes('Engineer fee £285.00: issue a fee note'))).toBe(true);
    expect(r.notes.some((n) => n.includes('No total-loss assessment recorded'))).toBe(true);
  });

  it('lists every missing §4.6 item on a bare report', () => {
    const bare: EngineerReport = {
      ...complete,
      instructedBy: '',
      instructedAt: '',
      engineerQualifications: '',
      inspectionAt: undefined,
      inspectionPlace: undefined,
      inspectionConditions: undefined,
      odometerMiles: undefined,
      preAccidentCondition: '',
      damageDescription: '',
      repairMethod: undefined,
      estimateId: undefined,
      roadworthyReason: '',
      repairDurationWorkingDays: undefined,
      adasNotes: undefined,
      photoEvidenceIds: [],
      feePence: 0,
      consistentWithCircumstances: false,
      consistencyNote: undefined,
    };
    const r = engineerReportChecklist(bare, { vehicle: {} });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      'Instructing party (instructedBy)',
      'Date of instruction (instructedAt)',
      "Engineer's qualifications (IAEA/IMI)",
      'Date of inspection (inspectionAt)',
      'Place of inspection (inspectionPlace)',
      'Conditions of inspection (inspectionConditions)',
      'Odometer reading at inspection (odometerMiles)',
      'Vehicle registration',
      'VIN',
      'MOT status / expiry',
      'Pre-accident condition',
      'Damage description',
      'Photographs of the damage (photoEvidenceIds)',
      'Repair method and estimate (repairMethod or estimateId)',
      'Why the vehicle is unroadworthy (roadworthyReason)',
      'Repair duration in working days (repairDurationWorkingDays)',
      'ADAS notes (state "none fitted" where that is the position)',
      'Explanation of why the damage is not consistent with the stated circumstances (consistencyNote)',
      'Engineer fee (feePence)',
    ]);
  });

  it('requires PAV, salvage category and value once a total-loss context exists', () => {
    const r = engineerReportChecklist({ ...complete, salvageCategory: 'S', repairDurationWorkingDays: undefined });
    expect(r.missing).toEqual([
      'Repair duration in working days (repairDurationWorkingDays)',
      'Total-loss assessment (repair + hire + storage vs PAV − salvage)',
      'PAV assessment with comparables (pavAssessmentId)',
      'Salvage value (actual bid or offer, never a fixed percentage)',
    ]);
    const tl = assessTotalLoss({ repairNetPence: 450_000, repairWorkingDays: 15, hireDailyRatePence: 4_232, pavPence: 600_000, salvage: { pence: 90_000, source: 'bid', category: 'S' } });
    const ok = engineerReportChecklist({ ...complete, repairDurationWorkingDays: undefined, totalLoss: tl, pavAssessmentId: 'pav-1', salvageCategory: 'S', salvageValuePence: 90_000 });
    expect(ok.ok).toBe(true);
    expect(ok.notes.some((n) => n.includes('carried by the total-loss assessment'))).toBe(true);
  });

  it('desktop basis does not need a place but is flagged as weaker', () => {
    const r = engineerReportChecklist({ ...complete, inspectionBasis: 'desktop', inspectionPlace: undefined });
    expect(r.ok).toBe(true);
    expect(r.notes.some((n) => n.startsWith('Desktop inspection: weaker evidence'))).toBe(true);
  });

  it('EV notes become mandatory for an EV or hybrid', () => {
    const r = engineerReportChecklist({ ...complete, evNotes: undefined }, { isEvOrHybrid: true });
    expect(r.missing).toEqual(['EV/hybrid notes (high-voltage battery and cabling inspection)']);
    const conv = engineerReportChecklist({ ...complete, evNotes: undefined });
    expect(conv.ok).toBe(true);
    expect(conv.notes.some((n) => n.includes('No EV notes'))).toBe(true);
  });

  it('for court: CPR 35 / PD 35 items are required and the PD 27A £750 cap is noted', () => {
    const r = engineerReportChecklist({ ...complete, forCourt: true }, { track: 'small_claims' });
    expect(r.ok).toBe(false);
    expect(r.courtItemsChecked).toHaveLength(4);
    expect(r.missing).toEqual([
      'CPR 35.10(3): substance of all material instructions, written and oral',
      'CPR 35.3 / 35.10(2): statement that the expert understands and has complied with the duty to the court',
      'PD 35: statement of truth in the prescribed form',
      'PD 35 para 3.2(9): declaration per the Guidance for the Instruction of Experts in Civil Claims',
    ]);
    expect(r.notes.some((n) => n.includes('CPR 27.2 disapplies most of Part 35') && n.includes('CPR 27.5') && n.includes('£750.00 per expert (PD 27A para 7.3(2))'))).toBe(true);
    expect(r.notes.some((n) => n.includes('Engineer fee £285.00 is within the £750.00 small-claims cap'))).toBe(true);
    expect(SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE).toBe(75_000);

    const ok = engineerReportChecklist(
      { ...complete, forCourt: true },
      { courtDeclarations: { substanceOfInstructions: true, dutyToCourt: true, statementOfTruth: true, expertDeclaration: true } },
    );
    expect(ok.ok).toBe(true);
    expect(ok.notes.some((n) => n.includes('small-claims cap'))).toBe(false); // no track given → no fee comparison
  });

  it('warns when the fee exceeds the small-claims cap', () => {
    const r = engineerReportChecklist({ ...complete, forCourt: true, feePence: 80_000 }, { track: 'small_claims', courtDeclarations: { substanceOfInstructions: true, dutyToCourt: true, statementOfTruth: true, expertDeclaration: true } });
    expect(r.ok).toBe(true);
    expect(r.notes.some((n) => n.includes('Engineer fee £800.00 exceeds the £750.00 small-claims cap'))).toBe(true);
  });
});
