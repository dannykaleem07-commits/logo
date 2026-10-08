/**
 * Pure helpers for exact (licensed) models — no React, no three.js (unit tested on their own).
 *
 *  - part keys: `n<node>p<primitive>`, read from GLTFLoader's `parser.associations` (the same key the API stores);
 *  - the vehicle → match query (catalogue slugs when the vehicle has them, else make / model text and year);
 *  - per-part styles for the damage view (severity / hover / selected) and the tagging tool (zone area colours);
 *  - the frame rotation that turns a model so its nose points to +X (the damage model's convention).
 */
import { HOVER_COLOUR, SEVERITY_COLOURS, type DamageMap } from '../damageModel';
import { getZone, type ZoneArea } from '../zones';
import type { ForwardAxis, Model3dMatchQuery, Model3dView } from './exactApi';

/** Anything that describes the vehicle: the damage model's VehicleIdentity, a domain Vehicle, or catalogue slugs. */
export interface ExactModelVehicle {
  make?: string;
  model?: string;
  /** Catalogue generation id ('ford-fiesta-mk7-2008-2017') or a generation name. */
  generation?: string;
  generationId?: string;
  makeSlug?: string;
  modelSlug?: string;
  body?: string;
  bodyType?: string;
  year?: number;
  yearOfManufacture?: number;
  colour?: string;
  registration?: string;
  /** Domain Vehicle.spec.catalogue */
  spec?: { catalogue?: { makeSlug?: string; modelSlug?: string; generationId?: string } } | undefined;
}

const GEN_ID = /^[a-z0-9]+(-[a-z0-9]+)+$/;

/** The /models3d/match query for a vehicle; null when there is nothing to match on. */
export function matchQueryFor(v: ExactModelVehicle | null | undefined): Model3dMatchQuery | null {
  if (!v) return null;
  const cat = v.spec?.catalogue;
  const q: Model3dMatchQuery = {};
  const makeSlug = v.makeSlug ?? cat?.makeSlug;
  const modelSlug = v.modelSlug ?? cat?.modelSlug;
  if (makeSlug && modelSlug) {
    q.makeSlug = makeSlug;
    q.modelSlug = modelSlug;
  } else if (v.make?.trim()) {
    q.make = v.make.trim();
    if (v.model?.trim()) q.model = v.model.trim();
  } else return null;
  const gen = v.generationId ?? cat?.generationId ?? (v.generation && GEN_ID.test(v.generation) ? v.generation : undefined);
  if (gen) q.generationId = gen;
  const body = v.bodyType ?? v.body;
  if (body?.trim()) q.bodyType = body.trim();
  const year = v.year ?? v.yearOfManufacture;
  if (year && Number.isInteger(year)) q.year = year;
  return q;
}

/** Stable cache key for a match query. */
export function matchKey(q: Model3dMatchQuery | null): string {
  if (!q) return '';
  return (['makeSlug', 'modelSlug', 'make', 'model', 'generationId', 'bodyType', 'year'] as const).map((k) => String(q[k] ?? '').toLowerCase()).join('|');
}

// ---------------------------------------------------------------------------
// Part keys
// ---------------------------------------------------------------------------

export interface AssocObject {
  parent: AssocObject | null;
}
export type Associations = Map<unknown, { nodes?: number; meshes?: number; primitives?: number } | undefined>;

