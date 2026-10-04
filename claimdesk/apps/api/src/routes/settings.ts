/**
 * Settings: registered office, bank (Confirmation-of-Payee warning when the account name is not the exact registered
 * name — live File 1 "bank details could not be validated"), VAT, ICO, rate card, API-key presence. Legacy details
 * (ARCHITECTURE convention 9) are refused.
 */
import type { FastifyInstance } from 'fastify';
import { legacyCheck, REGISTERED_NAME } from '@ccguk/domain';
import type { Settings } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { parse } from '../schemas/common.js';
import { settingsPatchBody } from '../schemas/services.js';

export interface SettingsWarning {
  code: 'CONFIRMATION_OF_PAYEE' | 'REGISTERED_OFFICE_MISSING' | 'BANK_MISSING' | 'ICO_MISSING' | 'VAT_MISSING';
  message: string;
}

export function settingsWarnings(s: Settings): SettingsWarning[] {
  const w: SettingsWarning[] = [];
  const registered = s.companyName || REGISTERED_NAME;
  if (!s.bank) w.push({ code: 'BANK_MISSING', message: 'No bank details — invoices and the vendor-verification pack cannot render.' });
  else if (s.bank.accountName.trim() !== registered.trim()) {
    w.push({ code: 'CONFIRMATION_OF_PAYEE', message: `Bank account name "${s.bank.accountName}" is not the exact registered name "${registered}". Confirmation of Payee will return a mismatch and insurer payments will be refused (File 1: "bank details could not be validated").` });
  }
  if (!s.registeredOffice) w.push({ code: 'REGISTERED_OFFICE_MISSING', message: 'Registered office not set — documents print "[registered office]" in the Part 6 disclosure.' });
  if (!s.icoRegistration) w.push({ code: 'ICO_MISSING', message: 'ICO registration number not recorded.' });
  if (!s.vatNumber) w.push({ code: 'VAT_MISSING', message: 'VAT number not recorded — invoices will not show VAT registration.' });
  return w;
}

function view(ctx: AppContext) {
  const s = ctx.settings();
  return { ...s, apiKeys: s.apiKeysPresent, registeredName: REGISTERED_NAME, warnings: settingsWarnings(s) };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/settings', async () => view(ctx));

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
    return { ...after, apiKeys: after.apiKeysPresent, registeredName: REGISTERED_NAME, warnings: settingsWarnings(after) };
  });
}
