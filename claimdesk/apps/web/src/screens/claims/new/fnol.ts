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
 * Bodies mirror the API's zod schemas (apps/api/src/schemas/claims.ts): the claim is created in one POST with the
 * insurer and third-party refs, the inline intervention offer, `servicesAgreedAt`, `injuryReferralTo` and the intake
 * answers the domain validator checks (`takenCold`, `witnesses` with relationships, `offerDisclosed` + details,
 * `thirdParty.registrationUnknown`). The API creates the witness parties itself and runs the connected-party check;
 * a decision already given on the offer is recorded with PATCH offers. `PATCH /claims/:id` is strict, so nothing
 * else is patched on the new claim.
 *
 * TODO wire when @ccguk/domain intake lands: replace DISCLOSURE_TEXT / SCRIPT_GUARD_QUESTION with the
 * exported `intakeScript` and run `validateFnol` on the built body before POST.
 */
import type { AccidentDetails, InterventionOffer, ISODate, ISODateTime, OnFileMatch, Party, PartyRole } from '@ccguk/domain';
import { normaliseRegistration, isValidUkRegistration, MIN_CIRCUMSTANCES_CHARS } from '@ccguk/domain';
import type { ClaimVehicleInput, CreateClaimBody, CreateEventBody, FnolOfferInput, LookupMode, OfferPatchBody, PartyInput, PartyRef, VehicleInput, VehicleLookupResult, VehicleRef, WitnessInput } from '../../../api/client';
import { emptyPickerValue, toVehicleInput as pickerToVehicleInput, validatePicker, type VehiclePickerValue } from '../../vehicles/vehiclePicker';

export { MIN_CIRCUMSTANCES_CHARS };

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

export const TAKEN_COLD_LABEL = 'The account was taken cold: open questions only, recorded verbatim, nothing suggested.';
export const TP_REG_UNKNOWN_LABEL = 'Registration unknown — the other driver failed to stop (MIB untraced route; report to the police within 14 days).';
export const WITNESS_RELATIONSHIP_HINT = 'Feeds the connected-party check (lesson g). Write "None" if a stranger.';

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

export type LookupState = 'idle' | 'loading' | 'ok' | 'manual' | 'error';

/**
 * Step 3 state (docs/TEMPLATES-VEHICLES-DESKTOP.md §E.5). The registration is searched with POST /vehicles/lookup:
 * live (DVLA VES + DVSA MOT) when keys are set, otherwise ClaimDesk's own records plus the Total Car Check link.
 * The vehicle then comes from one of: an existing vehicle reused by id ("Use this vehicle"), the live lookup, or the
 * VehiclePicker (catalogue cascade, Total Car Check paste, typed) — saved as unverified.
 */
export interface FnolVehicleState {
  registration: string;
  lookupState: LookupState;
  lookup: VehicleLookupResult | null;
  lookupError: string;
  /** Hand entry: the VehiclePicker value (used when the lookup did not return the vehicle, or to override it). */
  picker: VehiclePickerValue;
  /** Override a live lookup with hand entry. */
  useManual: boolean;
  /** Odometer as stated by the client at FNOL (whole miles; recorded as a 'client' reading). */
  odometerMiles: string;
  /** "Use this vehicle": an on-file vehicle reused by id. */
  onFile: OnFileMatch | null;
}

export function emptyVehicleState(): FnolVehicleState {
  return { registration: '', lookupState: 'idle', lookup: null, lookupError: '', picker: emptyPickerValue(), useManual: false, odometerMiles: '', onFile: null };
}

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
  /** Handler's confirmation that the account was taken cold (sent as `takenCold: true`; never as false). */
  takenCold: boolean;
}

export type FnolChannel = NonNullable<CreateClaimBody['channel']>;

export interface FnolState {
  channel: FnolChannel;
  disclosure: { acknowledged: boolean; readAt: string; acknowledgedBy: string };
  claimant: PartyForm;
  driverSameAsClaimant: boolean;
  driver: PartyForm;
  clientInsurer: { name: string; policyNumber: string };
  vehicle: FnolVehicleState;
  accident: AccidentForm;
  thirdParty: { registration: string; registrationUnknown: boolean; driverName: string; insurerName: string; insurerPolicyNumber: string; contact: string };
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
    vehicle: emptyVehicleState(),
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
      airbagsDeployed: undefined,
      takenCold: false
    },
    thirdParty: { registration: '', registrationUnknown: false, driverName: '', insurerName: '', insurerPolicyNumber: '', contact: '' },
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
/** The API requires at least five characters for a phone number. */
const phoneOk = (p: string) => p.replace(/\s+/g, '').length >= 5;

