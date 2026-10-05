import { describe, expect, it } from 'vitest';
import type { OnFileMatch, Vehicle } from '@ccguk/domain';
import { parseVehicleCheckText } from '@ccguk/domain';
import type { CatalogueMakeSummary, CatalogueModelSummary, FeatureVocabulary, NormalisedModel } from '../../api/vehiclesApi';
import { identificationRows } from '../claim/lib/vehicle';
import {
  applyOnFile,
  applyParsed,
  bodyOptions,
  bodyOptionValue,
  clearAfter,
  customEntryBody,
  defaultParsedSelection,
  effectiveSource,
  emptyPickerValue,
  engineOptions,
  featureLabels,
  filterVocabulary,
  findMake,
  findModel,
  fuelOptions,
  generationOptions,
  linkToCatalogue,
  modelWithoutRemainder,
  parseBodyOption,
  parsedRecordFields,
  parsedRows,
  patchHasChanges,
  pickerFromVehicle,
  resolveFromModel,
  setBody,
  setEngine,
  setFuel,
  setGeneration,
  setMake,
  setModel,
  setTransmission,
  setTrim,
  setTrimFree,
  setYear,
  toSpec,
  toVehicleInput,
  transmissionOptions,
  trimInVariant,
  trimOptions,
  validatePicker,
  vehiclePatchFrom,
  yearOptions,
  type VehiclePickerValue
} from './vehiclePickerModel';

// ---------------------------------------------------------------------------
// Fixtures (synthetic, in the normalised shape GET /catalogue/makes/:make/models/:model returns)
// ---------------------------------------------------------------------------

const FIESTA: NormalisedModel = {
  name: 'Fiesta',
  slug: 'fiesta',
  aliases: ['Fiesta ST'],
  vehicleType: 'car',
  segment: 'supermini',
  years: { from: 2008, to: 2023 },
  makeSlug: 'ford',
  generations: [
    {
      id: 'ford-fiesta-mk7-2008-2017',
      name: 'Mk7 (2008–2017)',
      from: 2008,
      to: 2017,
      bodies: [{ body: 'hatchback', doors: [3, 5], seats: [5] }],
      trims: [
        { id: 'zetec', name: 'Zetec' },
        { id: 'titanium', name: 'Titanium' }
      ],
      engines: [{ id: '1-25-82ps-petrol', label: '1.25 82PS petrol', cc: 1250, ccApprox: true, fuel: 'petrol', domainFuel: 'petrol', powerPs: 82 }],
      fuels: ['petrol'],
      transmissions: ['manual']
    },
    {
      id: 'ford-fiesta-mk8-2017-2023',
      name: 'Mk8 (2017–2023)',
      from: 2017,
      to: 2023,
      bodies: [
        { body: 'hatchback', doors: [3, 5], seats: [5] },
        { body: 'estate', doors: [5], seats: [5] }
      ],
      trims: [
        { id: 'trend', name: 'Trend', features: ['dab'] },
        { id: 'zetec', name: 'Zetec', features: ['dab', 'sat_nav'] },
        { id: 'st-3', name: 'ST-3', from: 2018, bodies: ['hatchback'], engines: ['1.5 EcoBoost 200PS petrol'], features: ['sat_nav', 'heated_seats_front'], gtaGroup: 'S3' }
      ],
      engines: [
        { id: '1-0-ecoboost-100ps-petrol', label: '1.0 EcoBoost 100PS petrol', cc: 999, fuel: 'petrol', domainFuel: 'petrol', powerPs: 100, transmissions: ['manual', 'automatic'] },
        { id: '1-0-ecoboost-125ps-mild-hybrid-petrol', label: '1.0 EcoBoost 125PS mild-hybrid petrol', cc: 999, fuel: 'mild-hybrid', domainFuel: 'petrol', mildHybrid: true, powerPs: 125, from: 2020 },
        { id: '1-5-ecoboost-200ps-petrol', label: '1.5 EcoBoost 200PS petrol', cc: 1497, fuel: 'petrol', domainFuel: 'petrol', powerPs: 200, transmissions: ['manual'] },
        { id: '1-5-tdci-85ps-diesel', label: '1.5 TDCi 85PS diesel', cc: 1499, fuel: 'diesel', domainFuel: 'diesel', powerPs: 85, to: 2019 }
      ],
      fuels: ['petrol', 'mild-hybrid', 'diesel'],
      transmissions: ['manual', 'automatic']
    }
  ]
};

const MAKES: CatalogueMakeSummary[] = [
  { slug: 'ford', make: 'Ford', dvlaNames: ['FORD'], aliases: [], modelCount: 3, years: { from: 2000, to: null }, vehicleTypes: ['car', 'van'] },
  { slug: 'mercedes-benz', make: 'Mercedes-Benz', dvlaNames: ['MERCEDES-BENZ', 'MERCEDES'], aliases: ['Merc'], modelCount: 40, years: { from: 2000, to: null }, vehicleTypes: ['car', 'van'] },
  { slug: 'citroen', make: 'Citroën', dvlaNames: ['CITROEN'], aliases: [], modelCount: 20, years: { from: 2000, to: null }, vehicleTypes: ['car'] }
];

