/**
 * Deterministic field reading (docs/SMART-INTAKE.md §4.3): labelled values ("Registration: KX21 ABC") and bare
 * patterns (plates, VINs, DVLA licence numbers, postcodes, phones, emails, CCG references, police references) read from
 * the page text without the AI. Same `ExtractedField` shape as the AI; `quote` is the matched line; confidence 0.6 for
 * a bare pattern, 0.8 for a label with a valid value, never above 0.85. Bank details are read only as target-less
 * fields (never applied; used for a signal).
 *
 * Roles: on a V5C, licence, insurance certificate, MOT, estimate or report the person and car are the client's; on a
 * form, a section heading ("Other driver", "Your vehicle") or a prefix on the label ("Other driver's name") decides;
 * on an insurer letter from the other side "your client" is our client and "our policyholder / our insured" is the
 * third party. Values whose role cannot be told get an `(unassigned)` name and no target (used only for grouping keys).
 */
import type { ExtractedField } from '../../agents/results.js';
import type { DocType, FieldRole, FieldTarget } from '../../agents/types.js';
import type { BundleFieldKey } from './types.js';
import { DVLA_LICENCE_RE } from './classify.js';
import { DATE_PATTERN, EMAIL_SCAN_RE, findDateTime, isPlate, normPhone, normPostcode, parseLooseDate, parseLooseTime, PHONE_SCAN_RE, POSTCODE_SCAN_RE, TIME_PATTERN, VRM_SCAN_RE, displayPlate, displayPostcode } from './text.js';

/**
 * Names of target-less readings, shared with the AI prompt. A name that maps to a bundle key becomes a candidate for it
 * (`candidates.ts`); `witnesses` is the witness list; `null` = a fact used only by code (signals, grouping, timeline).
 */
export const RULE_FIELD_NAMES: Readonly<Record<string, BundleFieldKey | 'witnesses' | null>> = {
  'Police reference': 'accident.policeReference',
  'Police attended': 'accident.policeAttended',
  'Accident postcode': 'accident.postcode',
  'Vehicle driveable': 'accident.driveable',
  'Hire needed': 'hire.needed',
  'Insurer name': 'tp.insurerName',
  'Client insurer name': 'clientInsurer.name',
  'Repairer name': 'repairer.name',
  'Repairer phone': 'repairer.phone',
  'Engineer name': 'engineer.name',
  'Engineer reference': 'engineer.reference',
  Witnesses: 'witnesses',
  'ClaimDesk reference': null,
  'Sort code': null,
  'Account number': null,
  'Keeper since': null,
  'Valid from': null,
  'Valid until': null,
  'Licence valid until': null,
  'MOT expiry': null,
  'Inspection date': null,
  'Liability statement': null,
  'Offer made': null,
  'Registration (unassigned)': null,
  'VIN (unassigned)': null,
  'Licence number (unassigned)': null,
  'Phone (unassigned)': null,
  'Email (unassigned)': null,
  'Name (unassigned)': null,
};
export const RULE_FIELD_NAME_LIST: readonly string[] = Object.keys(RULE_FIELD_NAMES);

export interface RuleExtractOptions {
  insurerNames: string[];
}

const CONF_LABEL = 0.8;
const CONF_BARE = 0.6;
const MAX_CONF = 0.85;

type Role = FieldRole | null;

/** Docs whose person and car are the client's unless a section says otherwise. */
const CLIENT_DOCS: ReadonlySet<DocType> = new Set<DocType>([
  'v5c', 'driving_licence', 'insurance_certificate', 'mot_certificate', 'proof_of_address', 'bodyshop_estimate', 'audatex_estimate', 'engineer_report',
  'signed_ccguk_form', 'fnol_form', 'bank_statement', 'payslip', 'damage_photo', 'vehicle_photo_other',
]);
const LETTER_DOCS: ReadonlySet<DocType> = new Set<DocType>(['insurer_letter', 'correspondence']);

