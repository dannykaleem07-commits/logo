/**
 * FNOL wizard model (pure; unit-tested). The React steps only read/write this state and call the API.
 *
 * BLUEPRINT §3.1 rules enforced here:
 *  - the call-recording disclosure is read and acknowledged before any detail is taken (step 1);
 *  - the client's account of the accident is taken cold, in their own words (never suggested);
 *  - injuries → referral-out task, no fee (lesson j);
 *  - the script guard asks "Has anyone offered you a vehicle? What exactly, by whom, when?" and logs the
 *    answer to the intervention register (lesson m). Nothing here advises on accepting or refusing an offer.
 *
 * TODO wire when @ccguk/domain intake lands: replace DISCLOSURE_TEXT / SCRIPT_GUARD_QUESTION with the
 * exported `intakeScript` and run `validateFnol` on the built body before POST.
 */
import type { AccidentDetails, InterventionOffer, ISODateTime } from '@ccguk/domain';
import { normaliseRegistration, isValidUkRegistration } from '@ccguk/domain';
import type { CreateClaimBody, CreateEventBody, InterventionOfferInput, PartyInput, VehicleInput, VehicleLookupResult, WitnessInput } from '../../../api/client';

// ---------------------------------------------------------------------------
// Script text
// ---------------------------------------------------------------------------

export const DISCLOSURE_TITLE = 'Call-recording disclosure';

/** Read aloud (or shown) before any detail is taken. Keep it factual: no advice, no promises. */
export const DISCLOSURE_TEXT = [
  'This call is being recorded. The recording may be used as evidence in your claim and may be disclosed to the insurer, your own insurer, an engineer, a solicitor you instruct, or a court.',
  'Courtesy Cars Group UK Ltd provides accident management, credit hire, recovery and storage services. It is not a firm of solicitors and is not regulated by the SRA.',
  'We will ask you to describe the accident in your own words. Please answer from your own memory; we will not suggest answers.',
  'If anyone has been injured we will refer that part of the claim to an independent personal injury solicitor and will not charge a fee for the referral.'
];

export const SCRIPT_GUARD_QUESTION = 'Has anyone offered you a vehicle? What exactly, by whom, when?';

/** Handler-facing note shown beside the script-guard question. Deliberately says nothing about accepting or refusing. */
export const SCRIPT_GUARD_NOTE =
  'Record exactly what the client says: the vehicle offered, who offered it and when. The answer goes on the intervention register and a written reply to the insurer is due within 1 working day.';

export const INJURY_REFERRAL_NOTICE =
  'Injury reported. A personal injury referral-out task will be created on submission and logged on the file. CCGUK takes no fee for the referral and continues the damage-only claim.';

export const CIRCUMSTANCES_CAPTION = "The client's own words — do not suggest.";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Step = 1 | 2 | 3 | 4 | 5 | 6;

export const STEPS: Array<{ n: Step; label: string }> = [
  { n: 1, label: 'Disclosure' },
  { n: 2, label: 'Claimant & driver' },
  { n: 3, label: 'Vehicle' },
  { n: 4, label: 'Accident' },
  { n: 5, label: 'Vehicle offers' },
  { n: 6, label: 'Services & review' }
];

export interface PartyForm {
  name: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  line1: string;
  line2: string;
  town: string;
  postcode: string;
  drivingLicenceNumber: string;
}

export const emptyParty = (): PartyForm => ({ name: '', phone: '', email: '', dateOfBirth: '', line1: '', line2: '', town: '', postcode: '', drivingLicenceNumber: '' });

export interface ManualVehicleForm {
  make: string;
  model: string;
  colour: string;
  fuelType: NonNullable<VehicleInput['fuelType']> | '';
  transmission: NonNullable<VehicleInput['transmission']> | '';
  yearOfManufacture: string;
  vin: string;
  motExpiryDate: string;
  odometerMiles: string;
}

export const emptyManualVehicle = (): ManualVehicleForm => ({ make: '', model: '', colour: '', fuelType: '', transmission: '', yearOfManufacture: '', vin: '', motExpiryDate: '', odometerMiles: '' });

export type LookupState = 'idle' | 'loading' | 'ok' | 'manual' | 'error';

export interface OfferForm {
  /** undefined = the question has not been asked/answered yet */
  offered: boolean | undefined;
  receivedAt: string;
  channel: InterventionOffer['channel'];
  offerorName: string;
  vehicleClassOffered: string;
  dailyRatePence: number | null;
  rateIncludesVat: boolean;
  excessPence: number | null;
  mileageLimitPerDay: string;
  deliveryIncluded: boolean | undefined;
  insuranceIncluded: boolean | undefined;
  durationStated: string;
  otherTerms: string;
  clientDecision: InterventionOffer['clientDecision'];
  clientReasons: string;
}