const MODELS: CatalogueModelSummary[] = [
  { makeSlug: 'ford', slug: 'fiesta', name: 'Fiesta', vehicleType: 'car', segment: 'supermini', years: { from: 2008, to: 2023 }, bodies: ['hatchback', 'estate'] },
  { makeSlug: 'ford', slug: 'transit-custom', name: 'Transit Custom', vehicleType: 'van', segment: 'van-medium', years: { from: 2013, to: null }, bodies: ['panel-van'] }
];

const VOCAB: FeatureVocabulary = {
  schemaVersion: 1,
  categories: [
    { id: 'infotainment', label: 'Infotainment', items: [{ id: 'sat_nav', label: 'Satellite navigation', aliases: ['Sat nav'], kind: 'both' }, { id: 'dab', label: 'DAB radio', kind: 'feature' }] },
    { id: 'towing_load', label: 'Towing and load', items: [{ id: 'tow_bar', label: 'Tow bar', kind: 'extra' }] }
  ]
};

/** A Fiesta picked through the cascade down to the trim. */
function picked(): VehiclePickerValue {
  let v = emptyPickerValue('AB12CDE');
  v = setMake(v, 'Ford');
  v = setYear(v, 2019);
  v = setModel(v, MODELS[0]!, 'ford');
  v = setGeneration(v, 'ford-fiesta-mk8-2017-2023', FIESTA);
  v = setBody(v, parseBodyOption('hatchback|5'), FIESTA);
  v = setFuel(v, 'petrol', FIESTA);
  v = setEngine(v, '1-0-ecoboost-100ps-petrol', FIESTA);
  v = setTransmission(v, 'manual', FIESTA);
  v = setTrim(v, 'zetec', FIESTA);
  return v;
}

// ---------------------------------------------------------------------------

describe('make / model resolution', () => {
  it('finds a make by name, DVLA spelling, alias or without accents', () => {
    expect(findMake(MAKES, 'ford')?.slug).toBe('ford');
    expect(findMake(MAKES, 'MERCEDES')?.slug).toBe('mercedes-benz');
    expect(findMake(MAKES, 'merc')?.slug).toBe('mercedes-benz');
    expect(findMake(MAKES, 'CITROEN')?.slug).toBe('citroen');
    expect(findMake(MAKES, 'Opel')).toBeUndefined();
    expect(findModel(MODELS, 'transit custom')?.slug).toBe('transit-custom');
  });
});

