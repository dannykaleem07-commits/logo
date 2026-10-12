// owned by claimai-server
/**
 * Sent by us or received? (docs/CLAIM-AI-INPUT.md §3.6). Deterministic, works with the AI paused; the owner can
 * override per file. Order: owner override → documents that are not correspondence (`none`) → email headers → a CCGUK
 * form (signed = returned to us) → letters / invoices scored on letterhead, sign-off, references, salutation and the
 * addressee block.
 */
import type { DocType } from '../agents/types.js';
import type { BundleFileRole } from '../intake/smart/types.js';
import type { ContactRole } from './types.js';

export interface Identity {
  companyNames: string[];
  ourEmails: string[];
  ourDomains: string[];
  ourPostcodes: string[];
  ourPhones: string[];
  /** CCG-\d{4}-\d{5} */
  ourRefPattern: RegExp;
}

export interface PartyHints {
  client: { names: string[]; emails: string[] };
  insurer: { names: string[]; emails: string[]; domains: string[]; postcodes?: string[] } | null;
  others: Array<{ role: ContactRole; names: string[]; emails: string[] }>;
}

export interface DirectionInput {
  docType: DocType | null;
  role: BundleFileRole;
  isPhoto: boolean;
  email: { from: string | null; to: string[]; cc: string[] } | null;
  /** First 40 lines. */
  head: string;
  /** Last 25 lines. */
  tail: string;
  formTemplateId: string | null;
  signed: boolean | null;
  override: 'out' | 'in' | 'none' | null;
}

export interface DirectionResult {
  direction: 'out' | 'in' | 'none' | 'unknown';
  confidence: number;
  why: string;
  counterparty: { role: ContactRole | null; name: string | null };
}

/** Documents that are not correspondence: filed, never recorded as sent or received. */
export const NOT_CORRESPONDENCE: ReadonlySet<string> = new Set([
  'v5c', 'driving_licence', 'insurance_certificate', 'damage_photo', 'vehicle_photo_other', 'police_report', 'mot_certificate', 'bank_statement',
  'payslip', 'proof_of_address', 'witness_statement', 'bodyshop_estimate', 'audatex_estimate', 'engineer_report', 'fnol_form',
]);

const NONE_PARTY = { role: null, name: null } as const;

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9@.\s-]/g, ' ')
    .replace(/\b(the|ltd|limited|plc|llp|uk|insurance|insurers|company|co)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function nameIn(text: string, names: string[]): string | null {
  const t = ` ${norm(text)} `;
  for (const n of names) {
    const k = norm(n);
    if (k.length >= 3 && t.includes(` ${k} `)) return n;
  }
  return null;
}

const domainOf = (addr: string): string => (addr.toLowerCase().split('@')[1] ?? '').trim();
const addrOf = (s: string): string => {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1]! : s).trim().toLowerCase();
};

function isOurs(addr: string, id: Identity): boolean {
  const a = addrOf(addr);
  if (!a.includes('@')) return false;
  if (id.ourEmails.some((e) => e.toLowerCase() === a)) return true;
  const d = domainOf(a);
  return id.ourDomains.some((x) => x.toLowerCase() === d);
}

function partyOfAddress(addr: string | null, p: PartyHints): { role: ContactRole | null; name: string | null } {
  if (!addr) return { ...NONE_PARTY };
  const a = addrOf(addr);
  const display = addr.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || a;
  if (p.client.emails.some((e) => e.toLowerCase() === a)) return { role: 'client', name: p.client.names[0] ?? display };
  if (p.insurer && (p.insurer.emails.some((e) => e.toLowerCase() === a) || p.insurer.domains.some((d) => d.toLowerCase() === domainOf(a)))) return { role: 'at_fault_insurer', name: p.insurer.names[0] ?? display };
  for (const o of p.others) if (o.emails.some((e) => e.toLowerCase() === a)) return { role: o.role, name: o.names[0] ?? display };
  return { role: null, name: display };
}

const lines = (s: string): string[] => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** All party names with their role, the insurer first. */
function partyNames(p: PartyHints): Array<{ role: ContactRole; names: string[] }> {
  return [...(p.insurer ? [{ role: 'at_fault_insurer' as ContactRole, names: p.insurer.names }] : []), ...p.others.map((o) => ({ role: o.role, names: o.names }))];
}

