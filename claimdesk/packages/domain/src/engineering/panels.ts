/**
 * Vehicle zone taxonomy — ClaimDesk's own named panels/parts, used by the 3D damage model, photo findings, estimate
 * line matching and engineer reports. This is original data (no Audatex or OEM model data), deliberately coarse:
 * one zone per part an engineer would talk about on a UK motor claim.
 *
 * Sides follow the vehicle (driver's view): L = left = nearside (N/S) in the UK, R = right = offside (O/S).
 * Some zones only exist on some bodies (tailgate vs boot lid, sliding door, load bed); `zonesForBody` filters.
 */

export const VEHICLE_BODY_TYPES = ['hatchback', 'saloon', 'estate', 'coupe', 'convertible', 'suv', 'mpv', 'panel-van', 'pickup'] as const;
export type VehicleBodyType = (typeof VEHICLE_BODY_TYPES)[number];

export const VEHICLE_BODY_LABELS: Record<VehicleBodyType, string> = {
  hatchback: 'Hatchback',
  saloon: 'Saloon',
  estate: 'Estate',
  coupe: 'Coupe',
  convertible: 'Convertible',
  suv: 'SUV / 4x4',
  mpv: 'MPV',
  'panel-van': 'Panel van',
  pickup: 'Pick-up'
};

export type ZoneSide = 'L' | 'R' | 'centre';
export type ZoneArea = 'front' | 'rear' | 'side' | 'roof' | 'underbody' | 'interior' | 'glass' | 'lamps' | 'wheels';
export type ZoneKind = 'panel' | 'bumper' | 'lamp' | 'glass' | 'trim' | 'mirror' | 'wheel' | 'structural' | 'mechanical' | 'sensor';
export type ZoneOperation = 'repair' | 'replace' | 'paint' | 'blend' | 'r_and_i';

export const ZONE_OPERATIONS: readonly ZoneOperation[] = ['repair', 'replace', 'paint', 'blend', 'r_and_i'];
export const ZONE_OPERATION_LABELS: Record<ZoneOperation, string> = {
  repair: 'Repair',
  replace: 'Replace',
  paint: 'Paint',
  blend: 'Blend',
  r_and_i: 'R&I'
};
export const ZONE_AREA_LABELS: Record<ZoneArea, string> = {
  front: 'Front',
  rear: 'Rear',
  side: 'Sides',
  roof: 'Roof',
  underbody: 'Underbody',
  interior: 'Interior',
  glass: 'Glass',
  lamps: 'Lamps',
  wheels: 'Wheels & suspension'
};

export interface VehicleZone {
  id: string;
  label: string;
  side: ZoneSide;
  area: ZoneArea;
  kind: ZoneKind;
  /** Typical operations, most likely first. */
  operations: readonly ZoneOperation[];
  /** Bodies this zone exists on; undefined = every body. */
  bodies?: readonly VehicleBodyType[];
  /** Extra words used to match free-text panel names (estimate lines, photo findings). */
  aliases?: readonly string[];
}

const CARS: readonly VehicleBodyType[] = ['hatchback', 'saloon', 'estate', 'coupe', 'convertible', 'suv', 'mpv'];
const FOUR_DOOR: readonly VehicleBodyType[] = ['hatchback', 'saloon', 'estate', 'suv', 'pickup'];
const TAILGATE: readonly VehicleBodyType[] = ['hatchback', 'estate', 'suv', 'mpv'];
const BOOT: readonly VehicleBodyType[] = ['saloon', 'coupe', 'convertible'];
const FIXED_ROOF: readonly VehicleBodyType[] = ['hatchback', 'saloon', 'estate', 'coupe', 'suv', 'mpv', 'panel-van', 'pickup'];
const SLIDING: readonly VehicleBodyType[] = ['mpv', 'panel-van'];
const NOT_VAN_PICKUP: readonly VehicleBodyType[] = CARS;

