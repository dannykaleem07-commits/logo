/**
 * UK vehicle registration mark handling (BLUEPRINT §3.2).
 *
 * Formats recognised:
 *  - current (September 2001 onwards):  AB12 CDE   — 2 letters area code, 2 digit age identifier, 3 random letters
 *  - prefix  (August 1983 – August 2001): A123 BCD  — 1 letter year, 1–3 digits, 3 letters
 *  - suffix  (1963 – July 1983):          ABC 123D  — 3 letters, 1–3 digits, 1 letter year
 *  - dateless (pre-1963 and cherished):   ABC 1234 / 1234 ABC / A 1 — 1–3 letters and 1–4 digits
 *  - Northern Ireland:                    AIZ 1234  — 3 letters with I or Z in positions 2–3, 1–4 digits
 */

export type RegistrationFormat = 'current' | 'prefix' | 'suffix' | 'dateless' | 'northern_ireland' | 'invalid';

/** Uppercase, strip whitespace and separators: 'ab12 cde' → 'AB12CDE'. */
export function normaliseRegistration(input: string): string {
  return (input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// Letters I and Q are never used in current-format area codes; Z only appears in the random letters.
const CURRENT = /^[A-HJ-PR-Y]{2}\d{2}[A-HJ-PR-Z]{3}$/;
// Prefix year letters ran A–Y skipping I, O, Q, U, Z.
const PREFIX = /^[A-HJ-NPR-TV-Y]\d{1,3}[A-Z]{3}$/;
// Suffix year letters ran A–Y skipping I, O, Q, U, Z.
const SUFFIX = /^[A-Z]{3}\d{1,3}[A-HJ-NPR-TV-Y]$/;
// Northern Ireland: 3 letters, the second or third of which is I or Z, then 1–4 digits.
const NORTHERN_IRELAND = /^[A-Z](?:[IZ][A-Z]|[A-Z][IZ])\d{1,4}$/;
// Dateless: letters then digits, or digits then letters.
const DATELESS_LETTERS_FIRST = /^[A-Z]{1,3}\d{1,4}$/;
const DATELESS_DIGITS_FIRST = /^\d{1,4}[A-Z]{1,3}$/;

/** Classify a registration mark. Accepts raw or normalised input. */
export function registrationFormat(input: string): RegistrationFormat {
  const reg = normaliseRegistration(input);
  if (reg.length < 2 || reg.length > 7) return 'invalid';
  if (CURRENT.test(reg)) return 'current';
  if (PREFIX.test(reg)) return 'prefix';
  if (SUFFIX.test(reg)) return 'suffix';
  if (NORTHERN_IRELAND.test(reg)) return 'northern_ireland';
  if (DATELESS_LETTERS_FIRST.test(reg) || DATELESS_DIGITS_FIRST.test(reg)) return 'dateless';
  return 'invalid';
}

export function isValidUkRegistration(input: string): boolean {
  return registrationFormat(input) !== 'invalid';
}

/** Display form with the conventional space: 'AB12CDE' → 'AB12 CDE', 'A123BCD' → 'A123 BCD', 'ABC123D' → 'ABC 123D'. */
export function formatRegistration(input: string): string {
  const reg = normaliseRegistration(input);
  switch (registrationFormat(reg)) {
    case 'current':
      return `${reg.slice(0, 4)} ${reg.slice(4)}`;
    case 'prefix': {
      // letter + digits | three letters
      return `${reg.slice(0, reg.length - 3)} ${reg.slice(reg.length - 3)}`;
    }
    case 'suffix':
      return `${reg.slice(0, 3)} ${reg.slice(3)}`;
    case 'northern_ireland':
      return `${reg.slice(0, 3)} ${reg.slice(3)}`;
    case 'dateless': {
      const m = reg.match(/^([A-Z]+)(\d+)$/) ?? reg.match(/^(\d+)([A-Z]+)$/);
      if (m && m[1] && m[2]) return `${m[1]} ${m[2]}`;
      return reg;
    }
    default:
      return reg;
  }
}
