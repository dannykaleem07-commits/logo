/**
 * Identity keys per file (docs/SMART-INTAKE.md §4.4): what links two files to one case, or a file to an existing claim
 * — CCG references, VINs, insurer references, licence numbers, name + date of birth, police references (strong);
 * registrations, plates read in photos, policy numbers, phones, emails (medium); names, postcodes, accident days (weak).
 *
 * A stop list (built by the API from settings, the fleet and the mail account) removes identifiers that appear across
 * many cases: the company's own phone/email/postcode, fleet registrations and policies. Phones, emails and postcodes on
 * letters (an insurer's letterhead) are downgraded to weak unless the reading's role says they are a party's own.
 */
import type { BundleFileRole, Candidate, CandidateEngine } from './types.js';
import { londonDayOf, normPhone, normPostcode, normVrm, POSTCODE_SCAN_RE } from './text.js';

export type KeyKind = 'ccg_ref' | 'vin' | 'vrm' | 'insurer_ref' | 'policy' | 'licence' | 'name_dob' | 'name' | 'postcode' | 'phone' | 'email' | 'accident_date' | 'police_ref' | 'sha_on_claim' | 'plate';
export type KeyStrength = 'strong' | 'medium' | 'weak';
export type KeyRole = 'client' | 'third_party' | 'unknown';

export interface FileKey {
  kind: KeyKind;
  /** Normalised value. */
  value: string;
  strength: KeyStrength;
  role: KeyRole;
  source: CandidateEngine | 'sha';
  /** How a person would read it ("KX21 ABC", "Jane Doe"). */
  display?: string;
}

export interface FileKeys {
  fileId: string;
  position: number;
  parentFileId: string | null;
  role: BundleFileRole;
  isPhoto: boolean;
  takenAt: string | null;
  keys: FileKey[];
  /** "V5C" or the filename, for reasons ("Same VIN as the V5C"). */
  label?: string;
  /** Not a photo and not a container: counts as a document for the main-group tie-break. */
  isDocument?: boolean;
}

export const KEY_STRENGTH: Readonly<Record<KeyKind, KeyStrength>> = {
  ccg_ref: 'strong', vin: 'strong', insurer_ref: 'strong', licence: 'strong', name_dob: 'strong', police_ref: 'strong', sha_on_claim: 'strong',
  vrm: 'medium', plate: 'medium', policy: 'medium', phone: 'medium', email: 'medium',
  name: 'weak', postcode: 'weak', accident_date: 'weak',
};

export interface StopList {
  vrms: string[];
  policies: string[];
  phones: string[];
  emails: string[];
  emailDomains: string[];
  postcodes: string[];
  names: string[];
}

export const EMPTY_STOP_LIST: StopList = { vrms: [], policies: [], phones: [], emails: [], emailDomains: [], postcodes: [], names: [] };

const LETTER_TYPES = new Set(['insurer_letter', 'correspondence']);

/** "Jane Mary Doe" → "doe|j" (surname + first initial: tolerant of middle names and initials). */
export function personKey(name: string): string | null {
  const tokens = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !['mr', 'mrs', 'ms', 'miss', 'dr', 'mx'].includes(t));
  if (tokens.length < 2) return tokens.length === 1 && tokens[0]!.length > 2 ? tokens[0]! : null;
  return `${tokens[tokens.length - 1]}|${tokens[0]![0]}`;
}

/** A key value as stored in the claim index (same normalisation as the files). */
export function normaliseKeyValue(kind: KeyKind, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (kind) {
    case 'vrm':
    case 'plate':
      return normVrm(v) || null;
    case 'vin':
    case 'licence':
    case 'insurer_ref':
    case 'policy':
    case 'police_ref':
    case 'ccg_ref':
      return v.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
    case 'phone':
      return normPhone(v);
    case 'email':
      return v.toLowerCase().includes('@') ? v.toLowerCase() : null;
    case 'postcode':
      return normPostcode(v) || null;
    case 'name':
      return personKey(v);
    case 'accident_date':
      return londonDayOf(v);
    default:
      return v.toLowerCase();
  }
}

const ROLE_OF = (key: string): KeyRole => (key.startsWith('tp.') ? 'third_party' : key.startsWith('client.') || key.startsWith('driver.') || key.startsWith('vehicle.') || key.startsWith('clientInsurer.') ? 'client' : 'unknown');

/** Extra facts about the file beyond its readings. */
export interface KeyExtras {
  /** Claim ids that already hold a file with this sha256 (`same_file_on_claim`). */
  shaOnClaims: string[];
  /** Plates read in the photo (as printed). */
  plates: string[];
  takenAt: string | null;
  position?: number;
  parentFileId?: string | null;
  role?: BundleFileRole;
  isPhoto?: boolean;
  label?: string;
  /** Target-less identifiers (CCG references, unassigned registrations, letterhead phones …). */
  otherKeys?: Array<{ kind: KeyKind; value: string; role?: KeyRole; display?: string }>;
}

