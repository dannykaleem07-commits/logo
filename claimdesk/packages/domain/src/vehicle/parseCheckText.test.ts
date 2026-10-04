/**
 * Paste parser tests. EVERY FIXTURE HERE IS SYNTHETIC — typed for these tests to imitate the layouts a browser copy
 * produces (label: value, tab-separated table, label line then value line). None is a real Total Car Check page; add a
 * real pasted sample as a fixture when CCGUK sends one (TEMPLATES-VEHICLES-DESKTOP §L.8).
 */
import { describe, expect, it } from 'vitest';
import { parseLooseDate, parseVehicleCheckText, PASTE_MAX_CHARS } from './parseCheckText.js';

const TODAY = '2026-10-04';

/** SYNTHETIC: "Label: Value" lines with page noise (cookie banner, menu, adverts). */
const SYNTHETIC_COLON = `We use cookies to improve your experience. Accept all cookies
Make sure you check the V5C before buying.
Home | Free Check | Full Check | Contact
Vehicle Details
Registration: AB12 CDE
Make: FORD
Model: FIESTA ZETEC
Colour: BLUE
Fuel Type: PETROL
Engine Size: 1,242 cc
BHP: 81 bhp
Year of Manufacture: 2012
Date First Registered: 14 March 2012
Transmission: 5 Speed Manual
CO2 Emissions: 120 g/km
Euro Status: Euro 5
MOT Status: Valid
MOT Expiry Date: 12th Mar 2027
Tax Status: Taxed
Tax Due: 01/04/2027
Last MOT Mileage: 48,210 miles
Average Mileage: 7,500 miles per year
VIN: WF0DXXGAKDCA12345
Get the full history for £9.99`;

/** SYNTHETIC: a copied two-column web table (label TAB value), several pairs on one line too. */
const SYNTHETIC_TABS = [
  'Vehicle Make\tVOLKSWAGEN\tVehicle Model\tGOLF MATCH TDI',
  'Colour\tGREY',
  'Fuel\tDiesel',
  'Engine Capacity\t1598cc',
  'Power\t110 PS',
  'Gearbox\tDSG',
  'Number of Doors\t5',
  'Seats\t5',
  'Body Style\tHatchback',
  'Registered Date\t2016-09-01',
  'MOT Expires\t30 September 2027',
  'Road Tax\tSORN',
].join('\n');

/** SYNTHETIC: label on one line, value on the next (Windows line endings, NBSP and zero-width characters). */
const SYNTHETIC_LINES = ['Make', 'TOYOTA', 'Model', 'Yaris Icon', 'Fuel type', 'Petrol/Electric', 'First Registered', 'March 2019', 'Engine size', '1.5 litres', 'Transmission', 'CVT', 'MOT', 'Expired', 'Tax Status', 'Untaxed​'].join('\r\n');