const PANEL_OPS: readonly ZoneOperation[] = ['repair', 'replace', 'paint', 'blend', 'r_and_i'];
const BUMPER_OPS: readonly ZoneOperation[] = ['repair', 'replace', 'paint', 'r_and_i'];
const SWAP_OPS: readonly ZoneOperation[] = ['replace', 'r_and_i'];
const GLASS_OPS: readonly ZoneOperation[] = ['replace', 'repair', 'r_and_i'];
const STRUCT_OPS: readonly ZoneOperation[] = ['repair', 'replace', 'paint'];
const MECH_OPS: readonly ZoneOperation[] = ['replace', 'repair', 'r_and_i'];

type ZoneSeed = Omit<VehicleZone, 'side'> & { side?: ZoneSide };

function pair(base: string, label: string, z: Omit<ZoneSeed, 'id' | 'label'>): VehicleZone[] {
  return [
    { ...z, id: `${base}_l`, label: `${label} (N/S, left)`, side: 'L' },
    { ...z, id: `${base}_r`, label: `${label} (O/S, right)`, side: 'R' }
  ];
}
function one(z: ZoneSeed): VehicleZone {
  return { side: 'centre', ...z };
}

/** The full taxonomy (77 zones). Order = display order within an area. */
export const VEHICLE_ZONES: readonly VehicleZone[] = [
  // ── front ──
  one({ id: 'front_bumper', label: 'Front bumper', area: 'front', kind: 'bumper', operations: BUMPER_OPS, aliases: ['front bumper', 'f bumper', 'bumper front', 'front bar'] }),
  one({ id: 'front_lower_grille', label: 'Front bumper lower grille', area: 'front', kind: 'trim', operations: SWAP_OPS, aliases: ['lower grille', 'bumper grille', 'lower grill'] }),
  one({ id: 'grille', label: 'Radiator grille', area: 'front', kind: 'trim', operations: SWAP_OPS, aliases: ['grille', 'grill', 'radiator grille', 'front grille'] }),
  one({ id: 'bonnet', label: 'Bonnet', area: 'front', kind: 'panel', operations: PANEL_OPS, aliases: ['bonnet', 'hood'] }),
  one({ id: 'front_panel', label: 'Front panel (slam panel)', area: 'front', kind: 'structural', operations: STRUCT_OPS, aliases: ['front panel', 'slam panel', 'upper crossmember', 'front crossmember', 'bonnet slam', 'front end carrier'] }),
  one({ id: 'radiator', label: 'Radiator / cooling pack', area: 'front', kind: 'mechanical', operations: MECH_OPS, aliases: ['radiator', 'condenser', 'cooling pack', 'intercooler', 'cooling fan'] }),
  one({ id: 'front_parking_sensors', label: 'Front parking sensors', area: 'front', kind: 'sensor', operations: ['replace', 'r_and_i'], aliases: ['front parking sensor', 'front pdc', 'front park sensor'] }),
  one({ id: 'front_radar', label: 'Front radar / ADAS sensor', area: 'front', kind: 'sensor', operations: ['replace', 'r_and_i'], aliases: ['radar', 'acc sensor', 'adas', 'distance sensor', 'front camera'] }),
  ...pair('chassis_leg', 'Front chassis leg', { area: 'front', kind: 'structural', operations: STRUCT_OPS, aliases: ['chassis leg', 'chassis rail', 'front leg', 'crash can', 'inner wing'] }),

  // ── lamps ──
  ...pair('headlamp', 'Headlamp', { area: 'lamps', kind: 'lamp', operations: ['replace', 'r_and_i', 'repair'], aliases: ['headlamp', 'headlight', 'head lamp', 'head light'] }),
  ...pair('fog_lamp', 'Front fog lamp', { area: 'lamps', kind: 'lamp', operations: SWAP_OPS, aliases: ['fog lamp', 'fog light', 'foglamp', 'drl'] }),
  ...pair('rear_lamp', 'Rear lamp', { area: 'lamps', kind: 'lamp', operations: SWAP_OPS, aliases: ['rear lamp', 'tail lamp', 'tail light', 'rear light', 'taillight', 'combination lamp'] }),
  one({ id: 'high_level_brake_lamp', label: 'High-level brake lamp', area: 'lamps', kind: 'lamp', operations: SWAP_OPS, aliases: ['high level brake', 'third brake', 'high-level brake', 'hlbl'] }),

  // ── sides ──
  ...pair('front_wing', 'Front wing', { area: 'side', kind: 'panel', operations: PANEL_OPS, aliases: ['front wing', 'wing', 'fender', 'front fender'] }),
  ...pair('front_door', 'Front door', { area: 'side', kind: 'panel', operations: PANEL_OPS, aliases: ['front door', 'door front', 'driver door', 'passenger door'] }),
  ...pair('rear_door', 'Rear door', { area: 'side', kind: 'panel', operations: PANEL_OPS, bodies: FOUR_DOOR, aliases: ['rear door', 'back door', 'door rear'] }),
  ...pair('sliding_door', 'Sliding side door', { area: 'side', kind: 'panel', operations: PANEL_OPS, bodies: SLIDING, aliases: ['sliding door', 'side load door', 'slide door', 'side door'] }),
  ...pair('quarter_panel', 'Rear quarter panel', { area: 'side', kind: 'panel', operations: PANEL_OPS, bodies: CARS, aliases: ['quarter panel', 'rear quarter', 'rear wing', 'quarter', 'qtr panel', 'rear fender'] }),
  ...pair('load_side_panel', 'Load area side panel', { area: 'side', kind: 'panel', operations: PANEL_OPS, bodies: ['panel-van'], aliases: ['load area side', 'side panel', 'body side', 'rear side panel', 'load side'] }),
  ...pair('load_bed_side', 'Load bed side', { area: 'side', kind: 'panel', operations: PANEL_OPS, bodies: ['pickup'], aliases: ['bed side', 'load bed side', 'box side', 'tub side'] }),
  ...pair('sill', 'Sill', { area: 'side', kind: 'panel', operations: PANEL_OPS, aliases: ['sill', 'rocker', 'side skirt', 'sill panel'] }),
  ...pair('a_pillar', 'A-pillar', { area: 'side', kind: 'structural', operations: STRUCT_OPS, aliases: ['a pillar', 'a-post', 'windscreen pillar'] }),
  ...pair('b_pillar', 'B-pillar', { area: 'side', kind: 'structural', operations: STRUCT_OPS, aliases: ['b pillar', 'b-post', 'centre pillar'] }),
  ...pair('door_mirror', 'Door mirror', { area: 'side', kind: 'mirror', operations: ['replace', 'repair', 'paint', 'r_and_i'], aliases: ['door mirror', 'wing mirror', 'mirror', 'side mirror', 'mirror cover', 'mirror glass'] }),
  ...pair('wheel_arch_trim', 'Wheel arch trim', { area: 'side', kind: 'trim', operations: SWAP_OPS, bodies: ['suv', 'pickup'], aliases: ['arch trim', 'wheel arch trim', 'arch moulding', 'arch extension', 'cladding'] }),

  // ── glass ──
  one({ id: 'windscreen', label: 'Windscreen', area: 'glass', kind: 'glass', operations: GLASS_OPS, aliases: ['windscreen', 'windshield', 'front screen'] }),
  one({ id: 'rear_screen', label: 'Rear screen', area: 'glass', kind: 'glass', operations: GLASS_OPS, bodies: ['hatchback', 'saloon', 'estate', 'coupe', 'suv', 'mpv', 'pickup'], aliases: ['rear screen', 'rear window', 'back glass', 'rear windscreen', 'backlight', 'tailgate glass'] }),
  ...pair('front_door_glass', 'Front door glass', { area: 'glass', kind: 'glass', operations: GLASS_OPS, aliases: ['front door glass', 'front side window', 'door glass front', 'front window'] }),
  ...pair('rear_door_glass', 'Rear door glass', { area: 'glass', kind: 'glass', operations: GLASS_OPS, bodies: FOUR_DOOR, aliases: ['rear door glass', 'rear side window', 'door glass rear', 'rear window door'] }),
  ...pair('quarter_glass', 'Rear quarter glass', { area: 'glass', kind: 'glass', operations: GLASS_OPS, bodies: NOT_VAN_PICKUP, aliases: ['quarter glass', 'quarter light', 'quarter window', 'rear side glass'] }),
  one({ id: 'sunroof', label: 'Sunroof glass', area: 'glass', kind: 'glass', operations: GLASS_OPS, bodies: ['hatchback', 'saloon', 'estate', 'coupe', 'suv', 'mpv'], aliases: ['sunroof', 'sun roof', 'panoramic roof', 'glass roof'] }),

  // ── roof ──
  one({ id: 'roof', label: 'Roof panel', area: 'roof', kind: 'panel', operations: PANEL_OPS, bodies: FIXED_ROOF, aliases: ['roof', 'roof panel', 'roof skin'] }),
  one({ id: 'soft_top', label: 'Soft top (hood)', area: 'roof', kind: 'trim', operations: ['replace', 'repair', 'r_and_i'], bodies: ['convertible'], aliases: ['soft top', 'hood', 'roof canvas', 'convertible roof', 'hood fabric'] }),
  ...pair('roof_rail', 'Roof rail', { area: 'roof', kind: 'trim', operations: SWAP_OPS, bodies: ['estate', 'suv'], aliases: ['roof rail', 'roof bar'] }),

  // ── rear ──
  one({ id: 'rear_bumper', label: 'Rear bumper', area: 'rear', kind: 'bumper', operations: BUMPER_OPS, aliases: ['rear bumper', 'r bumper', 'bumper rear', 'back bumper', 'rear bar'] }),
  one({ id: 'tailgate', label: 'Tailgate', area: 'rear', kind: 'panel', operations: PANEL_OPS, bodies: TAILGATE, aliases: ['tailgate', 'hatch', 'rear hatch', 'boot door', 'liftgate'] }),
  one({ id: 'boot_lid', label: 'Boot lid', area: 'rear', kind: 'panel', operations: PANEL_OPS, bodies: BOOT, aliases: ['boot lid', 'bootlid', 'trunk lid', 'boot', 'decklid'] }),
  ...pair('rear_load_door', 'Rear load door', { area: 'rear', kind: 'panel', operations: PANEL_OPS, bodies: ['panel-van'], aliases: ['rear load door', 'barn door', 'rear van door', 'back door van', 'rear cargo door'] }),
  one({ id: 'load_bed_tailgate', label: 'Load bed tailgate', area: 'rear', kind: 'panel', operations: PANEL_OPS, bodies: ['pickup'], aliases: ['bed tailgate', 'drop side', 'tail board', 'tailboard', 'load bed tailgate'] }),
  one({ id: 'load_bed_floor', label: 'Load bed floor', area: 'rear', kind: 'panel', operations: STRUCT_OPS, bodies: ['pickup'], aliases: ['bed floor', 'load bed', 'tub', 'bed liner'] }),
  one({ id: 'rear_panel', label: 'Rear panel (back panel)', area: 'rear', kind: 'structural', operations: STRUCT_OPS, aliases: ['rear panel', 'back panel', 'rear valance', 'rear crossmember', 'rear end panel'] }),
  one({ id: 'boot_floor', label: 'Boot floor', area: 'rear', kind: 'structural', operations: STRUCT_OPS, bodies: CARS, aliases: ['boot floor', 'spare wheel well', 'trunk floor', 'luggage floor'] }),
  one({ id: 'rear_parking_sensors', label: 'Rear parking sensors', area: 'rear', kind: 'sensor', operations: ['replace', 'r_and_i'], aliases: ['rear parking sensor', 'rear pdc', 'reversing sensor', 'rear park sensor'] }),
  one({ id: 'reversing_camera', label: 'Reversing camera', area: 'rear', kind: 'sensor', operations: ['replace', 'r_and_i'], aliases: ['reversing camera', 'rear camera', 'reverse camera', 'backup camera'] }),
  one({ id: 'spoiler', label: 'Rear spoiler', area: 'rear', kind: 'trim', operations: ['replace', 'paint', 'r_and_i'], bodies: CARS, aliases: ['spoiler', 'rear wing spoiler', 'lip spoiler'] }),

  // ── wheels & suspension ──
  one({ id: 'wheel_fl', label: 'Wheel & tyre front N/S (left)', side: 'L', area: 'wheels', kind: 'wheel', operations: ['replace', 'repair'], aliases: ['wheel', 'alloy', 'tyre', 'tire', 'rim'] }),
  one({ id: 'wheel_fr', label: 'Wheel & tyre front O/S (right)', side: 'R', area: 'wheels', kind: 'wheel', operations: ['replace', 'repair'], aliases: ['wheel', 'alloy', 'tyre', 'tire', 'rim'] }),
  one({ id: 'wheel_rl', label: 'Wheel & tyre rear N/S (left)', side: 'L', area: 'wheels', kind: 'wheel', operations: ['replace', 'repair'], aliases: ['wheel', 'alloy', 'tyre', 'tire', 'rim'] }),
  one({ id: 'wheel_rr', label: 'Wheel & tyre rear O/S (right)', side: 'R', area: 'wheels', kind: 'wheel', operations: ['replace', 'repair'], aliases: ['wheel', 'alloy', 'tyre', 'tire', 'rim'] }),
  ...pair('front_suspension', 'Front suspension', { area: 'wheels', kind: 'mechanical', operations: MECH_OPS, aliases: ['front suspension', 'wishbone', 'track control arm', 'strut', 'hub', 'steering arm', 'track rod', 'lower arm'] }),
  ...pair('rear_suspension', 'Rear suspension', { area: 'wheels', kind: 'mechanical', operations: MECH_OPS, aliases: ['rear suspension', 'rear axle', 'trailing arm', 'rear beam', 'rear shock'] }),

  // ── underbody ──
  one({ id: 'floor_pan', label: 'Floor pan', area: 'underbody', kind: 'structural', operations: STRUCT_OPS, aliases: ['floor pan', 'floor', 'underbody', 'floorpan'] }),
  one({ id: 'exhaust', label: 'Exhaust system', area: 'underbody', kind: 'mechanical', operations: MECH_OPS, aliases: ['exhaust', 'silencer', 'tailpipe', 'back box', 'dpf', 'catalytic'] }),

  // ── interior ──
  one({ id: 'dashboard', label: 'Dashboard', area: 'interior', kind: 'trim', operations: ['replace', 'repair', 'r_and_i'], aliases: ['dashboard', 'dash', 'fascia', 'instrument panel'] }),
  one({ id: 'airbags', label: 'Airbags / SRS', area: 'interior', kind: 'mechanical', operations: ['replace'], aliases: ['airbag', 'srs', 'seat belt pretensioner', 'pretensioner', 'curtain airbag'] }),
  one({ id: 'seats', label: 'Seats & interior trim', area: 'interior', kind: 'trim', operations: ['replace', 'repair', 'r_and_i'], aliases: ['seat', 'seats', 'headlining', 'interior trim', 'door card', 'upholstery'] })
];