export const emptyOffer = (): OfferForm => ({
  offered: undefined,
  receivedAt: '',
  channel: 'phone',
  offerorName: '',
  vehicleClassOffered: '',
  dailyRatePence: null,
  rateIncludesVat: false,
  excessPence: null,
  mileageLimitPerDay: '',
  deliveryIncluded: undefined,
  insuranceIncluded: undefined,
  durationStated: '',
  otherTerms: '',
  clientDecision: 'pending',
  clientReasons: ''
});

export interface AccidentForm {
  occurredAt: string; // ISODateTime
  location: string;
  postcode: string;
  circumstances: string;
  policeAttended: boolean | undefined;
  policeReference: string;
  cctvAvailable: boolean | undefined;
  dashcamAvailable: boolean | undefined;
  injuries: boolean | undefined;
  roadworthyAfter: boolean | undefined;
  driveable: boolean | undefined;
  airbagsDeployed: boolean | undefined;
}

export interface FnolState {
  channel: CreateClaimBody['channel'];
  disclosure: { acknowledged: boolean; readAt: string; acknowledgedBy: string };
  claimant: PartyForm;
  driverSameAsClaimant: boolean;
  driver: PartyForm;
  clientInsurer: { name: string; policyNumber: string };
  vehicle: {
    registration: string;
    lookupState: LookupState;
    lookup: VehicleLookupResult | null;
    lookupError: string;
    manual: ManualVehicleForm;
    useManual: boolean;
  };
  accident: AccidentForm;
  thirdParty: { registration: string; driverName: string; insurerName: string; insurerPolicyNumber: string; contact: string };
  witnesses: WitnessInput[];
  injury: { referralTo: string; notes: string };
  offer: OfferForm;
  services: { hire: boolean; recovery: boolean; storage: boolean; engineer: boolean; notes: string };
  handlerId: string;
}

