import { describe, it, expect } from 'vitest';
import {
  scoreLiability,
  assessAcceptance,
  hireFigure,
  otherHeadsFigure,
  acceptanceHireDays,
  impecuniosityReadiness,
  enforceabilityReadiness,
  ACCEPTANCE_CONDITIONS as C,
} from './index.js';
import { FILE1_ACCIDENT, file1Bundle, file3Bundle, day0Bundle, hire, offer, gate, ledger } from '../playbook/fixture.js';
import type { AccidentDetails } from '../types.js';

const rearEnd: AccidentDetails = {
  occurredAt: '2026-09-21T08:30:00+01:00',
  location: 'Barking Road / Green Street junction, London',
  circumstances: 'I was stationary at the red light. The van behind did not stop and ran into the back of me.',
  thirdPartyAccount: 'He said sorry, he was looking at his phone.',
  policeAttended: false,
  cctvAvailable: false,
  dashcamAvailable: false,
  independentWitness: false,
  injuries: false,
};

describe('scoreLiability', () => {
  it('starts at 50 with no factors', () => {
    const r = scoreLiability({ occurredAt: '2026-09-21T08:30:00+01:00', location: 'Somewhere', circumstances: 'Collision on the carriageway.' });
    expect(r.score).toBe(50);
    expect(r.band).toBe('weak');
    expect(r.factors).toHaveLength(1);
  });

  it('rear-end shunt +25; an apology is not an admission (Compensation Act 2006 s.2)', () => {
    const r = scoreLiability(rearEnd);
    expect(r.score).toBe(75);
    expect(r.factors.map((f) => [f.factor, f.delta])).toEqual([
      ['baseline', 50],
      ['clear_breach_by_third_party', 25],
      ['third_party_apology', 0],
    ]);
    expect(r.factors[2]!.note).toContain('Compensation Act 2006 s.2');
    expect(r.band).toBe('strong');
  });

  it('admission +20, independent witness +15, police +5, footage obtained +15; clamped at 100 with the raw score kept', () => {
    const r = scoreLiability(
      { ...rearEnd, thirdPartyAccount: 'He admitted it was his fault.', independentWitness: true, policeAttended: true, policeReference: 'CAD 55/210926', dashcamAvailable: true },
      { footageObtained: true },
    );
    // 50 + 25 + 20 + 15 + 15 + 5 = 130 → 100
    expect(r.rawScore).toBe(130);
    expect(r.score).toBe(100);
    expect(r.factors.find((f) => f.factor === 'police_attended')!.note).toContain('£215.10');
  });

  it('footage available but not obtained is +8 with the 7-day note; "admits nothing" is not an admission', () => {
    const r = scoreLiability({ ...rearEnd, thirdPartyAccount: 'He admits nothing.', cctvAvailable: true });
    const footage = r.factors.find((f) => f.factor === 'footage_available_not_obtained')!;
    expect(footage.delta).toBe(8);
    expect(footage.note).toContain('obtain within 7 days');
    expect(r.factors.some((f) => f.factor === 'third_party_admission')).toBe(false);
    expect(r.score).toBe(83);
  });

  it('File 1: Highway Code rules +25, contradiction −15 = 60; +15 once the CCTV is on file', () => {
    expect(scoreLiability(FILE1_ACCIDENT).score).toBe(60);
    expect(scoreLiability({ ...FILE1_ACCIDENT, cctvAvailable: true }, { footageObtained: true }).score).toBe(75);
    expect(scoreLiability(FILE1_ACCIDENT, { thirdPartyAccountContradicts: false }).score).toBe(75);
  });

  it('File 3 lane-merge dispute: contradiction −15 and merge scenario −20 = 15 (weak)', () => {
    const r = scoreLiability(file3Bundle().claim.accident);
    expect(r.score).toBe(15);
    expect(r.band).toBe('weak');
    expect(r.factors.find((f) => f.factor === 'dispute_prone_scenario')!.note).toContain('merging');
  });

  it('explicit Highway Code rules against the third party, roundabout and car-park scenarios, prior claims capped at −20', () => {
    const base: AccidentDetails = { occurredAt: '2026-09-21T08:30:00+01:00', location: 'Gallows Corner roundabout', circumstances: 'He entered the roundabout as I was already on it.' };
    const r = scoreLiability(base, { highwayCodeRulesAgainstThirdParty: [185, 186], priorClaimsOnRegistration: 3 });
    // 50 + 25 − 20 (roundabout) − 20 (3 prior claims, capped) = 35
    expect(r.score).toBe(35);
    expect(r.factors.find((f) => f.factor === 'clear_breach_by_third_party')!.note).toContain('185, 186');
    expect(r.factors.find((f) => f.factor === 'prior_claims_same_registration')!.delta).toBe(-20);
    expect(scoreLiability({ ...base, location: 'Tesco car park, Beckton', circumstances: 'Reversing out of a parking bay when he reversed into me.' }).score).toBe(30);
    expect(scoreLiability(base, { priorClaimsOnRegistration: 1 }).factors.find((f) => f.factor === 'prior_claims_same_registration')!.delta).toBe(-10);
  });

  it('cannot go below 0', () => {
    const r = scoreLiability({ ...file3Bundle().claim.accident }, { priorClaimsOnRegistration: 5 });
    // 50 − 15 − 20 − 20 = −5 → 0
    expect(r.rawScore).toBe(-5);
    expect(r.score).toBe(0);
  });
});

