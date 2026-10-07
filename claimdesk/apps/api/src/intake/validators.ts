// owned by intake
/**
 * Deterministic checks for extracted values (docs/SUPREME-DESIGN.md §G.2 step 4). The model reads; code validates.
 *
 *  - VIN: 17 characters from [A-HJ-NPR-Z0-9] (never I, O or Q); the position-9 check digit is enforced where it
 *    applies (North American VINs, first character 1–5) and reported otherwise.
 *  - UK VRM: current (AB12 CDE), prefix (A123 BCD), suffix (ABC 123D), dateless (1–4 digits and 1–3 letters either way)
 *    — the format is returned.
 *  - DVLA driving licence number (GB): 16 characters — surname (5, padded with 9), decade, month (+50 for women), day,
 *    year digit, initials (2, padded with 9), an arbitrary digit, two check characters — cross-checked against the
 *    surname, date of birth, sex and initials when they are known.
 *  - Dates (ISO, UK day-first, "12 March 2019"), date-times, money (→ integer pence), postcodes, phones, emails.
 */

export interface ValidationResult<T = string> {
  ok: boolean;
  /** The normalised value (when it could be parsed). */
  value?: T;
  /** Plain-English problems (empty when ok). */
  errors: string[];
  /** Notes that are not failures (e.g. "check digit not applicable"). */
  notes?: string[];
}

const ok = <T>(value: T, notes?: string[]): ValidationResult<T> => ({ ok: true, value, errors: [], ...(notes?.length ? { notes } : {}) });
const fail = <T = string>(errors: string[], value?: T): ValidationResult<T> => ({ ok: false, errors, ...(value !== undefined ? { value } : {}) });

// ---------------------------------------------------------------------------
// VIN
// ---------------------------------------------------------------------------

const VIN_VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** The ISO 3779 / FMVSS 565 check character for a 17-character VIN. */
export function vinCheckDigit(vin: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const c = vin[i]!;
    const v = /\d/.test(c) ? Number(c) : (VIN_VALUES[c] ?? 0);
    sum += v * VIN_WEIGHTS[i]!;
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

export function validateVin(raw: string): ValidationResult {
  const vin = raw.toUpperCase().replace(/[\s-]/g, '');
  if (vin.length !== 17) return fail([`A VIN has 17 characters; this has ${vin.length}`], vin);
  if (/[IOQ]/.test(vin)) return fail(['A VIN never contains I, O or Q (read as 1 or 0)'], vin);
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return fail(['A VIN uses only letters and digits'], vin);
  const expected = vinCheckDigit(vin);
  const northAmerican = /^[1-5]/.test(vin);
  if (northAmerican) {
    if (vin[8] !== expected) return fail([`The check digit (9th character) should be ${expected}, not ${vin[8]}`], vin);
    return ok(vin, ['check digit verified']);
  }
  return ok(vin, [vin[8] === expected ? 'check digit consistent' : 'check digit not applicable (not a North American VIN)']);
}

// ---------------------------------------------------------------------------
// UK VRM
// ---------------------------------------------------------------------------

export type VrmFormat = 'current' | 'prefix' | 'suffix' | 'dateless';

export function normaliseVrm(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The UK registration format of a plate, or undefined. */
export function vrmFormat(raw: string): VrmFormat | undefined {
  const v = normaliseVrm(raw);
  if (/^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(v)) return 'current';
  if (/^[A-Z][0-9]{1,3}[A-Z]{3}$/.test(v)) return 'prefix';
  if (/^[A-Z]{3}[0-9]{1,3}[A-Z]$/.test(v)) return 'suffix';
  if (/^[0-9]{1,4}[A-Z]{1,3}$/.test(v) || /^[A-Z]{1,3}[0-9]{1,4}$/.test(v)) return 'dateless';
  return undefined;
}

export function validateVrm(raw: string): ValidationResult & { format?: VrmFormat } {
  const v = normaliseVrm(raw);
  if (!v) return fail(['No registration mark']);
  if (v.length > 8) return fail(['A UK registration has at most 7 characters'], v);
  const format = vrmFormat(v);
  if (!format) return fail(['Not a UK registration format (current, prefix, suffix or dateless)'], v);
  // Current-format age identifiers start at 51 (September 2001) and 02 (March 2002): 00 and 01 were never issued.
  if (format === 'current') {
    const age = Number(v.slice(2, 4));
    if (age === 0 || age === 1) return fail([`The age identifier ${v.slice(2, 4)} was never issued`], v);
  }
  return { ...ok(v), format };
}

/** Display form: "AB12 CDE" for current plates, otherwise unchanged (normalised). */
export function displayVrm(raw: string): string {
  const v = normaliseVrm(raw);
  return vrmFormat(v) === 'current' ? `${v.slice(0, 4)} ${v.slice(4)}` : v;
}

// ---------------------------------------------------------------------------
// Dates, money
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n: number): string => String(n).padStart(2, '0');

function realDate(y: number, m: number, d: number): boolean {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parse a date written as ISO, UK day-first (12/03/2019, 12.03.19) or words (12 March 2019, March 12, 2019) → YYYY-MM-DD. */
export function parseDate(raw: string): string | undefined {
  const s = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return realDate(+m[1]!, +m[2]!, +m[3]!) ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
  m = /^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let y = +m[3]!;
    if (m[3]!.length === 2) y += y > 50 ? 1900 : 2000;
    return realDate(y, +m[2]!, +m[1]!) ? `${y}-${pad2(+m[2]!)}-${pad2(+m[1]!)}` : undefined;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase().slice(0, m[2]!.toLowerCase().startsWith('sept') ? 4 : 3)];
    return mon && realDate(+m[3]!, mon, +m[1]!) ? `${m[3]}-${pad2(mon)}-${pad2(+m[1]!)}` : undefined;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
    return mon && realDate(+m[3]!, mon, +m[2]!) ? `${m[3]}-${pad2(mon)}-${pad2(+m[2]!)}` : undefined;
  }
  return undefined;
}