describe('cascade', () => {
  it('picks make → year → model → generation → body → fuel → engine → transmission → trim', () => {
    const v = picked();
    expect(v).toMatchObject({
      make: 'Ford',
      model: 'Fiesta',
      yearOfManufacture: 2019,
      segment: 'supermini',
      bodyType: 'Hatchback',
      doors: 5,
      seats: 5,
      fuelType: 'petrol',
      engineCapacityCc: 999,
      powerPs: 100,
      transmission: 'manual',
      variant: 'Zetec',
      catalogue: { makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk8-2017-2023', engineId: '1-0-ecoboost-100ps-petrol', trimId: 'zetec' }
    });
    // picking the trim pre-ticks its standard features
    expect(v.features).toEqual(['dab', 'sat_nav']);
    expect(v.source.provider).toBe('catalogue');
  });

  it('changing a step clears the later ones', () => {
    const v = picked();
    const gen = setGeneration(v, 'ford-fiesta-mk7-2008-2017', FIESTA);
    expect(gen.catalogue).toEqual({ makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk7-2008-2017' });
    // the Mk8 engine and trim ids go; body, fuel and gearbox that the Mk7 also offers stay
    expect(gen).toMatchObject({ bodyType: 'Hatchback', doors: 5, fuelType: 'petrol', engineCapacityCc: undefined, powerPs: undefined, transmission: 'manual', variant: '' });
    expect(gen.features).toEqual([]); // the Zetec's pre-ticked features go with the trim
    expect(gen.make).toBe('Ford');
    expect(gen.yearOfManufacture).toBe(2019);

    // a petrol engine does not fit diesel; the gearbox and the Zetec trim are still on offer and stay
    const fuel = setFuel(v, 'diesel', FIESTA);
    expect(fuel).toMatchObject({ fuelType: 'diesel', engineCapacityCc: undefined, powerPs: undefined, transmission: 'manual', variant: 'Zetec', bodyType: 'Hatchback' });
    expect(fuel.catalogue?.engineId).toBeUndefined();
    expect(fuel.catalogue?.trimId).toBe('zetec');
    // the estate has no ST-3: picking it clears that trim and its features
    const st3 = setTrim(setEngine(v, '1-5-ecoboost-200ps-petrol', FIESTA), 'st-3', FIESTA);
    const estate = setBody(st3, parseBodyOption('estate|5'), FIESTA);
    expect(estate.catalogue?.trimId).toBeUndefined();
    expect(estate.variant).toBe('');
    expect(estate.features).not.toContain('heated_seats_front');

    const make = setMake(v, 'Vauxhall');
    expect(make).toMatchObject({ make: 'Vauxhall', model: '', catalogue: undefined, segment: undefined, yearOfManufacture: undefined, variant: '' });
    expect(make.source.provider).toBe('manual');

    const year = setYear(v, 2016, FIESTA);
    expect(year).toMatchObject({ yearOfManufacture: 2016, model: '', catalogue: undefined });

    // re-typing the same make in another case keeps everything
    expect(setMake(v, 'FORD').model).toBe('Fiesta');
    // same value → same object
    expect(setFuel(v, 'petrol', FIESTA)).toBe(v);
    expect(clearAfter(v, 'trim', FIESTA)).toEqual(v);
  });

  it('extras and hand-ticked features survive a trim change; the previous trim’s features are taken back', () => {
    let v = picked();
    v = { ...v, features: [...v.features, 'heated_steering_wheel'], extras: ['tow_bar'] };
    const trend = setTrim(v, 'trend', FIESTA);
    expect(trend.variant).toBe('Trend');
    expect(trend.features).toEqual(['heated_steering_wheel', 'dab']);
    expect(trend.extras).toEqual(['tow_bar']);
    const typed = setTrimFree(v, 'Zetec Edition');
    expect(typed.variant).toBe('Zetec Edition');
    expect(setTrimFree(v, 'Zetec Edition', FIESTA).catalogue?.trimId).toBeUndefined();
    expect(setTrimFree(v, 'Zetec Edition', FIESTA).features).toEqual(['heated_steering_wheel']);
  });

  it('a typed model drops the catalogue pick and becomes a manual source', () => {
    const v = setModel(picked(), 'Fiesta Van', undefined, FIESTA);
    expect(v.catalogue).toBeUndefined();
    expect(v.segment).toBeUndefined();
    expect(v.source.provider).toBe('manual');
  });
});

describe('options from a NormalisedModel', () => {
  it('generations for the year (all when none match)', () => {
    expect(generationOptions(FIESTA, 2019).map((o) => o.value)).toEqual(['ford-fiesta-mk8-2017-2023']);
    expect(generationOptions(FIESTA, 2017).map((o) => o.value)).toEqual(['ford-fiesta-mk7-2008-2017', 'ford-fiesta-mk8-2017-2023']);
    expect(generationOptions(FIESTA, 2030)).toHaveLength(2);
    expect(generationOptions(undefined, 2019)).toEqual([]);
  });
  it('bodies with doors, round-tripping the option value', () => {
    const opts = bodyOptions(FIESTA, 'ford-fiesta-mk8-2017-2023');
    expect(opts.map((o) => o.label)).toEqual(['Hatchback, 3 doors', 'Hatchback, 5 doors', 'Estate, 5 doors']);
    expect(parseBodyOption('estate|5')).toEqual({ bodyType: 'Estate', doors: 5 });
    expect(bodyOptionValue({ bodyType: 'Estate', doors: 5 })).toBe('estate|5');
    expect(bodyOptionValue({ bodyType: 'HATCHBACK', doors: 3 })).toBe('hatchback|3');
  });
  it('fuels, engines and transmissions follow the year and the engine', () => {
    const gen = 'ford-fiesta-mk8-2017-2023';
    expect(fuelOptions(FIESTA, gen, 2021).map((o) => o.value)).toEqual(['petrol']); // the diesel ended in 2019
    expect(fuelOptions(FIESTA, gen, 2018).map((o) => o.value)).toEqual(['petrol', 'diesel']);
    expect(engineOptions(FIESTA, gen, { fuel: 'petrol', year: 2018 }).map((o) => o.value)).toEqual(['1-0-ecoboost-100ps-petrol', '1-5-ecoboost-200ps-petrol']);
    expect(engineOptions(FIESTA, gen, { fuel: 'petrol', year: 2021 })).toHaveLength(3); // mild hybrid from 2020
    expect(transmissionOptions(FIESTA, gen, '1-5-ecoboost-200ps-petrol').map((o) => o.value)).toEqual(['manual']);
    expect(transmissionOptions(FIESTA, gen).map((o) => o.value)).toEqual(['manual', 'automatic']);
  });
  it('trims narrowed by body, engine and year', () => {
    const gen = 'ford-fiesta-mk8-2017-2023';
    expect(trimOptions(FIESTA, gen).map((o) => o.label)).toEqual(['Trend', 'Zetec', 'ST-3']);
    expect(trimOptions(FIESTA, gen, { bodyType: 'Estate' }).map((o) => o.label)).toEqual(['Trend', 'Zetec']);
    expect(trimOptions(FIESTA, gen, { engineId: '1-0-ecoboost-100ps-petrol' }).map((o) => o.label)).toEqual(['Trend', 'Zetec']);
    expect(trimOptions(FIESTA, gen, { year: 2017 }).map((o) => o.label)).toEqual(['Trend', 'Zetec']);
  });
  it('years follow the make', () => {
    const years = yearOptions(MAKES[0], '2026-10-04');
    expect(years[0]).toEqual({ value: '2026', label: '2026' });
    expect(years.at(-1)?.value).toBe('2000');
    expect(yearOptions(undefined, '2026-10-04', 1985).at(-1)?.value).toBe('1985');
  });
});

describe('resolveFromModel', () => {
  it('fills the generation, trim and engine a paste implies, and leaves a settled value alone', () => {
    const v: VehiclePickerValue = { ...emptyPickerValue('AB12CDE'), make: 'Ford', model: 'Fiesta', variant: 'zetec', yearOfManufacture: 2019, engineCapacityCc: 998, fuelType: 'petrol', powerPs: 99, catalogue: { makeSlug: 'ford', modelSlug: 'fiesta' }, source: { provider: 'totalcarcheck_manual' } };
    const r = resolveFromModel(v, FIESTA);
    expect(r.catalogue).toEqual({ makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk8-2017-2023', trimId: 'zetec', engineId: '1-0-ecoboost-100ps-petrol' });
    expect(r).toMatchObject({ variant: 'Zetec', segment: 'supermini', features: ['dab', 'sat_nav'], source: { provider: 'totalcarcheck_manual' } });
    expect(resolveFromModel(r, FIESTA)).toBe(r);
    // two engines fit 999 cc without a power figure: none is guessed
    const ambiguous = resolveFromModel({ ...v, powerPs: undefined, yearOfManufacture: 2021, variant: '' }, FIESTA);
    expect(ambiguous.catalogue?.engineId).toBeUndefined();
  });
});

describe('applyParsed (Total Car Check paste)', () => {
  // Synthetic paste in the copied-table layout with page noise; not a real Total Car Check page.
  const TEXT = [
    'Accept all cookies',
    'Make\tFORD',
    'Model\tFIESTA ZETEC',
    'Colour\tBLUE',
    'Fuel Type\tPETROL',
    'Engine Size\t998 cc',
    'BHP\t99 bhp',
    'Year of Manufacture\t2019',
    'Date First Registered\t14 March 2019',
    'Tax Status\tTaxed',
    'Tax Due\t1 April 2027',
    'MOT Expiry\t13 March 2027',
    'CO2 Emissions\t104 g/km',
    'Registration\tAB12CDE'
  ].join('\n');
  const parsed = parseVehicleCheckText(TEXT, { expectedRegistration: 'AB12CDE', today: '2026-10-04' });

  it('lists the parsed fields and ticks the applicable ones', () => {
    const rows = parsedRows(parsed);
    expect(rows.map((r) => r.field)).toEqual(expect.arrayContaining(['make', 'model', 'colour', 'fuelType', 'engineCapacityCc', 'powerBhp', 'registration']));
    expect(rows.find((r) => r.field === 'registration')?.applicable).toBe(false);
    expect(rows.find((r) => r.field === 'engineCapacityCc')?.value).toBe('998 cc');
    expect(defaultParsedSelection(parsed)).not.toContain('registration');
  });

  it('applies the ticked fields, splits model and trim with the catalogue match and records the paste as the source', () => {
    const start = { ...picked(), colour: 'Red' };
    const v = applyParsed(start, parsed, {
      match: { makeSlug: 'ford', modelSlug: 'fiesta', variantRemainder: 'Zetec', makeName: 'Ford', modelName: 'Fiesta' },
      url: 'https://totalcarcheck.co.uk/FreeCheck?regno=AB12CDE',
      pastedText: TEXT
    });
    expect(v).toMatchObject({ make: 'Ford', model: 'Fiesta', variant: 'Zetec', colour: 'Blue', fuelType: 'petrol', engineCapacityCc: 998, yearOfManufacture: 2019, monthOfFirstRegistration: '2019-03', taxDueDate: '2027-04-01', motExpiryDate: '2027-03-13', powerPs: 100 });
    expect(v.registration).toBe('AB12CDE');
    expect(v.source).toMatchObject({ provider: 'totalcarcheck_manual', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=AB12CDE', pastedText: TEXT });
    expect(v.source.appliedFields).toEqual(expect.arrayContaining(['make', 'model', 'variant', 'colour', 'engineCapacityCc', 'powerPs', 'co2Gkm', 'taxStatus']));
    expect(v.source.parsed).toMatchObject({ make: expect.any(String), co2Gkm: 104 });
    // same make/model: the catalogue pick stays, the pasted engine figures drop the engine id
    expect(v.catalogue?.modelSlug).toBe('fiesta');
    expect(v.catalogue?.engineId).toBeUndefined();
    // record-only fields go to the vehicle record
    expect(parsedRecordFields(v.source)).toEqual({ co2Gkm: 104, taxStatus: 'Taxed' });
  });

  it('only the ticked fields are applied; a different model restarts the catalogue pick', () => {
    const v = applyParsed(picked(), parsed, { selected: ['colour'] });
    expect(v.colour).toBe('Blue');
    expect(v.model).toBe('Fiesta');
    expect(v.source.appliedFields).toEqual(['colour']);
    const other = parseVehicleCheckText('Make: FORD\nModel: KUGA TITANIUM', { today: '2026-10-04' });
    const k = applyParsed(picked(), other, {});
    expect(k.model).toMatch(/kuga titanium/i);
    expect(k.catalogue).toBeUndefined();
    expect(k.variant).toBe('');
    expect(modelWithoutRemainder('Fiesta Zetec', 'Zetec')).toBe('Fiesta');
  });
});

describe('applyOnFile / pickerFromVehicle', () => {
  it('fills the value from a vehicle on file, spec included', () => {
    const m: OnFileMatch = {
      vehicleId: 'veh-1',
      registration: 'AB12CDF',
      match: 'partial',
      make: 'FORD',
      model: 'FIESTA',
      variant: 'ZETEC',
      colour: 'BLUE',
      yearOfManufacture: 2018,
      fuelType: 'petrol',
      transmission: 'manual',
      engineCapacityCc: 999,
      spec: { catalogue: { makeSlug: 'ford', modelSlug: 'fiesta' }, segment: 'supermini', doors: 5, features: ['dab'], extras: ['tow_bar'] },
      ownership: 'client',
      claims: [],
      lookups: []
    };
    const v = applyOnFile({ ...picked(), vin: 'WF0XXXGCDX1234567', motExpiryDate: '2027-01-01' }, m);
    expect(v).toMatchObject({ registration: 'AB12CDF', make: 'FORD', model: 'FIESTA', variant: 'ZETEC', doors: 5, segment: 'supermini', features: ['dab'], extras: ['tow_bar'], catalogue: { makeSlug: 'ford', modelSlug: 'fiesta' } });
    expect(v.vin).toBeUndefined(); // a different registration: details not carried over
    expect(v.motExpiryDate).toBeUndefined();
    expect(v.source.provider).toBe('catalogue');
    expect(applyOnFile(emptyPickerValue(), { ...m, make: 'UNKNOWN', model: 'UNKNOWN', spec: undefined }).make).toBe('');
  });
  it('builds the edit value from a Vehicle', () => {
    const vehicle: Vehicle = { id: 'v1', registration: 'AB12CDE', make: 'FORD', model: 'FOCUS', variant: 'ST-LINE', colour: 'GREY', fuelType: 'petrol', odometer: [], ownership: 'client', lookups: [], createdAt: '2026-01-01T00:00:00Z', spec: { features: ['dab'], extras: [], seats: 5, powerPs: 125 } };
    expect(pickerFromVehicle(vehicle)).toMatchObject({ registration: 'AB12CDE', make: 'FORD', model: 'FOCUS', variant: 'ST-LINE', colour: 'GREY', seats: 5, powerPs: 125, features: ['dab'], source: { provider: 'manual' } });
  });
});

describe('toSpec / toVehicleInput / vehiclePatchFrom', () => {
  it('spec carries the catalogue ids, segment, doors, seats, power and equipment', () => {
    const v = { ...picked(), extras: ['tow_bar', 'tow_bar'] };
    expect(toSpec(v)).toEqual({
      catalogue: { makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk8-2017-2023', engineId: '1-0-ecoboost-100ps-petrol', trimId: 'zetec' },
      segment: 'supermini',
      doors: 5,
      seats: 5,
      powerPs: 100,
      features: ['dab', 'sat_nav'],
      extras: ['tow_bar']
    });
    expect(toSpec({ ...emptyPickerValue(), doors: 0, powerPs: 1.5 })).toEqual({ features: [], extras: [] });
  });
  it('vehicle input: normalised registration, picker fields, spec and source — never a verification', () => {
    const input = toVehicleInput({ ...picked(), registration: 'ab12 cde', vin: 'wf0x xxgc dx12 34567', monthOfFirstRegistration: '2019-03' }, { ownership: 'fleet' });
    expect(input).toMatchObject({ registration: 'AB12CDE', make: 'Ford', model: 'Fiesta', variant: 'Zetec', bodyType: 'Hatchback', engineCapacityCc: 999, vin: 'WF0XXXGCDX1234567', monthOfFirstRegistration: '2019-03', ownership: 'fleet', source: { provider: 'catalogue' } });
    expect(input.spec?.catalogue?.trimId).toBe('zetec');
    expect(JSON.stringify(input)).not.toMatch(/verif/);
    const bare = toVehicleInput({ ...emptyPickerValue('AB12CDE'), make: 'Ford', model: 'Ka' });
    expect(bare).toEqual({ registration: 'AB12CDE', make: 'Ford', model: 'Ka', source: { provider: 'manual' } });
    expect(effectiveSource({ ...bare, ...emptyPickerValue(), source: { provider: 'catalogue' } })).toEqual({ provider: 'manual' });
  });
  it('patch: only what changed, null to clear, spec when it changed', () => {
    const initial = picked();
    expect(patchHasChanges(vehiclePatchFrom(initial, initial))).toBe(false);
    const next = { ...initial, colour: 'Blue', variant: '', extras: ['tow_bar'], make: '' };
    const body = vehiclePatchFrom(initial, next);
    expect(body).toMatchObject({ colour: 'Blue', variant: null, source: { provider: 'catalogue' } });
    expect(body.spec?.extras).toEqual(['tow_bar']);
    expect('make' in body).toBe(false); // make cannot be cleared
    const cleared = vehiclePatchFrom({ ...emptyPickerValue(), features: ['dab'] }, emptyPickerValue());
    expect(cleared.spec).toBeNull();
  });
  it('validates year, engine size, power, month and VIN', () => {
    expect(validatePicker(emptyPickerValue(), { requireMakeModel: true })).toEqual({ make: expect.any(String), model: expect.any(String) });
    const e = validatePicker({ ...emptyPickerValue(), yearOfManufacture: 1900, engineCapacityCc: 1.6, powerPs: 0, monthOfFirstRegistration: '2019-13', vin: 'ABC' }, { today: '2026-10-04' });
    expect(Object.keys(e).sort()).toEqual(['engineCapacityCc', 'monthOfFirstRegistration', 'powerPs', 'vin', 'yearOfManufacture']);
  });
});

describe('add to catalogue', () => {
  it('builds the custom entry for each level, needing the parents first', () => {
    const v = picked();
    expect(customEntryBody('make', v, ' Genesis ')).toEqual({ ok: true, body: { level: 'make', make: 'Genesis', name: 'Genesis' } });
    expect(customEntryBody('model', { ...v, segment: 'suv-small' }, 'Puma Gen-E')).toMatchObject({ ok: true, body: { level: 'model', make: 'Ford', model: 'Puma Gen-E', name: 'Puma Gen-E', segment: 'suv-small', data: { years: { from: 2019, to: null } } } });
    expect(customEntryBody('trim', v, 'Active X')).toEqual({ ok: true, body: { level: 'trim', make: 'Ford', model: 'Fiesta', generationId: 'ford-fiesta-mk8-2017-2023', name: 'Active X' } });
    expect(customEntryBody('engine', v, '1.1 Ti-VCT 75PS petrol')).toMatchObject({ ok: true, body: { level: 'engine', generationId: 'ford-fiesta-mk8-2017-2023', data: { fuel: 'petrol', cc: 999, powerPs: 100 } } });
    expect(customEntryBody('trim', { ...v, catalogue: undefined }, 'X')).toMatchObject({ ok: false });
    expect(customEntryBody('model', emptyPickerValue(), 'X')).toMatchObject({ ok: false });
    expect(customEntryBody('make', v, '  ')).toMatchObject({ ok: false });
  });
});

describe('features', () => {
  it('filters by label, id or alias and labels ids', () => {
    expect(filterVocabulary(VOCAB, 'sat nav').map((c) => c.items.map((i) => i.id))).toEqual([['sat_nav']]);
    expect(filterVocabulary(VOCAB, 'tow').map((c) => c.id)).toEqual(['towing_load']);
    expect(filterVocabulary(VOCAB, '')).toHaveLength(2);
    expect(featureLabels(VOCAB, ['dab', 'heated_seats_front'])).toEqual(['DAB radio', 'Heated seats front']);
  });
  it('the Vehicle tab identification rows show doors, seats, power, segment, features and extras', () => {
    const vehicle: Vehicle = { id: 'v1', registration: 'AB12CDE', make: 'FORD', model: 'FIESTA', odometer: [], ownership: 'client', lookups: [], createdAt: '2026-01-01T00:00:00Z', spec: { segment: 'supermini', doors: 5, seats: 5, powerPs: 100, features: ['dab', 'sat_nav'], extras: ['tow_bar'] } };
    const rows = Object.fromEntries(identificationRows(vehicle, VOCAB).map((r) => [r.label, r.value]));
    expect(rows).toMatchObject({ Doors: 5, Seats: 5, Power: '100 PS', Segment: 'Supermini', Features: 'DAB radio, Satellite navigation', Extras: 'Tow bar' });
  });
});

describe('API shapes used by the picker (client.ts / vehiclesApi.ts)', () => {
  it('normaliseLookupResult keeps onFile, externalLinks and lookupMode in both branches', async () => {
    const { normaliseLookupResult } = await import('../../api/client');
    const onFile: OnFileMatch[] = [{ vehicleId: 'v1', registration: 'AB12CDE', match: 'exact', make: 'FORD', model: 'FIESTA', ownership: 'client', claims: [], lookups: [] }];
    const links = [{ id: 'totalcarcheck' as const, label: 'Open on Total Car Check', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=AB12CDE', note: 'n', verified: false as const }];
    const manual = normaliseLookupResult({ status: 'manual_required', registration: 'AB12CDE', lookupMode: 'manual', onFile, externalLinks: links }, 'AB12CDE');
    expect(manual).toMatchObject({ status: 'manual_required', lookupMode: 'manual', onFile, externalLinks: links });
    const live = normaliseLookupResult({ status: 'ok', registration: 'AB12CDE', vehicle: { id: 'v1', registration: 'AB12CDE', make: 'FORD', model: 'FIESTA', odometer: [], ownership: 'client', lookups: [], createdAt: '2026-01-01T00:00:00Z' }, providers: { dvla_ves: 'ok', dvsa_mot: 'ok' }, lookupMode: 'live', onFile, externalLinks: links }, 'AB12CDE');
    expect(live).toMatchObject({ status: 'ok', lookupMode: 'live', onFile, externalLinks: links });
    // an older reply without the fields normalises exactly as before
    expect('onFile' in normaliseLookupResult({ status: 'manual_required', registration: 'AB12CDE' }, 'AB12CDE')).toBe(false);
  });
  it('lookup mode from Settings, and the PATCH /vehicles reply', async () => {
    const { lookupModeFromSettings, normaliseVehiclePatchResult } = await import('../../api/vehiclesApi');
    expect(lookupModeFromSettings({ lookupMode: 'manual' })).toBe('manual');
    expect(lookupModeFromSettings({ apiKeys: { dvlaVes: true, dvsaMot: false, companiesHouse: false, gateway: false } })).toBe('live');
    expect(lookupModeFromSettings({ apiKeys: { dvlaVes: false, dvsaMot: false, companiesHouse: false, gateway: false } })).toBe('manual');
    expect(lookupModeFromSettings(undefined)).toBeUndefined();
    const vehicle = { id: 'v1', registration: 'AB12CDE', make: 'FORD', model: 'FIESTA', odometer: [], ownership: 'client' as const, lookups: [], createdAt: '2026-01-01T00:00:00Z' };
    expect(normaliseVehiclePatchResult({ ...vehicle, vehicle, lookupId: 'l1', warnings: [{ code: 'DIFFERS_FROM_VERIFIED', field: 'colour', verifiedValue: 'RED' }] })).toEqual({ vehicle, lookupId: 'l1', warnings: [{ code: 'DIFFERS_FROM_VERIFIED', field: 'colour', verifiedValue: 'RED' }] });
    expect(normaliseVehiclePatchResult(vehicle)).toEqual({ vehicle, warnings: [] });
  });
});

describe('legacy vehicles, pasted values and pasted trims', () => {
  const vehicle = (over: Partial<Vehicle> = {}): Vehicle => ({ id: 'v1', registration: 'LM19KPX', make: 'FORD', model: 'FIESTA', variant: '1.0 EcoBoost Zetec', yearOfManufacture: 2019, fuelType: 'petrol', transmission: 'manual', engineCapacityCc: 999, odometer: [], ownership: 'client', lookups: [], createdAt: '2026-01-01T00:00:00Z', ...over }) as Vehicle;

  it('links a DVLA upper-case vehicle saved without catalogue ids, keeping everything else', () => {
    const v = pickerFromVehicle(vehicle());
    expect(v.catalogue).toBeUndefined();
    const linked = linkToCatalogue(v, MAKES[0], MODELS);
    expect(linked.catalogue).toEqual({ makeSlug: 'ford', modelSlug: 'fiesta' });
    expect(linked).toMatchObject({ model: 'FIESTA', variant: '1.0 EcoBoost Zetec', yearOfManufacture: 2019, fuelType: 'petrol', transmission: 'manual', engineCapacityCc: 999, segment: 'supermini' });
    // then the model detail fills the generation for the year, the engine by size and the trim named in the variant
    const resolved = resolveFromModel(linked, FIESTA);
    expect(resolved.catalogue).toMatchObject({ generationId: 'ford-fiesta-mk8-2017-2023', trimId: 'zetec' });
    expect(resolved.variant).toBe('1.0 EcoBoost Zetec');
    // already linked, unknown model or no model list → unchanged
    expect(linkToCatalogue(linked, MAKES[0], MODELS)).toBe(linked);
    const unknown = pickerFromVehicle(vehicle({ model: 'PUMA' }));
    expect(linkToCatalogue(unknown, MAKES[0], MODELS)).toBe(unknown);
    expect(linkToCatalogue(v, MAKES[0], undefined)).toBe(v);
  });

  it('splits a TCC/DVLA model string into the catalogue model and the variant', () => {
    const v = { ...emptyPickerValue('AB12CDE'), make: 'FORD', model: 'TRANSIT CUSTOM 280 LIMITED' };
    const linked = linkToCatalogue(v, MAKES[0], MODELS);
    expect(linked).toMatchObject({ model: 'Transit Custom', variant: '280 LIMITED', catalogue: { makeSlug: 'ford', modelSlug: 'transit-custom' } });
  });

  it('finding the trim inside a longer variant: longest whole-word name, never a guess between equals', () => {
    const mk8 = FIESTA.generations[1]!;
    expect(trimInVariant(mk8, '1.0 EcoBoost Zetec')?.id).toBe('zetec');
    expect(trimInVariant(mk8, 'ST-3 1.5 EcoBoost')?.id).toBe('st-3');
    expect(trimInVariant(mk8, 'Zetecs')).toBeUndefined();
    expect(trimInVariant({ ...mk8, trims: [{ id: 'match-edition', name: 'Match Edition' }, { id: 'match', name: 'Match' }] }, 'Match Edition TSI EVO S-A')?.id).toBe('match-edition');
    expect(trimInVariant({ ...mk8, trims: [{ id: 'se', name: 'SE' }, { id: 'gt', name: 'GT' }] }, 'GT SE')?.id).toBe('gt');
  });

  it('a paste survives the rest of the cascade: body and engine keep petrol, automatic and the pasted 998 cc', () => {
    let v: VehiclePickerValue = {
      ...emptyPickerValue('WR19TCC'),
      make: 'Ford',
      model: 'Fiesta',
      yearOfManufacture: 2019,
      fuelType: 'petrol',
      transmission: 'automatic',
      engineCapacityCc: 998,
      catalogue: { makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk8-2017-2023' },
      source: { provider: 'totalcarcheck_manual', appliedFields: ['fuelType', 'transmission', 'engineCapacityCc'] }
    };
    v = setBody(v, parseBodyOption('hatchback|5'), FIESTA);
    expect(v).toMatchObject({ bodyType: 'Hatchback', doors: 5, fuelType: 'petrol', transmission: 'automatic', engineCapacityCc: 998 });
    v = setEngine(v, '1-0-ecoboost-100ps-petrol', FIESTA);
    expect(v).toMatchObject({ fuelType: 'petrol', transmission: 'automatic', engineCapacityCc: 998, powerPs: 100 });
    expect(v.catalogue?.engineId).toBe('1-0-ecoboost-100ps-petrol');
    expect(v.source.provider).toBe('totalcarcheck_manual');
    // an engine with no automatic gearbox clears the gearbox, and a different engine size replaces the pasted one
    const st = setEngine(v, '1-5-ecoboost-200ps-petrol', FIESTA);
    expect(st).toMatchObject({ transmission: undefined, engineCapacityCc: 1497 });
  });
});

describe('registration rules relaxed in manager mode (0.3 §A.6 B08, B12, B17)', () => {
  it('flags a non-UK plate (a warning in manager mode), accepts UK formats and empty', async () => {
    const { registrationFormatMessage, NON_UK_REGISTRATION } = await import('./vehiclePickerModel');
    expect(registrationFormatMessage('DE 123 4567')).toBe(NON_UK_REGISTRATION);
    expect(registrationFormatMessage('W 12345X')).toBe(NON_UK_REGISTRATION);
    expect(registrationFormatMessage('FL25 MXX')).toBeUndefined();
    expect(registrationFormatMessage('kr20vxa')).toBeUndefined();
    expect(registrationFormatMessage('')).toBeUndefined();
  });
  it('detects a client vehicle on a claim (REGISTRATION_ON_CLAIM pre-warning)', async () => {
    const { isClientVehicleOnClaim } = await import('./vehiclePickerModel');
    const base = { vehicleId: 'v', registration: 'KR20VXA', make: 'X', model: 'Y', lookups: [] };
    expect(isClientVehicleOnClaim([{ ...base, match: 'exact', ownership: 'client', claims: [{ id: 'c', reference: 'R', openedAt: '2026-01-01' }] }] as never)).toBe(true);
    expect(isClientVehicleOnClaim([{ ...base, match: 'partial', ownership: 'client', claims: [{ id: 'c', reference: 'R', openedAt: '2026-01-01' }] }] as never)).toBe(false);
    expect(isClientVehicleOnClaim([{ ...base, match: 'exact', ownership: 'fleet', claims: [] }] as never)).toBe(false);
    expect(isClientVehicleOnClaim(undefined)).toBe(false);
  });
  it('a fleet vehicle offered as the client vehicle: blocked normally, a warning in manager mode', async () => {
    const { fleetMatchHandling } = await import('./vehiclePickerModel');
    expect(fleetMatchHandling({ blockFleet: true, managerOn: false })).toBe('block');
    expect(fleetMatchHandling({ blockFleet: true, managerOn: true })).toBe('warn');
    expect(fleetMatchHandling({ blockFleet: false, managerOn: true })).toBe('allow');
    expect(fleetMatchHandling({ blockFleet: false, warnFleet: true, managerOn: true })).toBe('warn');
  });
});
