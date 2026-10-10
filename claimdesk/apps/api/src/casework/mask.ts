// owned by casework
/**
 * PII minimisation for prompts (docs/SUPREME-DESIGN.md §K.3).
 *
 *   date of birth            → year only
 *   licence / NI / passport  → last 3 characters
 *   bank account             → last 4
 *   sort code                → masked
 *   policy numbers           → last 4
 *   phone / email            → partially masked (unless the task is to write to that address — `keepContacts`)
 *   addresses                → town + postcode district
 *
 * Names are kept (needed to reason and write). Unmasked values only enter outgoing text through `{{fact:…}}`
 * placeholders resolved by code (casework/facts.ts) from an unmasked brief.
 */

const BULLET = '•';

/** The last `n` characters prefixed with an ellipsis ("…123"); all bullets when the value is that short. */
export function lastN(value: string, n: number): string {
  const clean = value.replace(/\s+/g, '');
  if (!clean) return '';
  return clean.length <= n ? BULLET.repeat(clean.length) : `…${clean.slice(-n)}`;
}

/** "jane.doe@example.test" → "j•••@example.test" */
export function maskEmail(email: string): string {
  const s = email.trim();
  const at = s.indexOf('@');
  if (at <= 0) return `${BULLET.repeat(3)}`;
  return `${s[0]}${BULLET.repeat(3)}${s.slice(at)}`;
}

/** "07700 900123" → "07••• •••123" */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return BULLET.repeat(3);
  return `${digits.slice(0, 2)}${BULLET.repeat(3)} ${BULLET.repeat(3)}${digits.slice(-3)}`;
}

/** "1988-04-02" → "1988" */
export function maskDob(dob: string): string {
  const m = /^(\d{4})/.exec(dob.trim());
  return m ? m[1]! : BULLET.repeat(4);
}

export const maskSortCode = (): string => `${BULLET.repeat(2)}-${BULLET.repeat(2)}-${BULLET.repeat(2)}`;
export const maskAccountNumber = (v: string): string => lastN(v, 4);
export const maskPolicyNumber = (v: string): string => lastN(v, 4);
/** Driving licence, NI number, passport number. */
export const maskIdNumber = (v: string): string => lastN(v, 3);

/** Postcode district (outward code): "E1 6AN" → "E1", "IG11 0AA" → "IG11". */
export function postcodeDistrict(postcode: string): string {
  const t = postcode.trim().toUpperCase();
  const m = /^([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}$/.exec(t);
  return m ? m[1]! : (t.split(/\s+/)[0] ?? '');
}

export interface AddressLike {
  line1?: string;
  line2?: string;
  town?: string;
  county?: string;
  postcode?: string;
}

/** Town + postcode district ("London E1"); empty when neither is known. */
export function maskAddress(a: AddressLike | undefined | null): string {
  if (!a) return '';
  return [a.town?.trim(), a.postcode ? postcodeDistrict(a.postcode) : undefined].filter(Boolean).join(' ');
}

/** One-line full address (unmasked; only for placeholder resolution). */
export function fullAddress(a: AddressLike | undefined | null): string {
  if (!a) return '';
  return [a.line1, a.line2, a.town, a.county, a.postcode].map((x) => x?.trim()).filter(Boolean).join(', ');
}

export interface MaskOptions {
  /** Contact addresses the task writes to: left unmasked (lower-cased emails / digits-only phones compared). */
  keepContacts?: readonly string[];
}

const keep = (value: string, opts: MaskOptions): boolean => {
  const k = (opts.keepContacts ?? []).map((c) => c.trim().toLowerCase());
  const v = value.trim().toLowerCase();
  const digits = v.replace(/\D/g, '');
  return k.some((c) => c === v || (digits.length >= 6 && c.replace(/\D/g, '') === digits));
};

const KEY_RULES: Array<{ test: RegExp; mask: (v: string, o: MaskOptions) => string }> = [
  { test: /^(dateOfBirth|dob|birthDate)$/i, mask: (v) => maskDob(v) },
  { test: /(drivingLicenceNumber|licenceNumber|licenseNumber|niNumber|nationalInsurance\w*|passport\w*)$/i, mask: (v) => maskIdNumber(v) },
  { test: /^(accountNumber|bankAccount\w*|iban)$/i, mask: (v) => maskAccountNumber(v) },
  { test: /^sortCode$/i, mask: () => maskSortCode() },
  { test: /policyNumber$/i, mask: (v) => maskPolicyNumber(v) },
  { test: /^(phone|mobile|telephone|tel|phoneNumber)$/i, mask: (v, o) => (keep(v, o) ? v : maskPhone(v)) },
  { test: /^(email|emailAddress)$/i, mask: (v, o) => (keep(v, o) ? v : maskEmail(v)) },
];

/** Mask personal data in any JSON value by key (addresses → town + district; `licence.number` too). */
export function maskDeep(value: unknown, opts: MaskOptions = {}, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, opts, key));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (key && /address$/i.test(key) && ('postcode' in o || 'line1' in o || 'town' in o)) return maskAddress(o as AddressLike);
    if (key && /^bank$/i.test(key)) return { accountName: typeof o.accountName === 'string' ? o.accountName : null, accountNumber: typeof o.accountNumber === 'string' ? maskAccountNumber(o.accountNumber) : null, sortCode: o.sortCode ? maskSortCode() : null };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if ((key === 'licence' || key === 'drivingLicence') && k === 'number' && typeof v === 'string') out[k] = maskIdNumber(v);
      else out[k] = maskDeep(v, opts, k);
    }
    return out;
  }
  if (typeof value === 'string' && key) {
    const rule = KEY_RULES.find((r) => r.test.test(key));
    if (rule) return rule.mask(value, opts);
  }
  return value;
}

/**
 * Mask identifiers inside free text (notes, summaries): email addresses, UK phone numbers, sort codes, 8-digit account
 * numbers, NI numbers and 16-character licence numbers. Names and ordinary words are untouched.
 */
export function maskText(text: string, opts: MaskOptions = {}): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => (keep(m, opts) ? m : maskEmail(m)))
    .replace(/\b\d{2}-\d{2}-\d{2}\b/g, () => maskSortCode())
    .replace(/\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, (m) => maskIdNumber(m))
    .replace(/\b[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}\b/g, (m) => maskIdNumber(m))
    .replace(/(?:\+44\s?|\b0)(?:\d[\s-]?){9,10}\b/g, (m) => (keep(m, opts) ? m : maskPhone(m)))
    .replace(/\b\d{8}\b/g, (m) => maskAccountNumber(m));
}
