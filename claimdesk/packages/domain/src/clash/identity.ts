// owned by ap-clash
/**
 * Person and vehicle identity for clash detection (docs/SUPREME-AUTOPILOT.md §C.1) — pure.
 *
 * Two party rows are the same person when the ids match, or the normalised licence numbers match, or the casefolded,
 * whitespace-collapsed full name AND the date of birth match. A shared name alone never matches (two different people
 * called John Smith are two people). Registrations use `normaliseRegistration`; VINs are upper-cased with spaces
 * removed. Data quality limits this (SUPREME-AUTOPILOT §M.2): findings explain the match so a person can judge.
 */
import type { Id, Party, Vehicle } from '../types.js';
import type { DriverProfile } from '../eligibility/types.js';
import { normaliseRegistration } from '../vehicle/registration.js';

export type PersonLike = Pick<Party, 'id' | 'name' | 'dateOfBirth' | 'drivingLicenceNumber'>;

export function normaliseLicence(n: string | undefined | null): string {
  return (n ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normalisePersonName(n: string | undefined | null): string {
  return (n ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normaliseVin(v: string | undefined | null): string {
  return (v ?? '').toUpperCase().replace(/\s+/g, '');
}

/** How two people matched (null: not the same person). */
export type PersonMatch = 'id' | 'licence' | 'name_dob';

export function personMatch(a: PersonLike, b: PersonLike, profiles?: { a?: DriverProfile; b?: DriverProfile }): PersonMatch | null {
  if (a.id && b.id && a.id === b.id) return 'id';
  const la = normaliseLicence(profiles?.a?.licenceNumber ?? a.drivingLicenceNumber);
  const lb = normaliseLicence(profiles?.b?.licenceNumber ?? b.drivingLicenceNumber);
  if (la.length >= 5 && la === lb) return 'licence';
  const na = normalisePersonName(a.name);
  const nb = normalisePersonName(b.name);
  const da = a.dateOfBirth?.slice(0, 10);
  const db = b.dateOfBirth?.slice(0, 10);
  if (na && na === nb && da && da === db) return 'name_dob';
  return null;
}

export function samePerson(a: PersonLike, b: PersonLike, profiles?: { a?: DriverProfile; b?: DriverProfile }): boolean {
  return personMatch(a, b, profiles) !== null;
}

/** Same vehicle by registration or VIN (either matching is enough). */
export function vehicleMatch(a: Pick<Vehicle, 'registration' | 'vin'>, b: Pick<Vehicle, 'registration' | 'vin'>): 'registration' | 'vin' | null {
  const ra = normaliseRegistration(a.registration ?? '');
  const rb = normaliseRegistration(b.registration ?? '');
  if (ra && ra === rb) return 'registration';
  const va = normaliseVin(a.vin);
  const vb = normaliseVin(b.vin);
  if (va.length >= 11 && va === vb) return 'vin';
  return null;
}

/** Stable dedupe key: code + the sorted subject ids. */
export function clashDedupeKey(code: string, ids: Array<Id | undefined | null>): string {
  const clean = Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))).sort();
  return [code, ...clean].join(':');
}
