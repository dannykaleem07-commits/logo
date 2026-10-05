/**
 * Settings → GTA benchmark rates (pure; unit-tested) — docs/TEMPLATES-VEHICLES-DESKTOP.md §F.3, §F.4.
 *
 * The knowledge-base rate file stays the base. Your rows replace a KB row for the same group and period, hide it, or
 * add a group/period the file does not have. GTA rates are an industry benchmark only: Courtesy Cars Group UK Ltd is
 * not a GTA subscriber. A rate's verification is data — it is shown as stored and never upgraded here; "verified"
 * needs the https:// address it was checked against, and the server stamps who verified it and when.
 */
import type { ISODate, Pence } from '@ccguk/domain';
import type { GtaRateBody, GtaRateListItem, GtaSegmentItem } from '../../api/vehiclesApi';
import type { Tone } from '../../lib/status';

export const GTA_GROUP_RE = /^[A-Z]{1,3}\d{0,2}$/;
export const GTA_PERIOD_RE = /^\d{4}-\d{2}$/;

/** Shown under the segment defaults (§F.4). */
export const VAN_PICKUP_NOTE = 'Vans and pick-ups have no 2026-27 rows in the shipped rate file (the CP1, CP2 and PV2 rows ended on 30 June 2026). Add your own rate for those groups when you have a confirmed figure.';

export const RATES_BANNER = 'GTA rates are an industry benchmark only. Courtesy Cars Group UK Ltd is not a GTA subscriber; the figures are used for comparison and the hire charge is your own daily rate.';

export type RateOrigin = 'kb' | 'yours' | 'overrides' | 'hidden';

export const ORIGIN_LABEL: Record<RateOrigin, string> = {
  kb: 'Knowledge base',
  yours: 'Your rate',
  overrides: 'Overrides knowledge base',
  hidden: 'Hidden'
};

export const ORIGIN_TONE: Record<RateOrigin, Tone> = { kb: 'grey', yours: 'blue', overrides: 'amber', hidden: 'red' };

/** Origin badge for a row of GET /settings/gta-rates. */
export function rateOrigin(item: Pick<GtaRateListItem, 'origin' | 'overridesKb' | 'suppressed'>): RateOrigin {
  if (item.suppressed) return 'hidden';
  if (item.origin === 'manual') return item.overridesKb ? 'overrides' : 'yours';
  return 'kb';
}

export interface RateActions {
  /** 'create' = a KB row: editing creates your override (POST); 'update' = your row (PUT); null = show it first. */
  edit: 'create' | 'update' | null;
  hide: boolean;
  show: boolean;
  delete: boolean;
}

/** Edit (except a hidden row: show it first); Hide/Show where a KB row exists; Delete for your own rate rows. */
export function rateActions(item: GtaRateListItem): RateActions {
  const origin = rateOrigin(item);
  const hasKb = item.origin === 'kb' || Boolean(item.kbRate) || Boolean(item.overridesKb);
  const ownRate = Boolean(item.id) && item.origin === 'manual';
  return {
    edit: origin === 'hidden' ? null : item.id && item.origin === 'manual' ? 'update' : 'create',
    hide: hasKb && origin !== 'hidden',
    show: origin === 'hidden',
    delete: ownRate
  };
}

/** GTA years run 1 July – 30 June: '2026-27' for any date from 1 July 2026 to 30 June 2027. */
export function gtaPeriodFor(date: ISODate): { period: string; effectiveFrom: ISODate; effectiveTo: ISODate } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const start = m >= 7 ? y : y - 1;
  return { period: `${start}-${String((start + 1) % 100).padStart(2, '0')}`, effectiveFrom: `${start}-07-01`, effectiveTo: `${start + 1}-06-30` };
}

export interface RateForm {
  /** Set when editing one of your rows (PUT). */
  id?: string;
  /** Overriding a KB row: the group and period are that row's and cannot change. */
  lockKey?: boolean;
  group: string;
  description: string;
  dailyRatePence: Pence | null;
  period: string;
  effectiveFrom: ISODate | '';
  effectiveTo: ISODate | '';
  verificationStatus: 'unverified' | 'verified';
  sourceUrl: string;
  sourceNote: string;
  note: string;
}