const BY_ID = new Map(VEHICLE_ZONES.map((z) => [z.id, z]));

export function getZone(id: string): VehicleZone | undefined {
  return BY_ID.get(id);
}
export function isZoneId(id: string): boolean {
  return BY_ID.has(id);
}

export function zoneAppliesToBody(zoneOrId: VehicleZone | string, body: VehicleBodyType): boolean {
  const z = typeof zoneOrId === 'string' ? BY_ID.get(zoneOrId) : zoneOrId;
  if (!z) return false;
  return !z.bodies || z.bodies.includes(body);
}

const BODY_CACHE = new Map<VehicleBodyType, readonly VehicleZone[]>();
/** Zones present on a body type, in taxonomy order. */
export function zonesForBody(body: VehicleBodyType): readonly VehicleZone[] {
  let hit = BODY_CACHE.get(body);
  if (!hit) {
    hit = VEHICLE_ZONES.filter((z) => zoneAppliesToBody(z, body));
    BODY_CACHE.set(body, hit);
  }
  return hit;
}

/** Zones for a body grouped by area, areas in a stable display order, empty areas left out. */
export function zonesByArea(body: VehicleBodyType): Array<{ area: ZoneArea; label: string; zones: VehicleZone[] }> {
  const order: ZoneArea[] = ['front', 'rear', 'side', 'roof', 'glass', 'lamps', 'wheels', 'underbody', 'interior'];
  const zones = zonesForBody(body);
  return order
    .map((area) => ({ area, label: ZONE_AREA_LABELS[area], zones: zones.filter((z) => z.area === area) }))
    .filter((g) => g.zones.length > 0);
}

