import { describe, expect, it } from 'vitest';
import { apiKeyPresent, buildSettingsPatch, COMPANY_NAME, confirmationOfPayeeCheck, DEFAULT_RATE_CARD, parsePct, settingsToForm, usersFrom, validateSettings } from './settings';

describe('confirmationOfPayeeCheck', () => {
  it('passes only the exact registered name', () => {
    expect(confirmationOfPayeeCheck(COMPANY_NAME)).toEqual({ match: true });
    expect(confirmationOfPayeeCheck('  Courtesy Cars Group UK  Ltd ')).toEqual({ match: true });
    expect(confirmationOfPayeeCheck('Courtesy Cars Group UK Limited').match).toBe(false);
    expect(confirmationOfPayeeCheck('COURTESY CARS GROUP UK LTD').message).toMatch(/case only/);
    expect(confirmationOfPayeeCheck('Courtesy Cars').message).toMatch(/could not be validated/);
    expect(confirmationOfPayeeCheck('').message).toMatch(/No bank account name/);
  });
});

describe('settings form', () => {
  it('round-trips the API shape with VAT as a percentage', () => {
    const f = settingsToForm({ registeredOffice: '1 Example Way', bank: { accountName: COMPANY_NAME, sortCode: '123456', accountNumber: '12345678' }, rateCard: { ...DEFAULT_RATE_CARD } });
    expect(f.vatRatePct).toBe('20');
    expect(f.storageDailyPence).toBe(4500);
    const patch = buildSettingsPatch(f);
    expect(patch.rateCard).toEqual({ ...DEFAULT_RATE_CARD });
    expect(patch.bank).toEqual({ accountName: COMPANY_NAME, sortCode: '123456', accountNumber: '12345678', bankName: undefined });
    expect(patch.companyNumber).toBe('17430389');
  });
  it('fills rate-card gaps with the brief defaults (£90 + £3/mile + £25; £45/day; £285)', () => {
    const patch = buildSettingsPatch(settingsToForm(undefined));
    expect(patch.rateCard).toEqual({ recoveryCalloutPence: 9000, recoveryPerLoadedMilePence: 300, recoveryAdminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500, vatRate: 0.2 });
  });
  it('blocks legacy details and checks formats', () => {
    const f = settingsToForm(undefined);
    f.registeredOffice = '66 Paul Street, London EC2A 4PX';
    f.bankSortCode = '12345';
    f.bankAccountNumber = '1234';
    f.vatNumber = 'GB12';
    f.icoRegistration = '12';
    f.vatRatePct = 'twenty';
    const e = validateSettings(f);
    expect(e.registeredOffice).toMatch(/Legacy detail blocked/);
    expect(e.registeredOffice).toMatch(/66 Paul Street/);
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['bankSortCode', 'bankAccountNumber', 'vatNumber', 'icoRegistration', 'vatRatePct']));
    f.registeredOffice = '1 Example Way, London N1 1AA';
    f.bankSortCode = '12-34-56';
    f.bankAccountNumber = '12345678';
    f.vatNumber = 'GB 123 4567 89';
    f.icoRegistration = 'ZA123456';
    f.vatRatePct = '20%';
    expect(validateSettings(f)).toEqual({});
    expect(buildSettingsPatch(f).vatNumber).toBe('GB123456789');
    expect(buildSettingsPatch(f).bank?.sortCode).toBe('123456');
  });
  it('parses percentages and reads keys / users defensively', () => {
    expect(parsePct('20')).toBe(20);
    expect(parsePct('20 %')).toBe(20);
    expect(parsePct('120')).toBeNull();
    expect(parsePct('')).toBeNull();
    expect(apiKeyPresent(undefined, 'dvlaVes')).toBeUndefined();
    expect(apiKeyPresent({ apiKeys: { dvlaVes: true, dvsaMot: false, companiesHouse: false, gateway: false } }, 'dvlaVes')).toBe(true);
    expect(apiKeyPresent({ apiKeys: { dvlaVes: true, dvsaMot: false, companiesHouse: false, gateway: false } }, 'anthropic')).toBeUndefined();
    expect(usersFrom({ users: [{ id: 'u1', name: 'Danny', email: 'd@example.com', role: 'admin' }, 'junk'] })).toHaveLength(1);
    expect(usersFrom({})).toEqual([]);
  });
});
