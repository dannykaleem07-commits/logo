import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseVehicleCheckText, type OnFileMatch } from '@ccguk/domain';
import { applyParsed } from '../../vehicles/vehiclePicker';
import {
  anyServiceAgreed,
  buildCreateClaimBody,
  buildFnolOffer,
  buildFollowUpEvents,
  buildOfferDecision,
  DEFAULT_INJURY_REFERRAL,
  DISCLOSURE_TEXT,
  insurerRef,
  pickExistingParty,
  toVehicleRef,
  vehicleSource,
  firstInvalidStep,
  initialFnolState,
  SCRIPT_GUARD_NOTE,
  SCRIPT_GUARD_QUESTION,
  STEPS,
  validateStep,
  type FnolState
} from './fnol';

const now = new Date('2026-10-04T10:00:00Z');

function completeState(): FnolState {
  const s = initialFnolState();
  s.disclosure = { acknowledged: true, readAt: '2026-10-04T09:55:00.000Z', acknowledgedBy: 'DK' };
  s.handlerId = 'DK';
  s.claimant = { ...s.claimant, name: 'Jane Smith', phone: '07700 900123', email: 'jane@example.com', line1: '1 High St', postcode: 'n1 1aa' };
  s.vehicle = {
    ...s.vehicle,
    registration: 'ab12 cde',
    lookupState: 'ok',
    lookup: { status: 'ok', registration: 'AB12CDE', vehicle: { registration: 'AB12CDE', make: 'VOLKSWAGEN', model: 'GOLF', fuelType: 'petrol', yearOfManufacture: 2019 }, ves: { id: 'lk1', provider: 'dvla_ves', kind: 'vehicle', requestedAt: '2026-10-04T09:58:00Z', requestedBy: 'DK', raw: {}, verification: { status: 'verified' } } }
  };
  s.accident = {
    occurredAt: '2026-10-03T17:30:00.000Z',
    location: 'A40 Westway, W12',
    postcode: 'w12 7ab',
    circumstances: 'I was in lane two and the van moved into my lane without indicating and hit my rear quarter.',
    policeAttended: false,
    policeReference: '',
    cctvAvailable: true,
    dashcamAvailable: false,
    injuries: false,
    roadworthyAfter: false,
    driveable: false,
    airbagsDeployed: false,
    takenCold: true
  };
  s.thirdParty = { registration: 'lk19 xyz', registrationUnknown: false, driverName: '', insurerName: 'esure', insurerPolicyNumber: '', contact: '' };
  s.offer = { ...s.offer, offered: false };
  s.services = { hire: true, recovery: true, storage: false, engineer: true, notes: '' };
  return s;
}

