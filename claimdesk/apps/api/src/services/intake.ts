/**
 * FNOL intake normalisation (BLUEPRINT §3.1).
 *
 * `POST /claims` accepts two spellings of the same facts — the API's native body and the web client's FNOL-wizard body
 * (`apps/web/src/api/client.ts` CreateClaimBody). `normaliseFnol` folds them into one internal shape, and `toFnolInput`
 * maps that onto the domain's `FnolInput` so `validateFnol` sees every answer the handler gave (recording disclosure,
 * witnesses, client insurer and policy, third-party registration, injuries, roadworthiness, the script-guard question).
 */
import type { Party, Vehicle } from '@ccguk/domain';
import type { FnolInput } from '../engines.js';
import type { CreateClaimBody } from '../schemas/claims.js';
import type { PartyRef } from '../schemas/parties.js';
import type { VehicleRef } from '../schemas/vehicles.js';

export interface NormalisedWitness {
  party: PartyRef;
  name: string;
  relationship?: string;
  independent?: boolean;
}

export interface NormalisedFnol {
  claimant: PartyRef;
  driver?: PartyRef;
  vehicle: VehicleRef;
  thirdParties: PartyRef[];
  thirdPartyVehicle?: VehicleRef;
  thirdPartyRegistrationUnknown?: boolean;
  thirdPartyPolicyNumber?: string;
  thirdPartyContact?: string;
  atFaultInsurer?: PartyRef;
  atFaultInsurerRef?: string;
  clientInsurer?: PartyRef;
  clientPolicyNumber?: string;
  accident: CreateClaimBody['accident'];
  liability: CreateClaimBody['liability'];
  handlerId?: string;
  injuryReferralTo?: string;
  injuryNotes?: string;
  interventionOffer?: CreateClaimBody['interventionOffer'];
  servicesAgreedAt?: string;
  fnolAt?: string;
  callRecordingDisclosed?: boolean;
  callRecordingReadAt?: string;
  notes?: string;
  takenCold?: boolean;
  witnesses?: NormalisedWitness[];
  offerDisclosed?: boolean;
  offerDetails?: CreateClaimBody['offerDetails'];
  channel?: CreateClaimBody['channel'];
  services?: CreateClaimBody['services'];
}

const INDEPENDENT_RE = /^(none|no|independent|stranger|n\/a|unknown to (the )?client)$/i;