/** The identity keys of one file from its candidates (readings) and extras, minus the stop list. */
export function keysFromCandidates(fileId: string, candidates: Candidate[], extra: KeyExtras, stop: StopList = EMPTY_STOP_LIST): FileKeys {
  const keys: FileKey[] = [];
  const add = (kind: KeyKind, raw: string, role: KeyRole, source: FileKey['source'], display?: string, weak = false) => {
    const value = normaliseKeyValue(kind, raw);
    if (!value) return;
    if (stopped(kind, value, stop)) return;
    const strength: KeyStrength = weak ? 'weak' : KEY_STRENGTH[kind];
    if (keys.some((k) => k.kind === kind && k.value === value)) return;
    keys.push({ kind, value, strength, role, source, ...(display ? { display } : {}) });
  };
  const own = candidates.filter((c) => c.source.fileId === fileId && c.validatorOk);
  const byKey = (k: string) => own.filter((c) => c.key === k);
  for (const c of own) {
    const role = ROLE_OF(c.key);
    const onLetter = LETTER_TYPES.has(c.source.docType ?? '');
    const src = c.source.engine;
    switch (c.key) {
      case 'vehicle.registration':
      case 'tp.registration':
        add('vrm', c.value, role, src, c.display);
        break;
      case 'vehicle.vin':
        add('vin', c.value, role, src, c.display);
        break;
      case 'tp.insurerRef':
        add('insurer_ref', c.value, 'third_party', src, c.display);
        break;
      case 'tp.policyNumber':
      case 'clientInsurer.policyNumber':
        add('policy', c.value, role, src, c.display);
        break;
      case 'client.drivingLicenceNumber':
      case 'driver.drivingLicenceNumber':
        add('licence', c.value, 'client', src, c.display);
        break;
      case 'client.name':
      case 'driver.name':
      case 'tp.name':
        if (c.source.engine !== 'name_hint') add('name', c.value, role, src, c.display);
        break;
      case 'client.phone':
      case 'driver.phone':
      case 'tp.phone':
        add('phone', c.value, role, src, c.display, onLetter && role === 'unknown');
        break;
      case 'client.email':
        add('email', c.value, role, src, c.display, onLetter && role === 'unknown');
        break;
      case 'client.address':
      case 'driver.address':
      case 'tp.address': {
        const pc = c.value.toUpperCase().match(new RegExp(POSTCODE_SCAN_RE.source));
        if (pc) add('postcode', pc[0], role, src, pc[0]);
        break;
      }
      case 'accident.postcode':
        add('postcode', c.value, 'unknown', src, c.display);
        break;
      case 'accident.occurredAt':
        if (c.source.engine !== 'exif') add('accident_date', c.value, 'unknown', src, londonDayOf(c.value) ?? c.value);
        break;
      case 'accident.policeReference':
        add('police_ref', c.value, 'unknown', src, c.display);
        break;
      default:
        break;
    }
  }
  // name + date of birth of the same person in the same file
  for (const who of ['client', 'driver'] as const) {
    const n = byKey(`${who}.name`).find((c) => c.source.engine !== 'name_hint');
    const d = byKey(`${who}.dateOfBirth`)[0];
    if (n && d) {
      const pk = personKey(n.value);
      if (pk) add('name_dob', `${pk}|${d.value.slice(0, 10)}`, 'client', n.source.engine, `${n.display}, born ${d.value.slice(0, 10)}`);
    }
  }
  for (const o of extra.otherKeys ?? []) add(o.kind, o.value, o.role ?? 'unknown', 'rules', o.display ?? o.value, (o.kind === 'phone' || o.kind === 'email') && (o.role ?? 'unknown') === 'unknown');
  for (const claimId of extra.shaOnClaims) keys.push({ kind: 'sha_on_claim', value: claimId, strength: 'strong', role: 'unknown', source: 'sha' });
  for (const p of extra.plates) add('plate', p, 'unknown', 'plate', p);
  return {
    fileId,
    position: extra.position ?? 0,
    parentFileId: extra.parentFileId ?? null,
    role: extra.role ?? 'document',
    isPhoto: extra.isPhoto ?? false,
    takenAt: extra.takenAt,
    keys,
    ...(extra.label ? { label: extra.label } : {}),
    isDocument: !(extra.isPhoto ?? false) && !['archive', 'pack', 'email'].includes(extra.role ?? 'document'),
  };
}

function stopped(kind: KeyKind, value: string, stop: StopList): boolean {
  switch (kind) {
    case 'vrm':
    case 'plate':
      return stop.vrms.some((v) => normVrm(v) === value);
    case 'policy':
      return stop.policies.some((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '') === value);
    case 'phone':
      return stop.phones.some((v) => normPhone(v) === value);
    case 'email':
      return stop.emails.some((v) => v.toLowerCase() === value) || stop.emailDomains.some((d) => value.endsWith(`@${d.toLowerCase().replace(/^@/, '')}`));
    case 'postcode':
      return stop.postcodes.some((v) => normPostcode(v) === value);
    case 'name':
      return stop.names.some((v) => personKey(v) === value);
    default:
      return false;
  }
}