describe('hire and other-heads figures', () => {
  it('acceptanceHireDays counts each started 24-hour period', () => {
    expect(acceptanceHireDays('2026-09-22T10:00:00+01:00', '2026-10-02T10:00:00+01:00')).toBe(10);
    expect(acceptanceHireDays('2026-09-22T10:00:00+01:00', '2026-10-02T10:30:00+01:00')).toBe(11);
    expect(acceptanceHireDays('2026-09-22T10:00:00+01:00', '2026-09-22T10:00:00+01:00')).toBe(1);
  });

  it('hire: supplied projection → ledger → agreement projection (report-based, then 14-day default)', () => {
    const b = file1Bundle();
    expect(hireFigure(b, { projectedHirePence: 123 }).pence).toBe(123);
    expect(hireFigure(b, {})).toMatchObject({ pence: 59_760, basis: 'ledger claimed hire' });
    b.ledger = [];
    expect(hireFigure(b, {}).pence).toBe(59_760); // 10 days × £49.80 + VAT from the agreement
    // open hire, engineer says 6 working days → ceil(6 × 7/5) + 3 = 12 days → 12 × 4,980 = 59,760 + 11,952 VAT = 71,712
    b.hire = [hire({ endAt: undefined, collectedAt: undefined })];
    b.report = { ...file1Bundle().report!, repairDurationWorkingDays: 6 } as never;
    expect(hireFigure(b, {}).pence).toBe(71_712);
    // no report → 14 days → 14 × 4,980 = 69,720 + 13,944 = 83,664
    delete b.report;
    expect(hireFigure(b, {}).pence).toBe(83_664);
    expect(hireFigure(b, { acceptanceHireProjection: 20 }).pence).toBe(20 * 4980 + 20 * 996);
    b.hire = [];
    expect(hireFigure(b, {})).toEqual({ pence: 0, basis: 'no hire on the file' });
  });

  it('other heads: ledger first (salvage netted), then estimate/report/storage/recovery records', () => {
    const b = file1Bundle();
    // storage 32,400 + recovery 13,800 + engineer 28,500 = 74,700
    expect(otherHeadsFigure(b, {}).pence).toBe(74_700);
    b.ledger = ledger([
      { head: 'pav', kind: 'claimed', amountPence: 350_000 },
      { head: 'salvage', kind: 'claimed', amountPence: 50_000 },
      { head: 'interest', kind: 'claimed', amountPence: 9_999 },
    ]);
    expect(otherHeadsFigure(b, {}).pence).toBe(300_000);
    b.ledger = [];
    b.estimate = { totals: { grossPence: 150_000 } } as never;
    b.report = { feePence: 28_500 } as never;
    b.recovery = [{ id: 'rec-1', claimId: 'claim-1', at: '2026-09-21T10:00:00+01:00', fromLocation: 'A13', toLocation: 'yard', calloutPence: 9_000, loadedMiles: 12, perLoadedMilePence: 300, adminPence: 2_500, vatRate: 0.2, evidenceIds: [] }];
    // 150,000 + 28,500 + storage 6 days (27,000 + 5,400) + recovery (9,000 + 3,600 + 2,500 = 15,100 + 3,020) = 229,020
    expect(otherHeadsFigure(b, {}).pence).toBe(229_020);
    expect(otherHeadsFigure(b, { otherHeadsPence: 1 }).pence).toBe(1);
  });
});

describe('readiness', () => {
  it('impecuniosity: ready with statement + 3 bank statements + income; partial/none as items drop out; gate wins when supplied', () => {
    const b = file1Bundle();
    expect(impecuniosityReadiness(b).readiness).toBe('ready');
    b.evidence = b.evidence.filter((e) => e.kind !== 'bank_statement');
    const partial = impecuniosityReadiness(b);
    expect(partial.readiness).toBe('partial');
    expect(partial.missing).toEqual(["3 months' bank statements for every account (0 on file)"]);
    b.documents = [];
    b.evidence = [];
    expect(impecuniosityReadiness(b).readiness).toBe('none');
    expect(impecuniosityReadiness(b, [gate('impecuniosity', 'amber', ['x'])]).readiness).toBe('partial');
  });

  it('enforceability: all five items ready; none with no hire; partial when the express request is missing', () => {
    const b = file1Bundle();
    expect(enforceabilityReadiness(b).readiness).toBe('ready');
    b.hire = [hire({ enforceability: { cancellationInfoProvidedAt: '2026-09-22T10:05:00+01:00', schedule3FormProvidedAt: '2026-09-22T10:05:00+01:00', cca60fCompliant: true } })];
    const r = enforceabilityReadiness(b);
    expect(r.readiness).toBe('partial');
    expect(r.missing).toEqual(['express request to start during the cancellation period (reg 36)']);
    b.hire = [];
    expect(enforceabilityReadiness(b).readiness).toBe('none');
    expect(enforceabilityReadiness(b, [gate('enforceability', 'red', ['everything'])]).readiness).toBe('none');
  });
});