/** `n<node>p<primitive>` for a mesh GLTFLoader created, or null for objects that are not glTF primitives. */
export function partKeyOf(obj: AssocObject, associations: Associations): string | null {
  const own = associations.get(obj);
  if (!own || own.meshes === undefined) return null;
  const primitive = own.primitives ?? 0;
  // single-primitive meshes are the node object itself; multi-primitive meshes are children of the node's group
  let node = own.nodes;
  let cur: AssocObject | null = obj.parent;
  for (let i = 0; node === undefined && cur && i < 3; i += 1) {
    node = associations.get(cur)?.nodes;
    cur = cur.parent;
  }
  return node === undefined ? null : `n${node}p${primitive}`;
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/** Y rotation (radians) that turns the model's `forward` axis to +X. */
export function yawFor(forward: ForwardAxis): number {
  switch (forward) {
    case '+z':
      return Math.PI / 2;
    case '-z':
      return -Math.PI / 2;
    case '-x':
      return Math.PI;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

export interface PartStyle {
  /** Colour blended over the part's own colour. */
  colour?: string;
  /** 0..1 blend toward `colour`. */
  mix?: number;
  /** Self-illumination (hover / selection). */
  emissive?: string;
  emissiveIntensity?: number;
  /** Fade the part (tagging: parts that are not the subject). */
  dim?: boolean;
}

/** Damage view: severity colour on damaged zones, an accent glow on hover and selection. */
export function damagePartStyle(zone: string | undefined, damage: DamageMap, hovered: string | null, selected: string | null): PartStyle | null {
  if (!zone) return null;
  const d = damage[zone];
  const style: PartStyle = {};
  if (d && d.severity > 0) {
    style.colour = SEVERITY_COLOURS[d.severity];
    style.mix = 0.78;
  }
  if (zone === selected) {
    style.emissive = HOVER_COLOUR;
    style.emissiveIntensity = 0.55;
  } else if (zone === hovered) {
    style.emissive = HOVER_COLOUR;
    style.emissiveIntensity = 0.32;
  }
  return style.colour || style.emissive ? style : null;
}

/** One colour per zone area (the tagging tool shows what each part is mapped to at a glance). */
export const AREA_COLOURS: Record<ZoneArea, string> = {
  front: '#2f7de1',
  rear: '#8b5cf6',
  side: '#14a37f',
  roof: '#0ea5b7',
  underbody: '#7c6f64',
  interior: '#b4a07a',
  glass: '#60a5fa',
  lamps: '#f59e0b',
  wheels: '#475569',
};

export const UNMAPPED_COLOUR = '#e0457b';

/** Tagging view: area colour for mapped parts, a warning pink for unmapped ones, an accent on the selected part. */
export function tagPartStyle(zone: string | null | undefined, opts: { selected: boolean; hovered: boolean; showUnmapped: boolean }): PartStyle | null {
  const style: PartStyle = {};
  if (zone) {
    const area = getZone(zone)?.area;
    if (area) {
      style.colour = AREA_COLOURS[area];
      style.mix = 0.55;
    }
  } else if (opts.showUnmapped) {
    style.colour = UNMAPPED_COLOUR;
    style.mix = 0.45;
  }
  if (opts.selected) {
    style.emissive = HOVER_COLOUR;
    style.emissiveIntensity = 0.6;
  } else if (opts.hovered) {
    style.emissive = HOVER_COLOUR;
    style.emissiveIntensity = 0.3;
  }
  return style.colour || style.emissive ? style : null;
}

/** Effective zones with unsaved edits: `pending[key]` = zone | null (not a part) | undefined (back to automatic). */
export function zonesWithPending(view: Pick<Model3dView, 'parts' | 'autoZones' | 'tags'>, pending: Record<string, string | null | 'auto'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of view.parts) {
    let zone: string | null | undefined;
    const edit = pending[p.key];
    if (edit === 'auto') zone = view.autoZones[p.key]?.zone ?? null;
    else if (edit !== undefined) zone = edit;
    else if (view.tags[p.key] !== undefined) zone = view.tags[p.key];
    else zone = view.autoZones[p.key]?.zone ?? null;
    if (zone) out[p.key] = zone;
  }
  return out;
}

/** The PUT /tags body for a set of pending edits. */
export function tagsBodyFor(pending: Record<string, string | null | 'auto'>): { tags: Record<string, string | null>; clear: string[] } {
  const tags: Record<string, string | null> = {};
  const clear: string[] = [];
  for (const [k, v] of Object.entries(pending)) {
    if (v === 'auto') clear.push(k);
    else tags[k] = v;
  }
  return { tags, clear };
}

/** Parts that can be damaged in the view, grouped by zone (one zone can be several meshes). */
export function partsByZone(zones: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, zone] of Object.entries(zones)) {
    const list = out.get(zone);
    if (list) list.push(key);
    else out.set(zone, [key]);
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export const MATCHED_ON_LABEL: Record<string, string> = {
  'generation+body': 'exact generation and body',
  generation: 'exact generation',
  'year+body': 'generation by year, same body',
  year: 'generation by year',
  'model+body': 'same model and body (any generation)',
  model: 'same model (any generation)',
};
