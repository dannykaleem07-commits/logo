/**
 * Settings screen model (pure; unit-tested). BLUEPRINT §7.7 (vendor onboarding and bank validation), §3.4 (rate
 * card), §4.1 (lookups and where to register for keys). Pence over the wire; pounds only inside MoneyInput.
 */
import type { Address, Pence } from '@ccguk/domain';
import type { RateCardView, Settings } from '../../api/client';
import { findLegacyDetails, type LegacyHit } from '../../lib/legacy';

/** The exact registered name. Confirmation of Payee returns a full match only when the account name equals it. */
export const COMPANY_NAME = 'Courtesy Cars Group UK Ltd';
export const COMPANY_NUMBER = '17430389';

/**
 * The company's real details (design doc §H; mirror of @ccguk/documents brand.company, which the web does not import).
 * Bank, VAT and ICO were not supplied: they stay Settings inputs and are never invented.
 */
export const COMPANY_DETAILS = {
  registeredName: COMPANY_NAME,
  tradingName: 'Courtesy Cars UK',
  companyNumber: COMPANY_NUMBER,
  registeredOffice: '44 Syon Lane, Isleworth, London TW7 5NQ',
  caseHandlerPhone: '07425 475922',
  officePhone: '020 7052 5403',
  claimsEmail: 'claims@courtesycars.net',
  website: 'www.courtesycars.net',
  director: 'Shahzaib Ahmed Bari'
} as const;

/** The registered office as the API defaults it (packages/db DEFAULT_REGISTERED_OFFICE). */
export const DEFAULT_REGISTERED_OFFICE: Address = { line1: '44 Syon Lane', line2: 'Isleworth', town: 'London', postcode: 'TW7 5NQ' };

/** Footer line for the sign-in screen (registered office and both phone numbers). */
export const LEGAL_FOOTER = `${COMPANY_NAME} · Registered in England & Wales No. ${COMPANY_NUMBER} · ${COMPANY_DETAILS.registeredOffice} · ${COMPANY_DETAILS.officePhone} · ${COMPANY_DETAILS.caseHandlerPhone}`;

/** Second footer line of the app shell: where the company is and how to reach it. */
export const SHELL_CONTACT_LINE = `44 Syon Lane, Isleworth TW7 5NQ · ${COMPANY_DETAILS.officePhone}`;

/** "ClaimDesk 0.2.57" from GET /api/health `version`; just "ClaimDesk" until it is known. */
export function versionLabel(version: string | undefined | null): string {
  const v = (version ?? '').trim();
  return v ? `ClaimDesk ${v}` : 'ClaimDesk';
}

// ---------------------------------------------------------------------------
// Vehicle lookup mode (design doc §E)
// ---------------------------------------------------------------------------

export type LookupMode = 'live' | 'manual';

/** GET /settings `lookupMode`; older APIs without it: live when a DVLA or DVSA key is present. */
export function lookupModeOf(settings: Settings | undefined): LookupMode | undefined {
  const m = settings?.lookupMode;
  if (m === 'live' || m === 'manual') return m;
  const keys = settings?.apiKeys;
  if (!keys) return undefined;
  return keys.dvlaVes || keys.dvsaMot ? 'live' : 'manual';
}

export function lookupModeLabel(mode: LookupMode | undefined): string {
  if (mode === 'live') return 'Vehicle lookups: Live (DVLA / DVSA keys configured)';
  if (mode === 'manual') return 'Vehicle lookups: Manual (no DVLA/DVSA keys) — searches use ClaimDesk records and Total Car Check';
  return 'Vehicle lookups: checking…';
}

/** "More settings" card: pages built by the templates-web and vehicles-web slices. */
export const MORE_SETTINGS_LINKS: ReadonlyArray<{ to: string; label: string; description: string }> = [
  { to: '/settings/templates', label: 'Document templates', description: 'The CCGUK Word templates and your uploaded templates: fields, mappings and test fills.' },
  { to: '/settings/gta-rates', label: 'GTA benchmark rates', description: 'Daily rates by GTA group with their verification status (an industry benchmark only; CCGUK is not a subscriber).' }
];

export interface CopCheck {
  match: boolean;
  /** Plain-English line for the warning banner (undefined when it matches). */
  message?: string;
}

