// owned by ap-booking
/**
 * Like for like (docs/SUPREME-AUTOPILOT.md §B.5). Pure.
 *
 * score = 0.5·group + 0.2·body + 0.1·seats + 0.1·transmission + 0.1·fuel.
 * Group: benchmark DAILY RATES are compared, never group codes (S/M/F/CP codes do not order across families), exactly
 * as `hirePricingGuide` does: same 1.0; lower by ≤ 10 % 0.8; lower by more 0.5; higher 0.4 (only the like-for-like
 * rate is recoverable — clash GROUP_ABOVE_LFL); unknown client group or rate 0.5. GTA rates are a benchmark only.
 */
import type { FuelType, GtaRate, ISODate, Transmission, Vehicle } from '../types.js';
import { gtaRate } from '../gta/rates.js';
import type { AvailabilityQuery, LikeForLikeResult } from './types.js';

export type BodyFamily = 'hatch' | 'saloon' | 'estate' | 'suv' | 'mpv' | 'van' | 'coupe';
export type FuelFamily = 'ev' | 'hybrid' | 'petrol' | 'diesel' | 'other';

type ClientVehicle = AvailabilityQuery['clientVehicle'];
type BodySource = Pick<Vehicle, 'bodyType' | 'spec'> | null | undefined;

const ADJACENT: ReadonlyArray<[BodyFamily, BodyFamily]> = [
  ['hatch', 'saloon'],
  ['hatch', 'estate'],
  ['saloon', 'estate'],
  ['estate', 'suv'],
  ['hatch', 'suv'],
  ['suv', 'mpv'],
  ['mpv', 'van'],
  ['saloon', 'coupe'],
  ['hatch', 'coupe'],
];

/** Body family from the DVLA/catalogue body type, else the catalogue segment; null when neither says. */
export function bodyFamily(v: BodySource): BodyFamily | null {
  const body = (v?.bodyType ?? '').toLowerCase();
  if (body) {
    if (/hatch/.test(body)) return 'hatch';
    if (/estate|tourer|sports ?brake|avant|touring/.test(body)) return 'estate';
    if (/saloon|sedan|fastback|liftback/.test(body)) return 'saloon';
    if (/suv|4x4|crossover|off.?road/.test(body)) return 'suv';
    if (/mpv|people|multi.?purpose/.test(body)) return 'mpv';
    if (/van|panel|pick.?up|pickup|minibus/.test(body)) return 'van';
    if (/coupe|convertible|cabrio|roadster/.test(body)) return 'coupe';
  }
  const seg = (v?.spec?.segment ?? '').toLowerCase();
  if (!seg) return null;
  if (seg.startsWith('suv') || seg === 'pickup') return seg === 'pickup' ? 'van' : 'suv';
  if (seg.startsWith('mpv')) return 'mpv';
  if (seg.startsWith('van') || seg === 'minibus') return 'van';
  if (seg === 'executive' || seg === 'luxury') return 'saloon';
  if (seg === 'sports' || seg === 'supercar') return 'coupe';
  if (seg === 'city' || seg === 'supermini' || seg === 'small-family' || seg === 'large-family') return 'hatch';
  return null;
}

export function fuelFamily(f: FuelType | undefined): FuelFamily | null {
  if (!f) return null;
  if (f === 'electric') return 'ev';
  if (f === 'hybrid' || f === 'plugin_hybrid') return 'hybrid';
  if (f === 'petrol') return 'petrol';
  if (f === 'diesel') return 'diesel';
  return 'other';
}

function bodyScore(a: BodyFamily | null, b: BodyFamily | null): number {
  if (!a || !b) return 0.5;
  if (a === b) return 1;
  return ADJACENT.some(([x, y]) => (x === a && y === b) || (x === b && y === a)) ? 0.5 : 0;
}

function transmissionScore(client: Transmission | undefined, car: Transmission | undefined): number {
  if (!client || client === 'unknown' || !car || car === 'unknown') return 0.5;
  if (client === car) return 1;
  return client === 'manual' && car === 'automatic' ? 0.8 : 0;
}

function fuelScore(client: FuelFamily | null, car: FuelFamily | null): number {
  if (!client || !car) return 0.5;
  if (client === car) return 1;
  const pair = new Set([client, car]);
  if (pair.has('hybrid') && pair.has('petrol')) return 1;
  return 0.5;
}

function seatsScore(client: number | undefined, car: number | undefined): number {
  if (client === undefined) return 1;
  if (car === undefined) return 0.5;
  return car >= client ? 1 : 0;
}

const norm = (g: string | null | undefined): string | null => {
  const x = typeof g === 'string' ? g.trim().toUpperCase() : '';
  return x ? x : null;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function likeForLike(client: ClientVehicle, clientGroup: string | null, car: Vehicle, carGroup: string, rates: GtaRate[], date: ISODate): LikeForLikeResult {
  const cg = norm(clientGroup ?? client?.gtaGroup);
  const hg = norm(carGroup) ?? 'UNGROUPED';
  const clientRate = cg ? (gtaRate(cg, date, rates)?.dailyRatePence ?? null) : null;
  const carRate = hg !== 'UNGROUPED' ? (gtaRate(hg, date, rates)?.dailyRatePence ?? null) : null;

  let relation: LikeForLikeResult['group']['relation'] = 'unknown';
  let group = 0.5;
  if (cg && cg === hg) {
    relation = 'same';
    group = 1;
  } else if (clientRate !== null && carRate !== null) {
    if (carRate === clientRate) {
      relation = 'same';
      group = 1;
    } else if (carRate < clientRate) {
      relation = 'lower';
      group = (clientRate - carRate) / clientRate <= 0.1 ? 0.8 : 0.5;
    } else {
      relation = 'higher';
      group = 0.4;
    }
  }
  const body = bodyScore(bodyFamily(client), bodyFamily(car));
  const seats = seatsScore(client?.spec?.seats, car.spec?.seats);
  const transmission = transmissionScore(client?.transmission, car.transmission);
  const fuel = fuelScore(fuelFamily(client?.fuelType), fuelFamily(car.fuelType));
  const score = round2(0.5 * group + 0.2 * body + 0.1 * seats + 0.1 * transmission + 0.1 * fuel);

  const bits: string[] = [];
  if (relation === 'same') bits.push(`Same hire group as your own car (${hg})`);
  else if (relation === 'lower') bits.push(`A lower hire group (${hg}) than your own car (${cg})`);
  else if (relation === 'higher') bits.push(`A higher hire group (${hg}) than your own car (${cg})`);
  else bits.push(`Hire group ${hg}`);
  if (car.transmission === 'automatic' || car.transmission === 'manual') bits.push(car.transmission);
  if (car.spec?.seats) bits.push(`${car.spec.seats} seats`);
  const fam = fuelFamily(car.fuelType);
  if (fam === 'ev') bits.push('electric');
  else if (fam === 'hybrid') bits.push('hybrid');
  else if (car.fuelType && fam !== 'other') bits.push(car.fuelType);
  return {
    score,
    group: { client: cg, car: hg, relation, clientRatePence: clientRate, carRatePence: carRate },
    parts: { group, body, seats, transmission, fuel },
    sentence: `${bits.join(', ')}.`,
  };
}