export function emptyRateForm(today: ISODate): RateForm {
  const p = gtaPeriodFor(today);
  return { group: '', description: '', dailyRatePence: null, period: p.period, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo, verificationStatus: 'unverified', sourceUrl: '', sourceNote: '', note: '' };
}

/**
 * The form for a row. Your row → its values (PUT). A KB row → a new override with the KB figures as the starting
 * point, unverified until you give the source you checked it against.
 */
export function rateFormFromItem(item: GtaRateListItem): RateForm {
  const mine = Boolean(item.id) && item.origin === 'manual';
  const base = item.kbRate && !mine ? item.kbRate : item;
  const form: RateForm = {
    group: item.group,
    description: base.description ?? '',
    dailyRatePence: base.dailyRatePence || null,
    period: item.period,
    effectiveFrom: base.effectiveFrom,
    effectiveTo: base.effectiveTo,
    verificationStatus: mine && item.verification.status === 'verified' ? 'verified' : 'unverified',
    sourceUrl: mine ? (item.verification.sourceUrl ?? '') : '',
    sourceNote: mine ? (item.verification.sourceNote ?? '') : '',
    note: mine ? (item.note ?? '') : ''
  };
  if (mine && item.id) form.id = item.id;
  else form.lockKey = true;
  return form;
}

export type RateFormErrors = Partial<Record<keyof RateForm, string>>;

/** Client-side checks mirroring the server: group/period shape, pence > 0, from ≤ to, and verified ⇒ an https URL. */
export function validateRateForm(f: RateForm): RateFormErrors {
  const e: RateFormErrors = {};
  const group = f.group.trim().toUpperCase();
  if (!group) e.group = 'GTA group, e.g. S1, M, M1, CP1';
  else if (!GTA_GROUP_RE.test(group)) e.group = 'A GTA group looks like S1, M, M1 or CP2';
  if (f.dailyRatePence === null || !Number.isInteger(f.dailyRatePence) || f.dailyRatePence <= 0) e.dailyRatePence = 'Daily rate in pounds (more than £0)';
  if (!GTA_PERIOD_RE.test(f.period.trim())) e.period = 'Period like 2026-27';
  if (!f.effectiveFrom) e.effectiveFrom = 'From date';
  if (!f.effectiveTo) e.effectiveTo = 'To date';
  else if (f.effectiveFrom && f.effectiveTo < f.effectiveFrom) e.effectiveTo = 'The end is before the start';
  const url = f.sourceUrl.trim();
  if (f.verificationStatus === 'verified') {
    if (!url) e.sourceUrl = 'A verified rate needs the https:// address of the page or file you checked it against';
    else if (!/^https:\/\/\S+$/i.test(url)) e.sourceUrl = 'Use the https:// address of the source';
  } else if (url && !/^https?:\/\/\S+$/i.test(url)) e.sourceUrl = 'Enter a web address (https://…)';
  return e;
}

/** POST/PUT body. Never carries verifiedBy/verifiedAt: the server sets them from the signed-in user. */
export function rateBodyFrom(f: RateForm): GtaRateBody {
  const body: GtaRateBody = {
    group: f.group.trim().toUpperCase(),
    dailyRatePence: f.dailyRatePence ?? 0,
    period: f.period.trim(),
    effectiveFrom: f.effectiveFrom as ISODate,
    effectiveTo: f.effectiveTo as ISODate,
    verification: { status: f.verificationStatus }
  };
  if (f.description.trim()) body.description = f.description.trim();
  if (f.sourceUrl.trim()) body.verification!.sourceUrl = f.sourceUrl.trim();
  if (f.sourceNote.trim()) body.verification!.sourceNote = f.sourceNote.trim();
  if (f.note.trim()) body.note = f.note.trim();
  return body;
}

