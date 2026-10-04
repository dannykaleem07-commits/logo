/**
 * Counterparty monitoring (lesson k): the watch list, Companies House polling, SUPPLIER_HIGH_RISK flags on claims
 * where a high-risk company is a party. Without COMPANIES_HOUSE_API_KEY the poll marks rows unverified and skips.
 */
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@ccguk/db';
import type { Claim, CompanyWatch, Id, Party } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { parse } from '../schemas/common.js';
import { watchBody } from '../schemas/services.js';
import { assessCompanyRisk, createCompaniesHouseClient, type CompaniesHouseClient } from '../services/companiesHouse.js';
import { params } from './helpers.js';

export interface PollOutcome {
  at: string;
  polled: number;
  skipped: number;
  changed: CompanyWatch[];
  items: CompanyWatch[];
  flagsRaised: Array<{ claimId: Id; reference: string; companyNumber: string }>;
  note?: string;
}

const SUPPLIER_ROLES = new Set<Party['roles'][number]>(['supplier', 'repairer', 'engineer', 'recovery_agent', 'storage_yard', 'salvage_buyer', 'insurer', 'broker', 'solicitor']);
const OPEN_EXCLUDED = new Set<Claim['status']>(['settled', 'closed', 'declined']);

/** Claims where a party with this company number is a supplier/counterparty (ledger counterparty, engineer, offeror, insurer). */
export function claimsForCompany(ctx: AppContext, companyNumber: string): Array<{ claim: Claim; party: Party }> {
  const norm = ctx.repos.normaliseCompanyNumber(companyNumber);
  const parties = ctx.repos.listParties(ctx.db, { kind: 'company', limit: 100_000 }).filter((p) => p.companyNumber && ctx.repos.normaliseCompanyNumber(p.companyNumber) === norm);
  if (!parties.length) return [];
  const out = new Map<string, { claim: Claim; party: Party }>();
  const claims = ctx.repos.listClaims(ctx.db, { limit: 100_000 }).filter((c) => !OPEN_EXCLUDED.has(c.status));
  for (const claim of claims) {
    for (const party of parties) {
      const supplier = SUPPLIER_ROLES.has(party.roles[0] ?? 'other') || party.roles.some((r) => SUPPLIER_ROLES.has(r));
      if (!supplier) continue;
      const linked =
        claim.atFaultInsurerId === party.id ||
        claim.clientInsurerId === party.id ||
        claim.thirdPartyIds.includes(party.id) ||
        ctx.repos.listLedger(ctx.db, claim.id).some((e) => e.counterpartyId === party.id) ||
        ctx.repos.listEngineerReports(ctx.db, claim.id).some((r) => r.engineerPartyId === party.id) ||
        ctx.repos.listOffers(ctx.db, claim.id).some((o) => o.offerorPartyId === party.id);
      if (linked) out.set(claim.id, { claim, party });
    }
  }
  return [...out.values()];
}

