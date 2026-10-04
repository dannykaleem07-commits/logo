/**
 * Heuristic GTA group mapping from vehicle data.
 *
 * The GTA publishes a vehicle-to-group list; this module does NOT hold it. It infers a group
 * from body type, engine size and make/model lists so a handler has a sensible default to
 * confirm or correct. Every result says `heuristic: true` (unless the vehicle record already
 * carries a group) and the UI must show it as a suggestion.
 */
import type { GtaRate, Vehicle } from '../types.js';
import { defaultGtaRates } from './rates.js';

export type GtaGroupConfidence = 'high' | 'medium' | 'low';

export interface GtaGroupMapping {
  group: string;
  confidence: GtaGroupConfidence;
  reason: string;
  /** False only when the group was taken from the vehicle record. */
  heuristic: boolean;
  /** True when `rates` holds at least one row for this group (any period). */
  rateAvailable: boolean;
}

type VehicleLike = Pick<Vehicle, 'make' | 'model' | 'bodyType' | 'engineCapacityCc' | 'fuelType' | 'gtaGroup' | 'variant'>;

const SMALL_MODELS = [
  'fiesta', 'ka', 'corsa', 'adam', 'polo', 'up', 'i10', 'i20', 'yaris', 'aygo', 'fabia', 'citigo', 'ibiza', 'mii', 'picanto', 'rio',
  'micra', 'clio', 'twingo', 'zoe', '108', '208', 'c1', 'c3', 'ds3', 'jazz', 'swift', 'ignis', 'mini', 'mito', 'panda', '500', 'punto',
  'sandero', 'spark', 'aveo', 'leaf', 'e-208', 'e-up', 'corsa-e', 'honda e', 'mx-30', 'mazda2', '2',
];

const VAN_MODELS = [
  'transit', 'transit custom', 'transit connect', 'transit courier', 'sprinter', 'vito', 'citan', 'vivaro', 'movano', 'combo', 'trafic',
  'master', 'kangoo', 'caddy', 'transporter', 'crafter', 'berlingo', 'dispatch', 'relay', 'partner', 'expert', 'boxer', 'ducato',
  'doblo', 'scudo', 'nv200', 'nv300', 'nv400', 'townstar', 'primastar', 'interstar', 'proace', 'hilux', 'ranger', 'navara', 'l200',
  'amarok', 'd-max', 'proace city', 'e-transit', 'e-vito',
];
const LARGE_VAN_MODELS = ['sprinter', 'movano', 'master', 'crafter', 'relay', 'boxer', 'ducato', 'nv400', 'interstar', 'transit' /* 350 etc. */];

const PRESTIGE_MAKES = ['mercedes', 'mercedes-benz', 'bmw', 'audi', 'jaguar', 'land rover', 'range rover', 'porsche', 'lexus', 'tesla', 'maserati', 'bentley', 'aston martin', 'alpina', 'genesis'];

const MPV_MODELS = ['galaxy', 's-max', 'sharan', 'alhambra', 'zafira', 'touran', 'c4 picasso', 'grand c4', 'scenic', 'grand scenic', 'verso', 'carens', 'tiguan allspace', '5008'];

const SUV_MODELS = [
  'qashqai', 'juke', 'kuga', 'puma', 'ecosport', 'tiguan', 't-roc', 't-cross', 'sportage', 'tucson', 'niro', 'kona', 'cx-5', 'cx-30', 'cx-3',
  'rav4', 'c-hr', 'yaris cross', 'karoq', 'kamiq', 'ateca', 'arona', '3008', '2008', 'captur', 'kadjar', 'duster', 'mokka', 'crossland', 'grandland',
  'hr-v', 'cr-v', 'zs', 'hs', 'eclipse cross', 'asx', 'outlander', 'x-trail', 'xc40', 'xc60', 'q3', 'q5', 'x1', 'x3', 'glb', 'gla', 'glc',
];

