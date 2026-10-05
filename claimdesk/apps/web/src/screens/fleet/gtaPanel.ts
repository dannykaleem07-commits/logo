/**
 * Fleet unit GTA panel (pure; unit-tested) — docs/TEMPLATES-VEHICLES-DESKTOP.md §F.1.
 *
 * When make and model are known the panel asks GET /gta/suggest and pre-fills the GTA group and the daily rate from
 * the suggestion. Each field stops following the suggestion as soon as the user edits it (dirty tracking). GTA rates
 * are an industry benchmark only: Courtesy Cars Group UK Ltd is not a GTA subscriber, and the verification status of a
 * rate is shown as it is stored — nothing here upgrades it.
 */
import type { GtaRate, GtaSuggestion, GtaSuggestionBasis, ISODate, Pence } from '@ccguk/domain';
import { gtaRate } from '@ccguk/domain';
import type { FleetGtaSuggestionInput } from '../../api/client';
import type { GtaSuggestQuery } from '../../api/vehiclesApi';
import type { VehiclePickerValue } from '../vehicles/vehiclePickerModel';

/** The caveat under the panel (§F.1, exact wording). */
export const GTA_PANEL_CAVEAT = 'GTA rates are an industry benchmark only. Courtesy Cars Group UK Ltd is not a GTA subscriber. Set your own daily rate if it differs.';

export const GTA_GROUP_RE = /^[A-Z]{1,3}\d{0,2}$/;

/** Select value for "Other…" (free entry of a group with no loaded rate). */
export const OTHER_GROUP = '__other__';

/** "No benchmark rate is loaded for group X — add one in Settings → GTA benchmark rates". */
export function noRateMessage(group: string): string {
  return `No benchmark rate is loaded for group ${group} — add one in Settings → GTA benchmark rates`;
}

export interface GtaPanelState {
  /** Upper-case group code ('' when none). */
  group: string;
  /** True once the user has chosen or typed a group: the suggestion no longer changes it. */
  groupDirty: boolean;
  /** 'other' when the group is typed (Other…) rather than chosen from the groups that have rates. */
  groupMode: 'select' | 'other';
  ratePence: Pence | null;
  /** True once the user has typed a rate: neither the suggestion nor a group change replaces it. */
  rateDirty: boolean;
  /** The suggestion the fields were last filled from (sent with the unit for provenance). */
  suggestion?: GtaSuggestion;
}

export function emptyGtaPanel(): GtaPanelState {
  return { group: '', groupDirty: false, groupMode: 'select', ratePence: null, rateDirty: false };
}

/** An existing unit: its group and rate are the user's own, so suggestions never overwrite them. */
export function gtaPanelFromUnit(unit: { gtaGroup?: string; dailyRatePence?: Pence }, groupsWithRates: readonly string[] = []): GtaPanelState {
  const group = (unit.gtaGroup ?? '').trim().toUpperCase();
  return {
    group,
    groupDirty: Boolean(group),
    groupMode: group && groupsWithRates.length && !groupsWithRates.includes(group) ? 'other' : 'select',
    ratePence: unit.dailyRatePence ?? null,
    rateDirty: unit.dailyRatePence !== undefined && unit.dailyRatePence !== null
  };
}

/** The benchmark rate loaded for a group on a date (merged KB ⊕ your rates), if any. */
export function rateForGroup(group: string, rates: readonly GtaRate[] | undefined, date: ISODate): GtaRate | undefined {
  if (!group || !rates?.length) return undefined;
  return gtaRate(group, date, [...rates]);
}

/** Groups that have a rate loaded (for the Select), sorted. */
export function groupsWithRates(rates: readonly GtaRate[] | undefined): string[] {
  return [...new Set((rates ?? []).map((r) => r.group.trim().toUpperCase()))].sort((a, b) => a.localeCompare(b, 'en-GB', { numeric: true }));
}

export function groupOptions(rates: readonly GtaRate[] | undefined): Array<{ value: string; label: string }> {
  const opts = groupsWithRates(rates).map((g) => {
    const r = (rates ?? []).find((x) => x.group.toUpperCase() === g);
    // First sentence of the description only ('MPV/crossover group M1'), so the Select stays readable.
    // Parenthesised examples ('(e.g. Golf, Focus)') go first, so an 'e.g.' never cuts the label mid-bracket.
    const short = r?.description?.replace(/\s*\([^)]*\)/g, '').split(/\.\s/)[0]?.replace(/\.$/, '').trim();
    return { value: g, label: short && short !== g ? `${g} — ${short}` : g };
  });
  return [...opts, { value: OTHER_GROUP, label: 'Other…' }];
}