export async function pollWatchList(ctx: AppContext, actor: Actor, client?: CompaniesHouseClient): Promise<PollOutcome> {
  const key = ctx.config.keys.companiesHouseApiKey;
  const ch = client ?? (key ? createCompaniesHouseClient({ apiKey: key, timeoutMs: ctx.config.lookupTimeoutMs }) : undefined);
  const at = ctx.now();
  const rows = ctx.repos.listCompanyWatch(ctx.db);
  const changed: CompanyWatch[] = [];
  const flagsRaised: PollOutcome['flagsRaised'] = [];
  let polled = 0;
  let skipped = 0;
  for (const row of rows) {
    let updated: CompanyWatch;
    if (!ch) {
      skipped += 1;
      const risk = assessCompanyRisk({ status: row.status, accountsOverdue: row.accountsOverdue, confirmationStatementOverdue: row.confirmationStatementOverdue, gazetteNotices: row.gazetteNotices, verified: false });
      const riskLevel = row.riskLevel === 'high' ? 'high' : risk.riskLevel;
      updated = ctx.repos.recordCompanyPoll(ctx.db, row.companyNumber, { riskLevel, riskReasons: [...new Set([...row.riskReasons.filter((r) => !r.startsWith('Not polled')), ...risk.riskReasons])], polledAt: at });
    } else {
      try {
        const profile = await ch.profile(row.companyNumber);
        let gazette: Awaited<ReturnType<CompaniesHouseClient['gazetteFilings']>> = [];
        try {
          gazette = await ch.gazetteFilings(row.companyNumber);
        } catch (err) {
          ctx.logger.warn('watch: filing history unreachable', { companyNumber: row.companyNumber, error: String(err) });
        }
        const risk = assessCompanyRisk({ status: profile.status, statusDetail: profile.statusDetail, accountsOverdue: profile.accountsOverdue, confirmationStatementOverdue: profile.confirmationStatementOverdue, gazetteNotices: [...row.gazetteNotices, ...gazette], hasInsolvencyHistory: profile.hasInsolvencyHistory, verified: true });
        updated = ctx.repos.recordCompanyPoll(ctx.db, row.companyNumber, { status: profile.status, accountsOverdue: profile.accountsOverdue, confirmationStatementOverdue: profile.confirmationStatementOverdue, gazetteNotices: gazette, riskLevel: risk.riskLevel, riskReasons: risk.riskReasons, polledAt: at });
        if (profile.companyName && profile.companyName !== row.name) ctx.repos.upsertCompanyWatch(ctx.db, { ...updated, name: profile.companyName });
        polled += 1;
      } catch (err) {
        ctx.logger.warn('watch: poll failed', { companyNumber: row.companyNumber, error: String(err) });
        skipped += 1;
        updated = ctx.repos.recordCompanyPoll(ctx.db, row.companyNumber, { riskReasons: [...new Set([...row.riskReasons, `Poll failed ${at.slice(0, 10)}: ${(err as Error).message}`])], polledAt: at });
      }
    }
    const materially = updated.status !== row.status || updated.riskLevel !== row.riskLevel || updated.accountsOverdue !== row.accountsOverdue || updated.gazetteNotices.length !== row.gazetteNotices.length;
    if (materially) changed.push(updated);
    ctx.repos.appendAudit(ctx.db, { actor, action: 'watch.poll', entity: 'company_watch', entityId: updated.companyNumber, before: { status: row.status, riskLevel: row.riskLevel }, after: { status: updated.status, riskLevel: updated.riskLevel, polled: Boolean(ch) }, at });
    if (updated.riskLevel === 'high') {
      for (const { claim, party } of claimsForCompany(ctx, updated.companyNumber)) {
        if (claim.flags.some((f) => f.code === 'SUPPLIER_HIGH_RISK' && !f.clearedAt && f.message.includes(updated.companyNumber))) continue;
        ctx.repos.addClaimFlag(ctx.db, claim.id, { code: 'SUPPLIER_HIGH_RISK', severity: 'warn', message: `${party.name} (company ${updated.companyNumber}, ${party.roles.join('/')}) is high risk: ${updated.riskReasons.join('; ') || updated.status}. Check invoices, payments and the supplier's capacity to perform before relying on it.`, raisedBy: 'system', raisedAt: at });
        ctx.repos.appendAudit(ctx.db, { actor, action: 'claim.flag.raise', entity: 'claims', entityId: claim.id, after: { code: 'SUPPLIER_HIGH_RISK', companyNumber: updated.companyNumber, partyId: party.id }, at });
        flagsRaised.push({ claimId: claim.id, reference: claim.reference, companyNumber: updated.companyNumber });
      }
    }
  }
  return { at, polled, skipped, changed, items: ctx.repos.listCompanyWatch(ctx.db), flagsRaised, note: ch ? undefined : 'COMPANIES_HOUSE_API_KEY is not set — nothing was called; rows are marked unverified.' };
}

export function registerWatchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/watch', async (request) => {
    const q = request.query as { riskLevel?: CompanyWatch['riskLevel'] };
    return { items: ctx.repos.listCompanyWatch(ctx.db, { riskLevel: q.riskLevel }), companiesHouse: ctx.config.keysPresent.companiesHouse ? 'live' : 'no key (unverified)' };
  });

  app.post('/watch', async (request, reply) => {
    const body = parse(watchBody, request.body);
    const existing = ctx.repos.getCompanyWatch(ctx.db, body.companyNumber);
    const now = ctx.now();
    const row = ctx.db.transaction((tx) => {
      const w = ctx.repos.upsertCompanyWatch(tx, { companyNumber: body.companyNumber, name: body.name ?? existing?.name ?? `Company ${ctx.repos.normaliseCompanyNumber(body.companyNumber)}`, role: body.role, riskLevel: body.riskLevel ?? existing?.riskLevel, riskReasons: body.riskReasons ?? existing?.riskReasons, status: existing?.status, lastPolledAt: existing?.lastPolledAt, gazetteNotices: existing?.gazetteNotices, officerChanges: existing?.officerChanges });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: existing ? 'watch.update' : 'watch.add', entity: 'company_watch', entityId: w.companyNumber, after: { name: w.name, role: w.role, riskLevel: w.riskLevel }, at: now });
      return w;
    });
    return reply.status(existing ? 200 : 201).send(row);
  });

  app.get('/watch/:number', async (request) => {
    const { number } = params<{ number: string }>(request);
    const row = ctx.repos.requireCompanyWatch(ctx.db, number);
    return { ...row, claims: claimsForCompany(ctx, row.companyNumber).map(({ claim, party }) => ({ claimId: claim.id, reference: claim.reference, status: claim.status, partyId: party.id, partyName: party.name })) };
  });

  app.delete('/watch/:number', async (request, reply) => {
    const { number } = params<{ number: string }>(request);
    const row = ctx.repos.requireCompanyWatch(ctx.db, number);
    ctx.db.transaction((tx) => {
      ctx.repos.removeCompanyWatch(tx, row.companyNumber);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'watch.remove', entity: 'company_watch', entityId: row.companyNumber, before: { name: row.name, riskLevel: row.riskLevel }, at: ctx.now() });
    });
    return reply.status(204).send();
  });

  app.post('/watch/poll', async (request) => pollWatchList(ctx, request.actor));
}
