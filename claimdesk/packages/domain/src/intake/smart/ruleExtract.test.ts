import { describe, expect, it } from 'vitest';
import { RULE_FIELD_NAMES, ruleDocSide, ruleDocumentDate, ruleExtract } from './ruleExtract.js';

const opts = { insurerNames: ['Example Mutual Insurance'] };
const find = (fs: ReturnType<typeof ruleExtract>, target: string | null, name?: string) => fs.find((f) => f.target === target && (!name || f.name === name));

describe('ruleExtract', () => {
  it('reads a V5C: registration, VIN, keeper, make/model, first registration (client role, page and quote)', () => {
    const fs = ruleExtract(
      ['V5C Registration certificate\nRegistration mark: KX21 ABC\nVIN: WVWZZZ1KZAW000001\nRegistered keeper: Jane Doe\nAddress: 12 High Street, Reading, RG1 1AA\nMake: Vauxhall\nModel: Corsa SE\nColour: Blue\nDate of first registration: 15/03/2021\nDate of acquisition: 01/04/2021'],
      'v5c',
      opts,
    );
    expect(find(fs, 'vehicle:client.registration')).toMatchObject({ value: 'KX21 ABC', page: 1, quote: 'Registration mark: KX21 ABC', confidence: 0.8 });
    expect(find(fs, 'vehicle:client.vin')?.value).toBe('WVWZZZ1KZAW000001');
    expect(find(fs, 'party:client.name')?.value).toBe('Jane Doe');
    expect(find(fs, 'party:client.address')?.value).toBe('12 High Street, Reading, RG1 1AA');
    expect(find(fs, 'vehicle:client.make')?.value).toBe('Vauxhall');
    expect(find(fs, 'vehicle:client.model')?.value).toBe('Corsa SE');
    expect(find(fs, 'vehicle:client.colour')?.value).toBe('Blue');
    expect(find(fs, 'vehicle:client.firstRegistered')?.value).toBe('2021-03');
    expect(find(fs, null, 'Keeper since')?.value).toBe('2021-04-01');
    for (const f of fs) expect(f.confidence).toBeLessThanOrEqual(0.85);
  });

  it('reads a licence card: name, DOB, number, expiry; side front', () => {
    const pages = ['DRIVING LICENCE\n1. DOE\n2. JANE MARY\n3. 12.03.1990 UNITED KINGDOM\n4a. 01.01.2020\n4b. 01.01.2030\n5. DOE99903120JM9AB\n8. 12 High Street, Reading, RG1 1AA'];
    const fs = ruleExtract(pages, 'driving_licence', opts);
    expect(find(fs, 'party:client.name')?.value).toBe('Jane Mary Doe');
    expect(find(fs, 'party:client.dateOfBirth')?.value).toBe('1990-03-12');
    expect(find(fs, 'party:client.drivingLicenceNumber')?.value).toBe('DOE99903120JM9AB');
    expect(find(fs, null, 'Licence valid until')?.value).toBe('2030-01-01');
    expect(ruleDocSide(pages, 'driving_licence')).toBe('front');
    expect(ruleDocSide(['9. B, BE 12. 01\nCategories and restrictions'], 'driving_licence')).toBe('back');
  });

  it('reads an accident report form with sections for the other side', () => {
    const fs = ruleExtract(
      [
        'Accident report form\nYour details\nName: Jane Doe\nDate of birth: 12/03/1990\nTelephone: 07700 900123\nEmail: jane.doe@example.test\nYour vehicle\nRegistration: KX21 ABC\n\nOther vehicle\nRegistration: LM19 XYZ\nOther driver\'s name: Sam Other\nInsurer: Example Mutual Insurance\nPolicy number: POL123456\n\nAccident details\nDate of accident: 07/10/2026\nTime of accident: 17:45\nLocation: London Road, Reading RG1 2BB\nDescribe what happened: I was stationary at the lights when the other car drove into the back of me.\n\nWitnesses: none\nInjuries: no\nPolice attended: yes\nPolice reference: CAD1234\nIs the car driveable: no\nReplacement car needed: yes',
      ],
      'fnol_form',
      opts,
    );
    expect(find(fs, 'party:client.name')?.value).toBe('Jane Doe');
    expect(find(fs, 'party:client.dateOfBirth')?.value).toBe('1990-03-12');
    expect(find(fs, 'party:client.phone')?.value).toBe('07700900123');
    expect(find(fs, 'party:client.email')?.value).toBe('jane.doe@example.test');
    expect(find(fs, 'vehicle:client.registration')?.value).toBe('KX21 ABC');
    expect(find(fs, 'vehicle:third_party.registration')?.value).toBe('LM19 XYZ');
    expect(find(fs, 'party:third_party.name')?.value).toBe('Sam Other');
    expect(find(fs, 'claim.atFaultInsurerName')?.value).toBe('Example Mutual Insurance');
    expect(find(fs, 'claim.thirdPartyPolicyNumber')?.value).toBe('POL123456');
    expect(find(fs, 'claim.accident.occurredAt')?.value).toBe('2026-10-07 17:45');
    expect(find(fs, 'claim.accident.location')?.value).toBe('London Road, Reading RG1 2BB');
    expect(find(fs, 'claim.accident.postcode')?.value).toBe('RG1 2BB');
    expect(find(fs, 'claim.accident.circumstances')?.value).toMatch(/^I was stationary at the lights/);
    expect(find(fs, null, 'Witnesses')?.value).toBe('none');
    expect(find(fs, 'claim.accident.injuries')?.value).toBe('no');
    expect(find(fs, null, 'Police attended')?.value).toBe('yes');
    expect(find(fs, 'claim.accident.policeReference')?.value).toBe('CAD1234');
    expect(find(fs, null, 'Vehicle driveable')?.value).toBe('no');
    expect(find(fs, null, 'Hire needed')?.value).toBe('yes');
  });

  it('reads an insurer letter from the other side: their ref, our CCG ref, their insured, your client', () => {
    const fs = ruleExtract(
      ['Example Mutual Insurance\n7 October 2026\nOur ref: TPI/778812\nYour ref: CCG-2026-00042\nDear Sirs\nOur policyholder vehicle LM19 XYZ\nYour client vehicle KX21 ABC\nPolicy number: EMI-555\nWe accept liability for this accident.\nTel: 0118 496 0000'],
      'insurer_letter',
      opts,
    );
    expect(find(fs, 'claim.atFaultInsurerRef')?.value).toBe('TPI/778812');
    expect(find(fs, null, 'ClaimDesk reference')?.value).toBe('CCG-2026-00042');
    expect(find(fs, 'vehicle:third_party.registration')?.value).toBe('LM19 XYZ');
    expect(find(fs, 'vehicle:client.registration')?.value).toBe('KX21 ABC');
    expect(find(fs, 'claim.thirdPartyPolicyNumber')?.value).toBe('EMI-555');
    expect(find(fs, 'claim.atFaultInsurerName')?.value).toBe('Example Mutual Insurance');
    expect(find(fs, null, 'Liability statement')?.value).toMatch(/We accept liability/);
    expect(find(fs, null, 'Phone (unassigned)')?.value).toBe('01184960000');
    expect(ruleDocumentDate(['Example Mutual Insurance\n7 October 2026\nOur ref: TPI/778812'], 'insurer_letter')).toBe('2026-10-07');
  });

  it('bank details are read without a target and an offer is spotted', () => {
    const fs = ruleExtract(['Sort code: 12-34-56\nAccount number: 12345678\nWe are pleased to offer £500 in settlement'], 'insurer_letter', opts);
    expect(find(fs, null, 'Sort code')?.value).toBe('12-34-56');
    expect(find(fs, null, 'Account number')?.value).toBe('12345678');
    expect(find(fs, null, 'Offer made')?.value).toBe('yes');
    expect(fs.filter((f) => f.target).length).toBe(0);
  });

  it('bare plates on an unknown-role page are unassigned; VINs and licence numbers too', () => {
    const fs = ruleExtract(['Note about KX21 ABC and WVWZZZ1KZAW000001 and DOE99903120JM9AB'], 'other', opts);
    expect(find(fs, null, 'Registration (unassigned)')?.value).toBe('KX21 ABC');
    expect(find(fs, null, 'VIN (unassigned)')?.value).toBe('WVWZZZ1KZAW000001');
    expect(find(fs, null, 'Licence number (unassigned)')?.value).toBe('DOE99903120JM9AB');
  });

  it('a police report: reference, both vehicles by section', () => {
    const fs = ruleExtract(['Police collision report\nIncident number: INC-2026-0042\nVehicle 1\nRegistration: KX21 ABC\nVehicle 2\nRegistration: LM19 XYZ\nName: Sam Other\nDate and time of incident: 07/10/2026 17:40'], 'police_report', opts);
    expect(find(fs, 'claim.accident.policeReference')?.value).toBe('INC-2026-0042');
    expect(find(fs, 'vehicle:client.registration')?.value).toBe('KX21 ABC');
    expect(find(fs, 'vehicle:third_party.registration')?.value).toBe('LM19 XYZ');
    expect(find(fs, 'party:third_party.name')?.value).toBe('Sam Other');
    expect(find(fs, 'claim.accident.occurredAt')?.value).toBe('2026-10-07 17:40');
  });

  it('never invents: dedupes repeated values and ignores invalid plates', () => {
    const fs = ruleExtract(['Registration: KX21 ABC\nKX21 ABC again\nRegistration: AB00 CDE'], 'v5c', opts);
    expect(fs.filter((f) => f.target === 'vehicle:client.registration').map((f) => f.value)).toEqual(['KX21 ABC']);
  });

  it('every target-less name is listed for the prompt', () => {
    const fs = ruleExtract(['Sort code: 12-34-56\nWitnesses: none\nPolice attended: yes\nKX21 ABC'], 'other', opts);
    for (const f of fs.filter((x) => !x.target)) expect(Object.keys(RULE_FIELD_NAMES)).toContain(f.name);
  });
});
