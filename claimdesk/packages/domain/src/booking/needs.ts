// owned by ap-booking
/** Hire needs defaults (docs/SUPREME-AUTOPILOT.md §B.5, §F.3). Pure. */
import type { HireNeeds } from './types.js';

/** Nothing known yet: no hard needs, every preference off, every answer unknown. */
export function blankHireNeeds(): HireNeeds {
  return {
    neededFrom: null,
    deliveryAddress: null,
    deliveryPostcode: null,
    seatsMin: null,
    automaticOnly: false,
    automaticPreferred: false,
    towbar: false,
    wheelchairAccessible: false,
    handControls: false,
    isofixCount: 0,
    evOk: null,
    phvWork: false,
    largeBoot: false,
    occupation: null,
    journeys: null,
    dependants: null,
    otherVehicles: 'unknown',
    ownInsurerCourtesyCar: 'unknown',
    clientCoverType: 'unknown',
    clientWantsHire: null,
    notes: null,
    source: {},
  };
}

/** Stored needs merged over the blank defaults (new keys never need a migration). */
export function withHireNeedsDefaults(stored: Partial<HireNeeds> | null | undefined): HireNeeds {
  const base = blankHireNeeds();
  if (!stored || typeof stored !== 'object') return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(stored)) if (v !== undefined && k in base) out[k] = v;
  return out as unknown as HireNeeds;
}
