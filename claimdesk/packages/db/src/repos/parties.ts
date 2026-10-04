import { and, eq, inArray, like, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Id, ISODateTime, Party, PartyRole } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError } from '../errors.js';
import { claims, parties, vehicles, type PartyRow } from '../schema.js';
import { bankKey, compact, denull, likeContains, newId, normaliseEmail, normalisePhone, normalisePostcode, normaliseRegistration, nowIso } from '../util.js';

export type CreatePartyInput = Omit<Party, 'id' | 'createdAt'> & { id?: Id; createdAt?: ISODateTime };
export type PartyPatch = Partial<Omit<Party, 'id' | 'createdAt'>>;

function toParty(row: PartyRow): Party {
  const { phoneNormalised: _p, emailNormalised: _e, postcodeNormalised: _pc, bankKey: _b, ...rest } = row;
  return denull(rest);
}

function matchKeys(p: { phone?: string; email?: string; address?: { postcode: string }; bank?: { sortCode: string; accountNumber: string } }) {
  return {
    phoneNormalised: normalisePhone(p.phone) ?? null,
    emailNormalised: normaliseEmail(p.email) ?? null,
    postcodeNormalised: normalisePostcode(p.address?.postcode) ?? null,
    bankKey: bankKey(p.bank) ?? null,
  };
}

export function createParty(db: Db, input: CreatePartyInput): Party {
  const id = input.id ?? newId();
  const createdAt = input.createdAt ?? nowIso();
  db.insert(parties)
    .values({ ...input, id, createdAt, ...matchKeys(input) })
    .run();
  return requireParty(db, id);
}

export function getParty(db: Db, id: Id): Party | undefined {
  const row = db.select().from(parties).where(eq(parties.id, id)).get();
  return row ? toParty(row) : undefined;
}

export function requireParty(db: Db, id: Id): Party {
  const p = getParty(db, id);
  if (!p) throw new NotFoundError('party', id);
  return p;
}

export function getParties(db: Db, ids: Id[]): Party[] {
  if (!ids.length) return [];
  const rows = db.select().from(parties).where(inArray(parties.id, ids)).all();
  const byId = new Map(rows.map((r) => [r.id, toParty(r)]));
  return ids.map((id) => byId.get(id)).filter((p): p is Party => Boolean(p));
}

export function updateParty(db: Db, id: Id, patch: PartyPatch): Party {
  const current = requireParty(db, id);
  const merged = { ...current, ...compact(patch) };
  db.update(parties)
    .set({ ...compact(patch), ...matchKeys(merged) })
    .where(eq(parties.id, id))
    .run();
  return requireParty(db, id);
}

export interface SearchPartiesOptions {
  roles?: PartyRole[];
  limit?: number;
}

/**
 * Search parties by name / trading name / email / phone / company number, or by a vehicle registration
 * (returns the claimant, driver and third parties on every claim involving that registration).
 */
export function searchParties(db: Db, query: string, options: SearchPartiesOptions = {}): Party[] {
  const q = query.trim();
  if (!q) return [];
  const limit = options.limit ?? 50;
  const pattern = likeContains(q);
  const phone = normalisePhone(q);
  const conds: SQL[] = [
    like(parties.name, pattern),
    like(parties.tradingName, pattern),
    like(parties.email, pattern),
    like(parties.companyNumber, pattern),
  ];
  if (phone && phone.length >= 6) conds.push(like(parties.phoneNormalised, `%${phone}%`));

  // registration route
  const reg = normaliseRegistration(q);
  const partyIdsViaReg = new Set<string>();
  if (reg.length >= 4) {
    const vehicleIds = db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(like(vehicles.registration, `%${reg}%`))
      .all()
      .map((v) => v.id);
    if (vehicleIds.length) {
      const claimRows = db
        .select({ claimantId: claims.claimantId, driverId: claims.driverId, thirdPartyIds: claims.thirdPartyIds })
        .from(claims)
        .where(or(inArray(claims.clientVehicleId, vehicleIds), inArray(claims.thirdPartyVehicleId, vehicleIds)))
        .all();
      for (const c of claimRows) {
        partyIdsViaReg.add(c.claimantId);
        if (c.driverId) partyIdsViaReg.add(c.driverId);
        for (const tp of c.thirdPartyIds) partyIdsViaReg.add(tp);
      }
    }
  }
  if (partyIdsViaReg.size) conds.push(inArray(parties.id, [...partyIdsViaReg]));

  let rows = db
    .select()
    .from(parties)
    .where(or(...conds))
    .orderBy(parties.name)
    .limit(limit)
    .all();
  if (options.roles?.length) {
    const wanted = new Set(options.roles);
    rows = rows.filter((r) => r.roles.some((role) => wanted.has(role)));
  }
  return rows.map(toParty);
}

