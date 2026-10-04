/**
 * Settings: registered office, bank (Confirmation-of-Payee warning when the account name is not the exact registered
 * name — live File 1 "bank details could not be validated"), VAT, ICO, rate card, API-key presence and the vehicle
 * lookup mode ('live' with a DVLA or DVSA key, otherwise 'manual'). Legacy details (ARCHITECTURE convention 9) are
 * refused. The registered office defaults to the real one (44 Syon Lane, Isleworth, London TW7 5NQ); bank, VAT and
 * ICO were not supplied and stay Settings inputs.
 */
import type { FastifyInstance } from 'fastify';
import { legacyCheck, REGISTERED_NAME } from '@ccguk/domain';
import type { Settings } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { parse } from '../schemas/common.js';
import { settingsPatchBody } from '../schemas/services.js';

export interface SettingsWarning {
  code: 'CONFIRMATION_OF_PAYEE' | 'REGISTERED_OFFICE_MISSING' | 'BANK_NOT_SET' | 'ICO_MISSING' | 'VAT_MISSING';
  message: string;
}

export type LookupMode = 'live' | 'manual';

/** 'live' when a DVLA VES or DVSA MOT key is configured; otherwise searches use ClaimDesk records and Total Car Check. */
export function lookupModeOf(keys: { dvlaVes?: boolean; dvsaMot?: boolean } | undefined): LookupMode {
  return keys?.dvlaVes || keys?.dvsaMot ? 'live' : 'manual';
}

export function settingsWarnings(s: Settings): SettingsWarning[] {
  const w: SettingsWarning[] = [];
  const registered = s.companyName || REGISTERED_NAME;
  if (!s.bank) w.push({ code: 'BANK_NOT_SET', message: 'Bank details not set — the payment direction (CCGUK-05), invoices and the vendor-verification pack need them. Enter the account exactly as the bank holds it.' });
  else if (s.bank.accountName.trim() !== registered.trim()) {
    w.push({ code: 'CONFIRMATION_OF_PAYEE', message: `Bank account name "${s.bank.accountName}" is not the exact registered name "${registered}". Confirmation of Payee will return a mismatch and insurer payments will be refused (File 1: "bank details could not be validated").` });
  }
  // Settings fall back to the real registered office, so this fires only if a stored value is unusable.
  if (!s.registeredOffice?.line1?.trim() || !s.registeredOffice?.postcode?.trim()) w.push({ code: 'REGISTERED_OFFICE_MISSING', message: 'Registered office incomplete — documents print the default office (44 Syon Lane, Isleworth, London TW7 5NQ) in the Part 6 disclosure.' });
  if (!s.icoRegistration) w.push({ code: 'ICO_MISSING', message: 'ICO registration number not recorded.' });
  if (!s.vatNumber) w.push({ code: 'VAT_MISSING', message: 'VAT number not recorded — invoices will not show VAT registration.' });
  return w;
}

function view(ctx: AppContext) {
  const s = ctx.settings();
  return { ...s, apiKeys: s.apiKeysPresent, registeredName: REGISTERED_NAME, lookupMode: lookupModeOf(s.apiKeysPresent), warnings: settingsWarnings(s) };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/settings', async () => view(ctx));

  /** Read-only staff list for display (names on claims, approver labels). Sign-in username only — never a password hash. */
  app.get('/users', async () => {
    const items = ctx.repos.listUsers(ctx.db).map((u) => ({ id: u.id, name: u.name, username: u.username, email: u.email, role: u.role, mfaEnabled: Boolean(u.mfaEnabled) }));
    return { items, total: items.length };
  });

  app.patch('/settings', async (request) => {
    const body = parse(settingsPatchBody, request.body);
    const legacy = legacyCheck(JSON.stringify(body));
    if (legacy.length) throw badRequest(`Legacy details are blocked: ${legacy.map((f) => f.draftValue ?? f.message).join('; ')}`, { code: 'LEGACY_DETAIL', flags: legacy });
    if (body.companyName && body.companyName.trim() !== REGISTERED_NAME) throw badRequest(`companyName must be the registered name "${REGISTERED_NAME}"`);
    const before = ctx.settings();
    const now = ctx.now();
    const after = ctx.db.transaction((tx) => {
      const s = ctx.repos.patchSettings(tx, body, request.actor);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'settings.patch.api', entity: 'settings', entityId: 'default', before: { bankAccountName: before.bank?.accountName, registeredOffice: before.registeredOffice }, after: { ...body, bank: body.bank ? { accountName: body.bank.accountName, bankName: body.bank.bankName } : undefined }, at: now });
      return s;
    });
    return { ...after, apiKeys: after.apiKeysPresent, registeredName: REGISTERED_NAME, lookupMode: lookupModeOf(after.apiKeysPresent), warnings: settingsWarnings(after) };
  });
}
