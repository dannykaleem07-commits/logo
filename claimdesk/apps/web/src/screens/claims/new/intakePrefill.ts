// owned by intake
/**
 * New claim from files (docs/SUPREME-DESIGN.md §G.3): map an intake new-claim draft (a partial CreateClaimBody plus
 * per-field sources) onto the FNOL wizard state, and list the "from V5C, page 1" badges. Pure; unit-tested.
 *
 * Only facts read from documents are prefilled. The disclosure, the client's own account (taken cold), the script
 * questions and the services stay for the owner — the prefill never answers them.
 */
import type { NewClaimDraft } from '../../../api/intakeApi';
import type { FnolState, PartyForm } from './fnol';

export interface PrefillBadge {
  /** Wizard field key (matches the validation keys: 'claimant.name', 'vehicle.registration', …). */
  field: string;
  /** Owner-facing field name. */
  label: string;
  value: string;
  /** "from V5C, page 1" */
  source: string;
  confidence: number;
}

export interface IntakePrefill {
  state: FnolState;
  badges: PrefillBadge[];
  /** Read from the documents but with no field in the wizard (shown so nothing is lost). */
  notInWizard: PrefillBadge[];
}

const LABELS: Record<string, string> = {
  'claimant.name': 'Claimant name',
  'claimant.phone': 'Claimant phone',
  'claimant.email': 'Claimant email',
  'claimant.dateOfBirth': 'Claimant date of birth',
  'claimant.address': 'Claimant address',
  'claimant.drivingLicenceNumber': 'Claimant licence number',
  'driver.name': 'Driver name',
  'driver.phone': 'Driver phone',
  'driver.email': 'Driver email',
  'driver.dateOfBirth': 'Driver date of birth',
  'driver.address': 'Driver address',
  'driver.drivingLicenceNumber': 'Driver licence number',
  'vehicle.registration': 'Registration',
  'vehicle.vin': 'VIN',
  'vehicle.make': 'Make',
  'vehicle.model': 'Model',
  'vehicle.colour': 'Colour',
  'vehicle.monthOfFirstRegistration': 'First registered',
  'accident.occurredAt': 'Accident date and time',
  'accident.location': 'Accident location',
  'thirdParty.registration': 'Other vehicle registration',
  'thirdParty.driverName': 'Other driver',
  'thirdParty.insurerPolicyNumber': 'Other driver’s policy number',
  'thirdParty.contact': 'Other driver contact',
  atFaultInsurerRef: 'At-fault insurer reference',
};

/** Wizard fields the prefill can fill (everything else is listed under notInWizard). */
const IN_WIZARD = new Set(Object.keys(LABELS).filter((k) => k !== 'atFaultInsurerRef'));

function partyForm(base: PartyForm, p: NonNullable<NewClaimDraft['body']['claimant']> | undefined): PartyForm {
  if (!p) return base;
  return {
    ...base,
    ...(p.name ? { name: p.name } : {}),
    ...(p.phone ? { phone: p.phone } : {}),
    ...(p.email ? { email: p.email } : {}),
    ...(p.dateOfBirth ? { dateOfBirth: p.dateOfBirth } : {}),
    ...(p.drivingLicenceNumber ? { drivingLicenceNumber: p.drivingLicenceNumber } : {}),
    ...(p.address ? { line1: p.address.line1 ?? '', line2: p.address.line2 ?? '', town: p.address.town ?? '', postcode: p.address.postcode ?? '' } : {}),
  };
}

function valueAt(body: NewClaimDraft['body'], path: string): string | undefined {
  let cur: unknown = body;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === undefined || cur === null) return undefined;
  if (typeof cur === 'object') {
    const a = cur as { line1?: string; line2?: string; town?: string; postcode?: string };
    return [a.line1, a.line2, a.town, a.postcode].filter(Boolean).join(', ');
  }
  return String(cur);
}

/** The wizard state with the draft's values, plus the source badges. */
export function prefillFromDraft(initial: FnolState, draft: NewClaimDraft): IntakePrefill {
  const b = draft.body;
  const s: FnolState = { ...initial };
  s.claimant = partyForm(initial.claimant, b.claimant);
  if (b.driver?.name) {
    s.driverSameAsClaimant = false;
    s.driver = partyForm(initial.driver, b.driver);
  }
  if (b.vehicle) {
    const v = b.vehicle;
    const reg = (v.registration ?? '').toUpperCase();
    s.vehicle = {
      ...initial.vehicle,
      registration: reg || initial.vehicle.registration,
      // The owner still searches the registration (live lookup or ClaimDesk's records); the picker holds what the
      // documents said, so hand entry starts from it.
      picker: {
        ...initial.vehicle.picker,
        registration: reg || initial.vehicle.picker.registration,
        ...(v.make ? { make: v.make } : {}),
        ...(v.model ? { model: v.model } : {}),
        ...(v.vin ? { vin: v.vin } : {}),
        ...(v.colour ? { colour: v.colour } : {}),
        ...(v.monthOfFirstRegistration ? { monthOfFirstRegistration: v.monthOfFirstRegistration } : {}),
      },
    };
  }
  if (b.accident) {
    s.accident = { ...initial.accident, ...(b.accident.occurredAt ? { occurredAt: b.accident.occurredAt } : {}), ...(b.accident.location ? { location: b.accident.location } : {}) };
  }
  if (b.thirdParty) {
    const tp = b.thirdParty;
    s.thirdParty = {
      ...initial.thirdParty,
      ...(tp.registration ? { registration: tp.registration.toUpperCase(), registrationUnknown: false } : {}),
      ...(tp.driverName ? { driverName: tp.driverName } : {}),
      ...(tp.insurerPolicyNumber ? { insurerPolicyNumber: tp.insurerPolicyNumber } : {}),
      ...(tp.contact ? { contact: tp.contact } : {}),
    };
  }

  const badges: PrefillBadge[] = [];
  const notInWizard: PrefillBadge[] = [];
  for (const [field, src] of Object.entries(draft.sources)) {
    const value = valueAt(b, field);
    if (value === undefined) continue;
    const badge: PrefillBadge = { field, label: LABELS[field] ?? field, value, source: src.label, confidence: src.confidence };
    (IN_WIZARD.has(field) ? badges : notInWizard).push(badge);
  }
  const order = Object.keys(LABELS);
  const rank = (f: string) => (order.indexOf(f) === -1 ? 999 : order.indexOf(f));
  badges.sort((x, y) => rank(x.field) - rank(y.field));
  return { state: s, badges, notInWizard };
}

/** The `?intakeDraft=<id>` value of a location search string, if any. */
export function intakeDraftIdFrom(search: string): string | undefined {
  const id = new URLSearchParams(search).get('intakeDraft')?.trim();
  return id && /^[a-zA-Z0-9-]{8,64}$/.test(id) ? id : undefined;
}
