import { describe, it, expect } from 'vitest';
import { sha256Hex, evaluateGates, evaluateGate, EVIDENCE_GATES, guidedShotList } from './index.js';
import { greenBundle, fixtureDocument, fixtureEvidence, fixtureHire, fixtureOffer } from './bundle.fixture.js';

describe('sha256Hex', () => {
  it('matches the published SHA-256 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('evaluateGates', () => {
  it('a complete file is green on every gate', () => {
    const results = evaluateGates(greenBundle());
    expect(results.map((r) => r.gate)).toEqual(EVIDENCE_GATES);
    for (const r of results) {
      expect(r.status, `${r.gate}: ${r.missing.join('; ')}`).toBe('green');
      expect(r.missing).toEqual([]);
      expect(r.present.length).toBeGreaterThan(0);
    }
  });

  it('need: a drafted but unsigned statement of need is not evidence', () => {
    const b = greenBundle();
    b.documents = b.documents.map((d) => (d.templateId === 'form.statement_of_need' ? { ...d, status: 'draft' } : d));
    const r = evaluateGate(b, 'need');
    expect(r.status).toBe('red');
    expect(r.missing[0]).toContain('drafted but not signed');
    // a need witness statement satisfies it instead
    b.evidence.push(fixtureEvidence('ev-ws', 'witness_statement', { description: 'Statement of need: school run and shift work' }));
    expect(evaluateGate(b, 'need').status).toBe('green');
  });

  it('use: odometer figures and photos at both ends; amber at half', () => {
    const b = greenBundle();
    b.hire = [fixtureHire({ odometerIn: undefined })];
    b.evidence = b.evidence.filter((e) => e.id !== 'ev-odo-in');
    const r = evaluateGate(b, 'use');
    // 4 items, 2 present → amber
    expect(r.status).toBe('amber');
    expect(r.present).toHaveLength(2);
    expect(r.missing).toEqual([
      'Record the odometer reading at collection on the hire agreement',
      'Take a guided odometer photo at collection (captureShot "odometer", within a day of collection)'
    ]);
    // ongoing hire: collection items are not yet due
    b.hire = [fixtureHire({ endAt: undefined, collectedAt: undefined, odometerIn: undefined })];
    expect(evaluateGate(b, 'use').status).toBe('green');
    // no hire at all
    b.hire = [];
    const none = evaluateGate(b, 'use');
    expect(none.status).toBe('red');
    expect(none.missing[0]).toContain('No hire agreement on file');
  });

  it('period: dated events and roadworthiness on the report', () => {
    const b = greenBundle();
    b.events = b.events.filter((e) => e.type !== 'report_issued' && e.type !== 'repair_authorised');
    const r = evaluateGate(b, 'period');
    // 5 items, 3 present → amber
    expect(r.status).toBe('amber');
    expect(r.missing).toEqual([
      'Log the report_issued event when the engineer issues the report',
      'Log repair_authorised (with the authorising insurer) or total_loss_confirmed'
    ]);
    b.report = undefined;
    b.events = [];
    const red = evaluateGate(b, 'period');
    expect(red.status).toBe('red');
    expect(red.missing).toHaveLength(5);
    expect(red.missing[4]).toContain('roadworthy');
  });

  it('rate: daily rate, GTA group (benchmark) and a BHR screenshot', () => {
    const b = greenBundle();
    b.evidence = b.evidence.filter((e) => e.id !== 'ev-bhr-1');
    const r = evaluateGate(b, 'rate');
    expect(r.status).toBe('amber'); // 2 of 3
    expect(r.missing[0]).toContain('basic hire rate comparator');
    expect(r.present[0]).toBe('Agreement daily rate recorded (£49.80/day ex VAT)');
    expect(r.present[1]).toBe('GTA group recorded (S1)');
    b.hire = [fixtureHire({ dailyRatePence: 0, gtaGroup: '' })];
    expect(evaluateGate(b, 'rate').status).toBe('red');
    // a screenshot without the BHR wording does not count
    b.evidence.push(fixtureEvidence('ev-shot', 'screenshot', { description: 'random screenshot' }));
    expect(evaluateGate(b, 'rate').missing.some((m) => m.includes('basic hire rate'))).toBe(true);
  });

  it('impecuniosity: statement of means, 3 bank statements, income evidence', () => {
    const b = greenBundle();
    b.evidence = b.evidence.filter((e) => e.id !== 'ev-bank-3' && e.id !== 'ev-payslip');
    const r = evaluateGate(b, 'impecuniosity');
    expect(r.status).toBe('red'); // 1 of 3
    expect(r.missing).toEqual([
      "Upload 3 months' bank statements for every account (2 on file, 1 more needed)",
      'Upload at least one item of income evidence: payslip, SA302/tax return, accounts or benefit award letter'
    ]);
    // income evidence by description
    b.evidence.push(fixtureEvidence('ev-sa302', 'pdf', { description: 'SA302 tax calculation 2025-26' }));
    expect(evaluateGate(b, 'impecuniosity').status).toBe('amber');
  });

  it('mitigation: every offer decided and answered in writing, plus the questionnaire', () => {
    const b = greenBundle();
    b.offers = [fixtureOffer(), fixtureOffer({ id: 'offer-2', offerorName: 'Enterprise (for esure)', receivedAt: '2026-09-24T09:00:00Z', clientDecision: 'pending', replySentAt: undefined })];
    const r = evaluateGate(b, 'mitigation');
    expect(r.status).toBe('red'); // 1 of 3
    expect(r.missing).toEqual([
      "Record the client's decision and reasons for 1 pending intervention offer (Enterprise (for esure) 2026-09-24)",
      'Send and log a written reply (within 1 working day) to 1 offer (Enterprise (for esure) 2026-09-24)'
    ]);
    // no offers at all is fine, provided the questionnaire is signed
    b.offers = [];
    const none = evaluateGate(b, 'mitigation');
    expect(none.status).toBe('green');
    expect(none.present[1]).toContain('No intervention offers logged');
  });

  it('enforceability: the five W v Veolia / art 60F items per agreement', () => {
    const b = greenBundle();
    b.hire = [fixtureHire({ signedAt: undefined, enforceability: { cca60fCompliant: false } })];
    const r = evaluateGate(b, 'enforceability');
    expect(r.status).toBe('red'); // 0 of 5
    expect(r.missing).toHaveLength(5);
    expect(r.missing[2]).toContain('express written request to start');
    expect(r.missing[4]).toContain('art 60F');
    b.hire = [fixtureHire({ enforceability: { ...fixtureHire().enforceability, expressRequestToStartAt: undefined } })];
    const amber = evaluateGate(b, 'enforceability');
    expect(amber.status).toBe('amber'); // 4 of 5
    expect(amber.present[0]).toBe('Cancellation information provided (CCR 2013 Sch 2) on 2026-09-21');
  });

  it('liability: account, third party identified, one independent source', () => {
    const b = greenBundle();
    b.claim.accident = { ...b.claim.accident, cctvAvailable: false, policeReference: undefined };
    b.evidence = b.evidence.filter((e) => e.kind !== 'cctv');
    const r = evaluateGate(b, 'liability');
    expect(r.status).toBe('amber'); // 2 of 3
    expect(r.missing[0]).toContain('CCTV (preservation request now), dashcam, an independent witness, or a police reference');
    b.claim.accident = { ...b.claim.accident, circumstances: 'bump', dashcamAvailable: true };
    b.thirdPartyVehicle = undefined;
    b.atFaultInsurer = undefined;
    b.claim.atFaultInsurerId = undefined;
    const r2 = evaluateGate(b, 'liability');
    expect(r2.status).toBe('red'); // 1 of 3 (dashcam)
    expect(r2.present[0]).toBe('Independent source of liability evidence (dashcam)');
  });
});

describe('guidedShotList', () => {
  it('returns 12 shots by default with the four corners, plate, VIN, odometer and two close-ups required', () => {
    const list = guidedShotList();
    expect(list).toHaveLength(12);
    expect(list.filter((s) => s.required).map((s) => s.shot)).toEqual([
      'front_left',
      'front_right',
      'rear_left',
      'rear_right',
      'number_plate',
      'vin_plate',
      'odometer',
      'damage_close_1',
      'damage_close_2'
    ]);
    expect(new Set(list.map((s) => s.shot)).size).toBe(12);
    expect(list.find((s) => s.shot === 'odometer')!.instruction).toContain('miles/km');
  });

  it('can include all four tyres (15 shots)', () => {
    const list = guidedShotList({ includeAllTyres: true });
    expect(list).toHaveLength(15);
    expect(list.map((s) => s.shot)).toContain('tyre_rr');
    // returns fresh objects each call
    const a = guidedShotList();
    a[0]!.required = false;
    expect(guidedShotList()[0]!.required).toBe(true);
  });
});

// keep the unused import linter quiet for fixtures used only via greenBundle
void fixtureDocument;
