// owned by intake
/**
 * Intake validators (docs/SUPREME-DESIGN.md §G.2 step 4) and the field-target registry (§G.4). Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { FIELD_TARGETS, SENSITIVE_FIELD_TARGETS } from '@ccguk/domain';
import {
  decodeDvlaLicence,
  displayVrm,
  londonLocalToUtc,
  parseDate,
  parseMoneyToPence,
  parseUkAddress,
  parseYearMonth,
  splitName,
  surnameCode,
  validateDateTime,
  validateDvlaLicence,
  validateEmail,
  validateIsoDate,
  validateName,
  validatePostcode,
  validateUkPhone,
  validateVin,
  validateVrm,
  vinCheckDigit,
  vrmFormat,
} from '../intake/validators.js';
import { targetDef, targetDefs } from '../intake/targets.js';

describe('VIN', () => {
  it('accepts 17 characters without I, O, Q and normalises case and spaces', () => {
    expect(validateVin('wvwzzz1jzxw000001')).toMatchObject({ ok: true, value: 'WVWZZZ1JZXW000001' });
    expect(validateVin('WVW ZZZ 1JZ XW000001').ok).toBe(true);
  });
  it('refuses a wrong length or forbidden letters', () => {
    expect(validateVin('WVWZZZ1JZXW00001').errors[0]).toMatch(/17 characters/);
    expect(validateVin('WVWZZZ1JZXWO00001').errors[0]).toMatch(/I, O or Q/);
    expect(validateVin('WVWZZZ1JZXW00000!').ok).toBe(false);
  });
  it('enforces the check digit for North American VINs only', () => {
    // The classic worked example: 1M8GDM9AXKP042788 has check digit X.
    expect(vinCheckDigit('1M8GDM9AXKP042788')).toBe('X');
    expect(validateVin('1M8GDM9AXKP042788')).toMatchObject({ ok: true, notes: ['check digit verified'] });
    expect(validateVin('1M8GDM9A1KP042788').errors[0]).toMatch(/check digit/);
    // European VIN with an arbitrary 9th character: accepted, noted as not applicable.
    expect(validateVin('WVWZZZ1JZXW000001').notes?.[0]).toMatch(/not applicable|consistent/);
  });
});

describe('UK registration marks', () => {
  it('classifies current, prefix, suffix and dateless formats', () => {
    expect(vrmFormat('KX21 ABC')).toBe('current');
    expect(vrmFormat('A123 BCD')).toBe('prefix');
    expect(vrmFormat('ABC 123D')).toBe('suffix');
    expect(vrmFormat('1234 AB')).toBe('dateless');
    expect(vrmFormat('AB 1234')).toBe('dateless');
    expect(vrmFormat('ABCDEFG')).toBeUndefined();
  });
  it('validates and displays', () => {
    expect(validateVrm('kx21abc')).toMatchObject({ ok: true, value: 'KX21ABC', format: 'current' });
    expect(displayVrm('kx21abc')).toBe('KX21 ABC');
    expect(validateVrm('KX01 ABC').ok).toBe(false); // age identifier 01 was never issued
    expect(validateVrm('').ok).toBe(false);
    expect(validateVrm('TOOLONG12').ok).toBe(false);
  });
});

describe('DVLA driving licence numbers', () => {
  // Invented holders; the numbers are built from the published structure.
  it('decodes the structure (surname, decade, month +50 for women, day, year, initials)', () => {
    expect(decodeDvlaLicence('YUSUF954120A99AB')).toMatchObject({ surnameCode: 'YUSUF', birthMonth: 4, birthDay: 12, birthYearDigits: '90', sex: 'female', initials: 'A9' });
    expect(decodeDvlaLicence('OKAFO807305D99XY')).toMatchObject({ birthMonth: 7, birthDay: 30, birthYearDigits: '85', sex: 'male' });
    expect(decodeDvlaLicence('NOT A LICENCE')).toBeUndefined();
  });
  it('cross-checks surname, date of birth, sex and initials', () => {
    expect(validateDvlaLicence('YUSUF954120A99AB', { surname: 'Yusuf', forenames: 'Amina', dateOfBirth: '1990-04-12', sex: 'female' }).ok).toBe(true);
    const wrongDob = validateDvlaLicence('YUSUF954120A99AB', { surname: 'Yusuf', dateOfBirth: '1990-04-13' });
    expect(wrongDob.ok).toBe(false);
    expect(wrongDob.errors.join(' ')).toMatch(/day of birth/);
    expect(validateDvlaLicence('YUSUF954120A99AB', { surname: 'Jones' }).errors[0]).toMatch(/surname/);
    expect(validateDvlaLicence('YUSUF954120A99AB', { sex: 'male' }).errors[0]).toMatch(/encodes a woman/);
    expect(validateDvlaLicence('YUSUF913120A99AB').errors.join(' ')).toMatch(/month of birth/);
    expect(validateDvlaLicence('SHORT').errors[0]).toMatch(/16 characters/);
  });
  it('surname codes pad with 9 and read MAC as MC', () => {
    expect(surnameCode('Li')).toBe('LI999');
    expect(surnameCode('MacDonald')).toBe('MCDON');
    expect(surnameCode("O'Neill")).toBe('ONEIL');
    expect(splitName('Mr John Andrew SMITH')).toEqual({ surname: 'SMITH', forenames: 'John Andrew' });
    expect(splitName('SMITH, John')).toEqual({ surname: 'SMITH', forenames: 'John' });
  });
});

describe('dates and times', () => {
  it('parses ISO, UK day-first and written dates; refuses impossible ones', () => {
    expect(parseDate('2026-10-05')).toBe('2026-10-05');
    expect(parseDate('05/10/2026')).toBe('2026-10-05');
    expect(parseDate('5.10.26')).toBe('2026-10-05');
    expect(parseDate('5th October 2026')).toBe('2026-10-05');
    expect(parseDate('October 5, 2026')).toBe('2026-10-05');
    expect(parseDate('31/02/2026')).toBeUndefined();
    expect(parseDate('yesterday')).toBeUndefined();
    expect(validateIsoDate('01/01/2030', { notAfter: '2026-10-07T00:00:00Z' }).errors[0]).toMatch(/future/);
  });
  it('months of first registration', () => {
    expect(parseYearMonth('03/2021')).toBe('2021-03');
    expect(parseYearMonth('March 2021')).toBe('2021-03');
    expect(parseYearMonth('12/03/2021')).toBe('2021-03');
    expect(parseYearMonth('13/2021')).toBeUndefined();
  });
  it('local times are Europe/London (BST in summer, GMT in winter)', () => {
    expect(londonLocalToUtc('2026-10-05', 14, 30)).toBe('2026-10-05T13:30:00.000Z');
    expect(londonLocalToUtc('2026-12-05', 14, 30)).toBe('2026-12-05T14:30:00.000Z');
    expect(validateDateTime('05/10/2026 14:30')).toMatchObject({ ok: true, value: '2026-10-05T13:30:00.000Z' });
    expect(validateDateTime('05/10/2026 2:30pm').value).toBe('2026-10-05T13:30:00.000Z');
    expect(validateDateTime('2026-10-05T08:15:00Z').value).toBe('2026-10-05T08:15:00.000Z');
    expect(validateDateTime('05/10/2026 25:00').ok).toBe(false);
    expect(validateDateTime('2030-01-01T00:00:00Z', { notAfter: '2026-10-07T00:00:00.000Z' }).ok).toBe(false);
  });
});

describe('money and contact details', () => {
  it('money → integer pence', () => {
    expect(parseMoneyToPence('£1,234.56')).toMatchObject({ ok: true, value: 123456 });
    expect(parseMoneyToPence('12').value).toBe(1200);
    expect(parseMoneyToPence('GBP 99.5').value).toBe(9950);
    expect(parseMoneyToPence('-5').ok).toBe(false);
    expect(parseMoneyToPence('12.345').ok).toBe(false);
  });
  it('postcodes, addresses, phones, emails, names', () => {
    expect(validatePostcode('rg11aa').value).toBe('RG1 1AA');
    expect(parseUkAddress('12 High Street, Reading, RG1 1AA').value).toEqual({ line1: '12 High Street', town: 'Reading', postcode: 'RG1 1AA' });
    expect(parseUkAddress('Flat 2\n7 Mill Lane\nBristol BS1 4XY').value).toEqual({ line1: 'Flat 2', line2: '7 Mill Lane', town: 'Bristol', postcode: 'BS1 4XY' });
    expect(parseUkAddress('somewhere without a postcode').ok).toBe(false);
    expect(validateUkPhone('+44 7700 900123').value).toBe('07700 900123');
    expect(validateUkPhone('12345').ok).toBe(false);
    expect(validateEmail(' A.Person@Example.TEST ').value).toBe('a.person@example.test');
    expect(validateEmail('not-an-email').ok).toBe(false);
    expect(validateName('  Amina   Yusuf ').value).toBe('Amina Yusuf');
    expect(validateName('12345').ok).toBe(false);
  });
});

describe('field targets (§G.4)', () => {
  it('every FieldTarget has a definition; sensitivity follows the domain list', () => {
    expect(targetDefs().map((t) => t.target).sort()).toEqual([...FIELD_TARGETS].sort());
    for (const t of targetDefs()) expect(t.sensitive).toBe(SENSITIVE_FIELD_TARGETS.has(t.target));
    expect(targetDef('party:client.dateOfBirth')?.sensitive).toBe(true);
    expect(targetDef('vehicle:client.vin')?.sensitive).toBe(false);
    expect(targetDef('claim.status')).toBeUndefined();
    expect(targetDef('claim.liability')).toBeUndefined();
  });
  it('validators normalise per target', () => {
    const now = { now: '2026-10-07T09:00:00.000Z' };
    expect(targetDef('vehicle:client.registration')!.validate('kx21abc', now).value).toBe('KX21 ABC');
    expect(targetDef('vehicle:client.firstRegistered')!.validate('12/03/2021', now).value).toBe('2021-03');
    expect(targetDef('party:client.dateOfBirth')!.validate('12/04/1990', now).value).toBe('1990-04-12');
    expect(targetDef('party:client.dateOfBirth')!.validate('12/04/2020', now).ok).toBe(false); // a 6-year-old
    expect(targetDef('party:client.address')!.validate('12a high street, reading, rg1 1aa', now).value).toBe('12a high street, reading, RG1 1AA');
    expect(targetDef('claim.thirdPartyPolicyNumber')!.validate('pol 1234 5678', now).value).toBe('POL12345678');
    expect(targetDef('party:driver.drivingLicenceNumber')!.validate('YUSUF954120A99AB', { ...now, holder: { name: 'Amina Yusuf', dateOfBirth: '1990-04-12' } }).ok).toBe(true);
    expect(targetDef('party:driver.drivingLicenceNumber')!.validate('YUSUF954120A99AB', { ...now, holder: { name: 'Amina Jones' } }).ok).toBe(false);
  });
});
