/**
 * Pure state and colour helpers for the damage model (no React, no three.js) — unit tested on their own.
 */
import type { Tone } from './geometry';
import {
  DAMAGE_SEVERITY_LABELS,
  ZONE_OPERATION_LABELS,
  getZone,
  isZoneId,
  normaliseBodyType,
  suggestOperation,
  zoneAppliesToBody,
  zonesByArea,
  type DamageSeverity,
  type VehicleBodyType,
  type VehicleZone,
  type ZoneOperation
} from './zones';

export type { DamageSeverity, VehicleBodyType, ZoneOperation };

export interface ZoneDamage {
  severity: DamageSeverity;
  operation?: ZoneOperation;
  /** 0..1, only meaningful for AI suggestions. */
  confidence?: number;
  source: 'ai' | 'user';
}
export type DamageMap = Record<string, ZoneDamage>;

// ── colours ──

/** Severity fills (none = the part's own finish). Amber → orange → red reads in colour and in greyscale print. */
export const SEVERITY_COLOURS: Record<DamageSeverity, string> = {
  0: '#e6eaf0',
  1: '#f6c445',
  2: '#ee8435',
  3: '#d23b3b'
};

export const TONE_COLOURS: Record<Tone, string> = {
  body: '#e6eaf0',
  frame: '#b9c2cf',
  trim: '#7f8a99',
  glass: '#b7cde6',
  lamp: '#f7f9fc',
  soft: '#59606b',
  tyre: '#3b414b',
  rearlamp: '#e8a3a3',
  chrome: '#c9d1dc',
  black: '#5b6370',
  rim: '#c3cad4',
  liner: '#4a515c'
};

export const HOVER_COLOUR = '#1466d2';

export function zoneFill(tone: Tone, damage: ZoneDamage | undefined): string {
  const sev = damage?.severity ?? 0;
  return sev > 0 ? SEVERITY_COLOURS[sev] : TONE_COLOURS[tone];
}

export const SEVERITY_LEGEND: Array<{ severity: DamageSeverity; label: string; colour: string }> = ([0, 1, 2, 3] as const).map((s) => ({
  severity: s,
  label: DAMAGE_SEVERITY_LABELS[s],
  colour: SEVERITY_COLOURS[s]
}));

// ── reducer ──

export type DamageAction =
  | { type: 'setSeverity'; zone: string; severity: DamageSeverity }
  | { type: 'cycle'; zone: string }
  | { type: 'setOperation'; zone: string; operation: ZoneOperation | undefined }
  | { type: 'confirm'; zone: string }
  | { type: 'clear'; zone: string }
  | { type: 'clearAll' };

function userEntry(prev: ZoneDamage | undefined, patch: Partial<ZoneDamage>): ZoneDamage {
  const next: ZoneDamage = { ...prev, ...patch, source: 'user' } as ZoneDamage;
  delete next.confidence;
  if (next.operation === undefined) delete next.operation;
  return next;
}

/**
 * Damage edits. Any edit by the user turns an AI suggestion into a user entry (confidence dropped). Setting a zone to
 * none removes it — except an AI suggestion, which is kept as `{severity: 0, source: 'user'}` so the rejection is
 * remembered and the same suggestion is not shown again. Unknown zone ids are ignored. Unchanged → same object.
 */
export function damageReducer(state: DamageMap, action: DamageAction): DamageMap {
  if (action.type === 'clearAll') return Object.keys(state).length ? {} : state;
  if (!isZoneId(action.zone)) return state;
  const prev = state[action.zone];
  switch (action.type) {
    case 'setSeverity':
    case 'clear': {
      const severity = action.type === 'clear' ? 0 : action.severity;
      if (severity === 0) {
        if (!prev) return state;
        if (prev.source === 'ai') return { ...state, [action.zone]: { severity: 0, source: 'user' } };
        if (prev.severity === 0) return state;
        const { [action.zone]: _gone, ...rest } = state;
        return rest;
      }
      if (prev && prev.severity === severity && prev.source === 'user') return state;
      const operation = prev?.operation ?? suggestOperation(action.zone, severity);
      return { ...state, [action.zone]: userEntry(prev, { severity, operation }) };
    }
    case 'cycle': {
      const cur = prev?.severity ?? 0;
      return damageReducer(state, { type: 'setSeverity', zone: action.zone, severity: ((cur + 1) % 4) as DamageSeverity });
    }
    case 'setOperation': {
      if (!prev || prev.severity === 0) return state;
      if (prev.operation === action.operation && prev.source === 'user') return state;
      return { ...state, [action.zone]: userEntry(prev, { operation: action.operation }) };
    }
    case 'confirm': {
      if (!prev || prev.source !== 'ai') return state;
      return { ...state, [action.zone]: userEntry(prev, {}) };
    }
  }
}

// ── lists & labels ──

export interface DamagedZoneRow {
  zone: VehicleZone;
  damage: ZoneDamage;
  /** False when the zone does not exist on the current body (e.g. a boot lid recorded on a hatchback). */
  onBody: boolean;
}

/** Damaged zones (severity > 0), heaviest first, then taxonomy order. */
export function damagedZones(damage: DamageMap, body: VehicleBodyType): DamagedZoneRow[] {
  const rows: Array<DamagedZoneRow & { order: number }> = [];
  for (const [id, d] of Object.entries(damage)) {
    const zone = getZone(id);
    if (!zone || !d || d.severity <= 0) continue;
    rows.push({ zone, damage: d, onBody: zoneAppliesToBody(zone, body), order: ZONE_ORDER.get(id) ?? 0 });
  }
  rows.sort((a, b) => b.damage.severity - a.damage.severity || a.order - b.order);
  return rows.map(({ order: _o, ...r }) => r);
}

const ZONE_ORDER: ReadonlyMap<string, number> = (() => {
  const seen = new Map<string, number>();
  for (const b of ['hatchback', 'saloon', 'estate', 'coupe', 'convertible', 'suv', 'mpv', 'panel-van', 'pickup'] as const) {
    for (const g of zonesByArea(b)) for (const z of g.zones) if (!seen.has(z.id)) seen.set(z.id, seen.size);
  }
  return seen;
})();

export function damageSummary(damage: DamageMap): string {
  const counts = [0, 0, 0, 0];
  for (const d of Object.values(damage)) if (d && d.severity > 0) counts[d.severity]! += 1;
  const total = counts[1]! + counts[2]! + counts[3]!;
  if (!total) return 'No damage marked';
  const bits = ([3, 2, 1] as const).filter((s) => counts[s]).map((s) => `${counts[s]} ${DAMAGE_SEVERITY_LABELS[s].toLowerCase()}`);
  return `${total} part${total === 1 ? '' : 's'} damaged: ${bits.join(', ')}`;
}

export function describeDamage(d: ZoneDamage): string {
  const bits: string[] = [DAMAGE_SEVERITY_LABELS[d.severity]];
  if (d.operation) bits.push(ZONE_OPERATION_LABELS[d.operation]);
  if (d.source === 'ai') bits.push(d.confidence !== undefined ? `AI ${Math.round(d.confidence * 100)}%` : 'AI');
  return bits.join(' · ');
}

/** Accepts a body type or any free-text body description. */
export function resolveBody(body: VehicleBodyType | string | null | undefined): VehicleBodyType {
  return normaliseBodyType(body ?? '');
}
