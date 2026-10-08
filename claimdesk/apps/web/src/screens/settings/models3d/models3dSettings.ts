/**
 * Settings → 3D models: pure helpers (file checks, zone pickers, the parts table of the tagging tool). No React.
 */
import { VEHICLE_ZONES, ZONE_AREA_LABELS, getZone, zonesByArea, type VehicleBodyType, type ZoneArea } from '../../engineer/damage3d/zones';
import type { ForwardAxis, Model3dView, ModelBodyType } from '../../engineer/damage3d/exact/exactApi';
import { formatBytes, zonesWithPending } from '../../engineer/damage3d/exact/exactModel';

export const MODEL_FILE_ACCEPT = '.glb,.gltf,.zip';
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

/** A plain reason when the picked file cannot be a model upload, else null. */
export function checkModelFile(file: { name: string; size: number } | null | undefined, maxBytes: number = DEFAULT_MAX_BYTES): string | null {
  if (!file) return 'Choose a .glb, .gltf or .zip file';
  const ext = (/\.[^.]+$/.exec(file.name.toLowerCase())?.[0] ?? '').trim();
  if (!['.glb', '.gltf', '.zip'].includes(ext)) return 'Choose a .glb or .gltf file, or a .zip holding a .gltf with its .bin and textures';
  if (file.size === 0) return 'The file is empty';
  if (file.size > maxBytes) return `The file is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}`;
  if (/audatex|qapter|solera/i.test(file.name)) return 'Audatex / Qapter models cannot be imported';
  return null;
}

export const BODY_OPTIONS: Array<{ value: ModelBodyType; label: string }> = [
  { value: 'hatchback', label: 'Hatchback' },
  { value: 'saloon', label: 'Saloon' },
  { value: 'estate', label: 'Estate' },
  { value: 'coupe', label: 'Coupe' },
  { value: 'convertible', label: 'Convertible' },
  { value: 'suv', label: 'SUV / 4x4' },
  { value: 'mpv', label: 'MPV' },
  { value: 'panel-van', label: 'Panel van' },
  { value: 'pickup', label: 'Pick-up' },
];

/** Catalogue body names → the damage model's body types. */
export function bodyFromCatalogue(body: string | undefined): ModelBodyType | undefined {
  if (!body) return undefined;
  const map: Record<string, ModelBodyType> = {
    hatchback: 'hatchback', fastback: 'hatchback', liftback: 'hatchback', saloon: 'saloon', estate: 'estate', 'shooting-brake': 'estate',
    coupe: 'coupe', convertible: 'convertible', roadster: 'convertible', suv: 'suv', crossover: 'suv', mpv: 'mpv',
    'panel-van': 'panel-van', 'crew-van': 'panel-van', minibus: 'panel-van', camper: 'panel-van', pickup: 'pickup', 'chassis-cab': 'pickup',
  };
  return map[body];
}

export interface ZoneOptionGroup {
  area: ZoneArea;
  label: string;
  options: Array<{ value: string; label: string }>;
}

/** Zone choices grouped by area; only zones that exist on `body` when it is known. */
export function zoneOptionGroups(body?: ModelBodyType): ZoneOptionGroup[] {
  if (body) return zonesByArea(body as VehicleBodyType).map((g) => ({ area: g.area, label: g.label, options: g.zones.map((z) => ({ value: z.id, label: z.label })) }));
  const order: ZoneArea[] = ['front', 'rear', 'side', 'roof', 'glass', 'lamps', 'wheels', 'underbody', 'interior'];
  return order.map((area) => ({ area, label: ZONE_AREA_LABELS[area], options: VEHICLE_ZONES.filter((z) => z.area === area).map((z) => ({ value: z.id, label: z.label })) }));
}

export type PartSource = 'tag' | 'not-a-part' | 'name' | 'name+position' | 'position' | 'none';
export type PartFilter = 'all' | 'unmapped' | 'check' | 'tagged';