/**
 * GET /gta/suggest query for the picker facts and today's date, or null while make or model is missing. Catalogue
 * slugs are sent when the vehicle was picked from the catalogue (the API accepts slugs or names).
 */
export function suggestQuery(v: Pick<VehiclePickerValue, 'make' | 'model' | 'variant' | 'catalogue' | 'segment' | 'bodyType' | 'engineCapacityCc' | 'fuelType'> & Partial<Pick<VehiclePickerValue, 'yearOfManufacture'>>, date: ISODate): GtaSuggestQuery | null {
  const make = v.make.trim();
  const model = v.model.trim();
  if (!make || !model) return null;
  const c = v.catalogue;
  const q: GtaSuggestQuery = { make: c?.makeSlug || make, model: c?.modelSlug || model, date };
  if (c?.generationId) q.generationId = c.generationId;
  if (c?.trimId) q.trimId = c.trimId;
  if (v.segment) q.segment = v.segment;
  if (v.bodyType) q.bodyType = v.bodyType;
  if (v.engineCapacityCc && Number.isInteger(v.engineCapacityCc) && v.engineCapacityCc > 0) q.engineCapacityCc = v.engineCapacityCc;
  if (v.fuelType) q.fuelType = v.fuelType;
  if (v.variant.trim()) q.variant = v.variant.trim();
  if (v.yearOfManufacture !== undefined && Number.isInteger(v.yearOfManufacture)) q.yearOfManufacture = v.yearOfManufacture;
  return q;
}

/**
 * Apply a suggestion: fills the group and the rate unless the user has edited them. A suggested group with no loaded
 * rate leaves the rate empty (the panel then says which group needs a rate in Settings).
 */
export function applySuggestion(s: GtaPanelState, suggestion: GtaSuggestion | undefined, groups: readonly string[] = []): GtaPanelState {
  if (!suggestion) return s;
  let next: GtaPanelState = { ...s, suggestion };
  if (!s.groupDirty) {
    const group = suggestion.group ?? '';
    next = { ...next, group, groupMode: group && groups.length && !groups.includes(group) ? 'other' : 'select' };
  }
  if (!s.rateDirty) {
    const sameGroup = !next.group || (suggestion.group ?? '') === next.group;
    next = { ...next, ratePence: sameGroup ? (suggestion.rate?.dailyRatePence ?? null) : s.ratePence };
  }
  return next;
}

/**
 * The user picks or types a group. The rate follows the group's benchmark until the user has typed a rate.
 * `OTHER_GROUP` switches to free entry and keeps the current text.
 */
export function editGroup(s: GtaPanelState, value: string, rates: readonly GtaRate[] | undefined, date: ISODate): GtaPanelState {
  if (value === OTHER_GROUP) return { ...s, groupMode: 'other', groupDirty: true };
  const group = value.trim().toUpperCase();
  const next: GtaPanelState = { ...s, group, groupDirty: true };
  if (!s.rateDirty) next.ratePence = rateForGroup(group, rates, date)?.dailyRatePence ?? null;
  return next;
}

export function editGroupMode(s: GtaPanelState, mode: GtaPanelState['groupMode']): GtaPanelState {
  return { ...s, groupMode: mode };
}

/** Free entry when chosen, or when the group held has no loaded rate (it would not be in the Select). */
export function effectiveGroupMode(s: GtaPanelState, groups: readonly string[]): GtaPanelState['groupMode'] {
  if (s.groupMode === 'other') return 'other';
  if (s.group && groups.length > 0 && !groups.includes(s.group)) return 'other';
  return 'select';
}

/** The user types a rate: it is theirs from now on. */
export function editRate(s: GtaPanelState, pence: Pence | null): GtaPanelState {
  return { ...s, ratePence: pence, rateDirty: true };
}

/** Back to the suggestion (both fields follow it again). */
export function resetToSuggestion(s: GtaPanelState, groups: readonly string[] = []): GtaPanelState {
  return applySuggestion({ ...s, groupDirty: false, rateDirty: false }, s.suggestion, groups);
}