/** The matching zone on the other side (front_door_l ↔ front_door_r, wheel_fl ↔ wheel_fr); centre zones map to themselves. */
export function mirrorZoneId(id: string): string {
  let m: string;
  if (/_l$/.test(id)) m = id.replace(/_l$/, '_r');
  else if (/_r$/.test(id)) m = id.replace(/_r$/, '_l');
  else if (/^wheel_[fr][lr]$/.test(id)) m = id.slice(0, -1) + (id.endsWith('l') ? 'r' : 'l');
  else m = id;
  return BY_ID.has(m) ? m : id;
}

/**
 * The equivalent zone on another body: a tailgate on a saloon is the boot lid, a rear quarter on a panel van is the
 * load-area side panel, a rear door on a coupe does not exist (null). Lets AI findings recorded against one body
 * type be shown on another without losing them silently.
 */
export function mapZoneToBody(id: string, body: VehicleBodyType): string | null {
  if (zoneAppliesToBody(id, body)) return id;
  const side = /_([lr])$/.exec(id)?.[1];
  const sided = (base: string) => (side ? `${base}_${side}` : null);
  const base = id.replace(/_[lr]$/, '');
  const candidates: Record<string, Array<string | null>> = {
    tailgate: ['boot_lid', 'rear_load_door_l', 'load_bed_tailgate'],
    boot_lid: ['tailgate', 'rear_load_door_l', 'load_bed_tailgate'],
    load_bed_tailgate: ['tailgate', 'boot_lid', 'rear_load_door_l'],
    rear_load_door: ['tailgate', 'boot_lid', 'load_bed_tailgate'],
    quarter_panel: [sided('load_side_panel'), sided('load_bed_side')],
    load_side_panel: [sided('quarter_panel'), sided('load_bed_side')],
    load_bed_side: [sided('quarter_panel'), sided('load_side_panel')],
    rear_door: [sided('sliding_door')],
    sliding_door: [sided('rear_door')],
    rear_door_glass: [sided('quarter_glass')],
    roof: ['soft_top'],
    soft_top: ['roof'],
    boot_floor: ['load_bed_floor', 'floor_pan'],
    load_bed_floor: ['boot_floor', 'floor_pan']
  };
  for (const c of candidates[base] ?? []) if (c && zoneAppliesToBody(c, body)) return c;
  return null;
}

