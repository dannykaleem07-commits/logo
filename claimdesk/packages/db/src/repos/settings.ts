import { eq } from 'drizzle-orm';
import type { Address, BankDetails, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { ValidationError } from '../errors.js';
import { settings, type ApiKeysPresent, type RateCard, type SettingsRow } from '../schema.js';
import { denull, nowIso } from '../util.js';
import { appendAudit, type Actor } from './audit.js';

export interface Settings {
  id: 'default';
  companyName: string;
  companyNumber?: string;
  registeredOffice?: Address;
  vatNumber?: string;
  bank?: BankDetails;
  icoRegistration?: string;
  rateCard: RateCard;
  apiKeysPresent: ApiKeysPresent;
  updatedAt: ISODateTime;
}

export type SettingsPatch = Partial<Omit<Settings, 'id' | 'updatedAt' | 'rateCard' | 'apiKeysPresent'>> & {
  rateCard?: Partial<RateCard>;
  apiKeysPresent?: Partial<ApiKeysPresent>;
};

export const SETTINGS_ID = 'default' as const;

/** BLUEPRINT §3.4 rate card: £90 call-out + £3/loaded mile + £25 admin; storage £45/day; engineer's fee £285. */
export const DEFAULT_RATE_CARD: RateCard = {
  recoveryCalloutPence: 9000,
  perMilePence: 300,
  adminPence: 2500,
  storageDailyPence: 4500,
  engineerFeePence: 28500,
  vatRate: 0.2,
};

export const DEFAULT_API_KEYS_PRESENT: ApiKeysPresent = { dvlaVes: false, dvsaMot: false, companiesHouse: false, gateway: false, esign: false };

/**
 * Defaults used until the admin saves settings. The bank account name must equal the exact registered name so
 * Confirmation of Payee returns a full match (BLUEPRINT §7 point 7). Never any legacy detail (ARCHITECTURE 9).
 */
export const DEFAULT_SETTINGS: Settings = {
  id: SETTINGS_ID,
  companyName: 'Courtesy Cars Group UK Ltd',
  companyNumber: '17430389',
  rateCard: DEFAULT_RATE_CARD,
  apiKeysPresent: DEFAULT_API_KEYS_PRESENT,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

function toSettings(row: SettingsRow): Settings {
  return { ...denull(row), id: SETTINGS_ID, rateCard: { ...DEFAULT_RATE_CARD, ...row.rateCard }, apiKeysPresent: { ...DEFAULT_API_KEYS_PRESENT, ...row.apiKeysPresent } };
}

export function getSettings(db: Db): Settings {
  const row = db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).get();
  return row ? toSettings(row) : DEFAULT_SETTINGS;
}

/** Merge a patch into settings (creates the row on first save). Audited as `settings.patch`. */
export function patchSettings(db: Db, patch: SettingsPatch, actor: Actor): Settings {
  for (const [k, v] of Object.entries(patch.rateCard ?? {})) {
    if (k === 'vatRate') {
      if (typeof v !== 'number' || v < 0 || v > 1) throw new ValidationError('rateCard.vatRate must be a fraction between 0 and 1');
    } else if (!Number.isInteger(v) || (v as number) < 0) {
      throw new ValidationError(`rateCard.${k} must be non-negative integer pence`);
    }
  }
  return db.transaction((tx) => {
    const before = getSettings(tx);
    const at = nowIso();
    const next = {
      id: SETTINGS_ID,
      companyName: patch.companyName ?? before.companyName,
      companyNumber: patch.companyNumber ?? before.companyNumber ?? null,
      registeredOffice: patch.registeredOffice ?? before.registeredOffice ?? null,
      vatNumber: patch.vatNumber ?? before.vatNumber ?? null,
      bank: patch.bank ?? before.bank ?? null,
      icoRegistration: patch.icoRegistration ?? before.icoRegistration ?? null,
      rateCard: { ...before.rateCard, ...patch.rateCard },
      apiKeysPresent: { ...before.apiKeysPresent, ...patch.apiKeysPresent },
      updatedAt: at,
    };
    tx.insert(settings).values(next).onConflictDoUpdate({ target: settings.id, set: next }).run();
    appendAudit(tx, { actor, action: 'settings.patch', entity: 'settings', entityId: SETTINGS_ID, before, after: patch, at });
    return getSettings(tx);
  });
}