export function lookupLinkedClaims(state: FnolState) {
  return state.vehicle.lookup?.linkedClaims ?? [];
}

/** A fleet unit presented as the client vehicle is a hard stop (lessons f, h). */
export function fleetUnitHardStop(state: FnolState): boolean {
  const onFile = state.vehicle.onFile;
  return Boolean(state.vehicle.lookup?.fleetUnit) || Boolean(onFile && (onFile.ownership === 'fleet' || onFile.fleetUnit));
}

/** 'live' / 'manual' as the last search reported it, else what Settings says; undefined until known. */
export function vehicleLookupMode(v: FnolVehicleState, fromSettings?: LookupMode): LookupMode | undefined {
  return v.lookup?.lookupMode ?? fromSettings;
}

/** True when the details come from the VehiclePicker (no live result to use, or the handler overrides it). */
export function needsHandEntry(v: FnolVehicleState): boolean {
  if (v.onFile) return false;
  return v.useManual || v.lookupState === 'manual' || v.lookupState === 'error' || (v.lookupState === 'ok' && v.lookup?.status !== 'ok');
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
      else if (has(state.claimant.phone) && !phoneOk(state.claimant.phone)) e['claimant.contact'] = 'The phone number looks too short.';
      if (has(state.claimant.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.claimant.email.trim())) e['claimant.email'] = 'Enter a valid email address.';
      if (!state.driverSameAsClaimant && !has(state.driver.name)) e['driver.name'] = 'Driver name is required when the claimant was not driving.';
      if (!state.driverSameAsClaimant && has(state.driver.phone) && !phoneOk(state.driver.phone)) e['driver.contact'] = 'The phone number looks too short.';
      break;
    case 3: {
      const reg = normaliseRegistration(state.vehicle.registration);
      if (!reg) e['vehicle.registration'] = 'Registration is required.';
      else if (!isValidUkRegistration(reg)) e['vehicle.registration'] = 'This does not look like a UK registration mark. Check it with the client.';
      if (reg && isValidUkRegistration(reg)) {
        const v = state.vehicle;
        if (!v.onFile && (v.lookupState === 'idle' || v.lookupState === 'loading')) e['vehicle.lookup'] = 'Search the registration first (a live lookup when keys are set, otherwise ClaimDesk’s own records).';
        else if (needsHandEntry(v)) {
          // make + model from any source: the catalogue, a Total Car Check paste or typed by hand
          const pe = validatePicker(v.picker, { requireMakeModel: true, today: now.toISOString().slice(0, 10) });
          for (const [k, msg] of Object.entries(pe)) if (msg) e[`vehicle.${k}`] = msg;
        }
        if (has(v.odometerMiles) && !/^\d{1,7}$/.test(v.odometerMiles.replace(/[,\s]/g, ''))) e['vehicle.odometerMiles'] = 'Whole miles, e.g. 45210.';
      }
      if (fleetUnitHardStop(state)) e['vehicle.fleet'] = 'This registration is a CCGUK fleet unit. A fleet unit cannot be a client vehicle (hard stop).';
      break;
    }
    case 4: {
      const a = state.accident;
      if (!a.occurredAt) e['accident.occurredAt'] = 'Date and time of the accident are required.';
      else if (Date.parse(a.occurredAt) > now.getTime()) e['accident.occurredAt'] = 'The accident cannot be in the future.';
      if (!has(a.location)) e['accident.location'] = 'Location is required.';
      if (!has(a.circumstances) || a.circumstances.trim().length < MIN_CIRCUMSTANCES_CHARS) e['accident.circumstances'] = `Record the client's account in their own words (at least ${MIN_CIRCUMSTANCES_CHARS} characters).`;
      if (!a.takenCold) e['accident.takenCold'] = 'Confirm the account was taken cold before continuing.';
      if (a.injuries === undefined) e['accident.injuries'] = 'Answer the injuries question.';
      if (a.roadworthyAfter === undefined) e['accident.roadworthyAfter'] = 'Answer whether the vehicle is roadworthy.';
      if (a.driveable === undefined) e['accident.driveable'] = 'Answer whether the vehicle is driveable.';
      if (a.airbagsDeployed === undefined) e['accident.airbagsDeployed'] = 'Answer whether airbags deployed.';
      if (state.thirdParty.registrationUnknown) {
        if (has(state.thirdParty.registration)) e['thirdParty.registration'] = 'Either record the registration or mark it unknown, not both.';
      } else if (has(state.thirdParty.registration) && !isValidUkRegistration(state.thirdParty.registration)) {
        e['thirdParty.registration'] = 'Not a valid UK registration format — the API refuses it. Check it with the client, or mark it unknown.';
      }
      state.witnesses.forEach((w, i) => {
        if (!has(w.name)) e[`witness.${i}.name`] = 'Witness name is required (or remove the row).';
        if (!has(w.relationshipToClaimant) && !w.independent) e[`witness.${i}.relationship`] = 'How does the client know this witness? ("None" if a stranger.)';
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

/** A complete address needs line 1 and a postcode (API `addressSchema`); anything less is kept as a note. */
export function toAddress(p: Pick<PartyForm, 'line1' | 'line2' | 'town' | 'postcode'>): Party['address'] | undefined {
  if (!has(p.line1) || p.postcode.trim().length < 2) return undefined;
  const out: NonNullable<Party['address']> = { line1: p.line1.trim(), postcode: p.postcode.trim().toUpperCase() };
  if (has(p.line2)) out.line2 = p.line2.trim();
  if (has(p.town)) out.town = p.town.trim();
  return out;
}

export function toPartyInput(p: PartyForm, roles: PartyInput['roles']): PartyInput {
  const out: PartyInput = { kind: 'individual', name: p.name.trim(), roles };
  const notes: string[] = [];
  if (has(p.phone)) {
    if (phoneOk(p.phone)) out.phone = p.phone.trim();
    else notes.push(`Phone as given: ${p.phone.trim()}`);
  }
  if (has(p.email)) out.email = p.email.trim();
  if (has(p.dateOfBirth)) out.dateOfBirth = p.dateOfBirth;
  if (has(p.drivingLicenceNumber)) out.drivingLicenceNumber = p.drivingLicenceNumber.trim();
  const address = toAddress(p);
  if (address) out.address = address;
  else if (has(p.line1) || has(p.line2) || has(p.town) || has(p.postcode)) {
    notes.push(`Address (incomplete): ${[p.line1, p.line2, p.town, p.postcode].map((x) => x.trim()).filter(Boolean).join(', ')}`);
  }
  if (notes.length) out.notes = notes.join('. ');
  return out;
}

/**
 * Where the vehicle details come from: a vehicle already on file (reused by id), the DVLA/DVSA lookup, or hand entry
 * through the VehiclePicker (catalogue, Total Car Check paste or typed — stored as unverified).
 */
export function vehicleSource(v: FnolState['vehicle']): 'on_file' | 'lookup' | 'manual' {
  if (v.onFile) return 'on_file';
  return v.useManual || v.lookupState !== 'ok' || v.lookup?.status !== 'ok' ? 'manual' : 'lookup';
}

/** Legacy helper kept for callers that want the flat details; `toVehicleRef` is what the claim body uses. */
export function toVehicleInput(v: FnolState['vehicle']): VehicleInput {
  const ref = toVehicleRef(v, new Date().toISOString().slice(0, 10));
  return 'id' in ref ? { registration: normaliseRegistration(v.registration) } : ref;
}

/**
 * The vehicle for POST /claims. A vehicle reused from the on-file matches ("Use this vehicle") and a successful lookup
 * (which already upserted the vehicle with its DVLA/DVSA records) are referenced by id; otherwise the VehiclePicker
 * details are sent with their spec and source (API `vehicleInput`; the server records an unverified LookupRecord with
 * that provider). A client-stated odometer reading becomes a 'client' reading dated today.
 */
export function toVehicleRef(v: FnolState['vehicle'], today: ISODate): VehicleRef {
  const registration = normaliseRegistration(v.registration);
  const source = vehicleSource(v);
  if (v.onFile) return { id: v.onFile.vehicleId };
  const ok = v.lookup?.status === 'ok' ? v.lookup : undefined;
  if (source === 'lookup' && ok?.vehicle.id) return { id: ok.vehicle.id };
  const out: ClaimVehicleInput = { registration, ownership: 'client' };
  if (source === 'lookup' && ok) {
    const f = ok.vehicle;
    if (f.make) out.make = f.make;
    if (f.model) out.model = f.model;
    if (f.variant) out.variant = f.variant;
    if (f.colour) out.colour = f.colour;
    if (f.fuelType) out.fuelType = f.fuelType;
    if (f.transmission) out.transmission = f.transmission;
    if (f.yearOfManufacture) out.yearOfManufacture = f.yearOfManufacture;
    if (f.engineCapacityCc) out.engineCapacityCc = f.engineCapacityCc;
    if (f.vin) out.vin = f.vin;
    if (f.motExpiryDate) out.motExpiryDate = f.motExpiryDate;
    if (f.taxDueDate) out.taxDueDate = f.taxDueDate;
    return out;
  }
  // Hand entry: picker fields + spec + source (catalogue / Total Car Check paste / typed), saved as unverified.
  const hand: ClaimVehicleInput = { ...pickerToVehicleInput({ ...v.picker, registration }, { ownership: 'client' }), registration, ownership: 'client' };
  const miles = v.odometerMiles.replace(/[,\s]/g, '');
  if (/^\d{1,7}$/.test(miles)) {
    hand.odometer = [{ source: 'client', date: today, miles: Number(miles), note: 'Stated by the client at FNOL (unverified)' }];
  }
  return hand;
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

/** `offerDetails` for the domain validator: what / by whom / when, as the client described it. */
export function offerDetailsFrom(o: OfferForm): NonNullable<CreateClaimBody['offerDetails']> {
  return {
    what: has(o.vehicleClassOffered) ? o.vehicleClassOffered.trim() : has(o.otherTerms) ? o.otherTerms.trim() : undefined,
    byWhom: has(o.offerorName) ? o.offerorName.trim() : undefined,
    when: o.receivedAt || undefined
  };
}

export type KnownParty = Pick<Party, 'id' | 'name' | 'roles'>;

/** An existing party with this exact name (case-insensitive) and role, so insurers are not duplicated per claim. */
export function pickExistingParty(parties: KnownParty[], name: string, role: PartyRole = 'insurer'): KnownParty | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  return parties.find((p) => p.name.trim().toLowerCase() === n && p.roles.includes(role));
}

/** Insurer ref for the body: the known party's id when one matches, otherwise details for a new company party. */
export function insurerRef(name: string, known: KnownParty[] = []): PartyRef {
  const match = pickExistingParty(known, name, 'insurer');
  return match ? { id: match.id } : { kind: 'company', name: name.trim(), roles: ['insurer'] };
}

export const DEFAULT_INJURY_REFERRAL = 'Personal injury solicitor — to be instructed';

/** The intervention-register entry for a "yes" to the script-guard question (inline in POST /claims). Null when no offer. */
export function buildFnolOffer(state: FnolState): FnolOfferInput | null {
  const o = state.offer;
  if (!o.offered) return null;
  const terms: InterventionOffer['terms'] = {};
  if (o.excessPence !== null) terms.excessPence = o.excessPence;
  if (has(o.mileageLimitPerDay) && /^\d+$/.test(o.mileageLimitPerDay.trim())) terms.mileageLimitPerDay = Number(o.mileageLimitPerDay);
  if (o.deliveryIncluded !== undefined) terms.deliveryIncluded = o.deliveryIncluded;
  if (o.insuranceIncluded !== undefined) terms.insuranceIncluded = o.insuranceIncluded;
  if (has(o.durationStated)) terms.durationStated = o.durationStated.trim();
  if (has(o.otherTerms)) terms.otherTerms = o.otherTerms.trim();
  const input: FnolOfferInput = { offerorName: o.offerorName.trim(), channel: o.channel, clientToldToIgnore: false };
  if (o.receivedAt) input.receivedAt = o.receivedAt;
  if (has(o.vehicleClassOffered)) input.vehicleClassOffered = o.vehicleClassOffered.trim();
  if (o.dailyRatePence !== null) {
    input.dailyRatePence = o.dailyRatePence;
    input.rateIncludesVat = o.rateIncludesVat;
  }
  if (Object.keys(terms).length) input.terms = terms;
  return input;
}

/** PATCH /claims/:id/offers/:oid body when the client had already decided at FNOL; null while pending. */
export function buildOfferDecision(state: FnolState, now: ISODateTime): OfferPatchBody | null {
  const o = state.offer;
  if (!o.offered || o.clientDecision === 'pending') return null;
  const body: OfferPatchBody = { clientDecision: o.clientDecision, clientDecisionAt: state.disclosure.readAt || now };
  if (has(o.clientReasons)) body.clientReasons = o.clientReasons.trim();
  return body;
}

export interface BuildOptions {
  now: ISODateTime;
  /** Parties already on file (insurers) so the body references them by id instead of creating duplicates. */
  knownParties?: KnownParty[];
}

export function buildCreateClaimBody(state: FnolState, opts: BuildOptions): CreateClaimBody {
  const now = opts.now;
  const today = now.slice(0, 10);
  const known = opts.knownParties ?? [];
  const notes: string[] = [`FNOL via ${state.channel.replace(/_/g, ' ')}`];
  const body: CreateClaimBody = {
    claimant: toPartyInput(state.claimant, state.driverSameAsClaimant ? ['claimant', 'driver', 'keeper'] : ['claimant', 'keeper']),
    vehicle: toVehicleRef(state.vehicle, today),
    accident: toAccidentDetails(state.accident),
    liability: 'unknown',
    fnolAt: state.disclosure.readAt || now,
    callRecordingDisclosed: state.disclosure.acknowledged,
    ...(state.accident.takenCold ? { takenCold: true as const } : {}),
    ...(state.offer.offered !== undefined ? { offerDisclosed: state.offer.offered } : {}),
    ...(state.offer.offered ? { offerDetails: offerDetailsFrom(state.offer) } : {}),
    // descriptive web fields (see api/client.ts CreateClaimBody)
    channel: state.channel,
    disclosure: { callRecordingReadAt: state.disclosure.readAt || now, acknowledged: true, ...(has(state.disclosure.acknowledgedBy) ? { acknowledgedBy: state.disclosure.acknowledgedBy.trim() } : {}) },
    witnesses: state.witnesses.filter((w) => has(w.name)).map((w) => ({ ...w, name: w.name.trim() })),
    services: { hire: state.services.hire, recovery: state.services.recovery, storage: state.services.storage, engineer: state.services.engineer, ...(has(state.services.notes) ? { notes: state.services.notes.trim() } : {}) }
  };
  if (state.disclosure.readAt) notes.push(`Call-recording disclosure read ${state.disclosure.readAt}${has(state.disclosure.acknowledgedBy) ? ` by ${state.disclosure.acknowledgedBy.trim()}` : ''} and acknowledged`);
  if (!state.driverSameAsClaimant) body.driver = toPartyInput(state.driver, ['driver']);

  const tp = state.thirdParty;
  if (has(tp.driverName)) {
    const party: PartyInput = { kind: 'individual', name: tp.driverName.trim(), roles: ['third_party_driver'] };
    if (has(tp.contact)) party.notes = `Contact as given by the client: ${tp.contact.trim()}`;
    body.thirdParties = [party];
  } else if (has(tp.contact)) notes.push(`Third-party contact as given: ${tp.contact.trim()}`);
  if (tp.registrationUnknown) body.thirdParty = { registrationUnknown: true };
  else if (has(tp.registration)) body.thirdPartyVehicle = { registration: normaliseRegistration(tp.registration), ownership: 'third_party' };
  if (has(tp.insurerName)) body.atFaultInsurer = insurerRef(tp.insurerName, known);
  if (has(tp.insurerPolicyNumber)) body.atFaultInsurerRef = tp.insurerPolicyNumber.trim();

  if (has(state.clientInsurer.name)) body.clientInsurer = insurerRef(state.clientInsurer.name, known);
  if (has(state.clientInsurer.policyNumber)) body.clientPolicyNumber = state.clientInsurer.policyNumber.trim();

  if (state.accident.injuries) {
    body.injuryReferralTo = has(state.injury.referralTo) ? state.injury.referralTo.trim() : DEFAULT_INJURY_REFERRAL;
    if (has(state.injury.notes)) notes.push(`Injury notes: ${state.injury.notes.trim()}`);
  }
  const offer = buildFnolOffer(state);
  if (offer) body.interventionOffer = offer;
  if (anyServiceAgreed(state.services)) {
    body.servicesAgreedAt = now;
    notes.push(`Services agreed at FNOL: ${agreedServices(state.services).join(', ')}${has(state.services.notes) ? ` (${state.services.notes.trim()})` : ''}`);
  }
  if (has(state.handlerId)) body.handlerId = state.handlerId.trim();
  body.notes = notes.join('. ');
  return body;
}

export function agreedServices(s: FnolState['services']): Array<'hire' | 'recovery' | 'storage' | 'engineer'> {
  return (['hire', 'recovery', 'storage', 'engineer'] as const).filter((k) => s[k]);
}

/**
 * Events to append after the claim exists. The API itself appends `fnol` (with the witness reports), `services_agreed`
 * (from servicesAgreedAt), the injury-referral note and the `intervention_offer` event; this note adds the one detail
 * the API's event does not carry in its summary: which services were agreed.
 */
export function buildFollowUpEvents(state: FnolState, now: ISODateTime): CreateEventBody[] {
  const events: CreateEventBody[] = [];
  if (anyServiceAgreed(state.services)) {
    const agreed = agreedServices(state.services);
    events.push({
      type: 'note',
      at: now,
      summary: `Services agreed at FNOL: ${agreed.join(', ')}`,
      data: { task: 'services_agreed_detail', services: agreed, notes: state.services.notes.trim() || undefined },
      attributableTo: 'ccguk'
    });
  }
  return events;
}