export function listParties(db: Db, options: { roles?: PartyRole[]; kind?: Party['kind']; limit?: number; offset?: number } = {}): Party[] {
  const where: SQL[] = [];
  if (options.kind) where.push(eq(parties.kind, options.kind));
  let rows = db
    .select()
    .from(parties)
    .where(where.length ? and(...where) : undefined)
    .orderBy(parties.name)
    .limit(options.limit ?? 500)
    .offset(options.offset ?? 0)
    .all();
  if (options.roles?.length) {
    const wanted = new Set(options.roles);
    rows = rows.filter((r) => r.roles.some((role) => wanted.has(role)));
  }
  return rows.map(toParty);
}

export type ConnectionKey = 'phone' | 'email' | 'postcode' | 'bank' | 'name';

export interface ConnectionCandidate {
  party: Party;
  matchedOn: ConnectionKey[];
}

export interface FindConnectionsInput {
  /** The party being checked (its own row is excluded). */
  partyId?: Id;
  name?: string;
  phone?: string;
  email?: string;
  postcode?: string;
  bank?: { sortCode: string; accountNumber: string };
}

/**
 * Candidate connected parties by normalised phone / email / postcode / bank details (plus exact
 * case-insensitive name). This is the persistence half of BLUEPRINT §3.9: the domain `linkage` engine
 * scores the candidates (fuzzy names, witness independence). Pass a party id to seed from its stored details.
 */
export function findConnections(db: Db, input: FindConnectionsInput): ConnectionCandidate[] {
  let seed = input;
  if (input.partyId) {
    const p = requireParty(db, input.partyId);
    seed = {
      ...input,
      name: input.name ?? p.name,
      phone: input.phone ?? p.phone,
      email: input.email ?? p.email,
      postcode: input.postcode ?? p.address?.postcode,
      bank: input.bank ?? p.bank,
    };
  }
  const phone = normalisePhone(seed.phone);
  const email = normaliseEmail(seed.email);
  const postcode = normalisePostcode(seed.postcode);
  const bank = bankKey(seed.bank);
  const name = seed.name?.trim().toLowerCase();

  const conds: SQL[] = [];
  if (phone) conds.push(eq(parties.phoneNormalised, phone));
  if (email) conds.push(eq(parties.emailNormalised, email));
  if (postcode) conds.push(eq(parties.postcodeNormalised, postcode));
  if (bank) conds.push(eq(parties.bankKey, bank));
  if (name) conds.push(eq(sql`lower(trim(${parties.name}))`, name));
  if (!conds.length) return [];

  const where = input.partyId ? and(ne(parties.id, input.partyId), or(...conds)) : or(...conds);
  const rows = db.select().from(parties).where(where).all();
  return rows.map((r) => {
    const matchedOn: ConnectionKey[] = [];
    if (phone && r.phoneNormalised === phone) matchedOn.push('phone');
    if (email && r.emailNormalised === email) matchedOn.push('email');
    if (postcode && r.postcodeNormalised === postcode) matchedOn.push('postcode');
    if (bank && r.bankKey === bank) matchedOn.push('bank');
    if (name && r.name.trim().toLowerCase() === name) matchedOn.push('name');
    return { party: toParty(r), matchedOn };
  });
}