export function validateIsoDate(raw: string, opts: { notAfter?: string; notBefore?: string } = {}): ValidationResult {
  const d = parseDate(raw);
  if (!d) return fail([`"${raw.slice(0, 40)}" is not a date`]);
  if (opts.notAfter && d > opts.notAfter.slice(0, 10)) return fail([`${d} is in the future`], d);
  if (opts.notBefore && d < opts.notBefore.slice(0, 10)) return fail([`${d} is too early`], d);
  return ok(d);
}

/** YYYY-MM (first registration month) from a date or a month ("03/2019", "March 2019", "2019-03"). */
export function parseYearMonth(raw: string): string | undefined {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return +m[2]! >= 1 && +m[2]! <= 12 ? `${m[1]}-${m[2]}` : undefined;
  m = /^(\d{1,2})[/.\-](\d{4})$/.exec(s);
  if (m) return +m[1]! >= 1 && +m[1]! <= 12 ? `${m[2]}-${pad2(+m[1]!)}` : undefined;
  m = /^([A-Za-z]{3,9})\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
    return mon ? `${m[2]}-${pad2(mon)}` : undefined;
  }
  const d = parseDate(s);
  return d ? d.slice(0, 7) : undefined;
}

/**
 * A date-time → UTC ISO: ISO with an offset as it is; a date plus an optional "HH:MM" (am/pm) is read as Europe/London
 * wall time (documents in England & Wales print local times). A bare date becomes London midnight.
 */
export function validateDateTime(raw: string, opts: { notAfter?: string } = {}): ValidationResult {
  const s = raw.trim();
  let iso: string | undefined;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    iso = Number.isNaN(t) ? undefined : new Date(t).toISOString();
  } else {
    const m = /^(.*?)[,\sT]+(?:at\s+)?(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i.exec(s);
    const datePart = m ? parseDate(m[1]!) : parseDate(s);
    if (datePart) {
      let hh = m ? Number(m[2]) : 0;
      const mm = m ? Number(m[3]) : 0;
      const ampm = m?.[4]?.toLowerCase();
      if (ampm === 'pm' && hh < 12) hh += 12;
      if (ampm === 'am' && hh === 12) hh = 0;
      if (hh > 23 || mm > 59) return fail([`"${s}" has an impossible time`]);
      iso = londonLocalToUtc(datePart, hh, mm);
    }
  }
  if (!iso) return fail([`"${s.slice(0, 40)}" is not a date and time`]);
  if (opts.notAfter && iso > opts.notAfter) return fail([`${iso} is in the future`], iso);
  return ok(iso);
}