/** "Verified by Sam Smith on 2026-10-04" for a verified row; undefined otherwise. */
export function verifiedByText(item: Pick<GtaRateListItem, 'verification'>, name?: string): string | undefined {
  const v = item.verification;
  if (v.status !== 'verified') return undefined;
  const who = name || v.verifiedBy;
  return `Verified${who ? ` by ${who}` : ''}${v.verifiedAt ? ` on ${v.verifiedAt}` : ''}`;
}

/** Rows sorted for the table: group, then newest period first. */
export function sortRates(items: readonly GtaRateListItem[]): GtaRateListItem[] {
  return [...items].sort((a, b) => a.group.localeCompare(b.group, 'en-GB', { numeric: true }) || b.effectiveFrom.localeCompare(a.effectiveFrom));
}

/** Known group codes for the segment datalist (from the rate rows). */
export function knownGroups(items: readonly Pick<GtaRateListItem, 'group'>[]): string[] {
  return [...new Set(items.map((i) => i.group.toUpperCase()))].sort((a, b) => a.localeCompare(b, 'en-GB', { numeric: true }));
}

/** A segment row's group can be saved when it is a valid code and differs from what is stored. */
export function segmentGroupError(draft: string): string | undefined {
  const g = draft.trim().toUpperCase();
  if (!g) return 'Enter a GTA group';
  if (!GTA_GROUP_RE.test(g)) return 'A GTA group looks like S1, M, M1 or CP2';
  return undefined;
}

export function segmentChanged(item: GtaSegmentItem, draft: string | undefined): boolean {
  return draft !== undefined && draft.trim().toUpperCase() !== item.group.toUpperCase();
}

// ---------------------------------------------------------------------------
// Default view (0.3 §E14): the current period, grouped S / M / F / CP / PV; earlier periods behind a toggle
// ---------------------------------------------------------------------------

export interface RateFamily {
  key: string;
  label: string;
}

/** Families in display order; codes that match none fall into "Other groups". */
export const RATE_FAMILIES: readonly RateFamily[] = [
  { key: 'S', label: 'Standard cars (S)' },
  { key: 'M', label: 'MPV and crossover (M)' },
  { key: 'F', label: '4x4 (F)' },
  { key: 'CP', label: 'Pick-ups (CP)' },
  { key: 'PV', label: 'Panel vans (PV)' }
];
const OTHER_FAMILY: RateFamily = { key: 'OTHER', label: 'Other groups' };

/** The family of a group code: its leading letters ('CP1' → CP, 'M' → M, 'S3' → S). */
export function rateFamily(group: string): RateFamily {
  const letters = /^[A-Z]+/.exec(group.trim().toUpperCase())?.[0] ?? '';
  return RATE_FAMILIES.find((f) => f.key === letters) ?? OTHER_FAMILY;
}

/**
 * Split the rows at the current GTA period: `current` holds this period's rows (and any already entered for a later
 * one), `previous` the earlier periods. When nothing is in force yet, everything is current so the page is never empty.
 */
export function splitByPeriod<T extends Pick<GtaRateListItem, 'period'>>(items: readonly T[], currentPeriod: string): { current: T[]; previous: T[] } {
  const current = items.filter((i) => i.period >= currentPeriod);
  const previous = items.filter((i) => i.period < currentPeriod);
  if (!current.length) return { current: [...previous], previous: [] };
  return { current, previous };
}

/** Rows grouped by family in RATE_FAMILIES order (empty families left out), each sorted like the table. */
export function groupRatesByFamily(items: readonly GtaRateListItem[]): Array<RateFamily & { items: GtaRateListItem[] }> {
  const sorted = sortRates(items);
  const out: Array<RateFamily & { items: GtaRateListItem[] }> = [];
  for (const family of [...RATE_FAMILIES, OTHER_FAMILY]) {
    const rows = sorted.filter((i) => rateFamily(i.group).key === family.key);
    if (rows.length) out.push({ ...family, items: rows });
  }
  return out;
}
