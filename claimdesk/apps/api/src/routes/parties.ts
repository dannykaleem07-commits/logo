import type { FastifyInstance } from 'fastify';
import { findConnections, witnessIndependence, type LinkableParty, type Party } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { parse } from '../schemas/common.js';
import { connectionsQuery, partyInput, partyListQuery, partyPatch } from '../schemas/parties.js';
import { params } from './helpers.js';

const SUPPLIER_ROLES = new Set<Party['roles'][number]>(['supplier', 'repairer', 'recovery_agent', 'storage_yard', 'engineer', 'salvage_buyer', 'solicitor']);

/** Attach the registrations a party is associated with (claimant/driver/third party on claims). */
function withRegistrations(ctx: AppContext, party: Party): LinkableParty {
  const regs = new Set<string>();
  for (const c of ctx.repos.listClaims(ctx.db, { claimantId: party.id, limit: 1000 })) {
    const v = ctx.repos.getVehicle(ctx.db, c.clientVehicleId);
    if (v) regs.add(v.registration);
  }
  return regs.size ? { ...party, registrations: [...regs] } : party;
}

export function registerPartiesRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/parties', async (request) => {
    const q = parse(partyListQuery, request.query);
    const roles = q.role ? [q.role] : undefined;
    const items = q.q?.trim() ? ctx.repos.searchParties(ctx.db, q.q, { roles, limit: q.limit }) : ctx.repos.listParties(ctx.db, { roles, kind: q.kind, limit: q.limit, offset: q.offset });
    return { items, total: items.length };
  });

  app.post('/parties', async (request, reply) => {
    const body = parse(partyInput, request.body);
    const party = ctx.db.transaction((tx) => {
      const p = ctx.repos.createParty(tx, { ...body, createdAt: ctx.now() });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'party.create', entity: 'parties', entityId: p.id, after: { name: p.name, roles: p.roles }, at: ctx.now() });
      return p;
    });
    const candidates = ctx.repos.findConnections(ctx.db, { partyId: party.id });
    return reply.status(201).send({ ...party, connectionCandidates: candidates.map((c) => ({ partyId: c.party.id, name: c.party.name, matchedOn: c.matchedOn })) });
  });

  app.get('/parties/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return ctx.repos.requireParty(ctx.db, id);
  });

  app.patch('/parties/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(partyPatch, request.body);
    return ctx.db.transaction((tx) => {
      const before = ctx.repos.requireParty(tx, id);
      const after = ctx.repos.updateParty(tx, id, body);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'party.patch', entity: 'parties', entityId: id, before: { name: before.name, phone: before.phone, email: before.email }, after: body, at: ctx.now() });
      return after;
    });
  });

  /** Connected-party check (lesson g): subject vs staff (users), suppliers and previous clients, plus witness independence. */
  app.get('/parties/:id/connections', async (request) => {
    const { id } = params<{ id: string }>(request);
    const q = parse(connectionsQuery, request.query);
    const subject = withRegistrations(ctx, ctx.repos.requireParty(ctx.db, id));
    const staff: LinkableParty[] = ctx.repos.listUsers(ctx.db).map((u) => ({ id: `user:${u.id}`, kind: 'individual', name: u.name, email: u.email, roles: ['other'], createdAt: u.createdAt }));
    const all = ctx.repos.listParties(ctx.db, { limit: 100_000 }).filter((p) => p.id !== subject.id);
    const suppliers = all.filter((p) => p.roles.some((r) => SUPPLIER_ROLES.has(r)));
    const previousClients = all.filter((p) => p.roles.includes('claimant')).map((p) => withRegistrations(ctx, p));
    const witnesses = all.filter((p) => p.roles.includes('witness'));
    const connections = findConnections([subject], { staff, suppliers, previousClients, witnesses });

    // Witness independence against the claimant of the claim(s) this party sits on.
    let independence: Array<{ claimId: string; claimantId: string } & ReturnType<typeof witnessIndependence>> | undefined;
    if (subject.roles.includes('witness')) {
      const claims = q.claimId ? [ctx.repos.requireClaim(ctx.db, q.claimId)] : ctx.repos.listClaims(ctx.db, { limit: 100_000 }).filter((c) => c.thirdPartyIds.includes(subject.id) || c.driverId === subject.id);
      independence = claims.map((c) => {
        const claimant = withRegistrations(ctx, ctx.repos.requireParty(ctx.db, c.claimantId));
        const others = [claimant, ...ctx.repos.getParties(ctx.db, [c.driverId, ...c.thirdPartyIds].filter((x): x is string => Boolean(x) && x !== subject.id))];
        const local = findConnections([subject, ...others], { staff, suppliers, previousClients: previousClients.filter((p) => p.id !== c.claimantId) });
        return { claimId: c.id, claimantId: c.claimantId, ...witnessIndependence(subject, claimant, local) };
      });
    }
    const dbCandidates = ctx.repos.findConnections(ctx.db, { partyId: id }).map((c) => ({ partyId: c.party.id, name: c.party.name, matchedOn: c.matchedOn }));
    return { partyId: id, connections, candidates: dbCandidates, witnessIndependence: independence };
  });
}
