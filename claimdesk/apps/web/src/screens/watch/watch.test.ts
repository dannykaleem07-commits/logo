import { describe, expect, it } from 'vitest';
import type { CompanyWatch } from '@ccguk/domain';
import { companiesHouseUrl, companyStatusTone, isCompanyNumber, normaliseCompanyNumber, sortWatch, strikeOffNotices, supplierRiskBanner } from './watch';

function w(extra: Partial<CompanyWatch>): CompanyWatch {
  return { companyNumber: '12640635', name: 'CARFLEX LTD', role: 'supplier', gazetteNotices: [], officerChanges: [], riskLevel: 'high', riskReasons: ['Strike-off action suspended', 'Accounts overdue'], ...extra };
}

describe('company numbers', () => {
  it('normalises and validates Companies House numbers', () => {
    expect(normaliseCompanyNumber('1264 0635')).toBe('12640635');
    expect(normaliseCompanyNumber('123456')).toBe('00123456');
    expect(normaliseCompanyNumber('sc123456')).toBe('SC123456');
    expect(isCompanyNumber('12640635')).toBe(true);
    expect(isCompanyNumber('SC123456')).toBe(true);
    expect(isCompanyNumber('ABC')).toBe(false);
    expect(isCompanyNumber('123456789')).toBe(false);
    expect(companiesHouseUrl('12640635')).toBe('https://find-and-update.company-information.service.gov.uk/company/12640635');
  });
});

describe('tones and banners', () => {
  it('reads Companies House statuses', () => {
    expect(companyStatusTone('active')).toBe('green');
    expect(companyStatusTone('active-proposal-to-strike-off')).toBe('red');
    expect(companyStatusTone('dissolved')).toBe('red');
    expect(companyStatusTone('liquidation')).toBe('red');
    expect(companyStatusTone(undefined)).toBe('grey');
    expect(companyStatusTone('voluntary-arrangement')).toBe('amber');
  });
  it('sorts high risk first and writes the supplier banner', () => {
    const rows = sortWatch([w({ companyNumber: '1', name: 'Zed Ltd', riskLevel: 'low' }), w({ companyNumber: '2', name: 'Able Insurer', role: 'insurer', riskLevel: 'medium' }), w({})]);
    expect(rows.map((r) => r.name)).toEqual(['CARFLEX LTD', 'Able Insurer', 'Zed Ltd']);
    expect(supplierRiskBanner(rows)).toMatch(/CARFLEX LTD \(12640635\)/);
    expect(supplierRiskBanner(rows)).toMatch(/expect challenges to invoices/);
    expect(supplierRiskBanner([w({ riskLevel: 'low' })])).toBeUndefined();
    expect(supplierRiskBanner([w({ role: 'insurer' })])).toBeUndefined();
  });
  it('filters strike-off notices', () => {
    const notices = strikeOffNotices(w({ gazetteNotices: [{ date: '2026-05-01', type: 'gazette', note: 'First Gazette notice for compulsory strike-off' }, { date: '2026-06-01', type: 'other', note: 'Change of address' }] }));
    expect(notices).toHaveLength(1);
  });
});
