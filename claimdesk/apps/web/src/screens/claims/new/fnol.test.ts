import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  anyServiceAgreed,
  buildCreateClaimBody,
  buildFollowUpEvents,
  buildInjuryReferral,
  buildOfferInput,
  DISCLOSURE_TEXT,
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
    airbagsDeployed: false
  };
  s.thirdParty = { registration: 'lk19 xyz', driverName: '', insurerName: 'esure', insurerPolicyNumber: '', contact: '' };
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
    s.vehicle.manual.make = 'Ford';
    s.vehicle.manual.model = 'Focus';
    expect(validateStep(3, s, now)).toEqual({});
    s.vehicle.lookupState = 'ok';
    s.vehicle.lookup = { status: 'ok', registration: 'AB12CDE', vehicle: { registration: 'AB12CDE' }, fleetUnit: { id: 'fleet-7', registration: 'AB12CDE' } };
    expect(validateStep(3, s, now)['vehicle.fleet']).toMatch(/hard stop/);
  });
  it('step 4 requires the accident core fields and the yes/no answers', () => {
    const s = initialFnolState();
    const e = validateStep(4, s, now);
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['accident.occurredAt', 'accident.location', 'accident.circumstances', 'accident.injuries', 'accident.roadworthyAfter', 'accident.driveable', 'accident.airbagsDeployed']));
    const c = completeState();
    expect(validateStep(4, c, now)).toEqual({});
    c.accident.occurredAt = '2027-01-01T00:00:00Z';
    expect(validateStep(4, c, now)['accident.occurredAt']).toMatch(/future/);
    c.accident.occurredAt = '2026-10-03T17:30:00.000Z';
    c.witnesses.push({ name: '' });
    expect(validateStep(4, c, now)).toHaveProperty('witness.0.name');
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

describe('buildCreateClaimBody', () => {
  it('normalises registration and postcodes and carries the disclosure', () => {
    const body = buildCreateClaimBody(completeState());
    expect(body.vehicle.registration).toBe('AB12CDE');
    expect(body.vehicle.manual).toBe(false);
    expect(body.vehicle.lookupId).toBe('lk1');
    expect(body.vehicle.make).toBe('VOLKSWAGEN');
    expect(body.claimant.address?.postcode).toBe('N1 1AA');
    expect(body.claimant.roles).toEqual(['claimant', 'driver', 'keeper']);
    expect(body.driver).toBeUndefined();
    expect(body.thirdParty?.registration).toBe('LK19XYZ');
    expect(body.thirdParty?.insurerName).toBe('esure');
    expect(body.accident.postcode).toBe('W12 7AB');
    expect(body.accident.circumstances).toMatch(/lane two/);
    expect(body.disclosure).toEqual({ callRecordingReadAt: '2026-10-04T09:55:00.000Z', acknowledged: true, acknowledgedBy: 'DK' });
    expect(body.gtaSubscriber).toBe(false);
    expect(body.injury).toBeUndefined();
    expect(body.services).toEqual({ hire: true, recovery: true, storage: false, engineer: true });
  });
  it('uses manual entry when the lookup required it', () => {
    const s = completeState();
    s.vehicle.lookupState = 'manual';
    s.vehicle.useManual = true;
    s.vehicle.lookup = { status: 'manual_required', registration: 'AB12CDE', reason: 'no keys' };
    s.vehicle.manual = { ...s.vehicle.manual, make: 'Ford', model: 'Focus', yearOfManufacture: '2018', odometerMiles: '45210', vin: 'wf0abc' };
    const body = buildCreateClaimBody(s);
    expect(body.vehicle).toMatchObject({ registration: 'AB12CDE', manual: true, make: 'Ford', model: 'Focus', yearOfManufacture: 2018, odometerMiles: 45210, vin: 'WF0ABC' });
    expect(body.vehicle.lookupId).toBeUndefined();
  });
  it('adds a separate driver and the injury block when reported', () => {
    const s = completeState();
    s.driverSameAsClaimant = false;
    s.driver = { ...s.driver, name: 'Sam Smith' };
    s.accident.injuries = true;
    s.injury = { referralTo: 'PI Solicitors LLP', notes: 'whiplash' };
    const body = buildCreateClaimBody(s);
    expect(body.driver?.name).toBe('Sam Smith');
    expect(body.driver?.roles).toEqual(['driver']);
    expect(body.claimant.roles).toEqual(['claimant', 'keeper']);
    expect(body.injury).toEqual({ reported: true, referralTo: 'PI Solicitors LLP', notes: 'whiplash' });
  });
});

describe('buildOfferInput (script guard → intervention register)', () => {
  it('returns null when no offer was made', () => {
    expect(buildOfferInput(completeState())).toBeNull();
  });
  it('captures what / who / when and the rate in pence', () => {
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
    const offer = buildOfferInput(s)!;
    expect(offer).toMatchObject({ receivedAt: '2026-10-04T09:00:00.000Z', channel: 'phone', offerorName: 'esure', vehicleClassOffered: 'small hatchback', dailyRatePence: 2037, rateIncludesVat: false, clientDecision: 'pending', suitabilityReasons: [] });
    expect(offer.terms).toEqual({ excessPence: 25000, mileageLimitPerDay: 100, deliveryIncluded: true, durationStated: 'until repairs done' });
    expect(offer.clientDecisionAt).toBeUndefined();
  });
});

describe('follow-ups', () => {
  it('services agreed → services_agreed event; injuries → referral note and injuryReferral patch with no fee', () => {
    const s = completeState();
    const iso = now.toISOString();
    const events = buildFollowUpEvents(s, iso);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'services_agreed', at: iso, data: { services: ['hire', 'recovery', 'engineer'] } });
    expect(buildInjuryReferral(s, iso)).toBeNull();

    s.accident.injuries = true;
    s.injury.referralTo = 'PI Solicitors LLP';
    const withInjury = buildFollowUpEvents(s, iso);
    expect(withInjury).toHaveLength(2);
    expect(withInjury[1]).toMatchObject({ type: 'note', data: { task: 'injury_referral', feeTaken: false, referralTo: 'PI Solicitors LLP' } });
    expect(buildInjuryReferral(s, iso)).toEqual({ referredTo: 'PI Solicitors LLP', referredAt: iso, feeTaken: false });

    s.services = { hire: false, recovery: false, storage: false, engineer: false, notes: '' };
    expect(anyServiceAgreed(s.services)).toBe(false);
    expect(buildFollowUpEvents(s, iso).map((e) => e.type)).toEqual(['note']);
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