export const BASIS_LABEL: Record<GtaSuggestionBasis, string> = {
  recorded: 'already recorded for this vehicle',
  custom_override: 'from your catalogue additions',
  catalogue_trim: 'from the catalogue trim',
  catalogue_generation: 'from the catalogue generation',
  catalogue_model: 'from the catalogue model',
  segment_default: 'from the segment default',
  heuristic: 'a guess from the make, model, body and engine size',
  none: 'no suggestion'
};

/** "Suggested GTA group M1 — from the catalogue model (medium confidence)". */
export function suggestionLine(s: GtaSuggestion): string {
  if (!s.group) return 'No GTA group could be suggested — choose one.';
  return `Suggested GTA group ${s.group} — ${BASIS_LABEL[s.basis] ?? s.basis} (${s.confidence} confidence)`;
}

/** "Benchmark daily rate £65.49 (2026-27, unverified)". */
/** The benchmark line always names its group, so it is never read as the rate of a different (suggested) group. */
export function benchmarkLine(rate: Pick<GtaRate, 'group' | 'dailyRatePence' | 'period' | 'verification'> | null | undefined, formatPence: (p: Pence) => string): string | null {
  if (!rate) return null;
  return `Benchmark daily rate for ${rate.group.toUpperCase()}: ${formatPence(rate.dailyRatePence)} (${rate.period}, ${rate.verification.status})`;
}

/** "Suggested S3 (benchmark £55.00) — this unit is S1" when the saved or chosen group is not the suggested one. */
export function suggestionDiffersLine(s: Pick<GtaPanelState, 'group' | 'suggestion'>, formatPence: (p: Pence) => string): string | null {
  const sg = s.suggestion;
  if (!sg?.group || !s.group || sg.group.toUpperCase() === s.group.toUpperCase()) return null;
  return `Suggested ${sg.group.toUpperCase()}${sg.rate ? ` (benchmark ${formatPence(sg.rate.dailyRatePence)})` : ''} — this unit is ${s.group.toUpperCase()}`;
}

export interface GtaPanelView {
  suggestionText?: string;
  /** The rate loaded for the group the form holds (the suggested one, or the one the user chose). */
  rate?: GtaRate;
  /** Set when a group is chosen but no benchmark rate is loaded for it. */
  noRate?: string;
  groupPrefilled: boolean;
  ratePrefilled: boolean;
}

/** What the panel shows for the current state. */
export function panelView(s: GtaPanelState, rates: readonly GtaRate[] | undefined, date: ISODate): GtaPanelView {
  const view: GtaPanelView = {
    groupPrefilled: Boolean(s.group) && !s.groupDirty && Boolean(s.suggestion),
    ratePrefilled: s.ratePence !== null && !s.rateDirty && Boolean(s.suggestion || s.group)
  };
  if (s.suggestion) view.suggestionText = suggestionLine(s.suggestion);
  const rate = s.group ? (s.suggestion?.group === s.group && s.suggestion.rate ? s.suggestion.rate : rateForGroup(s.group, rates, date)) : undefined;
  if (rate) view.rate = rate;
  else if (s.group) view.noRate = noRateMessage(s.group);
  return view;
}

export type GtaPanelErrors = Partial<Record<'group' | 'ratePence', string>>;

export function validateGtaPanel(s: GtaPanelState): GtaPanelErrors {
  const e: GtaPanelErrors = {};
  if (!s.group) e.group = 'Choose a GTA group (industry benchmark group, e.g. S1, M, M1)';
  else if (!GTA_GROUP_RE.test(s.group)) e.group = 'A GTA group looks like S1, M, M1 or CP2';
  if (s.ratePence === null || s.ratePence <= 0) e.ratePence = 'Enter the daily rate in pounds';
  return e;
}

/** `gtaSuggestion` for POST /fleet: what was suggested, kept in the LookupRecord raw for provenance. */
export function gtaSuggestionInput(s: GtaPanelState): FleetGtaSuggestionInput | undefined {
  const sg = s.suggestion;
  if (!sg) return undefined;
  return { group: sg.group, basis: sg.basis, rateGroup: sg.rate?.group ?? null, ratePeriod: sg.rate?.period ?? null };
}
