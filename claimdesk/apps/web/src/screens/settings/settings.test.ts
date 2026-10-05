import { describe, expect, it } from 'vitest';
import { addressToLines, apiKeyPresent, buildSettingsPatch, COMPANY_DETAILS, COMPANY_NAME, confirmationOfPayeeCheck, DEFAULT_RATE_CARD, DEFAULT_REGISTERED_OFFICE, LEGAL_FOOTER, linesToAddress, lookupModeLabel, lookupModeOf, MORE_SETTINGS_LINKS, parsePct, settingsToForm, usersFrom, validateSettings, versionLabel } from './settings';

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
  it('round-trips the API shape with VAT as a percentage and the office as an address', () => {
    const f = settingsToForm({ registeredOffice: { line1: '44 Syon Lane', line2: 'Isleworth', town: 'London', postcode: 'TW7 5NQ' }, bank: { accountName: COMPANY_NAME, sortCode: '123456', accountNumber: '12345678' }, rateCard: { ...DEFAULT_RATE_CARD } });
    // no VAT by default: CCGUK's contracts say no VAT is charged and no VAT number is held
    expect(f.vatRatePct).toBe('0');
    expect(settingsToForm({ vatNumber: 'GB123456789', rateCard: { ...DEFAULT_RATE_CARD, vatRate: 0.2 } }).vatRatePct).toBe('20');
    expect(f.storageDailyPence).toBe(4500);
    expect(f.registeredOffice).toBe('44 Syon Lane\nIsleworth\nLondon\nTW7 5NQ');
    const patch = buildSettingsPatch(f);
    expect(patch.rateCard).toEqual({ ...DEFAULT_RATE_CARD });
    expect(patch.registeredOffice).toEqual({ line1: '44 Syon Lane', line2: 'Isleworth', town: 'London', postcode: 'TW7 5NQ' });
    expect(patch.bank).toEqual({ accountName: COMPANY_NAME, sortCode: '123456', accountNumber: '12345678', bankName: undefined });
    expect(patch.companyNumber).toBe('17430389');
  });
  it('reads the rate card in the API spelling (perMilePence / adminPence) and the web spelling alike', () => {
    expect(settingsToForm({ rateCard: { recoveryCalloutPence: 9000, perMilePence: 300, adminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500, vatRate: 0.2 } }).recoveryPerLoadedMilePence).toBe(300);
    expect(settingsToForm({ rateCard: { recoveryCalloutPence: 9000, perMilePence: 300, adminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500, vatRate: 0.2 } }).recoveryAdminPence).toBe(2500);
    expect(settingsToForm({ rateCard: { ...DEFAULT_RATE_CARD } }).recoveryAdminPence).toBe(2500);
  });
  it('parses the office textarea into an address and leaves out an empty bank block', () => {
    expect(linesToAddress('1 Example Way\nLondon\nN1 1AA')).toEqual({ line1: '1 Example Way', town: 'London', postcode: 'N1 1AA' });
    expect(linesToAddress('Unit 4, Some Estate, Barking, IG11 7AB')).toEqual({ line1: 'Unit 4', line2: 'Some Estate', town: 'Barking', postcode: 'IG11 7AB' });
    expect(linesToAddress('1 Example Way, London N1 1AA')).toEqual({ line1: '1 Example Way', town: 'London', postcode: 'N1 1AA' });
    expect(linesToAddress('1 Example Way')).toBeUndefined();
    expect(linesToAddress('1 Example Way\nnot a postcode')).toBeUndefined();
    expect(addressToLines(undefined)).toBe('');
    expect(addressToLines('legacy string')).toBe('legacy string');
    const f = settingsToForm(undefined);
    f.registeredOffice = '1 Example Way\nnot a postcode';
    expect(validateSettings(f).registeredOffice).toMatch(/postcode/);
    const patch = buildSettingsPatch(f);
    expect(patch.registeredOffice).toBeUndefined();
    expect(patch.bank).toBeUndefined();
  });
  it('fills rate-card gaps with the brief defaults (£90 + £3/mile + £25; £45/day; £285)', () => {
    const patch = buildSettingsPatch(settingsToForm(undefined));
    expect(patch.rateCard).toEqual({ recoveryCalloutPence: 9000, recoveryPerLoadedMilePence: 300, recoveryAdminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500, vatRate: 0 });
  });
  it('refuses a VAT rate above 0 without a VAT number', () => {
    const f = settingsToForm(undefined);
    f.vatRatePct = '20';
    expect(validateSettings(f).vatRatePct).toMatch(/VAT number/);
    f.vatNumber = 'GB123456789';
    expect(validateSettings(f).vatRatePct).toBeUndefined();
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
    expect(buildSettingsPatch(f).bank).toBeUndefined(); // no account name → no bank block (the API wants all three fields together)
    f.bankAccountName = COMPANY_NAME;
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

describe('company details, lookup mode and version (design doc §H.4)', () => {
  it('shows the real registered office by default; bank, VAT and ICO stay empty inputs', () => {
    const f = settingsToForm(undefined);
    expect(f.registeredOffice).toBe('44 Syon Lane\nIsleworth\nLondon\nTW7 5NQ');
    expect(linesToAddress(f.registeredOffice)).toEqual(DEFAULT_REGISTERED_OFFICE);
    expect(f.bankAccountName).toBe('');
    expect(f.vatNumber).toBe('');
    expect(f.icoRegistration).toBe('');
    expect(validateSettings(f)).toEqual({});
    expect(COMPANY_DETAILS).toMatchObject({ caseHandlerPhone: '07425 475922', officePhone: '020 7052 5403', claimsEmail: 'claims@courtesycars.net', website: 'www.courtesycars.net' });
    expect(LEGAL_FOOTER).toBe('Courtesy Cars Group UK Ltd · Registered in England & Wales No. 17430389 · 44 Syon Lane, Isleworth, London TW7 5NQ · 020 7052 5403 · 07425 475922');
  });
  it('reads the lookup mode from the API, or from the key flags of an older API', () => {
    expect(lookupModeOf({ lookupMode: 'manual' })).toBe('manual');
    expect(lookupModeOf({ lookupMode: 'live' })).toBe('live');
    expect(lookupModeOf({ apiKeys: { dvlaVes: false, dvsaMot: true, companiesHouse: false, gateway: false } })).toBe('live');
    expect(lookupModeOf({ apiKeys: { dvlaVes: false, dvsaMot: false, companiesHouse: true, gateway: false } })).toBe('manual');
    expect(lookupModeOf(undefined)).toBeUndefined();
    expect(lookupModeLabel('manual')).toBe('Vehicle lookups: Manual (no DVLA/DVSA keys) — searches use ClaimDesk records and Total Car Check');
    expect(lookupModeLabel('live')).toMatch(/^Vehicle lookups: Live/);
  });
  it('links the More settings pages and labels the version', () => {
    expect(MORE_SETTINGS_LINKS.map((l) => [l.to, l.label])).toEqual([
      ['/settings/templates', 'Document templates'],
      ['/settings/gta-rates', 'GTA benchmark rates']
    ]);
    expect(versionLabel('0.2.57')).toBe('ClaimDesk 0.2.57');
    expect(versionLabel(undefined)).toBe('ClaimDesk');
  });
});