/** Map free-text body descriptions (DVLA "5 DOOR HATCHBACK", "PANEL VAN", catalogue bodies) to a body type. */
export function normaliseBodyType(text: string | null | undefined): VehicleBodyType {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return 'hatchback';
  if (/pick[\s-]?up|double cab|crew cab|king cab|single cab/.test(t)) return 'pickup';
  if (/\bvan\b|panel|box van|luton|crew van|combi|light goods|lcv/.test(t)) return 'panel-van';
  if (/convertible|cabrio|roadster|spider|spyder|soft[\s-]?top|drophead|volante/.test(t)) return 'convertible';
  if (/coup[eé]/.test(t)) return 'coupe';
  if (/\bmpv\b|people carrier|multi[\s-]?purpose|minivan|\bmpv\b/.test(t)) return 'mpv';
  if (/\bsuv\b|4x4|crossover|off[\s-]?road|sport utility|station wagon 4/.test(t)) return 'suv';
  if (/estate|tourer|touring|avant|wagon|shooting brake|sports? ?tourer|variant\b/.test(t)) return 'estate';
  if (/saloon|sedan|limousine|4 ?door saloon/.test(t)) return 'saloon';
  if (/hatch|sportback|fastback|liftback/.test(t)) return 'hatchback';
  return 'hatchback';
}

