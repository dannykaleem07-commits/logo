import { describe, expect, it } from 'vitest';
import { externalVehicleLinks, TOTAL_CAR_CHECK_URL_TEMPLATE, totalCarCheckUrl } from './external.js';

describe('Total Car Check deep link', () => {
  it('uses the normalised registration (upper case, no spaces)', () => {
    expect(TOTAL_CAR_CHECK_URL_TEMPLATE).toBe('https://totalcarcheck.co.uk/FreeCheck?regno={REG}');
    expect(totalCarCheckUrl('ab12 cde')).toBe('https://totalcarcheck.co.uk/FreeCheck?regno=AB12CDE');
  });
  it('returns an empty string for an empty registration', () => {
    expect(totalCarCheckUrl('  ')).toBe('');
  });
  it('accepts an overriding template', () => {
    expect(totalCarCheckUrl('AB12CDE', 'https://example.test/check/{REG}?x={REG}')).toBe('https://example.test/check/AB12CDE?x=AB12CDE');
  });
});

describe('externalVehicleLinks', () => {
  it('lists Total Car Check, MOT history and vehicle enquiry, all unverified', () => {
    const links = externalVehicleLinks('KX21 ABC');
    expect(links.map((l) => l.id)).toEqual(['totalcarcheck', 'gov_mot_history', 'gov_vehicle_enquiry']);
    expect(links[0]).toMatchObject({ label: 'Open on Total Car Check', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=KX21ABC', verified: false });
    expect(links[0]!.note).toBe('Free check in your browser. Copy the details back into ClaimDesk; they are saved as unverified.');
    expect(links[1]!.url).toBe('https://www.check-mot.service.gov.uk/');
    expect(links[2]!.url).toBe('https://vehicleenquiry.service.gov.uk/');
    expect(links.every((l) => l.verified === false)).toBe(true);
  });
  it('uses the template option and drops the Total Car Check link for an empty registration', () => {
    expect(externalVehicleLinks('AB12CDE', { totalCarCheckTemplate: 'https://tcc.test/{REG}' })[0]!.url).toBe('https://tcc.test/AB12CDE');
    expect(externalVehicleLinks('').map((l) => l.id)).toEqual(['gov_mot_history', 'gov_vehicle_enquiry']);
  });
});
