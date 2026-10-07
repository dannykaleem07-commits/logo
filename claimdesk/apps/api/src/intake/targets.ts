// owned by intake
/**
 * Field targets (docs/SUPREME-DESIGN.md §G.4): the closed `FieldTarget` union from @ccguk/domain, each with
 *  - `sensitive` (§G.2 step 5: date of birth, licence number, policy number — always confirmed by the owner),
 *  - a validator (intake/validators.ts) that normalises the value,
 *  - how to read the current value from the claim, its vehicles and parties, and
 *  - the existing route(s) + body that apply it (run through `ctx.inject`, so validation, audit and the agent
 *    perimeter all apply — `intake/apply.ts`).
 *
 * Roles: `client` and `claimant` → the claimant and the client vehicle; `driver` → the claim's driver (the claimant
 * when no separate driver is recorded and the claimant drives); `third_party` → the first third party who is not a
 * witness or insurer, and the third-party vehicle. A missing party is created only from its name and a missing
 * third-party vehicle only from its registration (POST then link with PATCH /claims/:id). The registration of a
 * vehicle on file never changes here (the route refuses it) — such a proposal is `never`.
 *
 * Liability, ledger figures and claim status are not targets at all: the union is closed, so the model cannot propose
 * them.
 */
import { FIELD_TARGETS, SENSITIVE_FIELD_TARGETS, isFieldTarget, type Claim, type FieldRole, type FieldTarget, type Party, type PartyField, type Vehicle, type VehicleField } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import {
  displayVrm,
  formatAddress,
  normaliseVrm,
  parseUkAddress,
  parseYearMonth,
  splitName,
  validateDateTime,
  validateDvlaLicence,
  validateEmail,
  validateIsoDate,
  validateName,
  validateUkPhone,
  validateVin,
  validateVrm,
  type ValidationResult,
} from './validators.js';

export { FIELD_TARGETS, isFieldTarget, type FieldTarget };

// ---------------------------------------------------------------------------
// Snapshot of what the claim holds now
// ---------------------------------------------------------------------------

export interface ClaimSnapshot {
  claim: Claim;
  claimant?: Party;
  driver?: Party;
  /** True when `driver` is the claimant standing in (no separate driver recorded). */
  driverIsClaimant: boolean;
  thirdParty?: Party;
  clientVehicle?: Vehicle;
  thirdPartyVehicle?: Vehicle;
  /** The third party's policy number as last recorded (FNOL event data or an intake note). */
  thirdPartyPolicyNumber?: string;
}

const NOT_THIRD_PARTY = new Set(['witness', 'insurer', 'broker', 'solicitor', 'engineer', 'repairer', 'police', 'council']);

export function loadClaimSnapshot(ctx: AppContext, claimId: string): ClaimSnapshot {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const claimant = ctx.repos.getParty(ctx.db, claim.claimantId);
  const separateDriver = claim.driverId ? ctx.repos.getParty(ctx.db, claim.driverId) : undefined;
  const claimantDrives = !claim.driverId && Boolean(claimant?.roles.includes('driver'));
  const thirdParty = claim.thirdPartyIds
    .map((id) => ctx.repos.getParty(ctx.db, id))
    .find((p): p is Party => Boolean(p) && (p!.roles.includes('third_party_driver') || p!.roles.includes('third_party')) && !p!.roles.some((r) => NOT_THIRD_PARTY.has(r)));
  let thirdPartyPolicyNumber: string | undefined;
  for (const e of ctx.repos.listEvents(ctx.db, claimId)) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === 'fnol' && typeof data.thirdPartyPolicyNumber === 'string' && data.thirdPartyPolicyNumber) thirdPartyPolicyNumber = data.thirdPartyPolicyNumber;
    if (e.type === 'note' && data.intakeField === 'thirdPartyPolicyNumber' && typeof data.value === 'string') thirdPartyPolicyNumber = data.value;
  }
  return {
    claim,
    ...(claimant ? { claimant } : {}),
    ...(separateDriver ? { driver: separateDriver } : claimantDrives && claimant ? { driver: claimant } : {}),
    driverIsClaimant: claimantDrives,
    ...(thirdParty ? { thirdParty } : {}),
    ...(claim.clientVehicleId ? { clientVehicle: ctx.repos.getVehicle(ctx.db, claim.clientVehicleId) } : {}),
    ...(claim.thirdPartyVehicleId ? { thirdPartyVehicle: ctx.repos.getVehicle(ctx.db, claim.thirdPartyVehicleId) } : {}),
    ...(thirdPartyPolicyNumber ? { thirdPartyPolicyNumber } : {}),
  };
}