// ── severity & operations ──

export type DamageSeverity = 0 | 1 | 2 | 3;
export const DAMAGE_SEVERITIES: readonly DamageSeverity[] = [0, 1, 2, 3];
export const DAMAGE_SEVERITY_LABELS: Record<DamageSeverity, string> = { 0: 'None', 1: 'Light', 2: 'Medium', 3: 'Heavy' };

/** Photo-finding severities (§H.3) on the 0–3 scale; structural is treated as heavy. */
export function severityFromFinding(s: 'none' | 'light' | 'medium' | 'heavy' | 'structural' | string): DamageSeverity {
  switch (s) {
    case 'light':
      return 1;
    case 'medium':
      return 2;
    case 'heavy':
    case 'structural':
      return 3;
    default:
      return 0;
  }
}

/** A sensible first operation for a zone at a severity — always one of the zone's typical operations. */
export function suggestOperation(zoneOrId: VehicleZone | string, severity: DamageSeverity): ZoneOperation | undefined {
  const z = typeof zoneOrId === 'string' ? BY_ID.get(zoneOrId) : zoneOrId;
  if (!z || severity === 0) return undefined;
  const has = (op: ZoneOperation) => z.operations.includes(op);
  let want: ZoneOperation;
  switch (z.kind) {
    case 'panel':
    case 'bumper':
    case 'structural':
      want = severity >= 3 ? 'replace' : 'repair';
      break;
    case 'wheel':
    case 'glass':
    case 'mirror':
      want = severity >= 2 ? 'replace' : 'repair';
      break;
    default:
      want = 'replace';
  }
  if (has(want)) return want;
  return z.operations[0];
}