/** Europe/London wall time → UTC ISO (BST between the last Sundays of March and October, 01:00 UTC changeovers). */
export function londonLocalToUtc(date: string, hh: number, mm: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const lastSunday = (month: number): number => {
    const last = new Date(Date.UTC(y, month, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const asUtc = Date.UTC(y, mo - 1, d, hh, mm);
  const bstStart = Date.UTC(y, 2, lastSunday(3), 1, 0);
  const bstEnd = Date.UTC(y, 9, lastSunday(10), 1, 0);
  const guess = asUtc - 3_600_000;
  const inBst = guess >= bstStart && guess < bstEnd;
  return new Date(inBst ? guess : asUtc).toISOString();
}

/** "£1,234.56", "1234.5", "GBP 1,234", "£12" → integer pence. Negative and unparseable → error. */
export function parseMoneyToPence(raw: string): ValidationResult<number> {
  const s = raw.trim().replace(/^(gbp|£)\s*/i, '').replace(/\s*(gbp)$/i, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return fail<number>([`"${raw.slice(0, 40)}" is not an amount in pounds`]);
  const [whole, frac = ''] = s.split('.');
  return ok(Number(whole) * 100 + Number(frac.padEnd(2, '0')));
}

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

export function validatePostcode(raw: string): ValidationResult {
  const m = /^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\s*$/i.exec(raw);
  return m ? ok(`${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}`) : fail([`"${raw.slice(0, 20)}" is not a UK postcode`]);
}

export interface ParsedAddress {
  line1: string;
  line2?: string;
  town?: string;
  postcode: string;
}

/** A free-text UK address ("12 High Street, Reading, RG1 1AA") → address parts. A postcode is required. */
export function parseUkAddress(raw: string): ValidationResult<ParsedAddress> {
  const text = raw.replace(/\s*\n\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();
  const m = POSTCODE_RE.exec(text.toUpperCase());
  if (!m) return fail<ParsedAddress>(['The address has no UK postcode']);
  const postcode = `${m[1]} ${m[2]}`;
  const before = text.slice(0, m.index).replace(/[,\s]+$/, '');
  const parts = before.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return fail<ParsedAddress>(['The address has a postcode but no street']);
  const line1 = parts[0]!;
  const town = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const middle = parts.slice(1, parts.length > 1 ? -1 : undefined);
  return ok<ParsedAddress>({ line1, ...(middle.length ? { line2: middle.join(', ') } : {}), ...(town ? { town } : {}), postcode });
}

export function formatAddress(a: { line1?: string; line2?: string; town?: string; postcode?: string } | undefined): string | undefined {
  if (!a) return undefined;
  const s = [a.line1, a.line2, a.town, a.postcode].filter((x) => x && String(x).trim()).join(', ');
  return s || undefined;
}

export function validateUkPhone(raw: string): ValidationResult {
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+44')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('0044')) digits = `0${digits.slice(4)}`;
  digits = digits.replace(/\D/g, '');
  if (!/^0\d{9,10}$/.test(digits)) return fail([`"${raw.slice(0, 24)}" is not a UK phone number`]);
  return ok(digits.length === 11 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits);
}

export function validateEmail(raw: string): ValidationResult {
  const e = raw.trim().toLowerCase();
  return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/.test(e) ? ok(e) : fail([`"${raw.slice(0, 40)}" is not an email address`]);
}

/** A person's or company's name: letters required, no digits-only, at most 160 characters. */
export function validateName(raw: string): ValidationResult {
  const n = raw.replace(/\s+/g, ' ').trim();
  if (!n) return fail(['No name']);
  if (n.length > 160) return fail(['The name is too long']);
  if (!/\p{L}/u.test(n)) return fail(['A name needs letters']);
  return ok(n);
}

// ---------------------------------------------------------------------------
// DVLA driving licence number
// ---------------------------------------------------------------------------

export interface LicenceHolder {
  surname?: string;
  /** Forenames (first and middle) — the initials are positions 12–13. */
  forenames?: string;
  /** YYYY-MM-DD */
  dateOfBirth?: string;
  sex?: 'male' | 'female';
}

export interface DecodedLicence {
  surnameCode: string;
  /** Decade digit, month, day, year digit as encoded. */
  birthMonth: number;
  birthDay: number;
  birthYearDigits: string;
  sex: 'male' | 'female';
  initials: string;
}

/** The 5-character surname code: letters only, "MAC" → "MC", padded with 9s. */
export function surnameCode(surname: string): string {
  let s = surname.toUpperCase().replace(/[^A-Z]/g, '');
  if (s.startsWith('MAC')) s = `MC${s.slice(3)}`;
  return s.slice(0, 5).padEnd(5, '9');
}

export function initialsCode(forenames: string): string {
  const init = forenames
    .toUpperCase()
    .split(/[\s-]+/)
    .map((w) => w.replace(/[^A-Z]/g, ''))
    .filter(Boolean)
    .map((w) => w[0]!)
    .join('');
  return init.slice(0, 2).padEnd(2, '9');
}

export function decodeDvlaLicence(raw: string): DecodedLicence | undefined {
  const n = raw.toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z9]{5})(\d)(\d{2})(\d{2})(\d)([A-Z9]{2})(\d)([A-Z0-9]{2})$/.exec(n);
  if (!m) return undefined;
  const monthRaw = Number(m[3]);
  const sex: 'male' | 'female' = monthRaw > 50 ? 'female' : 'male';
  const month = sex === 'female' ? monthRaw - 50 : monthRaw;
  return { surnameCode: m[1]!, birthMonth: month, birthDay: Number(m[4]), birthYearDigits: `${m[2]}${m[5]}`, sex, initials: m[6]! };
}

export function validateDvlaLicence(raw: string, holder: LicenceHolder = {}): ValidationResult & { decoded?: DecodedLicence } {
  const n = raw.toUpperCase().replace(/\s+/g, '');
  if (n.length !== 16) return fail([`A GB licence number has 16 characters; this has ${n.length}`], n);
  const d = decodeDvlaLicence(n);
  if (!d) return fail(['Not the GB licence number structure (5 surname letters, 6 date digits, 2 initials, a digit, 2 check characters)'], n);
  const errors: string[] = [];
  if (!/^[A-Z]/.test(d.surnameCode) || /9[A-Z]/.test(d.surnameCode)) errors.push('The surname part is malformed');
  if (d.birthMonth < 1 || d.birthMonth > 12) errors.push('The month of birth part is impossible');
  if (d.birthDay < 1 || d.birthDay > 31) errors.push('The day of birth part is impossible');
  if (holder.surname && surnameCode(holder.surname) !== d.surnameCode) errors.push(`The surname part ${d.surnameCode} does not match the surname ${holder.surname}`);
  if (holder.dateOfBirth) {
    const dob = parseDate(holder.dateOfBirth);
    if (dob) {
      const [y, mo, day] = dob.split('-');
      if (`${y![2]}${y![3]}` !== d.birthYearDigits) errors.push('The year of birth does not match the date of birth');
      if (Number(mo) !== d.birthMonth) errors.push('The month of birth does not match the date of birth');
      if (Number(day) !== d.birthDay) errors.push('The day of birth does not match the date of birth');
    }
  }
  if (holder.sex && holder.sex !== d.sex) errors.push(`The month part encodes ${d.sex === 'female' ? 'a woman' : 'a man'}; the holder is recorded as ${holder.sex}`);
  if (holder.forenames && initialsCode(holder.forenames)[0] !== d.initials[0]) errors.push(`The initials part ${d.initials} does not match ${holder.forenames}`);
  return errors.length ? { ...fail(errors, n), decoded: d } : { ...ok(n), decoded: d };
}

/** Split "Mr John Andrew SMITH" / "SMITH, John" → surname + forenames (titles dropped). */
export function splitName(full: string): { surname?: string; forenames?: string } {
  const s = full.replace(/\b(mr|mrs|ms|miss|mx|dr|prof|sir|dame|rev)\.?\s+/gi, '').trim();
  if (!s) return {};
  if (s.includes(',')) {
    const [last, first] = s.split(',', 2).map((x) => x.trim());
    return { ...(last ? { surname: last } : {}), ...(first ? { forenames: first } : {}) };
  }
  const words = s.split(/\s+/);
  if (words.length === 1) return { surname: words[0]! };
  return { surname: words[words.length - 1]!, forenames: words.slice(0, -1).join(' ') };
}