/** Exact match required; whitespace differences are forgiven, case and wording are not. */
export function confirmationOfPayeeCheck(accountName: string | undefined): CopCheck {
  const name = (accountName ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return { match: false, message: 'No bank account name recorded. Confirmation of Payee needs the exact registered name before insurers can validate payment.' };
  if (name === COMPANY_NAME) return { match: true };
  if (name.toLowerCase() === COMPANY_NAME.toLowerCase()) return { match: false, message: `Account name "${name}" differs from the registered name in case only — banks may still return a partial match. Use "${COMPANY_NAME}" exactly.` };
  return { match: false, message: `Account name "${name}" is not the registered name "${COMPANY_NAME}". Confirmation of Payee will not return a full match and insurers will report "bank details could not be validated" (File 1).` };
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export interface SettingsForm {
  registeredOffice: string;
  vatNumber: string;
  icoRegistration: string;
  bankAccountName: string;
  bankSortCode: string;
  bankAccountNumber: string;
  bankName: string;
  recoveryCalloutPence: Pence | null;
  recoveryPerLoadedMilePence: Pence | null;
  recoveryAdminPence: Pence | null;
  storageDailyPence: Pence | null;
  engineerFeePence: Pence | null;
  /** Percent text as typed ("20"). */
  vatRatePct: string;
}

/** Rate card defaults from BLUEPRINT §3.4 / ARCHITECTURE convention 11 (£90 + £3/mile + £25; £45/day; £285). */
export const DEFAULT_RATE_CARD = { recoveryCalloutPence: 9000, recoveryPerLoadedMilePence: 300, recoveryAdminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500, vatRate: 0 } as const;

/** The API holds the registered office as an `Address`; the form edits it as one line per part (older builds sent a string). */
export function addressToLines(a: Address | string | undefined): string {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.line1, a.line2, a.town, a.county, a.postcode].map((x) => (x ?? '').trim()).filter(Boolean).join('\n');
}

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

/**
 * Textarea → `Address` (API `addressSchema`: line1 and postcode required). Parts are split on new lines or commas;
 * the last part must be a postcode, the first is line 1, the part before the postcode is the town, anything
 * between is line 2. Returns undefined when there is no usable address (the field is then left out of the patch).
 */
export function linesToAddress(text: string): Address | undefined {
  const parts = text
    .split(/\n|,/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  // "London N1 1AA" on one line: split the trailing postcode off the town.
  const last = parts[parts.length - 1]!;
  const m = /^(.*?)\s*([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})$/i.exec(last);
  if (!m) return undefined;
  const postcode = m[2]!.toUpperCase().replace(/\s+/g, ' ');
  if (!UK_POSTCODE.test(postcode)) return undefined;
  const line1 = parts[0]!;
  const middle = [...parts.slice(1, -1), ...(m[1]!.trim() ? [m[1]!.trim()] : [])];
  const out: Address = { line1, postcode };
  if (middle.length >= 1) out.town = middle[middle.length - 1];
  if (middle.length >= 2) out.line2 = middle.slice(0, -1).join(', ');
  return out;
}

/** Rate card as the API returns it (`perMilePence` / `adminPence`) or as the web spells it; either is read. */
export function rateCardPerMile(rc: RateCardView | undefined): Pence | null {
  return rc?.perMilePence ?? rc?.recoveryPerLoadedMilePence ?? null;
}
export function rateCardAdmin(rc: RateCardView | undefined): Pence | null {
  return rc?.adminPence ?? rc?.recoveryAdminPence ?? null;
}

export function settingsToForm(s: Settings | undefined): SettingsForm {
  const rc = s?.rateCard;
  return {
    // the real registered office until the API holds a different one
    registeredOffice: addressToLines(s?.registeredOffice) || addressToLines(DEFAULT_REGISTERED_OFFICE),
    vatNumber: s?.vatNumber ?? '',
    icoRegistration: s?.icoRegistration ?? '',
    bankAccountName: s?.bank?.accountName ?? '',
    bankSortCode: s?.bank?.sortCode ?? '',
    bankAccountNumber: s?.bank?.accountNumber ?? '',
    bankName: s?.bank?.bankName ?? '',
    recoveryCalloutPence: rc?.recoveryCalloutPence ?? null,
    recoveryPerLoadedMilePence: rateCardPerMile(rc),
    recoveryAdminPence: rateCardAdmin(rc),
    storageDailyPence: rc?.storageDailyPence ?? null,
    engineerFeePence: rc?.engineerFeePence ?? null,
    vatRatePct: rc ? String(Math.round(rc.vatRate * 10000) / 100) : ''
  };
}

export type SettingsErrors = Partial<Record<keyof SettingsForm, string>>;

export function parsePct(text: string): number | null {
  const t = text.replace(/[%\s]/g, '');
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : null;
}

export function validateSettings(f: SettingsForm): SettingsErrors {
  const e: SettingsErrors = {};
  const legacy = (text: string): LegacyHit[] => findLegacyDetails(text);
  for (const k of ['registeredOffice', 'bankAccountName', 'bankName'] as const) {
    const hits = legacy(f[k]);
    if (hits.length) e[k] = `Legacy detail blocked (lesson i): ${hits.map((h) => `"${h.found}"`).join(', ')}`;
  }
  if (f.registeredOffice.trim() && !e.registeredOffice && !linesToAddress(f.registeredOffice)) e.registeredOffice = 'One part per line, ending with the postcode (e.g. "1 Example Way", "London", "N1 1AA")';
  if (f.bankSortCode && !/^\d{2}-?\d{2}-?\d{2}$/.test(f.bankSortCode.trim())) e.bankSortCode = 'Sort code is six digits (e.g. 12-34-56)';
  if (f.bankAccountNumber && !/^\d{8}$/.test(f.bankAccountNumber.trim())) e.bankAccountNumber = 'Account number is eight digits';
  if (f.vatNumber && !/^(GB)?\s?\d{9}(\d{3})?$/i.test(f.vatNumber.replace(/\s+/g, ''))) e.vatNumber = 'UK VAT number: GB followed by 9 digits (leave blank if not registered)';
  if (f.icoRegistration && !/^[A-Z]{1,2}\d{6,7}$/i.test(f.icoRegistration.replace(/\s+/g, ''))) e.icoRegistration = 'ICO registration reference looks like ZA123456 or Z1234567';
  if (f.vatRatePct && parsePct(f.vatRatePct) === null) e.vatRatePct = 'Enter the VAT rate as a percentage, e.g. 20';
  else if ((parsePct(f.vatRatePct) ?? 0) > 0 && !f.vatNumber.trim()) e.vatRatePct = 'VAT can only be charged with a VAT number — enter it above, or leave the rate at 0';
  for (const k of ['recoveryCalloutPence', 'recoveryPerLoadedMilePence', 'recoveryAdminPence', 'storageDailyPence', 'engineerFeePence'] as const) {
    const v = f[k];
    if (v !== null && v < 0) e[k] = 'Cannot be negative';
  }
  return e;
}

/**
 * Form → PATCH /settings body (apps/api `settingsPatchBody`). Only the sections the form owns; pence stay pence;
 * VAT as a fraction; the registered office as an `Address`; the bank block only when an account name is given
 * (the API requires name, sort code and account number together).
 */
export function buildSettingsPatch(f: SettingsForm): Partial<Settings> {
  const rc = DEFAULT_RATE_CARD;
  const vat = parsePct(f.vatRatePct);
  const registeredOffice = linesToAddress(f.registeredOffice);
  const accountName = f.bankAccountName.replace(/\s+/g, ' ').trim();
  return {
    ...(registeredOffice ? { registeredOffice } : {}),
    companyNumber: COMPANY_NUMBER,
    vatNumber: f.vatNumber.replace(/\s+/g, '').toUpperCase() || undefined,
    icoRegistration: f.icoRegistration.replace(/\s+/g, '').toUpperCase() || undefined,
    ...(accountName ? { bank: { accountName, sortCode: f.bankSortCode.replace(/\D/g, ''), accountNumber: f.bankAccountNumber.trim(), bankName: f.bankName.trim() || undefined } } : {}),
    rateCard: {
      recoveryCalloutPence: f.recoveryCalloutPence ?? rc.recoveryCalloutPence,
      recoveryPerLoadedMilePence: f.recoveryPerLoadedMilePence ?? rc.recoveryPerLoadedMilePence,
      recoveryAdminPence: f.recoveryAdminPence ?? rc.recoveryAdminPence,
      storageDailyPence: f.storageDailyPence ?? rc.storageDailyPence,
      engineerFeePence: f.engineerFeePence ?? rc.engineerFeePence,
      vatRate: vat === null ? rc.vatRate : vat / 100
    }
  };
}

// ---------------------------------------------------------------------------
// API keys (BLUEPRINT §4.1)
// ---------------------------------------------------------------------------

export type ApiKeyName = 'dvlaVes' | 'dvsaMot' | 'companiesHouse' | 'gateway' | 'anthropic';

export interface ApiKeyMeta {
  key: ApiKeyName;
  label: string;
  unlocks: string;
  env: string;
  registerUrl?: string;
  registerNote: string;
  cost: string;
}

export const API_KEYS: ApiKeyMeta[] = [
  {
    key: 'dvlaVes',
    label: 'DVLA Vehicle Enquiry Service',
    unlocks: 'Tax and MOT status, make, colour, fuel, CO₂, first registration, export marker, V5C issue date.',
    env: 'DVLA_VES_API_KEY',
    registerUrl: 'https://developer-portal.driver-vehicle-licensing.api.gov.uk/',
    registerNote: 'DVLA developer portal; x-api-key header; one key per company; support dvlaapiaccess@dvla.gov.uk.',
    cost: 'Free'
  },
  {
    key: 'dvsaMot',
    label: 'DVSA MOT History',
    unlocks: 'Every MOT test, odometer reading, defect and advisory — feeds the mileage conflict engine.',
    env: 'DVSA_MOT_CLIENT_ID / DVSA_MOT_CLIENT_SECRET / DVSA_MOT_API_KEY',
    registerUrl: 'https://documentation.history.mot.api.gov.uk/',
    registerNote: 'OAuth 2.0 client credentials plus X-API-Key; the client secret expires every 2 years and a key unused for 90 days is revoked.',
    cost: 'Free'
  },
  {
    key: 'companiesHouse',
    label: 'Companies House',
    unlocks: 'Company status, filing deadlines, gazette (strike-off) notices and officer changes for the watch list.',
    env: 'COMPANIES_HOUSE_API_KEY',
    registerUrl: 'https://developer.company-information.service.gov.uk/',
    registerNote: 'Developer account; rate-limited. Needed for the nightly poll of CARFLEX LTD (12640635) and every supplier / insurer.',
    cost: 'Free (key required)'
  },
  {
    key: 'gateway',
    label: 'Commercial vehicle-data gateway',
    unlocks: 'Spec decode, valuation and provenance (write-off, finance, stolen) for PAV and total-loss work.',
    env: 'VEHICLE_GATEWAY_API_KEY',
    registerNote: 'Choose a licensed gateway (BLUEPRINT §4.1 names CarAnalytics, Vehicle Smart and DealerPricing) and read the licence for "no resale" / "internal use" clauses before signing.',
    cost: 'Pence per lookup; valuation ≈ £0.10–£0.25; provenance ≈ £1.25–£4.99'
  },
  {
    key: 'anthropic',
    label: 'LLM (retrieval assistant)',
    unlocks: 'Drafting assistance over the cited knowledge base and file data; every output is held for human approval.',
    env: 'ANTHROPIC_API_KEY',
    registerUrl: 'https://console.anthropic.com/',
    registerNote: 'Optional. Nothing is sent automatically; the consistency engine still checks every draft.',
    cost: '≈ £50–£200 / month (estimate)'
  }
];

export function apiKeyPresent(settings: Settings | undefined, key: ApiKeyName): boolean | undefined {
  const keys = settings?.apiKeys;
  if (!keys) return undefined;
  const v = (keys as Record<string, boolean | undefined>)[key];
  return v === undefined ? undefined : Boolean(v);
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  mfaEnabled?: boolean;
}

/** Users/roles are read-only for now: the API may expose them under settings.users. */
export function usersFrom(settings: Settings | undefined): UserRow[] {
  const raw = settings?.users;
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is UserRow => Boolean(u) && typeof u === 'object' && typeof (u as UserRow).name === 'string');
}

export const ROLE_LABEL: Record<string, string> = { handler: 'Handler', approver: 'Approver', engineer: 'Engineer', admin: 'Admin' };