function lc(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function modelMatches(model: string, variant: string, list: readonly string[]): boolean {
  const full = `${model} ${variant}`.trim();
  return list.some((m) => model === m || model.startsWith(`${m} `) || full.startsWith(m) || model.split(/\s+/)[0] === m);
}

const SUFFIX = ' — heuristic mapping; confirm against the GTA group list';

export function mapGtaGroup(vehicle: VehicleLike, rates: GtaRate[] = defaultGtaRates): GtaGroupMapping {
  const has = (g: string): boolean => rates.some((r) => r.group.toUpperCase() === g.toUpperCase());
  const result = (group: string, confidence: GtaGroupConfidence, reason: string, heuristic = true): GtaGroupMapping => ({
    group,
    confidence,
    reason: heuristic ? `${reason}${SUFFIX}` : reason,
    heuristic,
    rateAvailable: has(group),
  });

  if (vehicle.gtaGroup && vehicle.gtaGroup.trim()) {
    return result(vehicle.gtaGroup.trim().toUpperCase(), 'high', 'GTA group recorded on the vehicle', false);
  }

  const make = lc(vehicle.make);
  const model = lc(vehicle.model);
  const variant = lc(vehicle.variant);
  const body = lc(vehicle.bodyType);
  const cc = vehicle.engineCapacityCc;
  const electric = vehicle.fuelType === 'electric';

  // Commercial vehicles first — a van is never a car group.
  const vanBody = /\b(van|panel|pick.?up|lcv|commercial|chassis|tipper|luton|dropside|box)\b/.test(body);
  if (vanBody || modelMatches(model, variant, VAN_MODELS)) {
    const large = modelMatches(model, variant, LARGE_VAN_MODELS) && (cc === undefined || cc > 2000 || /\b(350|l3|l4|lwb|jumbo)\b/.test(`${model} ${variant}`));
    const bigEngine = cc !== undefined && cc > 2000;
    if (large || bigEngine) return result('CP2', 'medium', `commercial vehicle (${body || model}${cc ? `, ${cc}cc` : ''}) — medium/large van group`);
    return result('CP1', 'medium', `commercial vehicle (${body || model}${cc ? `, ${cc}cc` : ''}) — small van group`);
  }

  if (modelMatches(model, variant, SMALL_MODELS)) {
    const strong = cc === undefined ? electric : cc <= 1250;
    return result('S1', strong ? 'high' : 'medium', `small car (${vehicle.make} ${vehicle.model}${cc ? `, ${cc}cc` : ''})`);
  }

  if (PRESTIGE_MAKES.some((p) => make === p || make.startsWith(p))) {
    return result('P1', 'low', `prestige make (${vehicle.make}) — prestige groups are not in the shipped rate table`);
  }

  const mpvBody = /\b(mpv|people carrier|minibus|estate 7)\b/.test(body);
  if (mpvBody || modelMatches(model, variant, MPV_MODELS)) {
    return result('MPV1', 'low', `MPV / 7-seat (${vehicle.make} ${vehicle.model}) — MPV groups are not in the shipped rate table`);
  }

  const suvBody = /\b(suv|4x4|off.?road|crossover)\b/.test(body);
  if (suvBody || modelMatches(model, variant, SUV_MODELS)) {
    if (cc !== undefined && cc <= 1600) return result('M', 'low', `SUV/crossover (${vehicle.make} ${vehicle.model}, ${cc}cc) treated as medium; a 4x4 group may apply`);
    return result('M1', 'low', `SUV/crossover (${vehicle.make} ${vehicle.model}${cc ? `, ${cc}cc` : ''}) treated as upper-medium; a 4x4 group may apply`);
  }

  if (cc !== undefined && cc > 0) {
    if (cc <= 1250) return result('S1', 'medium', `engine ${cc}cc (≤1250cc) — small car`);
    if (cc <= 1600) return result('M', 'medium', `engine ${cc}cc (1251–1600cc) — medium car`);
    if (cc <= 2000) return result('M1', 'medium', `engine ${cc}cc (1601–2000cc) — upper-medium car`);
    return result('L', 'low', `engine ${cc}cc (>2000cc) — large car; large groups are not in the shipped rate table`);
  }

  if (electric) return result('M', 'low', `electric vehicle without a model match (${vehicle.make} ${vehicle.model}) — defaulted to medium`);
  return result('M', 'low', `no body type or engine size for ${vehicle.make} ${vehicle.model} — defaulted to medium`);
}
