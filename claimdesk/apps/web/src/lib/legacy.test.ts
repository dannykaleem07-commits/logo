import { describe, expect, it } from 'vitest';
import { findLegacyDetails, hasLegacyDetail } from './legacy';

describe('findLegacyDetails', () => {
  it('finds each legacy detail regardless of case and spacing', () => {
    const hits = findLegacyDetails('Trading as CAR FLEX, 66 Paul St? no: 66  Paul Street, London EC2A4PX, web courtesycarsuk.co.uk, co 17360033');
    expect(hits.map((h) => h.detail)).toEqual(['Car Flex', '17360033', '66 Paul Street', 'EC2A 4PX', 'courtesycarsuk.co.uk']);
    expect(hits.find((h) => h.detail === 'EC2A 4PX')?.found).toBe('EC2A4PX');
  });
  it('allows the exact registered style CARFLEX LTD but blocks any other casing', () => {
    expect(hasLegacyDetail('Supplier: CARFLEX LTD (12640635)')).toBe(false);
    expect(hasLegacyDetail('Supplier: Carflex Ltd')).toBe(true);
    expect(hasLegacyDetail('supplier: carflex ltd')).toBe(true);
    expect(hasLegacyDetail('Supplier: CARFLEX LTD trading as Car Flex')).toBe(true);
  });
  it('is clean for the current company details', () => {
    expect(findLegacyDetails('Courtesy Cars Group UK Ltd · 17430389 · claims@courtesycars.net')).toEqual([]);
    expect(findLegacyDetails('')).toEqual([]);
    expect(findLegacyDetails(undefined)).toEqual([]);
  });
});