describe('parseVehicleCheckText — layouts (synthetic fixtures)', () => {
  it('reads "Label: Value" lines and ignores page noise', () => {
    const r = parseVehicleCheckText(SYNTHETIC_COLON, { expectedRegistration: 'ab12cde', today: TODAY });
    expect(r.fields).toEqual({
      registration: 'AB12CDE',
      make: 'FORD',
      model: 'FIESTA ZETEC',
      colour: 'Blue',
      fuelType: 'petrol',
      engineCapacityCc: 1242,
      powerBhp: 81,
      yearOfManufacture: 2012,
      monthOfFirstRegistration: '2012-03',
      firstRegisteredDate: '2012-03-14',
      transmission: 'manual',
      co2Gkm: 120,
      euroStatus: 'Euro 5',
      motStatus: 'Valid',
      motExpiryDate: '2027-03-12',
      taxStatus: 'Taxed',
      taxDueDate: '2027-04-01',
      lastMotMileage: 48210,
      vin: 'WF0DXXGAKDCA12345',
    });
    expect(r.warnings).toEqual([]);
    expect(r.unmatchedLines).toEqual(expect.arrayContaining(['We use cookies to improve your experience. Accept all cookies', 'Make sure you check the V5C before buying.', 'Average Mileage: 7,500 miles per year', 'Get the full history for £9.99']));
    expect(r.matches.find((m) => m.field === 'make')).toEqual({ field: 'make', label: 'Make', raw: 'FORD', line: 6 });
  });

  it('reads tab-separated tables, several pairs per line', () => {
    const r = parseVehicleCheckText(SYNTHETIC_TABS, { today: TODAY });
    expect(r.fields).toMatchObject({
      make: 'VOLKSWAGEN',
      model: 'GOLF MATCH TDI',
      colour: 'Grey',
      fuelType: 'diesel',
      engineCapacityCc: 1598,
      powerBhp: 108, // 110 PS × 0.986
      transmission: 'automatic',
      doors: 5,
      seats: 5,
      bodyType: 'Hatchback',
      firstRegisteredDate: '2016-09-01',
      monthOfFirstRegistration: '2016-09',
      motExpiryDate: '2027-09-30',
      taxStatus: 'SORN',
    });
    expect(r.unmatchedLines).toEqual([]);
  });

  it('reads a label line followed by a value line; month-only dates; litres with a warning', () => {
    const r = parseVehicleCheckText(SYNTHETIC_LINES, { today: TODAY });
    expect(r.fields).toMatchObject({
      make: 'TOYOTA',
      model: 'Yaris Icon',
      fuelType: 'hybrid',
      monthOfFirstRegistration: '2019-03',
      engineCapacityCc: 1500,
      transmission: 'automatic',
      motStatus: 'Expired',
      taxStatus: 'Untaxed',
    });
    expect(r.fields.firstRegisteredDate).toBeUndefined();
    expect(r.warnings).toContain('Engine size given in litres — approximate');
  });

  it('reads a mixed free-check style page (synthetic: label lines, value lines, table rows, unit suffixes)', () => {
    const page = ['Free Car Check', 'AB12 CDE', 'Make', 'FORD', 'Model', 'FIESTA', 'Vehicle Age', '14 years 6 months', 'Engine Size (cc)', '1242', 'Tax Status', 'Taxed\tTax Due\t01 April 2027', 'MOT Status\tValid', 'Average Mileage\t7,500', 'Mileage Last Recorded\t48,210'].join('\n');
    const r = parseVehicleCheckText(page, { today: TODAY });
    expect(r.fields).toEqual({ make: 'FORD', model: 'FIESTA', engineCapacityCc: 1242, taxStatus: 'Taxed', taxDueDate: '2027-04-01', motStatus: 'Valid', lastMotMileage: 48210 });
    expect(r.unmatchedLines).toEqual(['Free Car Check', 'AB12 CDE', 'Vehicle Age', '14 years 6 months', 'Average Mileage 7,500']);
  });

  it('reads "Label Value" when the label is a known phrase at the start of the line', () => {
    const r = parseVehicleCheckText('Colour RED\nFuel Type DIESEL\nDoors 3\nMOT Status Valid\nMOT Valid until 12 March 2027\nMOT tests passed 8', { today: TODAY });
    expect(r.fields).toEqual({ colour: 'Red', fuelType: 'diesel', doors: 3, motStatus: 'Valid', motExpiryDate: '2027-03-12' });
    expect(r.unmatchedLines).toEqual(['MOT tests passed 8']);
  });
});

