/**
 * Pure helpers the resolvers use (design doc §B.3 rules): never read the clock (only `src.now`), return undefined when
 * the data is absent, convert instants to Europe/London before taking a date, never produce an end date, day count or
 * total for an open hire or storage record.
 */
import { calendarDaysBetween, compareIso, formatRegistration, londonDate, londonParts } from '@ccguk/domain';
import type { Address, ClaimEvent, HireAgreement, ISODate, ISODateTime, Party, RecoveryRecord, StorageRecord, Vehicle } from '@ccguk/domain';
import type { FieldValue, VerificationStatus } from './types.js';
import type { MergeDocumentRef, MergeHire, MergeSource } from './source.js';

// ---------------------------------------------------------------------------
// Value constructors (undefined in → undefined out)
// ---------------------------------------------------------------------------

export function txt(v: string | undefined | null): FieldValue | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? { t: 'text', v: s } : undefined;
}

/** Verbatim text (multi-line kept, only outer whitespace trimmed). */
export function verbatim(v: string | undefined | null): FieldValue | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  return { t: 'text', v: v.replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/g, '') };
}

export function dateOf(iso: string | undefined | null): FieldValue | undefined {
  if (!iso) return undefined;
  return { t: 'date', v: londonDate(iso) };
}

export function dateTimeOf(iso: string | undefined | null): FieldValue | undefined {
  if (!iso) return undefined;
  return /T/.test(iso) ? { t: 'datetime', v: iso } : { t: 'date', v: iso };
}

export function timeOf(iso: string | undefined | null): FieldValue | undefined {
  if (!iso || !/T/.test(iso)) return undefined;
  return { t: 'time', v: londonTime(iso) };
}

export function money(p: number | undefined | null, verification?: VerificationStatus): FieldValue | undefined {
  if (typeof p !== 'number' || !Number.isFinite(p)) return undefined;
  return verification ? { t: 'money', v: Math.round(p), verification } : { t: 'money', v: Math.round(p) };
}

export function int(n: number | undefined | null, unit?: string): FieldValue | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return unit ? { t: 'int', v: Math.trunc(n), unit } : { t: 'int', v: Math.trunc(n) };
}

export function bool(b: boolean | undefined | null): FieldValue | undefined {
  return typeof b === 'boolean' ? { t: 'bool', v: b } : undefined;
}

/** `true` when the condition holds, else undefined (absence of a record is not evidence of "no"). */
export function yesIf(cond: boolean): FieldValue | undefined {
  return cond ? { t: 'bool', v: true } : undefined;
}

export function choice(code: string | undefined | null): FieldValue | undefined {
  return code ? { t: 'choice', v: [code] } : undefined;
}