function clean(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

/** Fold both accepted body shapes into one. Pure. */
export function normaliseFnol(body: CreateClaimBody): NormalisedFnol {
  const thirdParties: PartyRef[] = [...(body.thirdParties ?? [])];
  let thirdPartyVehicle = body.thirdPartyVehicle;
  let atFaultInsurer = body.atFaultInsurer;
  const tp = body.thirdParty;
  if (tp) {
    const reg = clean(tp.registration);
    if (reg && !thirdPartyVehicle) thirdPartyVehicle = { registration: reg, make: 'UNKNOWN', model: 'UNKNOWN', ownership: 'third_party' };
    const driverName = clean(tp.driverName) ?? clean(tp.name);
    if (driverName) thirdParties.push({ kind: 'individual', name: driverName, roles: ['third_party', 'third_party_driver'], phone: clean(tp.contact) && /\d{5,}/.test(tp.contact!) ? tp.contact!.trim() : undefined });
    if (!atFaultInsurer) {
      if (tp.insurerId) atFaultInsurer = { id: tp.insurerId };
      else if (clean(tp.insurerName)) atFaultInsurer = { kind: 'company', name: tp.insurerName!.trim(), roles: ['insurer'] };
    }
  }

  let clientInsurer: PartyRef | undefined;
  let clientPolicyNumber = clean(body.clientPolicyNumber);
  const ci = body.clientInsurer;
  if (ci) {
    if (ci.id) clientInsurer = { id: ci.id };
    else if (clean(ci.name)) {
      const { policyNumber: _p, id: _i, ...rest } = ci;
      clientInsurer = { ...rest, kind: rest.kind ?? 'company', name: rest.name!.trim(), roles: rest.roles ?? ['insurer'] };
    }
    clientPolicyNumber = clientPolicyNumber ?? clean(ci.policyNumber);
  }

  const witnesses: NormalisedWitness[] | undefined = body.witnesses?.map((w) => {
    const relationship = clean(w.relationship) ?? clean(w.relationshipToClaimant) ?? (w.independent === true ? 'none' : undefined);
    const independent = w.independent ?? (relationship ? INDEPENDENT_RE.test(relationship) : undefined);
    return {
      name: w.name,
      relationship,
      independent,
      party: { kind: 'individual', name: w.name, phone: clean(w.phone), email: clean(w.email), address: w.address, roles: ['witness'], notes: relationship ? `Relationship to the claimant: ${relationship}` : undefined },
    };
  });

  const injuries = body.accident.injuries ?? (body.injury ? body.injury.reported : undefined);
  const accident = injuries === undefined ? body.accident : { ...body.accident, injuries };

  const disclosed = body.callRecordingDisclosed ?? (body.disclosure ? body.disclosure.acknowledged === true || Boolean(body.disclosure.callRecordingReadAt) : undefined);

  return {
    claimant: body.claimant,
    driver: body.driver,
    vehicle: body.vehicle,
    thirdParties,
    thirdPartyVehicle,
    thirdPartyRegistrationUnknown: tp?.registrationUnknown,
    thirdPartyPolicyNumber: clean(tp?.insurerPolicyNumber),
    thirdPartyContact: clean(tp?.contact),
    atFaultInsurer,
    atFaultInsurerRef: clean(body.atFaultInsurerRef),
    clientInsurer,
    clientPolicyNumber,
    accident,
    liability: body.liability,
    handlerId: body.handlerId,
    injuryReferralTo: clean(body.injuryReferralTo) ?? clean(body.injury?.referralTo),
    injuryNotes: clean(body.injury?.notes),
    interventionOffer: body.interventionOffer,
    servicesAgreedAt: body.servicesAgreedAt,
    fnolAt: body.fnolAt,
    callRecordingDisclosed: disclosed,
    callRecordingReadAt: body.disclosure?.callRecordingReadAt,
    notes: clean(body.notes),
    takenCold: body.takenCold,
    witnesses,
    offerDisclosed: body.offerDisclosed ?? (body.interventionOffer ? true : undefined),
    offerDetails: body.offerDetails ?? (body.interventionOffer ? { what: body.interventionOffer.vehicleClassOffered ?? 'a replacement vehicle', byWhom: body.interventionOffer.offerorName, when: body.interventionOffer.receivedAt ?? body.fnolAt ?? 'at FNOL' } : undefined),
    channel: body.channel,
    services: body.services,
  };
}

export interface ResolvedRefs {
  claimant?: Party;
  vehicle?: Vehicle;
  thirdPartyVehicle?: Vehicle;
  clientInsurer?: Party;
  atFaultInsurer?: Party;
}

/** Map the normalised FNOL onto the domain's `FnolInput`. Id references are filled from `resolved` when supplied. */
export function toFnolInput(n: NormalisedFnol, resolved: ResolvedRefs = {}): FnolInput {
  const claimant = 'id' in n.claimant ? resolved.claimant : n.claimant;
  const vehicle = 'id' in n.vehicle ? resolved.vehicle : n.vehicle;
  const tpVehicle = n.thirdPartyVehicle ? ('id' in n.thirdPartyVehicle ? resolved.thirdPartyVehicle : n.thirdPartyVehicle) : undefined;
  const tpDriver = n.thirdParties.find((p) => !('id' in p) && p.roles?.includes('third_party_driver')) as Exclude<PartyRef, { id: string }> | undefined;
  const insurer = n.atFaultInsurer ? ('id' in n.atFaultInsurer ? resolved.atFaultInsurer : n.atFaultInsurer) : undefined;
  const clientInsurer = n.clientInsurer ? ('id' in n.clientInsurer ? resolved.clientInsurer : n.clientInsurer) : undefined;
  const input: FnolInput = {
    accident: { ...n.accident, ...(n.takenCold !== undefined ? { takenCold: n.takenCold } : {}) },
    thirdParty: {
      ...(tpVehicle?.registration ? { registration: tpVehicle.registration } : {}),
      ...(n.thirdPartyRegistrationUnknown ? { registrationUnknown: true } : {}),
      ...(tpDriver?.name ? { name: tpDriver.name } : {}),
      ...(insurer?.name ? { insurer: insurer.name } : {}),
    },
  };
  if (n.callRecordingDisclosed !== undefined) input.recordingDisclosureGiven = n.callRecordingDisclosed;
  if (claimant) input.claimant = { name: claimant.name, phone: claimant.phone, email: claimant.email, dateOfBirth: claimant.dateOfBirth };
  if (vehicle?.registration) input.clientVehicle = { registration: vehicle.registration };
  if (n.witnesses !== undefined) input.witnesses = n.witnesses.map((w) => ({ name: w.name, phone: 'id' in w.party ? undefined : w.party.phone, email: 'id' in w.party ? undefined : w.party.email, relationship: w.relationship ?? (w.independent === true ? 'none' : undefined) }));
  if (clientInsurer?.name) input.clientInsurer = clientInsurer.name;
  if (n.clientPolicyNumber) input.clientPolicyNumber = n.clientPolicyNumber;
  if (n.offerDisclosed !== undefined) input.offerDisclosed = n.offerDisclosed;
  if (n.offerDetails) input.offerDetails = n.offerDetails;
  return input;
}

/** The roles a party takes by its position in the FNOL when the body gives none. */
export const FNOL_DEFAULT_ROLES = {
  claimant: ['claimant', 'driver'] as const,
  claimantWithDriver: ['claimant'] as const,
  driver: ['driver'] as const,
  thirdParty: ['third_party', 'third_party_driver'] as const,
  insurer: ['insurer'] as const,
  witness: ['witness'] as const,
};