export function directionOf(i: DirectionInput, id: Identity, p: PartyHints): DirectionResult {
  if (i.override) {
    return { direction: i.override, confidence: 1, why: 'Set by you', counterparty: { ...NONE_PARTY } };
  }
  if (i.isPhoto || (i.docType && NOT_CORRESPONDENCE.has(i.docType))) {
    return { direction: 'none', confidence: 0.95, why: 'A document for the file (not a letter or email)', counterparty: { ...NONE_PARTY } };
  }
  if (i.email || i.role === 'email') {
    const from = i.email?.from ?? null;
    const to = [...(i.email?.to ?? []), ...(i.email?.cc ?? [])];
    if (from && isOurs(from, id)) {
      const first = i.email?.to[0] ?? null;
      return { direction: 'out', confidence: 0.98, why: `Sent from our mailbox (${addrOf(from)})`, counterparty: partyOfAddress(first, p) };
    }
    if (to.some((a) => isOurs(a, id))) {
      return { direction: 'in', confidence: 0.98, why: `Sent to our mailbox${from ? ` by ${addrOf(from)}` : ''}`, counterparty: partyOfAddress(from, p) };
    }
    return { direction: 'unknown', confidence: 0.3, why: `From ${from ? addrOf(from) : 'an unknown sender'} to ${to.length ? to.map(addrOf).join(', ') : 'nobody listed'} — neither is our mailbox`, counterparty: partyOfAddress(from, p) };
  }
  if (i.formTemplateId) {
    if (i.signed) return { direction: 'in', confidence: 0.85, why: 'Our form, returned signed', counterparty: { role: 'client', name: p.client.names[0] ?? null } };
    return { direction: 'out', confidence: 0.7, why: 'Our form, not signed yet (sent out)', counterparty: { role: 'client', name: p.client.names[0] ?? null } };
  }

  // Letters, invoices and other correspondence: score both ways.
  const head = lines(i.head);
  const tail = lines(i.tail);
  const letterhead = head.slice(0, 3).join('\n');
  const dearIdx = head.findIndex((l) => /^dear\b/i.test(l));
  const addressee = head.slice(3, dearIdx > 3 ? dearIdx : Math.min(head.length, 12)).join('\n');
  const signIdx = tail.findIndex((l) => /\b(yours sincerely|yours faithfully|kind regards|best regards|regards)\b/i.test(l));
  const signOff = signIdx >= 0 ? tail.slice(signIdx, signIdx + 7).join('\n') : '';
  const all = `${i.head}\n${i.tail}`;
  const refRe = id.ourRefPattern.source;
  let out = 0;
  let inn = 0;
  const whyOut: string[] = [];
  const whyIn: string[] = [];
  let counterparty: { role: ContactRole | null; name: string | null } = { ...NONE_PARTY };

  if (nameIn(letterhead, id.companyNames)) {
    out += 3;
    whyOut.push('our letterhead');
  }
  if (signOff && nameIn(signOff, id.companyNames)) {
    out += 4;
    whyOut.push('signed off by us');
  }
  if (new RegExp(`our\\s+ref(?:erence)?\\.?\\s*:?\\s*(?:${refRe})`, 'i').test(all)) {
    out += 3;
    whyOut.push('"Our ref" is our claim reference');
  }
  if (new RegExp(`your\\s+ref(?:erence)?\\.?\\s*:?\\s*(?:${refRe})`, 'i').test(all)) {
    inn += 3;
    whyIn.push('"Your ref" is our claim reference');
  }
  if (/\bdear\s+(?:courtesy cars|ccguk|claims team)\b/i.test(all)) {
    inn += 3;
    whyIn.push('addressed to us');
  }
  for (const party of partyNames(p)) {
    const inHead = nameIn(letterhead, party.names);
    if (inHead) {
      inn += 3;
      whyIn.push(`${inHead}'s letterhead`);
      counterparty = { role: party.role, name: inHead };
    }
    const inSign = signOff ? nameIn(signOff, party.names) : null;
    if (inSign) {
      inn += 4;
      whyIn.push(`signed off by ${inSign}`);
      counterparty = { role: party.role, name: inSign };
    }
  }
  const pcs = (s: string) => (s.toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g) ?? []).map((x) => x.replace(/\s+/g, ''));
  const addrPcs = pcs(addressee);
  if (addrPcs.some((x) => id.ourPostcodes.map((y) => y.toUpperCase().replace(/\s+/g, '')).includes(x))) {
    inn += 2;
    whyIn.push('addressed to our postcode');
  }
  const insurerPcs = (p.insurer?.postcodes ?? []).map((y) => y.toUpperCase().replace(/\s+/g, ''));
  if (addrPcs.some((x) => insurerPcs.includes(x))) {
    out += 2;
    whyOut.push("addressed to the insurer's postcode");
    counterparty = { role: 'at_fault_insurer', name: p.insurer?.names[0] ?? null };
  }
  const toInsurer = p.insurer ? nameIn(addressee, p.insurer.names) : null;
  if (toInsurer && !nameIn(letterhead, p.insurer!.names)) {
    out += 2;
    whyOut.push(`addressed to ${toInsurer}`);
    counterparty = { role: 'at_fault_insurer', name: toInsurer };
  }
  const toClient = nameIn(addressee, p.client.names);
  if (toClient) {
    out += 2;
    whyOut.push(`addressed to ${toClient}`);
    if (!counterparty.role) counterparty = { role: 'client', name: toClient };
  }
  if (i.docType === 'invoice' && nameIn(head.slice(0, 8).join('\n'), id.companyNames)) {
    out += 4;
    whyOut.push('our invoice');
  }
  const diff = out - inn;
  if (diff >= 3) {
    if (counterparty.role === null && p.insurer && /insur/i.test(addressee)) counterparty = { role: 'at_fault_insurer', name: p.insurer.names[0] ?? null };
    return { direction: 'out', confidence: Math.min(0.95, 0.6 + 0.07 * diff), why: `Sent by us: ${whyOut.join(', ')}`, counterparty };
  }
  if (diff <= -3) return { direction: 'in', confidence: Math.min(0.95, 0.6 + 0.07 * -diff), why: `Received: ${whyIn.join(', ')}`, counterparty };
  return { direction: 'unknown', confidence: 0.3, why: 'Could not tell who wrote it — pick one', counterparty };
}
