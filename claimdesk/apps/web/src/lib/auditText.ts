/**
 * Plain English for recorded changes (hire corrections, audit rows): pence as £, instants as London dates, enum codes
 * as labels, rule keys as field names. Pure; shared by the hire card and the audit trails (0.3 §5 simplify).
 */
import { formatGBP } from '@ccguk/domain';

/** What ended a hire, by its stored code. */
export const HIRE_END_TRIGGER_LABEL: Readonly<Record<string, string>> = {
  repair_complete_24h: 'Repair completed — off-hire within 24 hours',
  tl_payment_5wd: 'Total-loss payment received — off-hire within 5 working days',
  insurer_termination_1wd: 'Insurer termination notice — off-hire within 1 working day',
  cash_in_lieu: 'Cash in lieu received — hire stops on receipt',
  client_returned: 'Client returned the vehicle',
  replacement_purchased: 'Client bought a replacement vehicle',
  manual: 'Other (give the reason)',
};

const ENUM_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  endTrigger: HIRE_END_TRIGGER_LABEL,
  use: { credit_hire: 'credit hire', self_drive: 'self drive' },
  kind: { claimed: 'claimed', invoiced: 'invoiced', paid: 'paid', reduced: 'reduced', written_off: 'written off', pcn_council: 'council PCN', pcn_private: 'private parking charge', nip: 'notice of intended prosecution' },
  head: { hire: 'hire', storage: 'storage', recovery: 'recovery', engineer_fee: "engineer's fee" },
};

const WORDS: Readonly<Record<string, string>> = { gta: 'GTA', vat: 'VAT', pcn: 'PCN', fnol: 'intake', reg: 'registration', dob: 'date of birth', mot: 'MOT', v5c: 'V5C' };

/** "dailyRatePence" → "daily rate"; "endAt" → "end"; "gtaGroup" → "GTA group". */
export function humaniseKey(key: string): string {
  const base = key.replace(/Pence$/, '').replace(/(?<=.)At$/, '').replace(/Id$/, '');
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((w) => WORDS[w] ?? w);
  return words.join(' ') || key;
}

const CHANGE_LABEL: Readonly<Record<string, string>> = {
  startAt: 'start',
  endAt: 'end',
  endTrigger: 'what ended it',
  dailyRatePence: 'daily rate',
  gtaGroup: 'car we give group',
  clientGtaGroup: "client's car group",
  days: 'days',
  netPence: 'net',
};

/** One recorded value as people read it. */
export function correctionValueText(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return key === 'endAt' ? 'running' : '—';
  if (typeof v === 'number' && /Pence$/.test(key)) return formatGBP(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' && /At$/.test(key) && !Number.isNaN(Date.parse(v))) {
    return new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  }
  if (typeof v === 'string' && ENUM_LABELS[key]?.[v]) return ENUM_LABELS[key][v]!;
  if (typeof v === 'string' && /^[a-z]+(?:_[a-z0-9]+)+$/.test(v)) return v.replace(/_/g, ' ');
  return String(v);
}

const HIDDEN_CHANGE_KEYS = new Set(['reason', 'claimId', 'ledger', 'ledgerEntryId']);

/** "start 1 Sep 2026, 10:00 → 3 Sep 2026, 10:00; days 12 → 10". */
export function correctionChangesText(changes: Record<string, { from: unknown; to: unknown }>): string {
  return Object.entries(changes)
    .filter(([k]) => !HIDDEN_CHANGE_KEYS.has(k))
    .map(([k, c]) => `${CHANGE_LABEL[k] ?? humaniseKey(k)} ${correctionValueText(k, c.from)} → ${correctionValueText(k, c.to)}`)
    .join('; ');
}

function record(o: unknown): Record<string, unknown> {
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
}

/** The from → to of an audit row's before/after (keys in either), e.g. for `hire.correct`. */
export function beforeAfterText(before: unknown, after: unknown): string {
  const b = record(before);
  const a = record(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !HIDDEN_CHANGE_KEYS.has(k) && (k in b || k in a));
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    const from = b[k];
    const to = a[k];
    if (typeof from === 'object' && from !== null) continue;
    if (typeof to === 'object' && to !== null) continue;
    if (from === to) continue;
    changes[k] = { from, to };
  }
  return correctionChangesText(changes);
}

/** Scalars of an audit row's `after`, readable ("use: credit hire · late entry: yes · end: 2 Oct 2026, 09:00"); ids hidden. */
export function fieldsText(after: unknown, max = 4): string {
  return Object.entries(record(after))
    .filter(([k, v]) => !/id$/i.test(k) && !/Ids?$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && String(v).trim() !== '')
    .slice(0, max)
    .map(([k, v]) => `${CHANGE_LABEL[k] ?? humaniseKey(k)}: ${correctionValueText(k, v)}`)
    .join(' · ');
}

const RULE_LABELS: Readonly<Record<string, string>> = {
  disclosure: 'call-recording disclosure',
  'claimant.contact': "client's phone or email",
  'claimant.name': "client's name",
  'claimant.email': "client's email",
  'driver.name': "driver's name",
  'driver.contact': "driver's phone",
  'vehicle.lookup': 'registration search',
  'vehicle.fleet': 'fleet car as the client car',
  'accident.takenCold': 'account taken cold',
  'accident.roadworthyAfter': 'roadworthy after the accident',
  'accident.airbagsDeployed': 'airbags deployed',
  'thirdParty.registration': 'third-party registration',
  'offer.offered': '"has anyone offered you a vehicle?"',
  fleetUnitId: 'fleet car',
  endBeforeStart: 'end before start',
  registrationFormat: 'registration format',
};

/** A web rule key ("fnol.claimant.contact", "editHire.endAt", "fleet.gtaGroup") as a field name. */
export function ruleKeyLabel(ruleKey: string): string {
  const rest = ruleKey.includes('.') ? ruleKey.slice(ruleKey.indexOf('.') + 1) : ruleKey;
  return RULE_LABELS[rest] ?? humaniseKey(rest);
}
