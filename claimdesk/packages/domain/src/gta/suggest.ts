/**
 * GTA group suggestion for a vehicle (TEMPLATES-VEHICLES-DESKTOP §D.6). Pure: the API passes the catalogue facts, the
 * segment defaults (DB overrides over the KB file) and the merged rate table.
 *
 * Order: group recorded on the vehicle (high) → user catalogue override (medium) → catalogue trim → generation → model
 * (medium) → segment default (low) → `mapGtaGroup` heuristic (low) → none. A suggestion is never a GTA ruling: CCGUK is
 * not a GTA subscriber and the GTA vehicle list is not held, so every result carries that note.
 */
import type { GtaRate, ISODate, Vehicle } from '../types.js';
import { mapGtaGroup } from './groups.js';
import { GTA_NON_SUBSCRIBER_NOTE, gtaRate } from './rates.js';

export type GtaSuggestionBasis = 'recorded' | 'custom_override' | 'catalogue_trim' | 'catalogue_generation' | 'catalogue_model' | 'segment_default' | 'heuristic' | 'none';

export interface GtaSuggestInput {
  /** vehicle.gtaGroup / fleet unit group already set. */
  recordedGroup?: string;
  /** vehicle_catalogue_custom override row. */
  customOverride?: string;
  catalogue?: { trimGroup?: string; generationGroup?: string; modelGroup?: string; segment?: string };
  /** DB overrides ⊕ KB defaults. */
  segmentDefaults: Record<string, string>;
  /** For the mapGtaGroup fallback. */
  vehicle: Pick<Vehicle, 'make' | 'model' | 'variant' | 'bodyType' | 'engineCapacityCc' | 'fuelType'>;
  date: ISODate;
  /** Merged rates (KB ⊕ manual). */
  rates: GtaRate[];
}

export interface GtaSuggestion {
  group: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  basis: GtaSuggestionBasis;
  /** Plain sentence(s) saying where the group came from (and when no rate is loaded for it). */
  reason: string;
  segment?: string;
  rate: (GtaRate & { origin?: 'kb' | 'manual' }) | null;
  note: string;
}

export const GTA_SUGGESTION_NOTE = `${GTA_NON_SUBSCRIBER_NOTE} This is a suggestion only — confirm the group.`;

const GROUP_RE = /^[A-Z]{1,3}\d{0,2}$/;

function clean(group: string | undefined | null): string | undefined {
  if (typeof group !== 'string') return undefined;
  const g = group.trim().toUpperCase();
  return GROUP_RE.test(g) ? g : undefined;
}

/** "No benchmark rate is loaded for group X on <date> — add it in Settings → GTA benchmark rates". */
export function noBenchmarkRateReason(group: string, date: ISODate): string {
  return `No benchmark rate is loaded for group ${group} on ${date} — add it in Settings → GTA benchmark rates.`;
}

export function suggestGtaGroup(input: GtaSuggestInput): GtaSuggestion {
  const segment = input.catalogue?.segment?.trim() || undefined;
  const pick = (): { group: string; confidence: GtaSuggestion['confidence']; basis: GtaSuggestionBasis; reason: string } | undefined => {
    const recorded = clean(input.recordedGroup);
    if (recorded) return { group: recorded, confidence: 'high', basis: 'recorded', reason: `Group ${recorded} is already recorded for this vehicle.` };
    const custom = clean(input.customOverride);
    if (custom) return { group: custom, confidence: 'medium', basis: 'custom_override', reason: `Group ${custom} is set for this vehicle in your catalogue additions.` };
    const trim = clean(input.catalogue?.trimGroup);
    if (trim) return { group: trim, confidence: 'medium', basis: 'catalogue_trim', reason: `Group ${trim} is suggested for this trim in the vehicle catalogue (unverified).` };
    const gen = clean(input.catalogue?.generationGroup);
    if (gen) return { group: gen, confidence: 'medium', basis: 'catalogue_generation', reason: `Group ${gen} is suggested for this model generation in the vehicle catalogue (unverified).` };
    const model = clean(input.catalogue?.modelGroup);
    if (model) return { group: model, confidence: 'medium', basis: 'catalogue_model', reason: `Group ${model} is suggested for this model in the vehicle catalogue (unverified).` };
    if (segment) {
      const def = clean(input.segmentDefaults[segment]);
      if (def) return { group: def, confidence: 'low', basis: 'segment_default', reason: `Group ${def} is the starting suggestion for the ${segment} segment.` };
    }
    const v = input.vehicle;
    const known = (s: string | undefined) => Boolean(s && s.trim() && s.trim().toUpperCase() !== 'UNKNOWN');
    if (known(v.make) || known(v.model)) {
      const m = mapGtaGroup({ make: v.make ?? '', model: v.model ?? '', variant: v.variant, bodyType: v.bodyType, engineCapacityCc: v.engineCapacityCc, fuelType: v.fuelType }, input.rates);
      const g = clean(m.group);
      if (g) return { group: g, confidence: 'low', basis: 'heuristic', reason: `Group ${g} is a heuristic guess from the make, model, body and engine size.` };
    }
    return undefined;
  };

  const chosen = pick();
  if (!chosen) {
    return {
      group: null,
      confidence: 'none',
      basis: 'none',
      reason: 'Not enough is known about the vehicle to suggest a GTA group — choose one.',
      ...(segment ? { segment } : {}),
      rate: null,
      note: GTA_SUGGESTION_NOTE,
    };
  }
  const rate = gtaRate(chosen.group, input.date, input.rates) ?? null;
  return {
    group: chosen.group,
    confidence: chosen.confidence,
    basis: chosen.basis,
    reason: rate ? chosen.reason : `${chosen.reason} ${noBenchmarkRateReason(chosen.group, input.date)}`,
    ...(segment ? { segment } : {}),
    rate,
    note: GTA_SUGGESTION_NOTE,
  };
}