describe('assessAcceptance', () => {
  it('File 3 archetype: lane-merge dispute, hire 6× other heads, no evidence → decline, costs exposure high, no hire until liability evidence', () => {
    const r = assessAcceptance(file3Bundle());
    expect(r.liabilityScore).toBe(15);
    expect(r.hireToOtherHeadsRatio).toBe(6);
    expect(r.costsExposure).toBe('high');
    expect(r.decision).toBe('decline');
    expect(r.conditions).toContain(C.noHireUntilLiability);
    expect(r.conditions).toContain(C.cctv);
    expect(r.conditions).toContain(C.impecuniosity);
    expect(r.conditions).toContain(C.enforceability);
    expect(r.impecuniosityReadiness).toBe('none');
    expect(r.enforceabilityReadiness).toBe('none');
    expect(r.perimeterFlags).toEqual(['LSA_LITIGATION_DRAFTS_ONLY']);
    expect(r.reasons.join('\n')).toContain('[2025] EWCA Civ 733');
    expect(r.reasons.join('\n')).toContain('Kindertons Ltd v Murtagh [2024] EWHC 471 (KB)');
    expect(r.reasons.join('\n')).toContain('Diriye v Bojaj [2020] EWCA Civ 1400');
    expect(r.reasons.join('\n')).toContain('W v Veolia');
    expect(r.reasons.join('\n')).toContain('Dimond v Lovell');
    expect(r.reasons.some((x) => x.startsWith('Decision: decline'))).toBe(true);
  });

  it('File 1: strong liability, hire 0.8× other heads, evidence ready → accept with no conditions', () => {
    const r = assessAcceptance(file1Bundle());
    expect(r.liabilityScore).toBe(75);
    expect(r.hireToOtherHeadsRatio).toBe(0.8);
    expect(r.costsExposure).toBe('low');
    expect(r.impecuniosityReadiness).toBe('ready');
    expect(r.enforceabilityReadiness).toBe('ready');
    expect(r.decision).toBe('accept');
    expect(r.conditions).toEqual([]);
    expect(r.perimeterFlags).toEqual(['LSA_LITIGATION_DRAFTS_ONLY']);
    expect(r.reasons.join('\n')).toContain('Legal Services Act 2007 s.12');
  });

  it('medium exposure when only one of the two tests fails; accept_with_conditions when readiness is not ready', () => {
    // strong liability but hire with no other heads known yet → medium, ratio undefined
    const d0 = assessAcceptance(day0Bundle(), { projectedHirePence: 100_000 });
    expect(d0.liabilityScore).toBe(60);
    expect(d0.hireToOtherHeadsRatio).toBeUndefined();
    expect(d0.costsExposure).toBe('medium');
    expect(d0.decision).toBe('accept_with_conditions');
    expect(d0.conditions).toEqual([C.impecuniosity, C.enforceability]);
    // weak liability but proportionate hire → medium
    const b = file1Bundle();
    const weak = assessAcceptance(b, { liabilityScore: 50 });
    expect(weak.costsExposure).toBe('medium');
    expect(weak.decision).toBe('accept_with_conditions');
    expect(weak.conditions).toEqual([C.cctv]);
    // gates supplied: an amber impecuniosity gate makes a clean file conditional
    const gated = assessAcceptance(file1Bundle(), { gates: [gate('impecuniosity', 'amber', ['2 more bank statements'])] });
    expect(gated.impecuniosityReadiness).toBe('partial');
    expect(gated.decision).toBe('accept_with_conditions');
    expect(gated.conditions).toEqual([C.impecuniosity]);
    expect(gated.reasons.join('\n')).toContain('2 more bank statements');
  });

  it('injury adds the perimeter flag and the refer-out condition; an unanswered offer adds the reply condition; weak + high ratio but score ≥ 40 is conditional, not declined', () => {
    const b = file1Bundle();
    b.claim = { ...b.claim, accident: { ...b.claim.accident, injuries: true } };
    b.offers = [offer({ replySentAt: undefined })];
    const r = assessAcceptance(b, { liabilityScore: 45, projectedHirePence: 500_000 });
    // hire 500,000 / other 74,700 = 6.69
    expect(r.hireToOtherHeadsRatio).toBe(6.69);
    expect(r.costsExposure).toBe('high');
    expect(r.decision).toBe('accept_with_conditions');
    expect(r.conditions).toEqual([C.noHireUntilLiability, C.cctv, C.interventionReply, C.injury]);
    expect(r.perimeterFlags).toEqual(['PERSONAL_INJURY_REFER_OUT', 'LSA_LITIGATION_DRAFTS_ONLY']);
    expect(r.reasons.join('\n')).toContain('LASPO 2012 ss.56–60');
  });

  it('an admitted liability position counts as a third-party admission', () => {
    const b = file1Bundle();
    b.claim = { ...b.claim, liability: 'admitted' };
    expect(assessAcceptance(b).liabilityScore).toBe(95);
  });
});