// ---------------------------------------------------------------------------
// Target definitions
// ---------------------------------------------------------------------------

export interface Provenance {
  intakeItemId?: string;
  evidenceId?: string;
  page?: number | null;
  quote?: string | null;
  proposalId?: string;
}

export interface ApplyStep {
  method: 'POST' | 'PATCH';
  /** Relative to /api. */
  url: string;
  body: unknown;
}

/** One request, or one that needs the previous response (create, then link). */
export type ApplyStepBuilder = (previous: unknown[]) => ApplyStep;

export interface TargetInspection {
  /** The value the claim holds now (display form), if any. */
  current?: string;
  /** True when applying creates a party or vehicle (always confirmed). */
  createsRecord: boolean;
  /** Why this target cannot be applied on this claim (→ policy `never`). */
  unavailable?: string;
}

export interface TargetDef {
  target: FieldTarget;
  kind: 'claim' | 'vehicle' | 'party';
  role?: FieldRole;
  field: string;
  label: string;
  sensitive: boolean;
  /** Validate + normalise. `hints` carries other values from the same document (e.g. the surname for a licence). */
  validate(value: string, hints: ValidationHints): ValidationResult;
  inspect(s: ClaimSnapshot, normalisedValue: string): TargetInspection;
  /** The route calls that apply the (validated, normalised) value. */
  plan(s: ClaimSnapshot, normalisedValue: string, prov: Provenance, now: string): ApplyStepBuilder[];
}

export interface ValidationHints {
  now: string;
  /** Name / DOB / sex of the person the field belongs to, when known (licence cross-check). */
  holder?: { name?: string; dateOfBirth?: string; sex?: 'male' | 'female' };
}

const ROLE_LABEL: Record<FieldRole, string> = { client: 'Client', claimant: 'Claimant', driver: 'Driver', third_party: 'Third party' };
const VEHICLE_LABEL: Record<VehicleField, string> = { vin: 'VIN', registration: 'registration', make: 'make', model: 'model', firstRegistered: 'first registered', colour: 'colour' };
const PARTY_LABEL: Record<PartyField, string> = { name: 'name', address: 'address', phone: 'phone', email: 'email', dateOfBirth: 'date of birth', drivingLicenceNumber: 'driving licence number' };

