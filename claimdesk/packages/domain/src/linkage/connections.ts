/**
 * Connected-party checker (live-file lesson g, BLUEPRINT §3.9).
 * Matches the parties on a claim against the staff, relatives, suppliers, previous-client and witness registers
 * on phone, email, address, bank details, name and vehicle registration.
 */
import type { Id, Party } from '../types.js';
import { normaliseRegistration } from '../vehicle/registration.js';
import { nameSimilarity, normaliseAddressKey, normaliseBankKey, normaliseEmail, normalisePhone, round2 } from './normalise.js';

export type ConnectionField = 'phone' | 'email' | 'address' | 'bank' | 'name' | 'vehicle';
export type RegisterName = 'subject' | 'staff' | 'relatives' | 'suppliers' | 'previousClients' | 'witnesses';

/** A Party optionally annotated with the registrations it is associated with (keeper, driver, hirer). */
export interface LinkableParty extends Party {
  registrations?: string[];
}

export interface Connection {
  aId: Id;
  bId: Id;
  aRegister: RegisterName;
  bRegister: RegisterName;
  field: ConnectionField;
  /** 0..1 */
  confidence: number;
  detail: string;
}

export interface LinkageRegisters {
  staff: LinkableParty[];
  relatives?: LinkableParty[];
  suppliers: LinkableParty[];
  previousClients: LinkableParty[];
  witnesses?: LinkableParty[];
}

export interface FindConnectionsOptions {
  /** Minimum combined name score to report a name connection (default 0.75). */
  nameThreshold?: number;
  /** Also compare subjects with one another (default true) — catches a witness sharing the claimant's phone. */
  compareSubjects?: boolean;
}

export const FIELD_CONFIDENCE: Record<Exclude<ConnectionField, 'name'>, number> = {
  bank: 0.95,
  phone: 0.9,
  email: 0.9,
  vehicle: 0.8,
  address: 0.7
};

function phones(p: LinkableParty): string[] {
  const out = new Set<string>();
  const n = normalisePhone(p.phone);
  if (n) out.add(n);
  return [...out];
}

/** Compare two parties field by field and return the connections found. */
export function compareParties(a: LinkableParty, aRegister: RegisterName, b: LinkableParty, bRegister: RegisterName, nameThreshold = 0.75): Connection[] {
  if (a.id === b.id) return [];
  const out: Connection[] = [];
  const push = (field: ConnectionField, confidence: number, detail: string) => out.push({ aId: a.id, bId: b.id, aRegister, bRegister, field, confidence: round2(confidence), detail });

  const pa = phones(a);
  const pb = new Set(phones(b));
  for (const ph of pa) if (pb.has(ph)) push('phone', FIELD_CONFIDENCE.phone, `Same phone number ${ph}`);

  const ea = normaliseEmail(a.email);
  const eb = normaliseEmail(b.email);
  if (ea && eb && ea === eb) push('email', FIELD_CONFIDENCE.email, `Same email address ${ea}`);

  const aa = normaliseAddressKey(a.address);
  const ab = normaliseAddressKey(b.address);
  if (aa && ab && aa === ab) push('address', FIELD_CONFIDENCE.address, `Same address (${a.address?.line1 ?? ''}, ${a.address?.postcode ?? ''})`.replace(/\(,\s*/, '('));

  const ba = normaliseBankKey(a.bank);
  const bb = normaliseBankKey(b.bank);
  if (ba && bb && ba === bb) push('bank', FIELD_CONFIDENCE.bank, `Same bank account (sort code ${a.bank?.sortCode ?? ''}, account ending ${(a.bank?.accountNumber ?? '').slice(-4)})`);

  const ra = new Set((a.registrations ?? []).map(normaliseRegistration).filter(Boolean));
  for (const r of (b.registrations ?? []).map(normaliseRegistration)) {
    if (r && ra.has(r)) push('vehicle', FIELD_CONFIDENCE.vehicle, `Both associated with vehicle ${r}`);
  }

  // Names: legal name and trading name on both sides.
  const aNames = [a.name, a.tradingName].filter((n): n is string => !!n);
  const bNames = [b.name, b.tradingName].filter((n): n is string => !!n);
  let best: { score: number; an: string; bn: string; jaccard: number; jw: number } | undefined;
  for (const an of aNames) {
    for (const bn of bNames) {
      const s = nameSimilarity(an, bn);
      if (!best || s.score > best.score) best = { score: s.score, an, bn, jaccard: s.jaccard, jw: s.jaroWinkler };
    }
  }
  if (best && best.score >= nameThreshold) {
    const conf = Math.min(0.9, best.score);
    push('name', conf, best.score >= 1 ? `Same name "${best.an}"` : `Similar names "${best.an}" / "${best.bn}" (token overlap ${round2(best.jaccard)}, Jaro-Winkler ${round2(best.jw)})`);
  }

  return out;
}

/**
 * Every connection between the claim's subjects and the registers, plus (by default) between the subjects themselves.
 * Results are de-duplicated per (pair, field).
 */
export function findConnections(subjects: LinkableParty[], registers: LinkageRegisters, opts: FindConnectionsOptions = {}): Connection[] {
  const nameThreshold = opts.nameThreshold ?? 0.75;
  const compareSubjects = opts.compareSubjects ?? true;
  const out: Connection[] = [];
  const seen = new Set<string>();
  const add = (cs: Connection[]) => {
    for (const c of cs) {
      const key = [c.aId, c.bId].sort().join('|') + '|' + c.field;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  };

  const registerList: Array<[RegisterName, LinkableParty[] | undefined]> = [
    ['staff', registers.staff],
    ['relatives', registers.relatives],
    ['suppliers', registers.suppliers],
    ['previousClients', registers.previousClients],
    ['witnesses', registers.witnesses]
  ];

  for (const s of subjects) {
    for (const [name, list] of registerList) {
      for (const other of list ?? []) add(compareParties(s, 'subject', other, name, nameThreshold));
    }
  }

  if (compareSubjects) {
    for (let i = 0; i < subjects.length; i++) {
      for (let j = i + 1; j < subjects.length; j++) add(compareParties(subjects[i]!, 'subject', subjects[j]!, 'subject', nameThreshold));
    }
  }

  return out.sort((x, y) => y.confidence - x.confidence);
}