export function initialFnolState(): FnolState {
  return {
    channel: 'phone',
    disclosure: { acknowledged: false, readAt: '', acknowledgedBy: '' },
    claimant: emptyParty(),
    driverSameAsClaimant: true,
    driver: emptyParty(),
    clientInsurer: { name: '', policyNumber: '' },
    vehicle: { registration: '', lookupState: 'idle', lookup: null, lookupError: '', manual: emptyManualVehicle(), useManual: false },
    accident: {
      occurredAt: '',
      location: '',
      postcode: '',
      circumstances: '',
      policeAttended: undefined,
      policeReference: '',
      cctvAvailable: undefined,
      dashcamAvailable: undefined,
      injuries: undefined,
      roadworthyAfter: undefined,
      driveable: undefined,
      airbagsDeployed: undefined
    },
    thirdParty: { registration: '', driverName: '', insurerName: '', insurerPolicyNumber: '', contact: '' },
    witnesses: [],
    injury: { referralTo: '', notes: '' },
    offer: emptyOffer(),
    services: { hire: false, recovery: false, storage: false, engineer: false, notes: '' },
    handlerId: ''
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type StepErrors = Record<string, string>;

const has = (s: string | undefined) => Boolean(s && s.trim());

export function lookupLinkedClaims(state: FnolState) {
  return state.vehicle.lookup?.linkedClaims ?? [];
}

/** A fleet unit presented as the client vehicle is a hard stop (lessons f, h). */
export function fleetUnitHardStop(state: FnolState): boolean {
  return Boolean(state.vehicle.lookup?.fleetUnit);
}

export function validateStep(step: Step, state: FnolState, now: Date = new Date()): StepErrors {
  const e: StepErrors = {};
  switch (step) {
    case 1:
      if (!state.disclosure.acknowledged) e['disclosure'] = 'The disclosure must be read and acknowledged before any detail is taken.';
      break;
    case 2:
      if (!has(state.claimant.name)) e['claimant.name'] = 'Full legal name is required.';
      if (!has(state.claimant.phone) && !has(state.claimant.email)) e['claimant.contact'] = 'A phone number or email address is required.';
      if (has(state.claimant.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.claimant.email.trim())) e['claimant.email'] = 'Enter a valid email address.';
      if (!state.driverSameAsClaimant && !has(state.driver.name)) e['driver.name'] = 'Driver name is required when the claimant was not driving.';
      break;
    case 3: {
      const reg = normaliseRegistration(state.vehicle.registration);
      if (!reg) e['vehicle.registration'] = 'Registration is required.';
      else if (!isValidUkRegistration(reg)) e['vehicle.registration'] = 'This does not look like a UK registration mark. Check it with the client.';
      if (reg && isValidUkRegistration(reg)) {
        if (state.vehicle.lookupState === 'idle' || state.vehicle.lookupState === 'loading') e['vehicle.lookup'] = 'Run the registration lookup (or choose manual entry).';
        if (state.vehicle.useManual || state.vehicle.lookupState === 'manual' || state.vehicle.lookupState === 'error') {
          if (!has(state.vehicle.manual.make)) e['vehicle.make'] = 'Make is required for manual entry.';
          if (!has(state.vehicle.manual.model)) e['vehicle.model'] = 'Model is required for manual entry.';
        }
      }
      if (fleetUnitHardStop(state)) e['vehicle.fleet'] = 'This registration is a CCGUK fleet unit. A fleet unit cannot be a client vehicle (hard stop).';
      break;
    }
    case 4: {
      const a = state.accident;
      if (!a.occurredAt) e['accident.occurredAt'] = 'Date and time of the accident are required.';
      else if (Date.parse(a.occurredAt) > now.getTime()) e['accident.occurredAt'] = 'The accident cannot be in the future.';
      if (!has(a.location)) e['accident.location'] = 'Location is required.';
      if (!has(a.circumstances) || a.circumstances.trim().length < 20) e['accident.circumstances'] = "Record the client's account in their own words (at least a sentence).";
      if (a.injuries === undefined) e['accident.injuries'] = 'Answer the injuries question.';
      if (a.roadworthyAfter === undefined) e['accident.roadworthyAfter'] = 'Answer whether the vehicle is roadworthy.';
      if (a.driveable === undefined) e['accident.driveable'] = 'Answer whether the vehicle is driveable.';
      if (a.airbagsDeployed === undefined) e['accident.airbagsDeployed'] = 'Answer whether airbags deployed.';
      if (has(state.thirdParty.registration) && !isValidUkRegistration(state.thirdParty.registration)) e['thirdParty.registration'] = 'Third-party registration does not look valid; record it as given but check it.';
      state.witnesses.forEach((w, i) => {
        if (!has(w.name)) e[`witness.${i}.name`] = 'Witness name is required (or remove the row).';
      });
      break;
    }
    case 5: {
      const o = state.offer;
      if (o.offered === undefined) e['offer.offered'] = 'Ask the question and record the answer.';
      if (o.offered) {
        if (!has(o.offerorName)) e['offer.offerorName'] = 'Who made the offer?';
        if (!o.receivedAt) e['offer.receivedAt'] = 'When was it offered?';
        if (!has(o.vehicleClassOffered) && !has(o.otherTerms)) e['offer.what'] = 'What exactly was offered? Record the vehicle or the terms as described.';
      }
      break;
    }
    case 6:
      break;
  }
  return e;
}

export function firstInvalidStep(state: FnolState, now: Date = new Date()): Step | null {
  for (const s of STEPS) {
    if (Object.keys(validateStep(s.n, state, now)).length > 0) return s.n;
  }
  return null;
}

export function anyServiceAgreed(s: FnolState['services']): boolean {
  return s.hire || s.recovery || s.storage || s.engineer;
}

// ---------------------------------------------------------------------------
// Builders (state → API bodies)
// ---------------------------------------------------------------------------

export function toPartyInput(p: PartyForm, roles: PartyInput['roles']): PartyInput {
  const out: PartyInput = { kind: 'individual', name: p.name.trim(), roles };
  if (has(p.phone)) out.phone = p.phone.trim();
  if (has(p.email)) out.email = p.email.trim();
  if (has(p.dateOfBirth)) out.dateOfBirth = p.dateOfBirth;
  if (has(p.drivingLicenceNumber)) out.drivingLicenceNumber = p.drivingLicenceNumber.trim();
  if (has(p.line1) || has(p.postcode)) {
    out.address = { line1: p.line1.trim(), postcode: p.postcode.trim().toUpperCase() };
    if (has(p.line2)) out.address.line2 = p.line2.trim();
    if (has(p.town)) out.address.town = p.town.trim();
  }
  return out;
}

export function toVehicleInput(v: FnolState['vehicle']): VehicleInput {
  const registration = normaliseRegistration(v.registration);
  const fromLookup = v.lookup?.status === 'ok' ? v.lookup.vehicle : v.lookup?.status === 'manual_required' ? v.lookup.partial : undefined;
  const manual = v.useManual || v.lookupState !== 'ok';
  const out: VehicleInput = { registration, ownership: 'client', manual };
  if (fromLookup && !manual) {
    if (fromLookup.make) out.make = fromLookup.make;
    if (fromLookup.model) out.model = fromLookup.model;
    if (fromLookup.variant) out.variant = fromLookup.variant;
    if (fromLookup.colour) out.colour = fromLookup.colour;
    if (fromLookup.fuelType) out.fuelType = fromLookup.fuelType;
    if (fromLookup.transmission) out.transmission = fromLookup.transmission;
    if (fromLookup.yearOfManufacture) out.yearOfManufacture = fromLookup.yearOfManufacture;
    if (fromLookup.engineCapacityCc) out.engineCapacityCc = fromLookup.engineCapacityCc;
    if (fromLookup.vin) out.vin = fromLookup.vin;
    if (fromLookup.motExpiryDate) out.motExpiryDate = fromLookup.motExpiryDate;
    if (fromLookup.taxDueDate) out.taxDueDate = fromLookup.taxDueDate;
    const ves = v.lookup?.status === 'ok' ? v.lookup.ves : undefined;
    if (ves?.id) out.lookupId = ves.id;
  } else {
    const m = v.manual;
    if (has(m.make)) out.make = m.make.trim();
    if (has(m.model)) out.model = m.model.trim();
    if (has(m.colour)) out.colour = m.colour.trim();
    if (m.fuelType) out.fuelType = m.fuelType;
    if (m.transmission) out.transmission = m.transmission;
    if (has(m.yearOfManufacture) && /^\d{4}$/.test(m.yearOfManufacture.trim())) out.yearOfManufacture = Number(m.yearOfManufacture);
    if (has(m.vin)) out.vin = m.vin.trim().toUpperCase();
    if (has(m.motExpiryDate)) out.motExpiryDate = m.motExpiryDate;
    if (has(m.odometerMiles) && /^\d+$/.test(m.odometerMiles.trim())) out.odometerMiles = Number(m.odometerMiles);
  }
  return out;
}

export function toAccidentDetails(a: AccidentForm): AccidentDetails {
  const out: AccidentDetails = { occurredAt: a.occurredAt, location: a.location.trim(), circumstances: a.circumstances.trim() };
  if (has(a.postcode)) out.postcode = a.postcode.trim().toUpperCase();
  if (a.policeAttended !== undefined) out.policeAttended = a.policeAttended;
  if (has(a.policeReference)) out.policeReference = a.policeReference.trim();
  if (a.cctvAvailable !== undefined) out.cctvAvailable = a.cctvAvailable;
  if (a.dashcamAvailable !== undefined) out.dashcamAvailable = a.dashcamAvailable;
  if (a.injuries !== undefined) out.injuries = a.injuries;
  if (a.roadworthyAfter !== undefined) out.roadworthyAfter = a.roadworthyAfter;
  if (a.driveable !== undefined) out.driveable = a.driveable;
  if (a.airbagsDeployed !== undefined) out.airbagsDeployed = a.airbagsDeployed;
  return out;
}

export function buildCreateClaimBody(state: FnolState): CreateClaimBody {
  const body: CreateClaimBody = {
    channel: state.channel,
    disclosure: { callRecordingReadAt: state.disclosure.readAt, acknowledged: true, ...(has(state.disclosure.acknowledgedBy) ? { acknowledgedBy: state.disclosure.acknowledgedBy.trim() } : {}) },
    claimant: toPartyInput(state.claimant, state.driverSameAsClaimant ? ['claimant', 'driver', 'keeper'] : ['claimant', 'keeper']),
    vehicle: toVehicleInput(state.vehicle),
    accident: toAccidentDetails(state.accident),
    witnesses: state.witnesses.filter((w) => has(w.name)).map((w) => ({ ...w, name: w.name.trim() })),
    services: { hire: state.services.hire, recovery: state.services.recovery, storage: state.services.storage, engineer: state.services.engineer, ...(has(state.services.notes) ? { notes: state.services.notes.trim() } : {}) },
    gtaSubscriber: false
  };
  if (!state.driverSameAsClaimant) body.driver = toPartyInput(state.driver, ['driver']);
  const tp = state.thirdParty;
  if (has(tp.registration) || has(tp.driverName) || has(tp.insurerName) || has(tp.contact)) {
    body.thirdParty = {};
    if (has(tp.registration)) body.thirdParty.registration = normaliseRegistration(tp.registration);
    if (has(tp.driverName)) body.thirdParty.driverName = tp.driverName.trim();
    if (has(tp.insurerName)) body.thirdParty.insurerName = tp.insurerName.trim();
    if (has(tp.insurerPolicyNumber)) body.thirdParty.insurerPolicyNumber = tp.insurerPolicyNumber.trim();
    if (has(tp.contact)) body.thirdParty.contact = tp.contact.trim();
  }
  if (has(state.clientInsurer.name) || has(state.clientInsurer.policyNumber)) {
    body.clientInsurer = {};
    if (has(state.clientInsurer.name)) body.clientInsurer.name = state.clientInsurer.name.trim();
    if (has(state.clientInsurer.policyNumber)) body.clientInsurer.policyNumber = state.clientInsurer.policyNumber.trim();
  }
  if (state.accident.injuries) {
    body.injury = { reported: true, ...(has(state.injury.referralTo) ? { referralTo: state.injury.referralTo.trim() } : {}), ...(has(state.injury.notes) ? { notes: state.injury.notes.trim() } : {}) };
  }
  if (has(state.handlerId)) body.handlerId = state.handlerId.trim();
  return body;
}

/** The intervention-register entry for a "yes" to the script-guard question. Null when no offer was made. */
export function buildOfferInput(state: FnolState): InterventionOfferInput | null {
  const o = state.offer;
  if (!o.offered) return null;
  const terms: InterventionOffer['terms'] = {};
  if (o.excessPence !== null) terms.excessPence = o.excessPence;
  if (has(o.mileageLimitPerDay) && /^\d+$/.test(o.mileageLimitPerDay.trim())) terms.mileageLimitPerDay = Number(o.mileageLimitPerDay);
  if (o.deliveryIncluded !== undefined) terms.deliveryIncluded = o.deliveryIncluded;
  if (o.insuranceIncluded !== undefined) terms.insuranceIncluded = o.insuranceIncluded;
  if (has(o.durationStated)) terms.durationStated = o.durationStated.trim();
  if (has(o.otherTerms)) terms.otherTerms = o.otherTerms.trim();
  const input: InterventionOfferInput = {
    receivedAt: o.receivedAt,
    channel: o.channel,
    offerorName: o.offerorName.trim(),
    terms,
    suitabilityReasons: [],
    clientDecision: o.clientDecision,
    evidenceIds: []
  };
  if (has(o.vehicleClassOffered)) input.vehicleClassOffered = o.vehicleClassOffered.trim();
  if (o.dailyRatePence !== null) {
    input.dailyRatePence = o.dailyRatePence;
    input.rateIncludesVat = o.rateIncludesVat;
  }
  if (has(o.clientReasons)) input.clientReasons = o.clientReasons.trim();
  if (o.clientDecision !== 'pending') input.clientDecisionAt = state.disclosure.readAt || o.receivedAt;
  return input;
}

/** Events to append after the claim exists: services agreed (starts the GTA 4.1 NCAF clock) and the injury referral task. */
export function buildFollowUpEvents(state: FnolState, now: ISODateTime): CreateEventBody[] {
  const events: CreateEventBody[] = [];
  if (anyServiceAgreed(state.services)) {
    const agreed = (['hire', 'recovery', 'storage', 'engineer'] as const).filter((k) => state.services[k]);
    events.push({
      type: 'services_agreed',
      at: now,
      summary: `Services agreed at FNOL: ${agreed.join(', ')}`,
      data: { services: agreed, notes: state.services.notes.trim() || undefined },
      attributableTo: 'ccguk'
    });
  }
  if (state.accident.injuries) {
    events.push({
      type: 'note',
      at: now,
      summary: `Injury reported at FNOL — personal injury referral-out task created${has(state.injury.referralTo) ? ` (${state.injury.referralTo.trim()})` : ''}; no fee taken`,
      data: { task: 'injury_referral', referralTo: state.injury.referralTo.trim() || undefined, feeTaken: false, notes: state.injury.notes.trim() || undefined },
      attributableTo: 'ccguk'
    });
  }
  return events;
}

/** The injuryReferral patch for PATCH /claims/:id (only when injuries were reported). */
export function buildInjuryReferral(state: FnolState, now: ISODateTime): { referredTo: string; referredAt: ISODateTime; feeTaken: false } | null {
  if (!state.accident.injuries) return null;
  return { referredTo: state.injury.referralTo.trim() || 'Personal injury solicitor — to be instructed', referredAt: now, feeTaken: false };
}