describe('parseVehicleCheckText — value parsers (synthetic)', () => {
  it('maps fuel synonyms', () => {
    const fuel = (v: string) => parseVehicleCheckText(`Fuel: ${v}`).fields.fuelType;
    expect(fuel('Petrol')).toBe('petrol');
    expect(fuel('DIESEL')).toBe('diesel');
    expect(fuel('Hybrid Electric')).toBe('hybrid');
    expect(fuel('Diesel/Electric')).toBe('hybrid');
    expect(fuel('Plug-in Hybrid')).toBe('plugin_hybrid');
    expect(fuel('PHEV')).toBe('plugin_hybrid');
    expect(fuel('Electricity')).toBe('electric');
    expect(fuel('EV')).toBe('electric');
    expect(fuel('LPG')).toBe('lpg');
    expect(fuel('banana')).toBeUndefined();
  });

  it('maps transmission synonyms', () => {
    const t = (v: string) => parseVehicleCheckText(`Transmission: ${v}`).fields.transmission;
    expect(t('Manual')).toBe('manual');
    expect(t('6 Speed Manual')).toBe('manual');
    expect(t('Automatic')).toBe('automatic');
    expect(t('Auto')).toBe('automatic');
    expect(t('Semi-Auto')).toBe('automatic');
    expect(t('7 speed DSG')).toBe('automatic');
  });

  it('converts PS to bhp (× 0.986, rounded) and keeps bhp as given', () => {
    expect(parseVehicleCheckText('Power: 150 PS').fields.powerBhp).toBe(148);
    expect(parseVehicleCheckText('Max Power: 118 bhp').fields.powerBhp).toBe(118);
  });

  it('reads MOT and tax status with dates', () => {
    const r = parseVehicleCheckText('MOT: Valid until 12 March 2027\nTax: Taxed (due 1st April 2027)');
    expect(r.fields).toMatchObject({ motStatus: 'Valid', motExpiryDate: '2027-03-12', taxStatus: 'Taxed', taxDueDate: '2027-04-01' });
    const e = parseVehicleCheckText('MOT Expiry: Expired 02/01/2026\nTax Status: SORN');
    expect(e.fields).toMatchObject({ motStatus: 'Expired', motExpiryDate: '2026-01-02', taxStatus: 'SORN' });
  });

  it('reads last MOT date and mileage, converting kilometres', () => {
    const r = parseVehicleCheckText('Last MOT: 10 May 2026 (41,230 miles)');
    expect(r.fields).toMatchObject({ lastMotDate: '2026-05-10', lastMotMileage: 41230 });
    const k = parseVehicleCheckText('Odometer: 100,000 km');
    expect(k.fields.lastMotMileage).toBe(62137);
    expect(k.warnings).toContain('Mileage given in kilometres — converted to miles');
  });

  it('ignores a masked or partial VIN with a warning', () => {
    const r = parseVehicleCheckText('VIN: WF0DXXGAKD*****45');
    expect(r.fields.vin).toBeUndefined();
    expect(r.warnings.some((w) => /masked VIN/.test(w))).toBe(true);
    const s = parseVehicleCheckText('VIN Number: WF0DXX');
    expect(s.fields.vin).toBeUndefined();
    expect(s.warnings.some((w) => /17-character/.test(w))).toBe(true);
  });

  it('warns when the pasted registration differs from the one searched', () => {
    const r = parseVehicleCheckText('Registration Number: CD34 EFG\nMake: VAUXHALL', { expectedRegistration: 'AB12 CDE' });
    expect(r.fields.registration).toBe('CD34EFG');
    expect(r.warnings).toContain('The pasted registration CD34EFG differs from AB12CDE');
  });

  it('keeps the first value of a field and warns about a later conflicting one', () => {
    const r = parseVehicleCheckText('Colour: Blue\nBody Colour: Red');
    expect(r.fields.colour).toBe('Blue');
    expect(r.warnings.some((w) => w.includes('colour'))).toBe(true);
  });

  it('rejects implausible years', () => {
    expect(parseVehicleCheckText('Year of Manufacture: 1890', { today: TODAY }).fields.yearOfManufacture).toBeUndefined();
    expect(parseVehicleCheckText('Year of Manufacture: 2028', { today: TODAY }).fields.yearOfManufacture).toBeUndefined();
    expect(parseVehicleCheckText('Year of Manufacture: 2027', { today: TODAY }).fields.yearOfManufacture).toBe(2027);
  });

  it('caps the input at 20 000 characters', () => {
    const r = parseVehicleCheckText(`${'x'.repeat(PASTE_MAX_CHARS + 50)}\nMake: FORD`);
    expect(r.fields.make).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('20,000'))).toBe(true);
  });

  it('copes with empty input', () => {
    expect(parseVehicleCheckText('')).toEqual({ fields: {}, matches: [], unmatchedLines: [], warnings: [] });
  });
});

describe('parseLooseDate', () => {
  it.each([
    ['12 March 2027', '2027-03-12', '2027-03'],
    ['12th Mar 2027', '2027-03-12', '2027-03'],
    ['12/03/2027', '2027-03-12', '2027-03'],
    ['2027-03-12', '2027-03-12', '2027-03'],
    ['March 12, 2027', '2027-03-12', '2027-03'],
    ['March 2019', undefined, '2019-03'],
    ['03/2019', undefined, '2019-03'],
  ])('%s', (text, date, month) => {
    const d = parseLooseDate(text);
    expect(d?.date).toBe(date);
    expect(d?.month).toBe(month);
  });
  it('rejects impossible dates', () => {
    expect(parseLooseDate('31/02/2027')).toBeUndefined();
  });
});