const same = (a: string | undefined, b: string | undefined): boolean => (a ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === (b ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const blankUnknown = (v: string | undefined): string | undefined => (v && v.trim() && v.trim().toUpperCase() !== 'UNKNOWN' ? v : undefined);
const enc = encodeURIComponent;

function textValidator(max: number, what: string): (v: string) => ValidationResult {
  return (v) => {
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t) return { ok: false, errors: [`No ${what}`] };
    if (t.length > max) return { ok: false, errors: [`The ${what} is longer than ${max} characters`], value: t.slice(0, max) };
    return { ok: true, value: t, errors: [] };
  };
}

function provenanceData(prov: Provenance): Record<string, unknown> {
  return { intakeItemId: prov.intakeItemId ?? null, evidenceId: prov.evidenceId ?? null, page: prov.page ?? null, quote: prov.quote ?? null, proposalId: prov.proposalId ?? null };
}

// ----- claim targets --------------------------------------------------------

const claimTargets: TargetDef[] = [
  {
    target: 'claim.accident.occurredAt',
    kind: 'claim',
    field: 'accident.occurredAt',
    label: 'Accident date and time',
    sensitive: false,
    validate: (v, h) => validateDateTime(v, { notAfter: h.now }),
    inspect: (s) => ({ current: s.claim.accident.occurredAt, createsRecord: false }),
    plan: (s, v) => [() => ({ method: 'PATCH', url: `/claims/${enc(s.claim.id)}`, body: { accident: { occurredAt: v } } })],
  },
  {
    target: 'claim.accident.location',
    kind: 'claim',
    field: 'accident.location',
    label: 'Accident location',
    sensitive: false,
    validate: textValidator(300, 'location'),
    inspect: (s) => ({ ...(s.claim.accident.location ? { current: s.claim.accident.location } : {}), createsRecord: false }),
    plan: (s, v) => [() => ({ method: 'PATCH', url: `/claims/${enc(s.claim.id)}`, body: { accident: { location: v } } })],
  },
  {
    target: 'claim.atFaultInsurerRef',
    kind: 'claim',
    field: 'atFaultInsurerRef',
    label: 'At-fault insurer’s reference',
    sensitive: false,
    validate: textValidator(60, 'reference'),
    inspect: (s) => ({ ...(s.claim.atFaultInsurerRef ? { current: s.claim.atFaultInsurerRef } : {}), createsRecord: false }),
    plan: (s, v) => [() => ({ method: 'PATCH', url: `/claims/${enc(s.claim.id)}`, body: { atFaultInsurerRef: v } })],
  },
  {
    target: 'claim.thirdPartyPolicyNumber',
    kind: 'claim',
    field: 'thirdPartyPolicyNumber',
    label: 'Third party’s policy number',
    sensitive: true,
    validate: (v) => {
      const t = v.replace(/\s+/g, '').toUpperCase();
      if (!t) return { ok: false, errors: ['No policy number'] };
      if (!/^[A-Z0-9/-]{4,40}$/.test(t)) return { ok: false, errors: ['A policy number is 4–40 letters, digits, / or -'], value: t };
      return { ok: true, value: t, errors: [] };
    },
    inspect: (s) => ({ ...(s.thirdPartyPolicyNumber ? { current: s.thirdPartyPolicyNumber } : {}), createsRecord: false }),
    // The claim has no column for it: it is recorded as a chronology note (the FNOL keeps it the same way).
    plan: (s, v, prov, now) => [
      () => ({
        method: 'POST',
        url: `/claims/${enc(s.claim.id)}/events`,
        body: { type: 'note', at: now, summary: 'Third party’s policy number recorded from a document', data: { intakeField: 'thirdPartyPolicyNumber', value: v, ...provenanceData(prov) } },
      }),
    ],
  },
];

// ----- vehicle targets ------------------------------------------------------

function vehicleOf(s: ClaimSnapshot, role: FieldRole): Vehicle | undefined {
  return role === 'third_party' ? s.thirdPartyVehicle : s.clientVehicle;
}

function vehicleCurrent(v: Vehicle | undefined, field: VehicleField): string | undefined {
  if (!v) return undefined;
  switch (field) {
    case 'vin':
      return v.vin || undefined;
    case 'registration':
      return v.registration ? displayVrm(v.registration) : undefined;
    case 'make':
      return blankUnknown(v.make);
    case 'model':
      return blankUnknown(v.model);
    case 'firstRegistered':
      return v.monthOfFirstRegistration || undefined;
    case 'colour':
      return v.colour || undefined;
  }
}

const VEHICLE_PATCH_FIELD: Record<Exclude<VehicleField, 'registration'>, string> = { vin: 'vin', make: 'make', model: 'model', firstRegistered: 'monthOfFirstRegistration', colour: 'colour' };

function vehicleValidator(field: VehicleField): TargetDef['validate'] {
  switch (field) {
    case 'vin':
      return (v) => validateVin(v);
    case 'registration':
      return (v) => {
        const r = validateVrm(v);
        return r.ok ? { ...r, value: displayVrm(r.value!) } : r;
      };
    case 'make':
      return textValidator(80, 'make');
    case 'model':
      return textValidator(120, 'model');
    case 'colour':
      return textValidator(60, 'colour');
    case 'firstRegistered':
      return (v, h) => {
        const ym = parseYearMonth(v);
        if (!ym) return { ok: false, errors: [`"${v.slice(0, 30)}" is not a month and year`] };
        if (ym > h.now.slice(0, 7)) return { ok: false, errors: [`${ym} is in the future`], value: ym };
        if (ym < '1900-01') return { ok: false, errors: [`${ym} is too early`], value: ym };
        return { ok: true, value: ym, errors: [] };
      };
  }
}

function vehicleTarget(role: FieldRole, field: VehicleField): TargetDef {
  const target = `vehicle:${role}.${field}` as FieldTarget;
  const label = `${role === 'third_party' ? 'Third-party vehicle' : 'Client vehicle'} ${VEHICLE_LABEL[field]}`;
  return {
    target,
    kind: 'vehicle',
    role,
    field,
    label,
    sensitive: SENSITIVE_FIELD_TARGETS.has(target),
    validate: vehicleValidator(field),
    inspect: (s, value) => {
      const v = vehicleOf(s, role);
      const current = vehicleCurrent(v, field);
      if (!v) {
        if (role !== 'third_party') return { createsRecord: false, unavailable: 'The claim has no client vehicle' };
        if (field === 'registration') return { createsRecord: true };
        return { createsRecord: false, unavailable: 'The claim has no third-party vehicle yet (its registration is needed first)' };
      }
      if (field === 'registration' && current && normaliseVrm(current) !== normaliseVrm(value)) {
        return { current, createsRecord: false, unavailable: `The vehicle on the claim is ${current}; a registration on file is never changed from a document — check which vehicle this is` };
      }
      return { ...(current ? { current } : {}), createsRecord: false };
    },
    plan: (s, value, prov) => {
      const v = vehicleOf(s, role);
      if (!v) {
        // third-party vehicle from its registration: create (or reuse by registration), then link
        return [
          () => ({ method: 'POST', url: '/vehicles', body: { registration: normaliseVrm(value), ownership: 'third_party', source: { provider: 'manual', appliedFields: ['registration'], parsed: { intake: provenanceData(prov) } } } }),
          (prev) => ({ method: 'PATCH', url: `/claims/${enc(s.claim.id)}`, body: { thirdPartyVehicleId: (prev[0] as { id: string }).id } }),
        ];
      }
      if (field === 'registration') return []; // already the same plate: nothing to do
      const key = VEHICLE_PATCH_FIELD[field];
      return [() => ({ method: 'PATCH', url: `/vehicles/${enc(v.id)}`, body: { [key]: value, source: { provider: 'manual', appliedFields: [key], parsed: { intake: provenanceData(prov) } } } })];
    },
  };
}

// ----- party targets --------------------------------------------------------

function partyOf(s: ClaimSnapshot, role: FieldRole): Party | undefined {
  if (role === 'client' || role === 'claimant') return s.claimant;
  if (role === 'driver') return s.driver;
  return s.thirdParty;
}

function partyCurrent(p: Party | undefined, field: PartyField): string | undefined {
  if (!p) return undefined;
  switch (field) {
    case 'name':
      return p.name || undefined;
    case 'address':
      return formatAddress(p.address);
    case 'phone':
      return p.phone || undefined;
    case 'email':
      return p.email || undefined;
    case 'dateOfBirth':
      return p.dateOfBirth || undefined;
    case 'drivingLicenceNumber':
      return p.drivingLicenceNumber || undefined;
  }
}

function partyValidator(field: PartyField): TargetDef['validate'] {
  switch (field) {
    case 'name':
      return (v) => validateName(v);
    case 'address':
      return (v) => {
        const r = parseUkAddress(v);
        return r.ok ? { ok: true, value: formatAddress(r.value)!, errors: [] } : { ok: false, errors: r.errors };
      };
    case 'phone':
      return (v) => validateUkPhone(v);
    case 'email':
      return (v) => validateEmail(v);
    case 'dateOfBirth':
      return (v, h) => {
        const r = validateIsoDate(v, { notAfter: h.now });
        if (!r.ok) return r;
        const age = Number(h.now.slice(0, 4)) - Number(r.value!.slice(0, 4));
        if (age < 15 || age > 110) return { ok: false, errors: [`A date of birth of ${r.value} gives an age of about ${age}`], value: r.value };
        return r;
      };
    case 'drivingLicenceNumber':
      return (v, h) => {
        const n = h.holder?.name ? splitName(h.holder.name) : {};
        return validateDvlaLicence(v, { ...n, ...(h.holder?.dateOfBirth ? { dateOfBirth: h.holder.dateOfBirth } : {}), ...(h.holder?.sex ? { sex: h.holder.sex } : {}) });
      };
  }
}

const ROLE_PARTY_ROLES: Record<FieldRole, string[]> = { client: ['claimant'], claimant: ['claimant'], driver: ['driver'], third_party: ['third_party', 'third_party_driver'] };

function partyTarget(role: FieldRole, field: PartyField): TargetDef {
  const target = `party:${role}.${field}` as FieldTarget;
  return {
    target,
    kind: 'party',
    role,
    field,
    label: `${ROLE_LABEL[role]} ${PARTY_LABEL[field]}`,
    sensitive: SENSITIVE_FIELD_TARGETS.has(target),
    validate: partyValidator(field),
    inspect: (s, value) => {
      const p = partyOf(s, role);
      // A driver named differently from the claimant (who drives by default) is a new, separate driver.
      if (role === 'driver' && s.driverIsClaimant && field === 'name' && p && !same(p.name, value)) return { createsRecord: true };
      if (role === 'driver' && s.driverIsClaimant && field !== 'name' && p) {
        // Details of "the driver" are the claimant's while the claimant drives.
        const current = partyCurrent(p, field);
        return { ...(current ? { current } : {}), createsRecord: false };
      }
      if (!p) {
        if (field === 'name') return { createsRecord: true };
        return { createsRecord: false, unavailable: `The claim has no ${ROLE_LABEL[role].toLowerCase()} yet (the name is needed first)` };
      }
      const current = partyCurrent(p, field);
      return { ...(current ? { current } : {}), createsRecord: false };
    },
    plan: (s, value) => {
      const p = partyOf(s, role);
      const createDriver = role === 'driver' && s.driverIsClaimant && field === 'name' && p && !same(p.name, value);
      if (!p || createDriver) {
        if (field !== 'name') return [];
        return [
          () => ({ method: 'POST', url: '/parties', body: { kind: 'individual', name: value, roles: ROLE_PARTY_ROLES[role] } }),
          (prev) => {
            const id = (prev[0] as { id: string }).id;
            const body = role === 'driver' ? { driverId: id } : { thirdPartyIds: [...s.claim.thirdPartyIds, id] };
            return { method: 'PATCH', url: `/claims/${enc(s.claim.id)}`, body };
          },
        ];
      }
      let patch: Record<string, unknown>;
      if (field === 'address') patch = { address: parseUkAddress(value).value };
      else patch = { [field]: value };
      return [() => ({ method: 'PATCH', url: `/parties/${enc(p.id)}`, body: patch })];
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ALL: TargetDef[] = [
  ...claimTargets,
  ...(['client', 'third_party', 'claimant', 'driver'] as FieldRole[]).flatMap((r) => (['vin', 'registration', 'make', 'model', 'firstRegistered', 'colour'] as VehicleField[]).map((f) => vehicleTarget(r, f))),
  ...(['client', 'third_party', 'claimant', 'driver'] as FieldRole[]).flatMap((r) => (['name', 'address', 'phone', 'email', 'dateOfBirth', 'drivingLicenceNumber'] as PartyField[]).map((f) => partyTarget(r, f))),
];
const BY_TARGET = new Map<string, TargetDef>(ALL.map((t) => [t.target, t]));

/** Every target has a definition (checked by the tests against @ccguk/domain FIELD_TARGETS). */
export function targetDefs(): readonly TargetDef[] {
  return ALL;
}

export function targetDef(target: string): TargetDef | undefined {
  return BY_TARGET.get(target);
}

/** Owner-facing label for a target ("Client vehicle VIN"). */
export function targetLabel(target: string): string {
  return targetDef(target)?.label ?? target;
}

/** The routes the targets call (the agent perimeter's allow-list for intake, declared on the claim_field_apply tool). */
export const TARGET_ROUTES: ReadonlyArray<{ method: 'POST' | 'PATCH'; pattern: string }> = [
  { method: 'PATCH', pattern: '/claims/:id' },
  { method: 'PATCH', pattern: '/vehicles/:id' },
  { method: 'PATCH', pattern: '/parties/:id' },
  { method: 'POST', pattern: '/vehicles' },
  { method: 'POST', pattern: '/parties' },
  { method: 'POST', pattern: '/claims/:id/events' },
];

export { same as sameValue };
