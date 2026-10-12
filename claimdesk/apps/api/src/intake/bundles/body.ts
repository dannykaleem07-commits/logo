// owned by intake-server
/**
 * The POST /claims body a bundle registers with (docs/SMART-INTAKE.md §6.6): built from the reconciled draft only.
 * The client's account is the client's own written words (or the owner's); `takenCold` and the call-recording
 * disclosure are left unset — those FNOL warnings become the first action in the brief ("Call the client"). Witnesses
 * are sent only when the documents answer the question (names or "none"). An injury is referred out (no fee). The
 * claim's liability is never set by intake (POST /claims defaults it to `unknown`).
 */
import { compatible, type BundleFieldKey, type DraftField, type WitnessDraft } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { CreateClaimBody } from '../../schemas/claims.js';
import { createClaimBody } from '../../schemas/claims.js';
import { parseUkAddress } from '../validators.js';

export interface BodyInput {
  fields: DraftField[];
  witnesses: WitnessDraft[];
  witnessesAnswered: boolean;
  bundleName: string;
  documents: number;
  now: string;
  /** "Use the existing client record" (decision link_party). */
  linkPartyId: string | null;
}

export interface BuiltBody {
  body: CreateClaimBody | null;
  /** Key details missing before a body can be built (the owner fills them in). */
  missing: string[];
}

const yes = (v: string | null | undefined) => v === 'yes';
const no = (v: string | null | undefined) => v === 'no';

function address(v: string | null): { line1: string; line2?: string; town?: string; postcode: string } | undefined {
  if (!v) return undefined;
  const r = parseUkAddress(v);
  return r.ok && r.value ? r.value : undefined;
}

/** An insurer party already on file with this name (so registering links it instead of creating a duplicate). */
function insurerOnFile(ctx: AppContext, name: string): string | undefined {
  const n = name.trim().toLowerCase();
  return ctx.repos.listParties(ctx.db, { roles: ['insurer'], limit: 2000 }).find((p) => p.name.trim().toLowerCase() === n)?.id;
}