const THIRD_HEAD = /^\s*(?:third[- ]party|other (?:driver|vehicle|party|side|car)|vehicle\s*(?:2|b|two)\b|their (?:details|vehicle)|our (?:policyholder|insured)(?:'s)? (?:details|vehicle)|at[- ]fault (?:driver|party|vehicle))/i;
const CLIENT_HEAD = /^\s*(?:your (?:details|vehicle|car)|client(?:'s)? (?:details|vehicle)|vehicle\s*(?:1|a|one)\b|policyholder details|claimant(?:'s)? details|insured details|registered keeper|driver details)/i;
const WITNESS_HEAD = /^\s*witness(?:es)? (?:details|information)\s*:?\s*$/i;
const ACCIDENT_HEAD = /^\s*(?:accident|incident|collision) (?:details|information)\s*:?\s*$/i;

const WHO_RE = String.raw`(?:(your|client'?s?|claimant'?s?|policyholder'?s?|keeper'?s?|other driver'?s?|other party'?s?|other vehicle'?s?|third[- ]party'?s?|tp|their|driver'?s?)\s+)?`;

function whoRole(who: string | undefined): Role | undefined {
  if (!who) return undefined;
  const w = who.toLowerCase();
  if (/^(your|client|claimant|keeper)/.test(w)) return 'client';
  if (/^(other|third|tp|their)/.test(w)) return 'third_party';
  if (/^driver/.test(w)) return 'driver';
  if (/^policyholder/.test(w)) return 'client';
  return undefined;
}

function lineRole(line: string, docType: DocType): Role | undefined {
  if (/\byour client\b/i.test(line)) return 'client';
  if (LETTER_DOCS.has(docType) && /\bour (?:policyholder|insured|client)\b/i.test(line)) return 'third_party';
  if (/\b(?:third party|other driver|other vehicle|other party)\b/i.test(line)) return 'third_party';
  return undefined;
}

interface Ctx {
  docType: DocType;
  page: number;
  lines: string[];
  index: number;
  section: Role | 'witness' | 'accident' | undefined;
  out: ExtractedField[];
}

function defaultRole(c: Ctx): Role {
  if (c.section === 'client' || c.section === 'third_party' || c.section === 'driver') return c.section;
  return CLIENT_DOCS.has(c.docType) ? 'client' : null;
}

function push(c: Ctx, name: string, target: FieldTarget | null, value: string | null, confidence: number, quote?: string): void {
  if (value === null || value === undefined) return;
  const v = value.replace(/\s+/g, ' ').trim();
  if (!v) return;
  c.out.push({ name, target, value: v, confidence: Math.min(MAX_CONF, confidence), page: c.page, quote: (quote ?? c.lines[c.index] ?? '').trim().slice(0, 400) || null });
}

/** Rest of the line after the label, or the next non-empty line when the label ends the line. */
function valueAfter(c: Ctx, rest: string): string {
  const r = rest.replace(/^\s*[:\-–]\s*/, '').trim();
  if (r) return r;
  for (let j = c.index + 1; j < Math.min(c.lines.length, c.index + 3); j += 1) {
    const n = c.lines[j]!.trim();
    if (n) return n;
  }
  return '';
}

/** A labelled multi-line value: the rest of the line plus following lines until a blank line or another "Label:". */
function blockAfter(c: Ctx, rest: string, maxLines = 20): string {
  const parts = [rest.replace(/^\s*[:\-–]\s*/, '').trim()].filter(Boolean);
  for (let j = c.index + 1; j < Math.min(c.lines.length, c.index + 1 + maxLines); j += 1) {
    const n = c.lines[j]!.trim();
    if (!n) {
      if (parts.length) break;
      continue;
    }
    if (/^[A-Z][A-Za-z'’ ()/]{1,40}:\s*/.test(n) && !/^(?:I|We|The|He|She|They)\b/.test(n)) break;
    parts.push(n);
  }
  return parts.join(' ').slice(0, 4000);
}

/** Address text from the label onwards: up to 4 lines, stopping after the line with a postcode. */
function addressAfter(c: Ctx, rest: string): string {
  const parts: string[] = [];
  const first = rest.replace(/^\s*[:\-–]\s*/, '').trim();
  if (first) parts.push(first);
  if (first && new RegExp(POSTCODE_SCAN_RE.source, 'i').test(first)) return parts.join(', ');
  for (let j = c.index + 1; j < Math.min(c.lines.length, c.index + 5); j += 1) {
    const n = c.lines[j]!.trim();
    if (!n) {
      if (parts.length) break;
      continue;
    }
    if (/^[A-Z][A-Za-z'’ ]{1,30}:/.test(n)) break;
    parts.push(n);
    if (new RegExp(POSTCODE_SCAN_RE.source, 'i').test(n)) break;
  }
  return parts.join(', ');
}

const yesNo = (v: string): 'yes' | 'no' | null => {
  const t = v.trim().toLowerCase();
  if (/^(yes|y|true|ticked|x)\b/.test(t)) return 'yes';
  if (/^(no|n|false|none|nil|not)\b/.test(t)) return 'no';
  return null;
};

const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, p: string, ch: string) => p + ch.toUpperCase());

function vrmIn(text: string): string | null {
  const re = new RegExp(VRM_SCAN_RE.source, 'g');
  for (const m of text.toUpperCase().matchAll(re)) if (isPlate(m[0])) return displayPlate(m[0]);
  // dateless plates are accepted after a label only, and only as the whole value
  const d = /^\s*([A-Z]{1,3}\s?\d{1,4}|\d{1,4}\s?[A-Z]{1,3})\s*$/.exec(text.toUpperCase());
  if (d && isPlate(d[1]!)) return displayPlate(d[1]!);
  return null;
}

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const isVinLike = (v: string): boolean => /^[A-HJ-NPR-Z0-9]{17}$/.test(v) && /\d/.test(v) && /[A-Z]/.test(v);

interface LabelRule {
  re: RegExp;
  run(c: Ctx, m: RegExpExecArray, role: Role): void;
}

const roleTarget = <F extends string>(role: Role, kind: 'party' | 'vehicle', field: F): FieldTarget | null => (role ? (`${kind}:${role}.${field}` as FieldTarget) : null);

const LABELS: LabelRule[] = [
  // UK photocard licence fields: 1. surname, 2. forenames, 3. DOB, 4b. expiry, 5. licence number, 8. address
  {
    re: /^\s*1\.\s*([A-Z][A-Z' -]{1,40})\s*$/,
    run(c, m) {
      if (c.docType !== 'driving_licence') return;
      const next = c.lines[c.index + 1]?.match(/^\s*2\.\s*(.+)$/);
      if (next) push(c, 'Name', 'party:client.name', titleCase(`${next[1]!.trim()} ${m[1]!.trim()}`), CONF_LABEL, `${c.lines[c.index]!.trim()} ${c.lines[c.index + 1]!.trim()}`);
    },
  },
  {
    re: new RegExp(`^\\s*3\\.\\s*(${DATE_PATTERN})`, 'i'),
    run(c, m) {
      if (c.docType !== 'driving_licence') return;
      push(c, 'Date of birth', 'party:client.dateOfBirth', parseLooseDate(m[1]!) ?? null, CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*4b\\.\\s*(${DATE_PATTERN})`, 'i'),
    run(c, m) {
      if (c.docType !== 'driving_licence') return;
      push(c, 'Licence valid until', null, parseLooseDate(m[1]!) ?? null, CONF_LABEL);
    },
  },
  {
    re: /^\s*5\.\s*([A-Z9]{5}\s?\d{6}\s?[A-Z9]{2}\d[A-Z]{2})/,
    run(c, m) {
      push(c, 'Driving licence number', 'party:client.drivingLicenceNumber', m[1]!.replace(/\s+/g, ''), CONF_LABEL);
    },
  },
  {
    re: /^\s*8\.\s*(.+)$/,
    run(c, m) {
      if (c.docType !== 'driving_licence') return;
      push(c, 'Address', 'party:client.address', addressAfter(c, m[1]!), CONF_LABEL);
    },
  },
  // V5C keeper
  {
    re: /^\s*(?:name of )?registered keeper(?:'s name)?\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!);
      if (v && /\p{L}/u.test(v) && !/\d{3,}/.test(v)) push(c, 'Registered keeper', 'party:client.name', v, 0.7);
    },
  },
  {
    re: /^\s*(?:date of acquisition|keeper since|date acquired|registered keeper since)\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const d = parseLooseDate(valueAfter(c, m[1]!).match(new RegExp(DATE_PATTERN, 'i'))?.[0] ?? '');
      push(c, 'Keeper since', null, d ?? null, CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:full\\s+)?name(?:\\s+of\\s+(driver|policyholder|client|claimant|insured|witness))?\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const of = m[2]?.toLowerCase();
      if (of === 'witness' || c.section === 'witness') return;
      let r = role;
      if (of === 'driver') r = r ?? 'driver';
      if (of && ['policyholder', 'client', 'claimant', 'insured'].includes(of)) r = 'client';
      const v = valueAfter(c, m[3]!);
      if (!v || !/\p{L}/u.test(v) || v.length > 80) return;
      if (r) push(c, 'Name', roleTarget(r, 'party', 'name'), v, CONF_LABEL);
      else push(c, 'Name (unassigned)', null, v, CONF_BARE);
    },
  },
  {
    re: /^\s*policyholder(?:'s)?(?: name)?\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!);
      if (!v || !/\p{L}/u.test(v)) return;
      push(c, 'Policyholder', LETTER_DOCS.has(c.docType) ? 'party:third_party.name' : 'party:client.name', v, CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:date of birth|d\\.?o\\.?b\\.?)\\s*[:\\-–]?\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const d = parseLooseDate(valueAfter(c, m[2]!).match(new RegExp(DATE_PATTERN, 'i'))?.[0] ?? '');
      if (d && role) push(c, 'Date of birth', roleTarget(role, 'party', 'dateOfBirth'), d, CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:home\\s+|postal\\s+)?address\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      if (c.section === 'witness') return;
      const v = addressAfter(c, m[2]!);
      if (v && role) push(c, 'Address', roleTarget(role, 'party', 'address'), v, CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:tel(?:ephone)?|phone|mobile|contact number)(?:\\s+(?:no|number))?\\.?\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      if (c.section === 'witness') return;
      const raw = valueAfter(c, m[2]!);
      const p = normPhone(raw.match(new RegExp(PHONE_SCAN_RE.source))?.[0] ?? raw);
      if (!p) return;
      if (c.section === undefined && /^(repairer|bodyshop)/i.test(c.lines[c.index - 1] ?? '')) push(c, 'Repairer phone', null, p, CONF_LABEL);
      else if (role) push(c, 'Phone', roleTarget(role, 'party', 'phone'), p, CONF_LABEL);
      else push(c, 'Phone (unassigned)', null, p, CONF_BARE);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}e-?mail(?:\\s+address)?\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      if (c.section === 'witness') return;
      const e = valueAfter(c, m[2]!).match(new RegExp(EMAIL_SCAN_RE.source))?.[0]?.toLowerCase();
      if (!e) return;
      if (role) push(c, 'Email', roleTarget(role, 'party', 'email'), e, CONF_LABEL);
      else push(c, 'Email (unassigned)', null, e, CONF_BARE);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:driving\\s+)?licen[cs]e\\s+(?:no|number)\\.?\\s*[:\\-–]?\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const v = valueAfter(c, m[2]!).replace(/\s+/g, '').toUpperCase();
      const lic = v.match(DVLA_LICENCE_RE)?.[0];
      if (lic) push(c, 'Driving licence number', role ? roleTarget(role, 'party', 'drivingLicenceNumber') : null, lic, CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:vehicle\\s+|car\\s+)?(?:registration|reg)(?:\\.|\\s+(?:mark|number|no\\.?|plate))?\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const v = vrmIn(valueAfter(c, m[2]!));
      if (!v) return;
      if (role === 'driver') role = 'client';
      if (role) push(c, 'Registration', roleTarget(role, 'vehicle', 'registration'), v, CONF_LABEL);
      else push(c, 'Registration (unassigned)', null, v, CONF_BARE);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:vin|v\\.i\\.n\\.|vehicle identification number|chassis(?:\\s+(?:no|number))?)\\.?\\s*[:\\-–]?\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const v = valueAfter(c, m[2]!).toUpperCase().replace(/[\s-]/g, '');
      const vin = v.match(/[A-Z0-9]{17}/)?.[0];
      if (!vin) return;
      if (role === 'driver') role = 'client';
      if (role) push(c, 'VIN', roleTarget(role, 'vehicle', 'vin'), vin, CONF_LABEL);
      else push(c, 'VIN (unassigned)', null, vin, CONF_BARE);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:vehicle\\s+)?make(?:\\s+(?:and|&)\\s+model)?\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const v = valueAfter(c, m[2]!);
      if (!v || !role) return;
      const r: Role = role === 'driver' ? 'client' : role;
      if (/model/i.test(c.lines[c.index]!.split(/[:\-–]/)[0]!)) {
        const [make, ...model] = v.split(/\s+/);
        push(c, 'Make', roleTarget(r, 'vehicle', 'make'), make ?? null, CONF_LABEL);
        if (model.length) push(c, 'Model', roleTarget(r, 'vehicle', 'model'), model.join(' '), CONF_LABEL);
      } else push(c, 'Make', roleTarget(r, 'vehicle', 'make'), v.split(/\s{2,}|,/)[0]!, CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:vehicle\\s+)?model\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const v = valueAfter(c, m[2]!);
      if (v && role) push(c, 'Model', roleTarget(role === 'driver' ? 'client' : role, 'vehicle', 'model'), v, CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:vehicle\\s+)?colou?r\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const v = valueAfter(c, m[2]!);
      if (v && role && v.length <= 40) push(c, 'Colour', roleTarget(role === 'driver' ? 'client' : role, 'vehicle', 'colour'), v, CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:date of first registration|first registered|date first registered)\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const raw = valueAfter(c, m[1]!);
      const d = parseLooseDate(raw.match(new RegExp(DATE_PATTERN, 'i'))?.[0] ?? '');
      const ym = d ? d.slice(0, 7) : /^(\d{1,2})[/.-](\d{4})$/.exec(raw.trim()) ? `${raw.trim().slice(-4)}-${raw.trim().split(/[/.-]/)[0]!.padStart(2, '0')}` : null;
      push(c, 'First registered', 'vehicle:client.firstRegistered', ym, CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:date(?:\s+and\s+time)?\s+of\s+(?:the\s+)?(?:accident|incident|loss|collision)|(?:accident|incident|collision)\s+date(?:\s+and\s+time)?|date\/time of (?:accident|incident))\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const raw = valueAfter(c, m[1]!);
      const dt = findDateTime(raw);
      if (!dt) return;
      let time = dt.time;
      if (!time) {
        for (let j = Math.max(0, c.index - 2); j < Math.min(c.lines.length, c.index + 3); j += 1) {
          const t = new RegExp(`^\\s*time(?:\\s+of\\s+(?:the\\s+)?(?:accident|incident|collision))?\\s*[:\\-–]?\\s*(${TIME_PATTERN})`, 'i').exec(c.lines[j]!);
          if (t) {
            time = parseLooseTime(t[1]!) ?? null;
            break;
          }
        }
      }
      push(c, 'Date of accident', 'claim.accident.occurredAt', time ? `${dt.date} ${time}` : dt.date, time ? CONF_LABEL : 0.7);
    },
  },
  {
    re: /^\s*(?:(?:location|place)(?:\s+of\s+(?:the\s+)?(?:accident|incident|collision))?|accident location|where did (?:it|the accident) happen\??)\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!);
      if (!v || v.length > 300) return;
      push(c, 'Accident location', 'claim.accident.location', v, CONF_LABEL);
      const pc = v.toUpperCase().match(new RegExp(POSTCODE_SCAN_RE.source));
      if (pc) push(c, 'Accident postcode', 'claim.accident.postcode', displayPostcode(pc[0]), 0.7);
    },
  },
  {
    re: /^\s*(?:(?:accident|incident)\s+postcode|postcode of (?:the )?accident)\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const pc = valueAfter(c, m[1]!).toUpperCase().match(new RegExp(POSTCODE_SCAN_RE.source));
      if (pc) push(c, 'Accident postcode', 'claim.accident.postcode', displayPostcode(pc[0]), CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:circumstances(?:\s+of\s+the\s+(?:accident|incident))?|describe what happened|what happened|description of (?:the )?(?:accident|incident)|details of (?:the )?accident|(?:your\s+)?account of (?:the )?accident|how did the accident happen\??)\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const v = blockAfter(c, m[1]!);
      if (v.length >= 10) push(c, 'Circumstances', 'claim.accident.circumstances', v, CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:police|crime|incident|CAD|collision)\s*(?:reference|ref|number|no)\.?(?:\s+(?:number|no))?\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!).match(/[A-Z0-9][A-Z0-9/-]{3,40}/i)?.[0];
      if (v) push(c, 'Police reference', 'claim.accident.policeReference', v.toUpperCase(), CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:police attended|did the police attend|were the police called|police in attendance)\??\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      push(c, 'Police attended', null, yesNo(valueAfter(c, m[1]!)), CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:injuries|was anyone (?:injured|hurt)|anyone (?:injured|hurt)|any injuries|personal injury)\??\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      push(c, 'Injuries', 'claim.accident.injuries', yesNo(valueAfter(c, m[1]!)), CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:is the )?(?:vehicle |car )?(?:driveable|drivable|roadworthy)(?: after the accident)?\??\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      push(c, 'Vehicle driveable', null, yesNo(valueAfter(c, m[1]!)), CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:(?:replacement|hire|courtesy) (?:car|vehicle)(?: (?:needed|required|wanted))?|do you need a (?:replacement|hire) (?:car|vehicle))\??\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      push(c, 'Hire needed', null, yesNo(valueAfter(c, m[1]!)), CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:independent\s+)?witness(?:es)?(?:\s+details)?\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!);
      if (!v) return;
      push(c, 'Witnesses', null, /^(none|no|nil|n\/a|no witnesses)\b/i.test(v) ? 'none' : v, CONF_LABEL);
    },
  },
  {
    re: /^\s*our\s+ref(?:erence)?\.?\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!).match(/[A-Z0-9][A-Z0-9/.-]{3,40}/i)?.[0];
      if (!v || /^CCG-\d{4}-\d{5}$/i.test(v)) return;
      if (c.docType === 'engineer_report') push(c, 'Engineer reference', null, v.toUpperCase(), CONF_LABEL);
      else if (LETTER_DOCS.has(c.docType)) push(c, 'Their reference', 'claim.atFaultInsurerRef', v.toUpperCase(), CONF_LABEL);
    },
  },
  {
    re: /^\s*claim\s+(?:no|number|ref(?:erence)?)\.?\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!).match(/[A-Z0-9][A-Z0-9/.-]{3,40}/i)?.[0];
      if (v && !/^CCG-/i.test(v) && LETTER_DOCS.has(c.docType)) push(c, 'Claim number', 'claim.atFaultInsurerRef', v.toUpperCase(), CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:insurance\\s+)?policy\\s+(?:no|number)\\.?\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const v = valueAfter(c, m[2]!).replace(/\s+/g, '').toUpperCase().match(/[A-Z0-9/-]{4,40}/)?.[0];
      if (!v) return;
      const tp = LETTER_DOCS.has(c.docType) ? role !== 'client' : role === 'third_party';
      push(c, 'Policy number', tp ? 'claim.thirdPartyPolicyNumber' : 'claim.clientPolicyNumber', v, CONF_LABEL);
    },
  },
  {
    re: new RegExp(`^\\s*${WHO_RE}(?:insurer|insurance company|insured with|insurers)\\s*[:\\-–]\\s*(.*)$`, 'i'),
    run(c, m, role) {
      const v = valueAfter(c, m[2]!);
      if (!v || v.length > 120) return;
      const tp = LETTER_DOCS.has(c.docType) ? role !== 'client' : role === 'third_party';
      push(c, tp ? 'Insurer name' : 'Client insurer name', tp ? 'claim.atFaultInsurerName' : 'claim.clientInsurerName', v, CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:repairer|bodyshop|body shop|garage)(?:\s+name)?\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!);
      if (v && v.length <= 120) push(c, 'Repairer name', null, v, CONF_LABEL);
    },
  },
  {
    re: /^\s*engineer(?:'s)?(?:\s+name)?\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!);
      if (v && v.length <= 120) push(c, 'Engineer name', null, v, CONF_LABEL);
    },
  },
  {
    re: /^\s*engineer(?:'s)?\s+ref(?:erence)?\.?\s*[:\-–]\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!).match(/[A-Z0-9][A-Z0-9/.-]{2,40}/i)?.[0];
      if (v) push(c, 'Engineer reference', null, v.toUpperCase(), CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:period of insurance|period of cover|cover period)\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const ds = [...valueAfter(c, m[1]!).matchAll(new RegExp(DATE_PATTERN, 'gi'))].map((x) => parseLooseDate(x[0])).filter((x): x is string => Boolean(x));
      if (ds[0]) push(c, 'Valid from', null, ds[0], CONF_LABEL);
      if (ds[1]) push(c, 'Valid until', null, ds[1], CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:valid from|effective (?:date|from)|start date|commencement(?: date)?|date of commencement)\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const d = parseLooseDate(valueAfter(c, m[1]!).match(new RegExp(DATE_PATTERN, 'i'))?.[0] ?? '');
      push(c, 'Valid from', null, d ?? null, CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:valid (?:until|to)|expiry(?: date)?|expires(?: on)?|date of expiry|end date)\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const d = parseLooseDate(valueAfter(c, m[1]!).match(new RegExp(DATE_PATTERN, 'i'))?.[0] ?? '');
      push(c, c.docType === 'mot_certificate' ? 'MOT expiry' : c.docType === 'driving_licence' ? 'Licence valid until' : 'Valid until', null, d ?? null, CONF_LABEL);
    },
  },
  {
    re: /^\s*(?:date of inspection|inspection date|inspected on|date inspected)\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const d = parseLooseDate(valueAfter(c, m[1]!).match(new RegExp(DATE_PATTERN, 'i'))?.[0] ?? '');
      push(c, 'Inspection date', null, d ?? null, CONF_LABEL);
    },
  },
  {
    re: /^\s*sort\s*code\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!).match(/\b\d{2}-\d{2}-\d{2}\b/)?.[0];
      push(c, 'Sort code', null, v ?? null, CONF_LABEL);
    },
  },
  {
    re: /^\s*account\s*(?:no|number)\.?\s*[:\-–]?\s*(.*)$/i,
    run(c, m) {
      const v = valueAfter(c, m[1]!).match(/\b\d{8}\b/)?.[0];
      push(c, 'Account number', null, v ?? null, CONF_LABEL);
    },
  },
];

const LIABILITY_RE = /[^.\n]*\b(?:we (?:accept|admit|deny|dispute) liability|liability is (?:accepted|admitted|denied|disputed|not admitted)|our (?:insured|policyholder|client) (?:accepts|admits|denies) (?:responsibility|liability)|(?:accept|admit)s? (?:full )?(?:responsibility|liability) for (?:this|the) (?:accident|incident|collision))\b[^.\n]*\.?/i;
const OFFER_RE = /\b(?:we are pleased to offer|(?:offer|sum) of £[\d,.]+|in (?:full and final )?settlement|interim payment|pre-accident value of £|we (?:enclose|have made|will make) (?:a )?payment|without prejudice offer|part 36 offer)\b/i;

/** Read the fields of a document from its page texts. */
export function ruleExtract(pages: string[], docType: DocType, opts: RuleExtractOptions): ExtractedField[] {
  const out: ExtractedField[] = [];
  pages.forEach((text, pi) => {
    const lines = (text ?? '').split(/\r?\n/);
    const c: Ctx = { docType, page: pi + 1, lines, index: 0, section: undefined, out };
    for (let i = 0; i < lines.length; i += 1) {
      c.index = i;
      const line = lines[i]!;
      if (!line.trim()) continue;
      const short = line.trim().length <= 60;
      const headingOnly = (re: RegExp) => short && re.test(line) && /^[\s:\-–]*(?:details|information)?[\s:\-–]*$/i.test(line.replace(re, ''));
      if (headingOnly(THIRD_HEAD)) c.section = 'third_party';
      else if (headingOnly(CLIENT_HEAD)) c.section = 'client';
      else if (short && WITNESS_HEAD.test(line)) c.section = 'witness';
      else if (short && ACCIDENT_HEAD.test(line)) c.section = 'accident';
      for (const rule of LABELS) {
        const m = rule.re.exec(line);
        if (!m) continue;
        const who = whoRole(m[1]);
        const role = (who !== undefined ? who : lineRole(line, docType)) ?? (c.section === 'witness' ? null : defaultRole(c));
        rule.run(c, m, role);
        break;
      }
      // Insurer names anywhere on certificates and letters.
      if (docType === 'insurance_certificate' || LETTER_DOCS.has(docType)) {
        for (const n of opts.insurerNames) {
          if (n.length >= 3 && line.toLowerCase().includes(n.toLowerCase())) {
            if (docType === 'insurance_certificate') push(c, 'Client insurer name', 'claim.clientInsurerName', n, CONF_BARE);
            else push(c, 'Insurer name', 'claim.atFaultInsurerName', n, CONF_BARE);
            break;
          }
        }
      }
      const liab = LIABILITY_RE.exec(line);
      if (liab) push(c, 'Liability statement', null, liab[0].trim(), CONF_LABEL);
      if (OFFER_RE.test(line) && LETTER_DOCS.has(docType)) push(c, 'Offer made', null, 'yes', CONF_BARE);
    }
    // Bare patterns over the whole page.
    const pageUpper = (text ?? '').toUpperCase();
    for (const m of pageUpper.matchAll(/\bCCG-\d{4}-\d{5}\b/g)) push({ ...c, index: lineIndexOf(lines, m[0]) }, 'ClaimDesk reference', null, m[0], CONF_LABEL, lineOf(lines, m[0]));
    for (const m of pageUpper.matchAll(VIN_RE)) {
      if (!isVinLike(m[0])) continue;
      const r = roleAt(lines, m[0], c, docType);
      if (r === 'third_party') push(c, 'VIN', 'vehicle:third_party.vin', m[0], CONF_BARE, lineOf(lines, m[0]));
      else if (r) push(c, 'VIN', 'vehicle:client.vin', m[0], CONF_BARE, lineOf(lines, m[0]));
      else push(c, 'VIN (unassigned)', null, m[0], CONF_BARE, lineOf(lines, m[0]));
    }
    for (const m of pageUpper.matchAll(new RegExp(VRM_SCAN_RE.source, 'g'))) {
      if (!isPlate(m[0])) continue;
      const v = displayPlate(m[0]);
      const r = roleAt(lines, m[0], c, docType);
      if (r === 'third_party') push(c, 'Registration', 'vehicle:third_party.registration', v, CONF_BARE, lineOf(lines, m[0]));
      else if (r) push(c, 'Registration', 'vehicle:client.registration', v, CONF_BARE, lineOf(lines, m[0]));
      else push(c, 'Registration (unassigned)', null, v, CONF_BARE, lineOf(lines, m[0]));
    }
    for (const m of (text ?? '').matchAll(new RegExp(DVLA_LICENCE_RE.source, 'g'))) {
      if (docType === 'driving_licence') push(c, 'Driving licence number', 'party:client.drivingLicenceNumber', m[0], CONF_BARE, lineOf(lines, m[0]));
      else push(c, 'Licence number (unassigned)', null, m[0], CONF_BARE, lineOf(lines, m[0]));
    }
    for (const m of (text ?? '').matchAll(new RegExp(EMAIL_SCAN_RE.source, 'g'))) {
      const e = m[0].toLowerCase();
      if (CLIENT_DOCS.has(docType) && docType !== 'bodyshop_estimate' && docType !== 'engineer_report' && docType !== 'audatex_estimate') push(c, 'Email', 'party:client.email', e, CONF_BARE, lineOf(lines, m[0]));
      else push(c, 'Email (unassigned)', null, e, CONF_BARE, lineOf(lines, m[0]));
    }
    for (const m of (text ?? '').matchAll(new RegExp(PHONE_SCAN_RE.source, 'g'))) {
      const p = normPhone(m[0]);
      if (!p) continue;
      push(c, 'Phone (unassigned)', null, p, CONF_BARE, lineOf(lines, m[0]));
    }
  });
  return dedupe(out);
}

function lineIndexOf(lines: string[], needle: string): number {
  const n = needle.toUpperCase();
  const i = lines.findIndex((l) => l.toUpperCase().includes(n));
  return i < 0 ? 0 : i;
}
function lineOf(lines: string[], needle: string): string {
  return lines[lineIndexOf(lines, needle)] ?? needle;
}

/** The role for a bare value: the line's own words, else the section heading above it, else the document's default. */
function roleAt(lines: string[], needle: string, c: Ctx, docType: DocType): Role {
  const idx = lineIndexOf(lines, needle);
  const line = lines[idx] ?? '';
  const own = lineRole(line, docType);
  if (own) return own;
  for (let j = idx; j >= 0; j -= 1) {
    const l = lines[j]!;
    if (l.trim().length <= 60 && THIRD_HEAD.test(l)) return 'third_party';
    if (l.trim().length <= 60 && CLIENT_HEAD.test(l)) return 'client';
  }
  return CLIENT_DOCS.has(docType) ? 'client' : null;
}

/** One reading per (name, target, value): the most confident, labelled before bare. */
function dedupe(fields: ExtractedField[]): ExtractedField[] {
  const best = new Map<string, ExtractedField>();
  const order: string[] = [];
  // A value already read with a label is not repeated as an unassigned bare reading.
  const labelled = new Set(fields.filter((f) => f.target).map((f) => norm(f.value)));
  for (const f of fields) {
    if (!f.target && / \(unassigned\)$/.test(f.name) && labelled.has(norm(f.value))) continue;
    const k = `${f.target ?? f.name}|${norm(f.value)}`;
    const prev = best.get(k);
    if (!prev) {
      best.set(k, f);
      order.push(k);
    } else if (f.confidence > prev.confidence) best.set(k, f);
  }
  return order.map((k) => best.get(k)!);
}
const norm = (v: string | null): string => (v ?? '').toUpperCase().replace(/[^A-Z0-9@.]/g, '');

/** The date printed on the document (a letter's date line, a report's date), as YYYY-MM-DD, or null. */
export function ruleDocumentDate(pages: string[], docType: DocType): string | null {
  const first = (pages[0] ?? '').split(/\r?\n/).slice(0, 40);
  const labelled = new RegExp(`^\\s*(?:date(?: of (?:letter|report|issue|estimate|invoice))?|dated|report date|invoice date|estimate date|issued(?: on)?)\\s*[:\\-–]?\\s*(${DATE_PATTERN})`, 'i');
  for (const l of first) {
    const m = labelled.exec(l);
    if (m) return parseLooseDate(m[1]!) ?? null;
  }
  if (LETTER_DOCS.has(docType)) {
    // A letter's date stands on its own line near the top.
    for (const l of first.slice(0, 20)) {
      const m = new RegExp(`^\\s*(${DATE_PATTERN})\\s*$`, 'i').exec(l);
      if (m) return parseLooseDate(m[1]!) ?? null;
    }
  }
  return null;
}

/** Front or back of a licence / card from its text (back: entitlement categories, "restrictions", codes table). */
export function ruleDocSide(pages: string[], docType: DocType): 'front' | 'back' | null {
  if (docType !== 'driving_licence') return null;
  const t = pages.join('\n');
  if (/\b(?:9\.|10\.|11\.|12\.)\s/.test(t) && /\bcategor(?:y|ies)\b|\bentitlement|restrictions?\b/i.test(t) && !/\b5\.\s*[A-Z9]{5}/.test(t)) return 'back';
  if (/\b(?:1\.|2\.|3\.|4a\.|5\.)\s/.test(t) || DVLA_LICENCE_RE.test(t)) return 'front';
  return null;
}

/** Postcodes in a text (normalised, no space). */
export function postcodesIn(text: string): string[] {
  return [...text.toUpperCase().matchAll(new RegExp(POSTCODE_SCAN_RE.source, 'g'))].map((m) => normPostcode(m[0]));
}
