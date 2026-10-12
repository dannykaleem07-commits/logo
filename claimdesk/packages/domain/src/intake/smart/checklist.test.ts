import { describe, expect, it } from 'vitest';
import { buildChecklist, caseKindOf, requestEmailText, type ChecklistInput } from './checklist.js';
import { BANNED_INTAKE_WORDS } from './types.js';

const base: ChecklistInput = { caseKind: 'non_fault_credit_hire', files: [], fields: {}, witnesses: 0, accidentDate: '2026-10-07', firstRegistered: null, policeAttended: null };
const item = (items: ReturnType<typeof buildChecklist>, id: string) => items.find((i) => i.id === id)!;
const f = (fileId: string, docType: ChecklistInput['files'][number]['docType'], over: Partial<ChecklistInput['files'][number]> = {}) => ({ fileId, docType, docSide: null, formTemplateId: null, scene: null, excluded: false, ...over });

describe('caseKindOf', () => {
  it('maps the facts to a case kind', () => {
    expect(caseKindOf({ hireNeeded: true, totalLoss: false, repair: true, tpRegistrationUnknown: false })).toBe('non_fault_credit_hire');
    expect(caseKindOf({ hireNeeded: false, totalLoss: false, repair: true, tpRegistrationUnknown: false })).toBe('non_fault_repair_only');
    expect(caseKindOf({ hireNeeded: true, totalLoss: true, repair: false, tpRegistrationUnknown: false })).toBe('total_loss');
    expect(caseKindOf({ hireNeeded: true, totalLoss: false, repair: false, tpRegistrationUnknown: true })).toBe('untraced');
    expect(caseKindOf({ hireNeeded: null, totalLoss: false, repair: false, tpRegistrationUnknown: false })).toBe('unknown');
  });
});

describe('buildChecklist', () => {
  it('an empty credit-hire bundle needs everything', () => {
    const items = buildChecklist(base);
    for (const id of ['v5c', 'licence_front', 'licence_back', 'insurance_certificate', 'damage_photos', 'tp_details', 'accident_account', 'estimate_or_report', 'bank_details', 'signed_hire_docs']) expect(item(items, id).status, id).toBe('missing');
    expect(item(items, 'police_report').status).toBe('not_needed');
    expect(item(items, 'mot_certificate').status).toBe('not_needed');
  });

  it('licence: unknown side counts as front and leaves the back partial', () => {
    let items = buildChecklist({ ...base, files: [f('l', 'driving_licence')] });
    expect(item(items, 'licence_front').status).toBe('have');
    expect(item(items, 'licence_back').status).toBe('partial');
    items = buildChecklist({ ...base, files: [f('l', 'driving_licence', { docSide: 'front' }), f('b', 'driving_licence', { docSide: 'back' })] });
    expect(item(items, 'licence_back')).toMatchObject({ status: 'have', fileIds: ['b'] });
  });

  it('damage photos: partial with 1–3 or no plate, have with 4 and a plate', () => {
    const photos = (n: number, plate: boolean) => Array.from({ length: n }, (_, i) => f(`p${i}`, 'damage_photo', { scene: 'damage', platesVisible: plate && i === 0 }));
    expect(item(buildChecklist({ ...base, files: photos(2, true) }), 'damage_photos').status).toBe('partial');
    expect(item(buildChecklist({ ...base, files: photos(4, false) }), 'damage_photos').status).toBe('partial');
    expect(item(buildChecklist({ ...base, files: photos(4, true) }), 'damage_photos').status).toBe('have');
  });

  it('signed hire docs: partial with one of the two', () => {
    expect(item(buildChecklist({ ...base, files: [f('a', 'signed_ccguk_form', { formTemplateId: 'agreement.ccguk_01_customer_loa' })] }), 'signed_hire_docs').status).toBe('partial');
    expect(item(buildChecklist({ ...base, files: [f('a', 'signed_ccguk_form', { formTemplateId: 'agreement.ccguk_01_customer_loa' }), f('b', 'signed_ccguk_form', { formTemplateId: 'agreement.ccguk_03_credit_hire' })] }), 'signed_hire_docs').status).toBe('have');
    expect(item(buildChecklist({ ...base, caseKind: 'non_fault_repair_only' }), 'signed_hire_docs').status).toBe('not_needed');
  });

  it('MOT needed for a car over three years old at the accident', () => {
    expect(item(buildChecklist({ ...base, firstRegistered: '2021-03' }), 'mot_certificate').status).toBe('missing');
    expect(item(buildChecklist({ ...base, firstRegistered: '2024-03' }), 'mot_certificate').status).toBe('not_needed');
  });

  it('police, witnesses, proof of address, other side, account', () => {
    let items = buildChecklist({ ...base, policeAttended: true, fields: { 'accident.policeReference': 'CAD1', 'tp.registration': 'LM19 XYZ', 'tp.insurerName': 'Example Mutual' }, witnesses: 2, files: [f('w', 'witness_statement'), f('form', 'fnol_form')], addressesDiffer: true });
    expect(item(items, 'police_report').status).toBe('have');
    expect(item(items, 'witness_statements').status).toBe('partial');
    expect(item(items, 'proof_of_address').status).toBe('missing');
    expect(item(items, 'tp_details').status).toBe('have');
    expect(item(items, 'accident_account').status).toBe('have');
    items = buildChecklist({ ...base, caseKind: 'untraced' });
    expect(item(items, 'tp_details').status).toBe('not_needed');
    expect(item(items, 'police_report').status).toBe('missing');
  });

  it('excluded files do not count', () => {
    expect(item(buildChecklist({ ...base, files: [f('v', 'v5c', { excluded: true })] }), 'v5c').status).toBe('missing');
  });
});

describe('requestEmailText', () => {
  it('lists every missing or partial item and passes the wording check', () => {
    const items = buildChecklist({ ...base, files: [f('l', 'driving_licence')] });
    const r = requestEmailText(items, 'Jane', 'CCG-2026-00042');
    expect(r.subject).toBe('CCG-2026-00042: Documents we still need for your claim');
    expect(r.body).toMatch(/^Dear Jane,/);
    for (const i of items.filter((x) => (x.status === 'missing' || x.status === 'partial') && x.id !== 'signed_hire_docs')) expect(r.body).toContain(i.label);
    expect(r.body).not.toContain('Driving licence, front');
    expect(BANNED_INTAKE_WORDS.test(r.body)).toBe(false);
    expect(r.body).not.toMatch(/£|offer/i);
  });
});