export function buildCreateClaimBody(ctx: AppContext, i: BodyInput): BuiltBody {
  const val = (k: BundleFieldKey): string | null => i.fields.find((f) => f.key === k)?.value ?? null;
  const missing: string[] = [];
  const name = val('client.name');
  const reg = val('vehicle.registration');
  const occurredAt = val('accident.occurredAt');
  const location = val('accident.location');
  const circumstances = val('accident.circumstances');
  if (!name && !i.linkPartyId) missing.push('the client’s name');
  if (!reg) missing.push('the client car’s registration');
  if (!occurredAt) missing.push('the accident date and time');
  else if (/^\d{4}-\d{2}-\d{2}$/.test(occurredAt)) missing.push('the time of the accident (only the date is known)');
  if (!location) missing.push('where the accident happened');
  if (!circumstances) missing.push('what happened (the client’s account)');
  if (missing.length) return { body: null, missing };

  const driverName = val('driver.name');
  const driverDiffers = Boolean(driverName && name && !compatible('client.name', { value: name }, { value: driverName }).same);
  const claimant = i.linkPartyId
    ? { id: i.linkPartyId }
    : {
        kind: 'individual' as const,
        name: name!,
        ...(val('client.phone') ? { phone: val('client.phone')! } : {}),
        ...(val('client.email') ? { email: val('client.email')! } : {}),
        ...(val('client.dateOfBirth') ? { dateOfBirth: val('client.dateOfBirth')!.slice(0, 10) } : {}),
        ...(val('client.drivingLicenceNumber') ? { drivingLicenceNumber: val('client.drivingLicenceNumber')! } : {}),
        ...(address(val('client.address')) ? { address: address(val('client.address'))! } : {}),
        roles: (driverDiffers ? ['claimant'] : ['claimant', 'driver']) as Array<'claimant' | 'driver'>,
      };
  const driver = driverDiffers
    ? {
        kind: 'individual' as const,
        name: driverName!,
        ...(val('driver.phone') ? { phone: val('driver.phone')! } : {}),
        ...(val('driver.dateOfBirth') ? { dateOfBirth: val('driver.dateOfBirth')!.slice(0, 10) } : {}),
        ...(val('driver.drivingLicenceNumber') ? { drivingLicenceNumber: val('driver.drivingLicenceNumber')! } : {}),
        ...(address(val('driver.address')) ? { address: address(val('driver.address'))! } : {}),
        roles: ['driver' as const],
      }
    : undefined;
  const vehicle = {
    registration: reg!.replace(/\s+/g, ''),
    ...(val('vehicle.vin') ? { vin: val('vehicle.vin')! } : {}),
    ...(val('vehicle.make') ? { make: val('vehicle.make')! } : {}),
    ...(val('vehicle.model') ? { model: val('vehicle.model')! } : {}),
    ...(val('vehicle.colour') ? { colour: val('vehicle.colour')! } : {}),
    ...(val('vehicle.firstRegistered') ? { monthOfFirstRegistration: val('vehicle.firstRegistered')!.slice(0, 7) } : {}),
    ownership: 'client' as const,
  };
  const tpReg = val('tp.registration');
  const thirdPartyVehicle = tpReg ? { registration: tpReg.replace(/\s+/g, ''), ...(val('tp.make') ? { make: val('tp.make')! } : {}), ...(val('tp.model') ? { model: val('tp.model')! } : {}), ownership: 'third_party' as const } : undefined;
  const thirdParties: NonNullable<CreateClaimBody['thirdParties']> = [];
  if (val('tp.name')) thirdParties.push({ kind: 'individual', name: val('tp.name')!, ...(val('tp.phone') ? { phone: val('tp.phone')! } : {}), ...(address(val('tp.address')) ? { address: address(val('tp.address'))! } : {}), roles: ['third_party', 'third_party_driver'] });
  if (val('repairer.name')) thirdParties.push({ kind: 'company', name: val('repairer.name')!, ...(val('repairer.phone') ? { phone: val('repairer.phone')! } : {}), roles: ['repairer'] });
  if (val('engineer.name')) thirdParties.push({ kind: 'company', name: val('engineer.name')!, roles: ['engineer'] });
  const tpInsurer = val('tp.insurerName');
  const tpInsurerId = tpInsurer ? insurerOnFile(ctx, tpInsurer) : undefined;
  const thirdParty: NonNullable<CreateClaimBody['thirdParty']> = {
    ...(tpInsurerId ? { insurerId: tpInsurerId } : tpInsurer ? { insurerName: tpInsurer } : {}),
    ...(val('tp.policyNumber') ? { insurerPolicyNumber: val('tp.policyNumber')! } : {}),
    ...(val('tp.phone') && !val('tp.name') ? { contact: val('tp.phone')! } : {}),
  };
  const clientInsurerName = val('clientInsurer.name');
  const clientInsurerId = clientInsurerName ? insurerOnFile(ctx, clientInsurerName) : undefined;
  const clientInsurer = clientInsurerName ? { ...(clientInsurerId ? { id: clientInsurerId } : { name: clientInsurerName }), ...(val('clientInsurer.policyNumber') ? { policyNumber: val('clientInsurer.policyNumber')! } : {}) } : undefined;
  const witnesses = i.witnessesAnswered ? i.witnesses.map((w) => ({ name: w.name, ...(w.phone ? { phone: w.phone } : {}), ...(w.relationship ? { relationship: w.relationship } : {}) })) : undefined;
  const injuries = yes(val('accident.injuries')) ? true : no(val('accident.injuries')) ? false : undefined;
  const driveable = yes(val('accident.driveable')) ? true : no(val('accident.driveable')) ? false : undefined;
  const policeAttended = yes(val('accident.policeAttended')) || Boolean(val('accident.policeReference')) ? true : no(val('accident.policeAttended')) ? false : undefined;
  const body = {
    claimant,
    ...(driver ? { driver } : {}),
    vehicle,
    ...(thirdPartyVehicle ? { thirdPartyVehicle } : {}),
    ...(thirdParties.length ? { thirdParties } : {}),
    ...(Object.keys(thirdParty).length ? { thirdParty } : {}),
    ...(val('tp.insurerRef') ? { atFaultInsurerRef: val('tp.insurerRef')! } : {}),
    ...(clientInsurer ? { clientInsurer } : {}),
    accident: {
      occurredAt: occurredAt!,
      location: location!,
      ...(val('accident.postcode') ? { postcode: val('accident.postcode')! } : {}),
      circumstances: circumstances!,
      ...(policeAttended !== undefined ? { policeAttended } : {}),
      ...(val('accident.policeReference') ? { policeReference: val('accident.policeReference')! } : {}),
      ...(injuries !== undefined ? { injuries } : {}),
      ...(driveable !== undefined ? { driveable, roadworthyAfter: driveable } : {}),
      ...(witnesses ? { independentWitness: witnesses.some((w) => /^(none|independent|stranger)$/i.test(w.relationship ?? '')) } : {}),
    },
    liability: 'unknown' as const,
    ...(witnesses ? { witnesses } : {}),
    ...(injuries ? { injury: { reported: true } } : {}),
    services: { hire: yes(val('hire.needed')) },
    channel: 'email' as const,
    fnolAt: i.now,
    notes: `Opened from intake bundle '${i.bundleName}' (${i.documents} document${i.documents === 1 ? '' : 's'}).`,
  };
  const parsed = createClaimBody.safeParse(body);
  if (!parsed.success) return { body: null, missing: parsed.error.issues.slice(0, 5).map((x) => `${x.path.join('.')}: ${x.message}`) };
  return { body: parsed.data, missing: [] };
}