export function list(items: Array<string | undefined | null> | undefined): FieldValue | undefined {
  const v = (items ?? []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return v.length ? { t: 'list', v } : undefined;
}

export function rows(v: Array<Record<string, string>>): FieldValue | undefined {
  return v.length ? { t: 'rows', v } : undefined;
}

// ---------------------------------------------------------------------------
// Formatting helpers used inside resolvers
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'HH:MM' in Europe/London. */
export function londonTime(iso: ISODateTime): string {
  const p = londonParts(iso);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `9 August 2026` (Europe/London). */
export function longDate(iso: ISODate | ISODateTime): string {
  const d = londonDate(iso);
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

/** One line, `, ` joined, postcode after the town with a space: `12 High Street, Hounslow TW3 1AB` (§B.4). */
export function addressOneLine(a: Address | undefined | null): string | undefined {
  if (!a) return undefined;
  const parts = [a.line1, a.line2, a.town, a.county].map((p) => (p ?? '').trim()).filter((p) => p !== '');
  const postcode = (a.postcode ?? '').trim().toUpperCase();
  if (postcode) {
    if (parts.length) parts[parts.length - 1] = `${parts[parts.length - 1]} ${postcode}`;
    else parts.push(postcode);
  }
  return parts.length ? parts.join(', ') : undefined;
}

/** Address without the postcode (01 has a separate Postcode cell). */
export function addressNoPostcode(a: Address | undefined | null): string | undefined {
  if (!a) return undefined;
  const parts = [a.line1, a.line2, a.town, a.county].map((p) => (p ?? '').trim()).filter((p) => p !== '');
  return parts.length ? parts.join(', ') : undefined;
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((w) => (/^\s+$|^-$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

/** `Jane Mary Smith` → `J. M. Smith`. */
export function initialsSurname(name: string | undefined): string | undefined {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1]!;
  return `${parts
    .slice(0, -1)
    .map((p) => `${p.charAt(0).toUpperCase()}.`)
    .join(' ')} ${last}`;
}

/** Initial letters of the first and last name: `Sarah Lee` → `SL`. */
export function initials(name: string | undefined): string | undefined {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return `${first}${last}`.toUpperCase();
}

export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

export function thousands(n: number): string {
  return Math.trunc(n).toLocaleString('en-GB');
}

const FUEL_LABEL: Record<string, string> = { petrol: 'petrol', diesel: 'diesel', hybrid: 'hybrid', plugin_hybrid: 'plug-in hybrid', electric: 'electric', lpg: 'LPG', other: 'other fuel' };

export function fuelLabel(v: Vehicle | undefined): string | undefined {
  return v?.fuelType ? FUEL_LABEL[v.fuelType] : undefined;
}

/** Make + model (+ variant when ≤ 20 chars). */
export function makeModel(v: Vehicle | undefined): string | undefined {
  if (!v) return undefined;
  const parts = [v.make, v.model].map((x) => (x ?? '').trim()).filter(Boolean);
  if (v.variant && v.variant.trim().length > 0 && v.variant.trim().length <= 20) parts.push(v.variant.trim());
  return parts.length ? parts.join(' ') : undefined;
}

export function regOf(v: Vehicle | undefined): string | undefined {
  return v?.registration ? formatRegistration(v.registration) : undefined;
}

export function makeModelReg(v: Vehicle | undefined): string | undefined {
  const mm = makeModel(v);
  const reg = regOf(v);
  if (mm && reg) return `${mm} — ${reg}`;
  return mm ?? reg;
}

/** `1,798cc hybrid`. */
export function engineFuel(v: Vehicle | undefined): string | undefined {
  if (!v) return undefined;
  const cc = v.engineCapacityCc ? `${thousands(v.engineCapacityCc)}cc` : undefined;
  const parts = [cc, fuelLabel(v)].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

export function transmissionCode(v: Vehicle | undefined): string | undefined {
  return v?.transmission === 'manual' || v?.transmission === 'automatic' ? v.transmission : undefined;
}

// ---------------------------------------------------------------------------
// Record selection
// ---------------------------------------------------------------------------

export function byTime<T>(items: T[], at: (x: T) => string | undefined): T[] {
  return [...items].filter((x) => !!at(x)).sort((a, b) => compareIso(at(a)!, at(b)!));
}

export function eventsOfType(src: MergeSource, pred: (type: string) => boolean): ClaimEvent[] {
  return byTime(src.events.filter((e) => pred(String(e.type))), (e) => e.at);
}

/** The subject hire: the selected agreement (src.hire), else the latest HireAgreement on the claim. */
export function subjectHire(src: MergeSource): MergeHire | undefined {
  if (src.hire) return src.hire;
  const latest = byTime(src.hires, (h) => h.startAt).pop();
  return latest ? { agreement: latest } : undefined;
}

export function agreementOf(src: MergeSource): HireAgreement | undefined {
  return subjectHire(src)?.agreement;
}

/** Latest storage record (by start). */
export function latestStorage(src: MergeSource): StorageRecord | undefined {
  return byTime(src.storage, (s) => s.startAt).pop();
}

export function openStorage(src: MergeSource): StorageRecord | undefined {
  return byTime(src.storage.filter((s) => !s.endAt), (s) => s.startAt).pop();
}

/** Inclusive London-calendar day count of a CLOSED storage record; undefined while open. */
export function storageDays(rec: StorageRecord | undefined): number | undefined {
  if (!rec?.endAt) return undefined;
  return calendarDaysBetween(rec.startAt, rec.endAt) + 1;
}

export function firstRecovery(src: MergeSource): RecoveryRecord | undefined {
  return byTime(src.recovery, (r) => r.at)[0];
}

export function recoveryNet(r: RecoveryRecord | undefined): number | undefined {
  if (!r) return undefined;
  return r.calloutPence + r.loadedMiles * r.perLoadedMilePence + r.adminPence;
}

/** Signed date (London) of the latest signed document with this canonical id. */
export function signedDocument(src: MergeSource, canonicalId: string): MergeDocumentRef | undefined {
  return byTime(
    src.documents.filter((d) => d.canonicalTemplateId === canonicalId && d.status === 'signed' && d.signedAt),
    (d) => d.signedAt
  ).pop();
}

export function latestDocument(src: MergeSource, canonicalId: string): MergeDocumentRef | undefined {
  return byTime(
    src.documents.filter((d) => d.canonicalTemplateId === canonicalId && d.status !== 'void'),
    (d) => d.createdAt
  ).pop();
}

/** Is an event addressed to this party (data.recipientPartyId / data.recipientRole)? */
export function eventTo(e: ClaimEvent, partyId: string | undefined, role?: string): boolean {
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (partyId && d['recipientPartyId'] === partyId) return true;
  return !!role && d['recipientRole'] === role;
}

export function ledgerReference(src: MergeSource, head: string, kind = 'invoiced'): string | undefined {
  const entry = byTime(
    src.ledger.filter((l) => l.head === head && l.kind === kind && l.reference),
    (l) => l.date
  ).pop();
  return entry?.reference ?? src.heads.find((h) => h.head === head)?.invoiceReference;
}

export function partyName(src: MergeSource, id: string | undefined): string | undefined {
  if (!id) return undefined;
  const all: Array<Party | undefined> = [src.atFaultInsurer, src.ownInsurer, src.claimant, src.driver, src.keeper, src.engineer, src.recoveryAgent, ...src.thirdPartyDrivers, ...src.witnesses];
  return all.find((p) => p?.id === id)?.name;
}

export function userName(src: MergeSource, id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (src.user.id === id) return src.user.name;
  if (src.caseHandler?.id === id) return src.caseHandler.name;
  return undefined;
}

/** True when `iso` is on or before src.now. */
export function notAfterNow(src: MergeSource, iso: string): boolean {
  return compareIso(iso, src.now) <= 0;
}

/** Event data field as a string. */
export function dataString(e: ClaimEvent | undefined, field: string): string | undefined {
  const v = (e?.data as Record<string, unknown> | undefined)?.[field];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function dataList(e: ClaimEvent | undefined, field: string): string[] {
  const v = (e?.data as Record<string, unknown> | undefined)?.[field];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