describe('validateStep', () => {
  it('step 1 requires the disclosure acknowledgement', () => {
    const s = initialFnolState();
    expect(validateStep(1, s, now)).toHaveProperty('disclosure');
    s.disclosure.acknowledged = true;
    expect(validateStep(1, s, now)).toEqual({});
  });
  it('step 2 requires name and a contact, and the driver when not the claimant', () => {
    const s = initialFnolState();
    expect(Object.keys(validateStep(2, s, now))).toEqual(expect.arrayContaining(['claimant.name', 'claimant.contact']));
    s.claimant.name = 'Jane';
    s.claimant.email = 'bad';
    expect(validateStep(2, s, now)).toHaveProperty('claimant.email');
    s.claimant.email = 'jane@example.com';
    s.driverSameAsClaimant = false;
    expect(validateStep(2, s, now)).toEqual({ 'driver.name': expect.any(String) });
  });
  it('step 3 requires a valid registration, a lookup or manual entry, and blocks fleet units', () => {
    const s = initialFnolState();
    expect(validateStep(3, s, now)).toHaveProperty('vehicle.registration');
    s.vehicle.registration = 'ABCDEFGH';
    expect(validateStep(3, s, now)['vehicle.registration']).toMatch(/UK registration/);
    s.vehicle.registration = 'AB12 CDE';
    expect(validateStep(3, s, now)).toHaveProperty('vehicle.lookup');
    s.vehicle.lookupState = 'manual';
    s.vehicle.lookup = { status: 'manual_required', registration: 'AB12CDE' };
    expect(Object.keys(validateStep(3, s, now))).toEqual(expect.arrayContaining(['vehicle.make', 'vehicle.model']));
    s.vehicle.picker = { ...s.vehicle.picker, make: 'Ford', model: 'Focus' };
    expect(validateStep(3, s, now)).toEqual({});
    s.vehicle.lookupState = 'ok';
    s.vehicle.lookup = { status: 'ok', registration: 'AB12CDE', vehicle: { registration: 'AB12CDE' }, fleetUnit: { id: 'fleet-7', registration: 'AB12CDE' } };
    expect(validateStep(3, s, now)['vehicle.fleet']).toMatch(/hard stop/);
  });
  it('step 4 requires the accident core fields, the taken-cold confirmation and the yes/no answers', () => {
    const s = initialFnolState();
    const e = validateStep(4, s, now);
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['accident.occurredAt', 'accident.location', 'accident.circumstances', 'accident.takenCold', 'accident.injuries', 'accident.roadworthyAfter', 'accident.driveable', 'accident.airbagsDeployed']));
    const c = completeState();
    expect(validateStep(4, c, now)).toEqual({});
    c.accident.occurredAt = '2027-01-01T00:00:00Z';
    expect(validateStep(4, c, now)['accident.occurredAt']).toMatch(/future/);
    c.accident.occurredAt = '2026-10-03T17:30:00.000Z';
    c.accident.circumstances = 'Hit from behind at the lights.'; // under the domain minimum (40 chars)
    expect(validateStep(4, c, now)['accident.circumstances']).toMatch(/40 characters/);
    c.accident.circumstances = completeState().accident.circumstances;
    c.witnesses.push({ name: '' });
    expect(Object.keys(validateStep(4, c, now))).toEqual(expect.arrayContaining(['witness.0.name', 'witness.0.relationship']));
    c.witnesses = [{ name: 'Alex Brown', independent: true }];
    expect(validateStep(4, c, now)).toEqual({});
    c.witnesses = [{ name: 'Chris Smith', relationshipToClaimant: 'Brother' }];
    expect(validateStep(4, c, now)).toEqual({});
  });
  it('step 4: a supplied third-party registration must be valid, or the plate is marked unknown (failed to stop)', () => {
    const c = completeState();
    c.thirdParty.registration = 'NOT A PLATE';
    expect(validateStep(4, c, now)['thirdParty.registration']).toMatch(/not a valid UK registration/i);
    c.thirdParty.registrationUnknown = true;
    expect(validateStep(4, c, now)['thirdParty.registration']).toMatch(/not both/);
    c.thirdParty.registration = '';
    expect(validateStep(4, c, now)).toEqual({});
    const body = buildCreateClaimBody(c, { now: now.toISOString() });
    expect(body.thirdParty).toEqual({ registrationUnknown: true });
    expect(body.thirdPartyVehicle).toBeUndefined();
  });
  it('step 5 requires the script-guard answer and the what/who/when of an offer', () => {
    const s = completeState();
    s.offer.offered = undefined;
    expect(validateStep(5, s, now)).toHaveProperty('offer.offered');
    s.offer.offered = true;
    expect(Object.keys(validateStep(5, s, now))).toEqual(expect.arrayContaining(['offer.offerorName', 'offer.receivedAt', 'offer.what']));
    s.offer.offerorName = 'esure';
    s.offer.receivedAt = '2026-10-04T09:00:00.000Z';
    s.offer.vehicleClassOffered = 'small hatchback';
    expect(validateStep(5, s, now)).toEqual({});
  });
  it('firstInvalidStep walks the steps in order', () => {
    expect(firstInvalidStep(initialFnolState(), now)).toBe(1);
    expect(firstInvalidStep(completeState(), now)).toBeNull();
    expect(STEPS.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('buildCreateClaimBody (apps/api createClaimBody shape)', () => {
  const iso = now.toISOString();
  it('normalises registration and postcodes, references insurers and the third party as party refs, and carries the disclosure', () => {
    const body = buildCreateClaimBody(completeState(), { now: iso });
    expect(body.vehicle).toMatchObject({ registration: 'AB12CDE', make: 'VOLKSWAGEN', model: 'GOLF', ownership: 'client' });
    expect('manual' in body.vehicle).toBe(false);
    expect('lookupId' in body.vehicle).toBe(false);
    expect('id' in body.claimant ? undefined : body.claimant.address?.postcode).toBe('N1 1AA');
    expect('id' in body.claimant ? undefined : body.claimant.roles).toEqual(['claimant', 'driver', 'keeper']);
    expect(body.driver).toBeUndefined();
    expect(body.thirdPartyVehicle).toEqual({ registration: 'LK19XYZ', ownership: 'third_party' });
    expect(body.thirdParties).toBeUndefined();
    expect(body.atFaultInsurer).toEqual({ kind: 'company', name: 'esure', roles: ['insurer'] });
    expect(body.accident.postcode).toBe('W12 7AB');
    expect(body.accident.circumstances).toMatch(/lane two/);
    expect(body.liability).toBe('unknown');
    expect(body.callRecordingDisclosed).toBe(true);
    expect(body.fnolAt).toBe('2026-10-04T09:55:00.000Z');
    expect(body.disclosure).toEqual({ callRecordingReadAt: '2026-10-04T09:55:00.000Z', acknowledged: true, acknowledgedBy: 'DK' });
    expect(body.handlerId).toBe('DK');
    expect(body.servicesAgreedAt).toBe(iso);
    expect(body.services).toEqual({ hire: true, recovery: true, storage: false, engineer: true });
    expect(body.injuryReferralTo).toBeUndefined();
    expect(body.interventionOffer).toBeUndefined();
    expect(body.takenCold).toBe(true);
    expect(body.offerDisclosed).toBe(false);
    expect(body.offerDetails).toBeUndefined();
    expect(body.witnesses).toEqual([]);
    expect(body.thirdParty).toBeUndefined();
    expect(body.notes).toMatch(/Services agreed at FNOL: hire, recovery, engineer/);
    expect(body.notes).toMatch(/disclosure read 2026-10-04T09:55:00.000Z by DK/);
    expect(body.notes).not.toMatch(/ignore/i);
  });
  it('references a looked-up vehicle by id (the lookup already stored the DVLA/DVSA records)', () => {
    const s = completeState();
    s.vehicle.lookup = { status: 'ok', registration: 'AB12CDE', vehicle: { id: 'veh-1', registration: 'AB12CDE', make: 'VOLKSWAGEN', model: 'GOLF' } };
    expect(toVehicleRef(s.vehicle, '2026-10-04')).toEqual({ id: 'veh-1' });
    expect(vehicleSource(s.vehicle)).toBe('lookup');
    s.vehicle.useManual = true;
    s.vehicle.picker = { ...s.vehicle.picker, make: 'Volkswagen', model: 'Golf GTI' };
    expect(vehicleSource(s.vehicle)).toBe('manual');
    expect(toVehicleRef(s.vehicle, '2026-10-04')).toMatchObject({ registration: 'AB12CDE', make: 'Volkswagen', model: 'Golf GTI' });
  });
  it('uses manual entry when the lookup required it, with the odometer as a client reading dated today', () => {
    const s = completeState();
    s.vehicle.lookupState = 'manual';
    s.vehicle.useManual = true;
    s.vehicle.lookup = { status: 'manual_required', registration: 'AB12CDE', reason: 'no keys' };
    s.vehicle.picker = { ...s.vehicle.picker, make: 'Ford', model: 'Focus', yearOfManufacture: 2018, vin: 'wf0abc' };
    s.vehicle.odometerMiles = '45,210';
    const body = buildCreateClaimBody(s, { now: iso });
    expect(body.vehicle).toMatchObject({ registration: 'AB12CDE', make: 'Ford', model: 'Focus', yearOfManufacture: 2018, vin: 'WF0ABC', ownership: 'client', source: { provider: 'manual' } });
    expect('id' in body.vehicle ? undefined : body.vehicle.odometer).toEqual([{ source: 'client', date: '2026-10-04', miles: 45210, note: expect.stringMatching(/client/) }]);
  });
  it('manual mode: make + model from a Total Car Check paste pass step 3 and go out with the spec and the paste as source', () => {
    const s = completeState();
    s.vehicle.lookupState = 'manual';
    s.vehicle.lookup = { status: 'manual_required', registration: 'AB12CDE', lookupMode: 'manual', onFile: [], externalLinks: [] };
    s.vehicle.useManual = true;
    expect(Object.keys(validateStep(3, s, now))).toEqual(expect.arrayContaining(['vehicle.make', 'vehicle.model']));
    // synthetic paste (not a real Total Car Check page)
    const parsed = parseVehicleCheckText('Make\tFORD\nModel\tFIESTA ZETEC\nColour\tBLUE\nFuel Type\tPETROL\nEngine Size\t998 cc\nYear of Manufacture\t2019', { expectedRegistration: 'AB12CDE', today: '2026-10-04' });
    s.vehicle.picker = applyParsed(s.vehicle.picker, parsed, { match: { makeSlug: 'ford', modelSlug: 'fiesta', variantRemainder: 'ZETEC', makeName: 'Ford', modelName: 'Fiesta' }, url: 'https://totalcarcheck.co.uk/FreeCheck?regno=AB12CDE', pastedText: 'Make\tFORD' });
    s.vehicle.picker.features = ['dab'];
    expect(validateStep(3, s, now)).toEqual({});
    const body = buildCreateClaimBody(s, { now: iso });
    expect(body.vehicle).toMatchObject({
      registration: 'AB12CDE',
      make: 'Ford',
      model: 'Fiesta',
      variant: 'ZETEC',
      colour: 'Blue',
      fuelType: 'petrol',
      engineCapacityCc: 998,
      yearOfManufacture: 2019,
      ownership: 'client',
      spec: { catalogue: { makeSlug: 'ford', modelSlug: 'fiesta' }, features: ['dab'], extras: [] },
      source: { provider: 'totalcarcheck_manual', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=AB12CDE', appliedFields: expect.arrayContaining(['make', 'model', 'variant', 'colour']) }
    });
    expect(JSON.stringify(body.vehicle)).not.toMatch(/verification|verified/);
  });
  it('manual mode: a catalogue pick goes out with source catalogue and the catalogue ids', () => {
    const s = completeState();
    s.vehicle.lookupState = 'manual';
    s.vehicle.lookup = { status: 'manual_required', registration: 'AB12CDE' };
    s.vehicle.useManual = true;
    s.vehicle.picker = { ...s.vehicle.picker, make: 'Ford', model: 'Fiesta', catalogue: { makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk8-2017-2023' }, segment: 'supermini', doors: 5 };
    const ref = toVehicleRef(s.vehicle, '2026-10-04');
    expect(ref).toMatchObject({ make: 'Ford', model: 'Fiesta', spec: { catalogue: { makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk8-2017-2023' }, segment: 'supermini', doors: 5 }, source: { provider: 'catalogue' } });
  });
  it('"Use this vehicle" references the on-file vehicle by id and passes step 3 without hand entry', () => {
    const s = completeState();
    s.vehicle.lookupState = 'manual';
    s.vehicle.lookup = { status: 'manual_required', registration: 'AB12CDE', lookupMode: 'manual' };
    s.vehicle.useManual = true;
    const match: OnFileMatch = { vehicleId: 'veh-9', registration: 'AB12CDE', match: 'exact', make: 'FORD', model: 'FOCUS', ownership: 'client', claims: [], lookups: [] };
    s.vehicle.onFile = match;
    expect(vehicleSource(s.vehicle)).toBe('on_file');
    expect(validateStep(3, s, now)).toEqual({});
    expect(buildCreateClaimBody(s, { now: iso }).vehicle).toEqual({ id: 'veh-9' });
    s.vehicle.onFile = { ...match, ownership: 'fleet', fleetUnit: { id: 'u1', status: 'available', gtaGroup: 'M', dailyRatePence: 5000 } };
    expect(validateStep(3, s, now)['vehicle.fleet']).toMatch(/hard stop/);
  });
  it('step 3 still needs the search first, and checks the hand-entered details', () => {
    const s = completeState();
    s.vehicle.lookupState = 'idle';
    s.vehicle.lookup = null;
    expect(validateStep(3, s, now)['vehicle.lookup']).toMatch(/Search the registration/);
    s.vehicle.lookupState = 'error';
    s.vehicle.picker = { ...s.vehicle.picker, make: 'Ford', model: 'Focus', vin: 'WF0XXX' };
    expect(validateStep(3, s, now)).toEqual({ 'vehicle.vin': expect.stringMatching(/17 characters/) });
    s.vehicle.picker.vin = '';
    s.vehicle.odometerMiles = 'about 40k';
    expect(validateStep(3, s, now)).toEqual({ 'vehicle.odometerMiles': expect.any(String) });
  });
  it('adds a separate driver, the third-party driver and the injury referral when reported (no PATCH of the claim)', () => {
    const s = completeState();
    s.driverSameAsClaimant = false;
    s.driver = { ...s.driver, name: 'Sam Smith' };
    s.thirdParty = { ...s.thirdParty, driverName: 'Pat Jones', contact: 'pat@example.com', insurerPolicyNumber: 'POL-1' };
    s.clientInsurer = { name: 'Admiral', policyNumber: 'ADM-9' };
    s.accident.injuries = true;
    s.injury = { referralTo: 'PI Solicitors LLP', notes: 'whiplash' };
    const body = buildCreateClaimBody(s, { now: iso });
    expect(body.driver).toMatchObject({ name: 'Sam Smith', roles: ['driver'] });
    expect('id' in body.claimant ? undefined : body.claimant.roles).toEqual(['claimant', 'keeper']);
    expect(body.thirdParties).toEqual([{ kind: 'individual', name: 'Pat Jones', roles: ['third_party_driver'], notes: 'Contact as given by the client: pat@example.com' }]);
    expect(body.atFaultInsurerRef).toBe('POL-1');
    expect(body.clientInsurer).toEqual({ kind: 'company', name: 'Admiral', roles: ['insurer'] });
    expect(body.clientPolicyNumber).toBe('ADM-9');
    expect(body.injuryReferralTo).toBe('PI Solicitors LLP');
    expect(body.notes).toMatch(/Injury notes: whiplash/);
    s.injury.referralTo = '';
    expect(buildCreateClaimBody(s, { now: iso }).injuryReferralTo).toBe(DEFAULT_INJURY_REFERRAL);
  });
  it('reuses an insurer already on file by id instead of creating a duplicate party', () => {
    const known = [
      { id: 'p-esure', name: 'esure', roles: ['insurer' as const] },
      { id: 'p-x', name: 'esure', roles: ['repairer' as const] }
    ];
    expect(pickExistingParty(known, ' ESURE ')?.id).toBe('p-esure');
    expect(pickExistingParty(known, 'Aviva')).toBeUndefined();
    expect(insurerRef('esure', known)).toEqual({ id: 'p-esure' });
    expect(insurerRef('Aviva', known)).toEqual({ kind: 'company', name: 'Aviva', roles: ['insurer'] });
    const body = buildCreateClaimBody(completeState(), { now: iso, knownParties: known });
    expect(body.atFaultInsurer).toEqual({ id: 'p-esure' });
  });
  it('keeps a too-short phone or an incomplete address as a note rather than failing the API schema', () => {
    const s = completeState();
    s.claimant = { ...s.claimant, phone: '123', line1: '', postcode: 'N1 1AA' };
    const body = buildCreateClaimBody(s, { now: iso });
    const claimant = 'id' in body.claimant ? undefined : body.claimant;
    expect(claimant?.phone).toBeUndefined();
    expect(claimant?.address).toBeUndefined();
    expect(claimant?.notes).toMatch(/Phone as given: 123/);
    expect(claimant?.notes).toMatch(/Address \(incomplete\): N1 1AA/);
    expect(validateStep(2, s, now)['claimant.contact']).toMatch(/too short/);
  });
});

describe('buildFnolOffer / buildOfferDecision (script guard → intervention register)', () => {
  const iso = now.toISOString();
  it('returns null when no offer was made', () => {
    expect(buildFnolOffer(completeState())).toBeNull();
    expect(buildOfferDecision(completeState(), iso)).toBeNull();
  });
  it('captures what / who / when and the rate in pence, inline in the FNOL body, never "told to ignore"', () => {
    const s = completeState();
    s.offer = {
      ...s.offer,
      offered: true,
      receivedAt: '2026-10-04T09:00:00.000Z',
      channel: 'phone',
      offerorName: 'esure',
      vehicleClassOffered: 'small hatchback',
      dailyRatePence: 2037,
      rateIncludesVat: false,
      excessPence: 25000,
      mileageLimitPerDay: '100',
      deliveryIncluded: true,
      insuranceIncluded: undefined,
      durationStated: 'until repairs done',
      otherTerms: '',
      clientDecision: 'pending',
      clientReasons: ''
    };
    const offer = buildFnolOffer(s)!;
    expect(offer).toEqual({
      offerorName: 'esure',
      channel: 'phone',
      clientToldToIgnore: false,
      receivedAt: '2026-10-04T09:00:00.000Z',
      vehicleClassOffered: 'small hatchback',
      dailyRatePence: 2037,
      rateIncludesVat: false,
      terms: { excessPence: 25000, mileageLimitPerDay: 100, deliveryIncluded: true, durationStated: 'until repairs done' }
    });
    const body = buildCreateClaimBody(s, { now: iso });
    expect(body.interventionOffer).toEqual(offer);
    expect(body.offerDisclosed).toBe(true);
    expect(body.offerDetails).toEqual({ what: 'small hatchback', byWhom: 'esure', when: '2026-10-04T09:00:00.000Z' });
    expect(buildOfferDecision(s, iso)).toBeNull();
    s.offer.clientDecision = 'declined';
    s.offer.clientReasons = 'needs an automatic for a disability';
    expect(buildOfferDecision(s, iso)).toEqual({ clientDecision: 'declined', clientDecisionAt: '2026-10-04T09:55:00.000Z', clientReasons: 'needs an automatic for a disability' });
    s.offer.clientReasons = '';
    expect(buildOfferDecision(s, iso)).toEqual({ clientDecision: 'declined', clientDecisionAt: '2026-10-04T09:55:00.000Z' });
  });
});

describe('follow-ups', () => {
  const iso = now.toISOString();
  it('services agreed → one detail note (the API appends services_agreed, the fnol event and the witness reports itself)', () => {
    const s = completeState();
    const events = buildFollowUpEvents(s, iso);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'note', at: iso, summary: 'Services agreed at FNOL: hire, recovery, engineer', data: { task: 'services_agreed_detail', services: ['hire', 'recovery', 'engineer'] } });

    s.witnesses = [
      { name: 'Alex Brown', phone: '07700 900999', relationshipToClaimant: 'None', independent: true },
      { name: 'Chris Smith', phone: 'c@example.com', relationshipToClaimant: 'Brother', independent: false },
      { name: '   ' }
    ];
    const body = buildCreateClaimBody(s, { now: iso });
    expect(body.witnesses).toEqual([
      { name: 'Alex Brown', phone: '07700 900999', relationshipToClaimant: 'None', independent: true },
      { name: 'Chris Smith', phone: 'c@example.com', relationshipToClaimant: 'Brother', independent: false }
    ]);
    expect(buildFollowUpEvents(s, iso)).toHaveLength(1); // witnesses are not posted again by the web

    s.services = { hire: false, recovery: false, storage: false, engineer: false, notes: '' };
    expect(anyServiceAgreed(s.services)).toBe(false);
    expect(buildFollowUpEvents(s, iso)).toEqual([]);
    expect(buildCreateClaimBody(s, { now: iso }).servicesAgreedAt).toBeUndefined();
  });
});

/**
 * Script guard (lesson m) and perimeter (convention 8): the wizard must never contain text that advises a client
 * to ignore or decline an insurer's vehicle offer, nor imply regulated status. The phrase list mirrors
 * packages/documents/src/brand.ts `legacy.bannedPhrases` plus the legacy details.
 */
describe('wizard copy never advises on offers and carries no legacy details', () => {
  const BANNED = [
    'ignore any offer of a courtesy car',
    'do not accept a vehicle from the insurer',
    'our solicitors',
    'we act as your solicitors',
    'legal advice from our lawyers',
    'car flex',
    'carflex ltd',
    '17360033',
    '66 paul street',
    'ec2a 4px',
    'courtesycarsuk.co.uk'
  ];
  const ADVICE_PATTERNS = [/(?<!not )regulated by the sra/i, /ignore (the|their|any) offer/i, /(decline|refuse|reject|turn down) (the|their|any|that) (offer|vehicle|courtesy car)/i, /tell (the client|them) to (ignore|decline|refuse)/i, /do not (accept|take) (the|a|their) (vehicle|car|offer)/i];
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'));

  it('scans every wizard source file', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      const lower = text.toLowerCase();
      for (const phrase of BANNED) expect(lower.includes(phrase), `${f} contains "${phrase}"`).toBe(false);
      for (const re of ADVICE_PATTERNS) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
  });
  it('the script text itself is neutral', () => {
    const all = [...DISCLOSURE_TEXT, SCRIPT_GUARD_QUESTION, SCRIPT_GUARD_NOTE].join(' ');
    for (const re of ADVICE_PATTERNS) expect(re.test(all)).toBe(false);
    expect(SCRIPT_GUARD_QUESTION).toBe('Has anyone offered you a vehicle? What exactly, by whom, when?');
    expect(DISCLOSURE_TEXT.join(' ')).toMatch(/is not a firm of solicitors/);
  });
});