export interface PartRow {
  key: string;
  name: string;
  detail: string;
  zone: string | null;
  zoneLabel: string;
  source: PartSource;
  triangles: number;
  /** Has an unsaved edit. */
  pending: boolean;
}

export const SOURCE_LABEL: Record<PartSource, string> = {
  tag: 'Tagged',
  'not-a-part': 'Not a damage part',
  name: 'Auto · name',
  'name+position': 'Auto · name + position',
  position: 'Auto · position (check)',
  none: 'Not mapped',
};

export function partRows(view: Pick<Model3dView, 'parts' | 'autoZones' | 'tags'>, pending: Record<string, string | null | 'auto'>, filter: PartFilter = 'all', search = ''): PartRow[] {
  const zones = zonesWithPending(view, pending);
  const q = search.trim().toLowerCase();
  const rows: PartRow[] = [];
  for (const p of view.parts) {
    const edit = pending[p.key];
    const tagged = edit !== undefined ? edit !== 'auto' : view.tags[p.key] !== undefined;
    const tagValue = edit !== undefined && edit !== 'auto' ? edit : view.tags[p.key];
    const auto = view.autoZones[p.key];
    const zone = zones[p.key] ?? null;
    const source: PartSource = tagged ? (tagValue === null ? 'not-a-part' : 'tag') : auto?.zone ? auto.source : 'none';
    const detail = [p.meshName && p.meshName !== p.name ? p.meshName : '', p.materialName ? `material ${p.materialName}` : '', p.parents[0] ? `in ${p.parents[0]}` : ''].filter(Boolean).join(' · ');
    const row: PartRow = { key: p.key, name: p.name, detail, zone, zoneLabel: zone ? (getZone(zone)?.label ?? zone) : source === 'not-a-part' ? '—' : 'Not mapped', source, triangles: p.triangles, pending: edit !== undefined };
    if (filter === 'unmapped' && (zone || source === 'not-a-part')) continue;
    if (filter === 'check' && source !== 'position' && source !== 'name+position') continue;
    if (filter === 'tagged' && source !== 'tag' && source !== 'not-a-part') continue;
    if (q && !`${row.name} ${row.detail} ${row.zoneLabel} ${row.key}`.toLowerCase().includes(q)) continue;
    rows.push(row);
  }
  return rows;
}

export function mappingSummary(view: Pick<Model3dView, 'parts' | 'autoZones' | 'tags'>, pending: Record<string, string | null | 'auto'>): { parts: number; mapped: number; unmapped: number; check: number; tagged: number } {
  const all = partRows(view, pending);
  return {
    parts: all.length,
    mapped: all.filter((r) => r.zone).length,
    unmapped: all.filter((r) => !r.zone && r.source !== 'not-a-part').length,
    check: all.filter((r) => r.source === 'position' || r.source === 'name+position').length,
    tagged: all.filter((r) => r.source === 'tag' || r.source === 'not-a-part').length,
  };
}

export const FORWARD_LABEL: Record<ForwardAxis, string> = { '+z': '+Z (glTF standard)', '-z': '−Z', '+x': '+X', '-x': '−X' };

/** Turn the model's nose 180° (front ↔ rear). */
export function reverseForward(f: ForwardAxis): ForwardAxis {
  return (f.startsWith('+') ? `-${f[1]}` : `+${f[1]}`) as ForwardAxis;
}
/** Turn the model's nose 90° (when the long axis was picked wrong). */
export function turnForward(f: ForwardAxis): ForwardAxis {
  const order: ForwardAxis[] = ['+z', '-x', '-z', '+x'];
  return order[(order.indexOf(f) + 1) % 4]!;
}

export function assignmentLabel(a: Model3dView['assignment']): string {
  return `${a.make} ${a.model}${a.generation ? ` · ${a.generation}` : ' · all generations'}${a.bodyType ? ` · ${BODY_OPTIONS.find((b) => b.value === a.bodyType)?.label ?? a.bodyType}` : ''}`;
}
