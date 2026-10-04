import { randomUUID } from 'node:crypto';
import type { ISODateTime } from '@ccguk/domain';

/** New entity id. */
export const newId = (): string => randomUUID();

/** Current instant as ISO 8601 (UTC). */
export const nowIso = (): ISODateTime => new Date().toISOString();

/**
 * Row → entity mapping type: every nullable column becomes `T | undefined`, which is assignable to the
 * domain's optional (`?:`) fields. Non-null columns are unchanged.
 */
export type Denulled<T> = { [K in keyof T]: null extends T[K] ? Exclude<T[K], null> | undefined : T[K] };

/** Drop null-valued keys from a row so it matches a domain entity with optional fields. */
export function denull<T extends object>(row: T): Denulled<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null) out[k] = v;
  }
  return out as Denulled<T>;
}

/** Remove `undefined` values (drizzle ignores them in `set`, but explicit is clearer in upserts). */
export function compact<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** Normalise a UK registration: uppercase, no spaces or punctuation. (Mirror of @ccguk/domain vehicle.normaliseRegistration.) */
export function normaliseRegistration(reg: string): string {
  return reg.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Normalise a UK phone number to digits with a leading 0 (e.g. "+44 7700 900123" → "07700900123"). */
export function normalisePhone(phone: string | undefined | null): string | undefined {
  if (!phone) return undefined;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0044')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('44') && digits.length >= 12) digits = `0${digits.slice(2)}`;
  return digits.length ? digits : undefined;
}

export function normaliseEmail(email: string | undefined | null): string | undefined {
  if (!email) return undefined;
  const e = email.trim().toLowerCase();
  return e.length ? e : undefined;
}

/** Postcode normalised to uppercase without spaces ("sw1a 1aa" → "SW1A1AA"). */
export function normalisePostcode(postcode: string | undefined | null): string | undefined {
  if (!postcode) return undefined;
  const p = postcode.toUpperCase().replace(/\s+/g, '');
  return p.length ? p : undefined;
}

/** Bank match key: sort code digits + account number digits. */
export function bankKey(bank: { sortCode?: string; accountNumber?: string } | undefined | null): string | undefined {
  if (!bank?.sortCode || !bank.accountNumber) return undefined;
  const sc = bank.sortCode.replace(/\D/g, '');
  const an = bank.accountNumber.replace(/\D/g, '');
  return sc && an ? `${sc}-${an}` : undefined;
}

/** `%q%` LIKE pattern. SQLite LIKE is case-insensitive for ASCII; wildcards typed by the user only widen the match. */
export function likeContains(q: string): string {
  return `%${q.trim()}%`;
}

/** Whole calendar days between two ISO instants, rounded up, minimum 1 (hire/storage day counting). */
export function chargeableDays(startAt: string, endAt: string): number {
  const ms = new Date(endAt).getTime() - new Date(startAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}
