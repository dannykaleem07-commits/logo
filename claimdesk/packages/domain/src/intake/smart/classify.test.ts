import { describe, expect, it } from 'vitest';
import { classifyText, RULES_MAX_CONFIDENCE, scoreText, topTypeOf } from './classify.js';

const base = { filename: 'doc.pdf', fingerprintTemplateId: null, isEmail: false, isImage: false, insurerNames: ['Example Mutual Insurance', 'Acme Insure'] };

describe('classifyText', () => {
  const cases: Array<[string, string]> = [
    ['v5c', 'V5C Vehicle registration certificate\nRegistered keeper: Jane Doe\nDVLA Swansea'],
    ['driving_licence', 'DRIVING LICENCE\n1. DOE\n2. JANE\n5. DOE99901010JA9AB'],
    ['insurance_certificate', 'Certificate of Motor Insurance\nPersons or classes of persons entitled to drive: the policyholder'],
    ['police_report', 'Police collision report\nCrime reference: CR/1234/26\nOfficer PC 1234'],
    ['fnol_form', 'Accident report form\nDetails of the accident\nDescribe what happened: I was stationary'],
    ['insurer_letter', 'Dear Sirs\nOur ref: TPI/778812\nYour ref: CCG-2026-00042\nWe write regarding liability. Example Mutual Insurance'],
    ['engineer_report', "Engineer's report\nPre-accident value £8,000\nRepair method: replace bumper"],
    ['bodyshop_estimate', 'Repair estimate\nLabour 4.0 hrs\nParts\nPaint & materials\nVAT\nTotal'],
    ['audatex_estimate', 'AudaEnterprise calculation\nAudatex'],
    ['invoice', 'Invoice number 1001\nAmount due £120'],
    ['bank_statement', 'Statement\nSort code 12-34-56\nBalance £100'],
    ['payslip', 'Payslip\nGross pay £2,000\nNI number AB123456C'],
    ['mot_certificate', 'MOT test certificate VT20\nOdometer reading 40,000'],
    ['witness_statement', 'Witness statement\nStatement of truth: I believe that the facts stated'],
    ['proof_of_address', 'Council tax bill 2026\nAccount holder Jane Doe'],
  ];
  for (const [type, text] of cases) {
    it(`classifies a ${type}`, () => {
      const r = classifyText(text, base);
      expect(r.docType).toBe(type);
      expect(r.confidence).toBeLessThanOrEqual(RULES_MAX_CONFIDENCE);
      expect(r.confidence).toBeGreaterThan(0);
    });
  }

  it('an email is correspondence unless another type scores 6 or more', () => {
    expect(classifyText('Hi, thanks for the update. Regards', { ...base, isEmail: true }).docType).toBe('correspondence');
    expect(classifyText('Dear Sirs, Our ref TPI/1. We write about liability on behalf of Example Mutual Insurance', { ...base, isEmail: true }).docType).toBe('insurer_letter');
  });

  it('photos with no text are vehicle photos at 0.3 (the AI decides)', () => {
    expect(classifyText('', { ...base, isImage: true })).toEqual({ docType: 'vehicle_photo_other', confidence: 0.3, scores: {} });
  });

  it('a CCGUK form fingerprint scores 6', () => {
    const r = classifyText('Some printed labels', { ...base, fingerprintTemplateId: 'form.ccguk_09_accident_report' });
    expect(r.docType).toBe('signed_ccguk_form');
  });

  it('no match → other', () => {
    expect(classifyText('lorem ipsum dolor', base).docType).toBe('other');
  });

  it('confidence is capped at 0.85 even with a big margin', () => {
    const r = classifyText('V5C V5C registration certificate registered keeper DVLA date of first registration', { ...base, filename: 'v5c.pdf' });
    expect(r.confidence).toBeLessThanOrEqual(0.85);
  });

  it('filename hints add weight', () => {
    expect(scoreText('nothing', { insurerNames: [], fingerprintTemplateId: null, filename: 'SMART-A-V5C.pdf' }).v5c).toBe(2);
  });

  it('topTypeOf reports the margin', () => {
    expect(topTypeOf({ v5c: 9, invoice: 2 })).toEqual({ type: 'v5c', top: 9, second: 2 });
    expect(topTypeOf({})).toEqual({ type: null, top: 0, second: 0 });
  });
});