// ── free-text matching ──

function normaliseText(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/\b([on])\/?s\/?([fr])\b/g, (_m, a: string, b: string) => ` ${a === 'o' ? 'offside' : 'nearside'} ${b === 'f' ? 'front' : 'rear'} `)
    .replace(/\b([on])\/?s\b/g, (_m, a: string) => ` ${a === 'o' ? 'offside' : 'nearside'} `)
    .replace(/\b([lr])hs?([fr])?\b/g, (_m, a: string, b?: string) => ` ${a === 'r' ? 'right' : 'left'} ${b ? (b === 'f' ? 'front' : 'rear') : ''} `)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${out} `;
}

/**
 * Best zone for a free-text panel name ("O/S/F wing", "N/S rear door glass", "rear bumper cover", "LH headlamp").
 * Sides: offside/right/RH/driver → R, nearside/left/LH/passenger → L (UK right-hand drive). Returns null when nothing
 * matches. With a body type, zones that do not exist on it are mapped across (`mapZoneToBody`) or dropped.
 */
export function zoneForPanelName(text: string, body?: VehicleBodyType): string | null {
  const t = normaliseText(text);
  if (!t.trim()) return null;
  const has = (w: string) => t.includes(` ${w} `);
  const side: 'L' | 'R' | null =
    has('offside') || has('right') || has('rh') || has('driver') || has('drivers') ? 'R' : has('nearside') || has('left') || has('lh') || has('passenger') || has('passengers') ? 'L' : null;
  const front = has('front');
  const rear = has('rear') || has('back');

  let best: { zone: VehicleZone; score: number } | null = null;
  for (const z of VEHICLE_ZONES) {
    const words = [z.label.replace(/\(.*?\)/g, ''), ...(z.aliases ?? [])].map((w) => normaliseText(w).trim()).filter(Boolean);
    let score = 0;
    for (const w of words) if (t.includes(` ${w} `)) score = Math.max(score, w.length * 2);
    if (score === 0) continue;
    if (z.side !== 'centre') {
      if (side && z.side !== side) continue;
      if (!side) score -= 1;
    }
    // wheels: pick the corner from front/rear + side
    if (z.kind === 'wheel') {
      const isFront = z.id[6] === 'f';
      if (front && !isFront) continue;
      if (rear && !front && isFront) continue;
    }
    // "front"/"rear" qualifiers disambiguate doors, lamps, bumpers, suspension
    const label = z.label.toLowerCase();
    if (front && !rear && label.startsWith('rear')) score -= 3;
    if (rear && !front && label.startsWith('front')) score -= 3;
    if (front && label.startsWith('front')) score += 1;
    if (rear && label.startsWith('rear')) score += 1;
    if (!best || score > best.score) best = { zone: z, score };
  }
  if (!best || best.score <= 0) return null;
  let id = best.zone.id;
  if (best.zone.kind === 'wheel' && !front && !rear) id = side === 'R' ? 'wheel_fr' : 'wheel_fl';
  if (best.zone.kind === 'wheel' && side) id = `${id.slice(0, 7)}${side === 'R' ? 'r' : 'l'}`;
  return body ? mapZoneToBody(id, body) : id;
}
