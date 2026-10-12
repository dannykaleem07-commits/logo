/**
 * When two readings of one detail are "the same" (docs/SMART-INTAKE.md §4.7). Registrations and VINs compare exactly
 * (one character different is a conflict, never compatible); names compare by surname and consistent initials ("J Doe"
 * ⊂ "Jane Doe" → prefer the fuller); addresses by postcode and contained lines; a date and a date-time on the same
 * London day are the same (prefer the date-time); phones by digits; makes and models by prefix (prefer the longer).
 */
import { BUNDLE_FIELD_META, type BundleFieldKey, type Candidate } from './types.js';
import { londonDayOf, normPhone, normPostcode, POSTCODE_SCAN_RE, squash } from './text.js';

export interface CompatResult {
  same: boolean;
  prefer?: 'a' | 'b';
  why?: string;
}

const upperAlnum = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function nameTokens(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !['mr', 'mrs', 'ms', 'miss', 'dr', 'mx'].includes(t));
}

function namesCompatible(a: string, b: string): CompatResult {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return { same: false };
  if (ta.join(' ') === tb.join(' ')) return { same: true };
  if (ta[ta.length - 1] !== tb[tb.length - 1]) return { same: false };
  const ga = ta.slice(0, -1);
  const gb = tb.slice(0, -1);
  const [short, long, shortIsA] = ga.length <= gb.length ? [ga, gb, true] : [gb, ga, false];
  // each given name / initial of the shorter matches a name of the longer, in order
  let j = 0;
  for (const s of short) {
    while (j < long.length && !(long[j] === s || (s.length === 1 && long[j]!.startsWith(s)) || (long[j]!.length === 1 && s.startsWith(long[j]!)))) j += 1;
    if (j >= long.length) return { same: false };
    j += 1;
  }
  const fullerA = ta.join(' ').length >= tb.join(' ').length;
  return { same: true, prefer: fullerA ? 'a' : 'b', why: `${shortIsA ? b : a} is the fuller form of the same name` };
}

function addressesCompatible(a: string, b: string): CompatResult {
  const pa = a.toUpperCase().match(new RegExp(POSTCODE_SCAN_RE.source))?.[0];
  const pb = b.toUpperCase().match(new RegExp(POSTCODE_SCAN_RE.source))?.[0];
  if (!pa || !pb || normPostcode(pa) !== normPostcode(pb)) return { same: false };
  const la = squash(a.toUpperCase().replace(pa, ''));
  const lb = squash(b.toUpperCase().replace(pb, ''));
  if (la === lb) return { same: true };
  const firstA = squash(a.split(',')[0] ?? '');
  const firstB = squash(b.split(',')[0] ?? '');
  if (la.includes(lb) || lb.includes(la) || (firstA && firstA === firstB)) return { same: true, prefer: la.length >= lb.length ? 'a' : 'b', why: 'same postcode and street' };
  return { same: false };
}

const isDateOnly = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

function datetimesCompatible(a: string, b: string): CompatResult {
  if (a === b) return { same: true };
  const da = londonDayOf(a);
  const db = londonDayOf(b);
  if (!da || !db) return { same: false };
  if (isDateOnly(a) || isDateOnly(b)) {
    if (da !== db) return { same: false };
    return { same: true, prefer: isDateOnly(a) && !isDateOnly(b) ? 'b' : isDateOnly(b) && !isDateOnly(a) ? 'a' : undefined, why: 'same day; the reading with a time is kept' } as CompatResult;
  }
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return { same: !Number.isNaN(ta) && ta === tb };
}

const yesNo = (v: string): string => {
  const t = v.trim().toLowerCase();
  if (/^(yes|y|true|1)$/.test(t)) return 'yes';
  if (/^(no|n|false|0|none)$/.test(t)) return 'no';
  return t;
};

/** Are two readings of `key` the same value (and which to keep)? */
export function compatible(key: BundleFieldKey, a: Pick<Candidate, 'value'>, b: Pick<Candidate, 'value'>): CompatResult {
  const va = a.value.trim();
  const vb = b.value.trim();
  if (va === vb) return { same: true };
  const kind = BUNDLE_FIELD_META[key].kind;
  switch (kind) {
    case 'vrm':
    case 'vin':
    case 'licence':
    case 'ref':
      return { same: upperAlnum(va) === upperAlnum(vb) };
    case 'name':
      return namesCompatible(va, vb);
    case 'address':
      return addressesCompatible(va, vb);
    case 'datetime':
      return datetimesCompatible(va, vb);
    case 'date':
      return { same: va.slice(0, 10) === vb.slice(0, 10) };
    case 'month':
      return { same: va.slice(0, 7) === vb.slice(0, 7), ...(va.length !== vb.length ? { prefer: va.length > vb.length ? 'a' : 'b' } : {}) } as CompatResult;
    case 'phone': {
      const pa = normPhone(va);
      return { same: pa !== null && pa === normPhone(vb) };
    }
    case 'email':
      return { same: va.toLowerCase() === vb.toLowerCase() };
    case 'postcode':
      return { same: normPostcode(va) === normPostcode(vb) };
    case 'bool':
    case 'yes_no':
      return { same: yesNo(va) === yesNo(vb) };
    case 'text': {
      const sa = squash(va);
      const sb = squash(vb);
      if (sa === sb) return { same: true };
      if (key === 'vehicle.make' || key === 'vehicle.model' || key === 'tp.make' || key === 'tp.model' || key === 'accident.location' || key === 'clientInsurer.name' || key === 'tp.insurerName' || key === 'repairer.name' || key === 'engineer.name') {
        if (sa && sb && (sa.startsWith(sb) || sb.startsWith(sa) || (key === 'accident.location' && (sa.includes(sb) || sb.includes(sa))))) return { same: true, prefer: sa.length >= sb.length ? 'a' : 'b', why: 'the longer reading includes the shorter' };
      }
      return { same: false };
    }
    default:
      return { same: false };
  }
}
