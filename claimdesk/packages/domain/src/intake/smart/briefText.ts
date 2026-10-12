/**
 * The one-glance case summary (docs/SMART-INTAKE.md §4.17, improvement 10): 3–6 plain sentences from the draft values
 * only. An AI-written summary is used only when every registration, date, money figure and reference in it appears in
 * the draft values (`verifySummary`); otherwise the template is used.
 */
import { BANNED_INTAKE_WORDS, type BundleFieldKey } from './types.js';
import { DATE_PATTERN, displayPlate, isPlate, londonDayOf, normVrm, parseLooseDate, VRM_SCAN_RE } from './text.js';

export interface SummaryInput {
  values: Partial<Record<BundleFieldKey, string | null>>;
  missingDocs: number;
  /** Optional extra: a liability statement found in the documents (quoted). */
  liabilityStatement?: string | null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(iso: string): string {
  const d = londonDayOf(iso) ?? iso.slice(0, 10);
  const [y, m, day] = d.split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function londonTime(iso: string): string | null {
  if (!/T\d{2}:\d{2}/.test(iso)) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
}

const yes = (v: string | null | undefined) => /^(yes|true)$/i.test((v ?? '').trim());
const no = (v: string | null | undefined) => /^(no|false)$/i.test((v ?? '').trim());

export function caseSummaryTemplate(d: SummaryInput): string {
  const v = d.values;
  const name = v['client.name'] ?? 'The client';
  const first = (v['client.name'] ?? '').split(/\s+/)[0] || 'The client';
  const car = [v['vehicle.colour']?.toLowerCase(), v['vehicle.make'], v['vehicle.model']].filter(Boolean).join(' ');
  const reg = v['vehicle.registration'] ? displayPlate(v['vehicle.registration']) : null;
  const tpReg = v['tp.registration'] ? displayPlate(v['tp.registration']) : null;
  const when = v['accident.occurredAt'];
  const sentences: string[] = [];
  let s1 = `${name}'s ${car || 'car'}${reg ? ` (${reg})` : ''} was hit${tpReg ? ` by ${tpReg}` : ''}`;
  if (v['accident.location']) s1 += ` at ${v['accident.location']}`;
  if (when) {
    const t = londonTime(when);
    s1 += ` on ${longDate(when)}${t ? ` at ${t}` : ''}`;
  }
  sentences.push(`${s1}.`);
  if (v['tp.insurerName'] || v['tp.insurerRef']) sentences.push(`The other driver is insured by ${v['tp.insurerName'] ?? 'an insurer not yet named'}${v['tp.insurerRef'] ? `; their reference is ${v['tp.insurerRef']}` : ''}.`);
  const driveable = no(v['accident.driveable']) ? 'The car is not driveable' : yes(v['accident.driveable']) ? 'The car is driveable' : null;
  const hire = yes(v['hire.needed']) ? `${first} needs a replacement car` : no(v['hire.needed']) ? `${first} does not need a replacement car` : null;
  if (driveable || hire) sentences.push(`${[driveable, hire].filter(Boolean).join(' and ')}.`);
  if (yes(v['accident.injuries'])) sentences.push('Someone was injured — the injury part is referred out (no fee is taken).');
  if (v['accident.policeReference']) sentences.push(`Police attended (ref ${v['accident.policeReference']}).`);
  else if (yes(v['accident.policeAttended'])) sentences.push('Police attended.');
  if (d.missingDocs > 0) sentences.push(`${d.missingDocs} document${d.missingDocs === 1 ? ' is' : 's are'} still needed.`);
  const text = sentences.slice(0, 6).join(' ');
  return BANNED_INTAKE_WORDS.test(text) ? text.replace(BANNED_INTAKE_WORDS, '…') : text;
}

/**
 * Every registration, date, money figure and reference in an AI summary must appear in the draft values; and the
 * summary must not use the banned wording. Otherwise the template is used.
 */
export function verifySummary(text: string, draftValues: Partial<Record<string, string | null>>): boolean {
  if (!text || !text.trim()) return false;
  if (BANNED_INTAKE_WORDS.test(text)) return false;
  const values = Object.values(draftValues).filter((x): x is string => Boolean(x));
  const blob = values.join(' | ');
  const blobUpper = blob.toUpperCase().replace(/[^A-Z0-9|]/g, '');
  // registrations
  for (const m of text.toUpperCase().matchAll(new RegExp(VRM_SCAN_RE.source, 'g'))) {
    if (!isPlate(m[0])) continue;
    if (!blobUpper.includes(normVrm(m[0]))) return false;
  }
  // dates
  const days = new Set(values.map((v) => londonDayOf(v) ?? parseLooseDate(v)).filter((x): x is string => Boolean(x)));
  for (const m of text.matchAll(new RegExp(DATE_PATTERN, 'gi'))) {
    const d = parseLooseDate(m[0]);
    if (d && !days.has(d)) return false;
  }
  // money figures never come from the documents into a summary unless a value holds them
  for (const m of text.matchAll(/£\s?[\d,]+(?:\.\d{2})?/g)) {
    const n = m[0].replace(/[^\d.]/g, '');
    if (!values.some((v) => v.replace(/[^\d.]/g, '').includes(n))) return false;
  }
  // references (letters/digits with a slash or dash, CCG refs)
  for (const m of text.matchAll(/\b(?:CCG-\d{4}-\d{5}|[A-Z]{2,}[/-][A-Z0-9/-]{2,})\b/g)) {
    if (!blobUpper.includes(m[0].toUpperCase().replace(/[^A-Z0-9]/g, ''))) return false;
  }
  return true;
}
