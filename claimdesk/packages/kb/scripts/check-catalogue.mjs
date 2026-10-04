#!/usr/bin/env node
/**
 * Vehicle catalogue validator and quality report (TEMPLATES-VEHICLES-DESKTOP §D.2–§D.4). Plain Node ESM, no dependencies.
 *
 *   node packages/kb/scripts/check-catalogue.mjs                       validate every make file + features.json, print counts
 *   node packages/kb/scripts/check-catalogue.mjs --reference <file>    … and report DfT/DVLA licensing models with no match
 *   options: --dir <catalogue dir>  --make <slug>[,<slug>]  --quiet  --json
 *
 * Exit code 1 when any schema error is found (warnings never fail). The coverage report (including the check that
 * README.md gives a reason for every unmatched reference model) never changes the exit code.
 * The data is reference material marked `unverified`; nothing here upgrades that status.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Schema constants (§D.2, §D.3, Appendix 3)
// ---------------------------------------------------------------------------

export const VEHICLE_TYPES = ['car', 'van', 'pickup', 'minibus', 'camper'];
export const SEGMENTS = ['city', 'supermini', 'small-family', 'large-family', 'executive', 'luxury', 'sports', 'supercar',
  'mpv-small', 'mpv-large', 'suv-small', 'suv-medium', 'suv-large', 'suv-luxury', 'pickup', 'van-small', 'van-medium',
  'van-large', 'minibus'];
export const BODIES = ['hatchback', 'saloon', 'estate', 'coupe', 'convertible', 'suv', 'crossover', 'mpv', 'pickup',
  'panel-van', 'crew-van', 'chassis-cab', 'minibus', 'roadster', 'fastback', 'liftback', 'shooting-brake', 'camper'];
export const FUELS = ['petrol', 'diesel', 'hybrid', 'mild-hybrid', 'plug-in-hybrid', 'electric', 'lpg', 'hydrogen'];
export const TRANSMISSIONS = ['manual', 'automatic'];
export const FEATURE_CATEGORIES = ['safety', 'driver_assistance', 'parking', 'lighting', 'climate', 'seats_interior',
  'infotainment', 'exterior', 'wheels_tyres', 'security', 'towing_load', 'ev_charging', 'accessibility', 'performance',
  'commercial'];
export const FEATURE_KINDS = ['feature', 'extra', 'both'];
/** Appendix 3: the 74 make slugs that must exist. */
export const REQUIRED_MAKES = ['volkswagen', 'skoda', 'seat', 'cupra', 'ford', 'vauxhall', 'audi', 'bmw', 'mini',
  'mercedes-benz', 'smart', 'porsche', 'volvo', 'polestar', 'saab', 'toyota', 'lexus', 'honda', 'nissan', 'mazda',
  'mitsubishi', 'subaru', 'suzuki', 'daihatsu', 'infiniti', 'isuzu', 'hyundai', 'kia', 'genesis', 'ssangyong', 'daewoo',
  'chevrolet', 'mg', 'byd', 'omoda', 'jaecoo', 'gwm', 'great-wall', 'proton', 'perodua', 'tata', 'leapmotor', 'xpeng',
  'ldv', 'peugeot', 'citroen', 'ds', 'renault', 'dacia', 'alpine', 'fiat', 'abarth', 'alfa-romeo', 'chrysler', 'jeep',
  'dodge', 'cadillac', 'iveco', 'jaguar', 'land-rover', 'rover', 'levc', 'lotus', 'aston-martin', 'bentley',
  'rolls-royce', 'mclaren', 'morgan', 'caterham', 'ineos', 'tesla', 'ferrari', 'lamborghini', 'maserati'];
/** Appendix 3 coverage priorities (highest UK volume) — the ≤ 5 % unmatched bar applies to these. */
export const PRIORITY_MAKES = ['ford', 'vauxhall', 'volkswagen', 'bmw', 'mercedes-benz', 'audi', 'toyota', 'nissan', 'kia',
  'hyundai', 'peugeot', 'renault', 'skoda', 'honda', 'citroen', 'fiat', 'mini', 'seat', 'mazda', 'land-rover', 'volvo', 'mg',
  'tesla', 'dacia', 'suzuki', 'jaguar', 'lexus', 'cupra', 'mitsubishi', 'porsche', 'byd', 'polestar', 'ds'];
/** Appendix 3 dvlaNames that must be present on a make. */
export const REQUIRED_DVLA_NAMES = { ssangyong: ['SSANGYONG', 'KGM'], gwm: ['GWM', 'ORA'], ldv: ['LDV', 'MAXUS'],
  'land-rover': ['LAND ROVER'], 'mercedes-benz': ['MERCEDES-BENZ'], citroen: ['CITROEN'] };

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const GTA_GROUP = /^[A-Z]{1,3}\d{0,2}$/;
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2026;
export const MAX_FILE_BYTES = 600 * 1024;

const MAKE_KEYS = ['make', 'slug', 'dvlaNames', 'aliases', 'verification', 'models'];
const VERIFICATION_KEYS = ['status', 'sourceNote'];
const MODEL_KEYS = ['name', 'slug', 'aliases', 'vehicleType', 'segment', 'years', 'gtaGroup', 'generations'];
const YEARS_KEYS = ['from', 'to'];
const GEN_KEYS = ['name', 'id', 'from', 'to', 'bodies', 'trims', 'engines', 'fuels', 'transmissions', 'gtaGroup', 'note'];
const BODY_KEYS = ['body', 'doors', 'seats'];
const TRIM_KEYS = ['name', 'from', 'to', 'bodies', 'engines', 'features', 'gtaGroup'];
const ENGINE_KEYS = ['label', 'cc', 'fuel', 'powerPs', 'powerKw', 'batteryKwh', 'transmissions', 'from', 'to'];
const FEATURE_ITEM_KEYS = ['id', 'label', 'aliases', 'kind'];

/** Same as packages/kb/src/catalogue/normalise.ts `slugify` (§A.4). */
export function slugify(text, max = 48) {
  const s = String(text)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛']/g, '')
    .replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/£/g, ' gbp ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = s.slice(0, max).replace(/-+$/g, '');
  return cut || 'x';
}

// ---------------------------------------------------------------------------
// Engine string grammar (§D.2)
// ---------------------------------------------------------------------------

/**
 * `[<litres>] <name words…> <power>PS <fuel>`; `<fuel>` is the last token (`mild-hybrid petrol|diesel` allowed as the last
 * two). Electric engines omit litres and may carry `<n>kWh`. Returns `{ fuel, litres?, powerPs, kwh? }` or `{ error }`.
 * A mild-hybrid engine's catalogue fuel is `mild-hybrid` (the base fuel is kept as `baseFuel`).
 */
export function parseEngineString(label) {
  if (typeof label !== 'string') return { error: 'engine must be a string or an object' };
  if (label !== label.trim() || /\s{2,}/.test(label)) return { error: 'extra whitespace' };
  const t = label.split(' ');
  let fuel;
  let baseFuel;
  let end = t.length;
  const last = t[end - 1];
  if ((last === 'petrol' || last === 'diesel') && t[end - 2] === 'mild-hybrid') {
    fuel = 'mild-hybrid';
    baseFuel = last;
    end -= 2;
  } else if (FUELS.includes(last)) {
    fuel = last;
    end -= 1;
  } else return { error: `last token must be a fuel (${FUELS.join(', ')})` };
  const ps = /^(\d+)PS$/.exec(t[end - 1] ?? '');
  if (!ps) return { error: 'the token before the fuel must be <power>PS' };
  end -= 1;
  const rest = t.slice(0, end);
  let litres;
  if (rest.length && /^\d\.\d$/.test(rest[0])) {
    litres = Number(rest[0]);
    rest.shift();
  }
  if (rest.some((w) => /^\d+PS$/.test(w))) return { error: 'more than one <power>PS token' };
  if (rest.some((w) => /^\d\.\d$/.test(w))) return { error: 'litres must be the first token' };
  if (fuel === 'electric' && litres !== undefined) return { error: 'electric engines omit litres' };
  if (litres === undefined && !rest.length) return { error: 'needs litres or name words' };
  const kwhTok = rest.find((w) => /^\d+(\.\d+)?kWh$/.test(w));
  const out = { fuel, powerPs: Number(ps[1]) };
  if (baseFuel) out.baseFuel = baseFuel;
  if (litres !== undefined) out.litres = litres;
  if (kwhTok) out.kwh = Number(kwhTok.slice(0, -3));
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isRec = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isYear = (v) => isInt(v) && v >= MIN_YEAR && v <= MAX_YEAR;

/** Validate one make file. Returns { errors, warnings, counts }. `featureIds` (Set) checks trim feature refs. */
export function validateMake(raw, file, { featureIds, bytes } = {}) {
  const errors = [];
  const warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const warn = (p, m) => warnings.push(`${p}: ${m}`);
  const counts = { models: 0, generations: 0, trims: 0, engines: 0, bodies: 0 };
  const keys = (obj, allowed, p) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(p, `unknown field '${k}'`);
  };
  const str = (v, p) => {
    if (typeof v !== 'string' || !v.trim()) { err(p, `expected a non-empty string, got ${JSON.stringify(v)}`); return false; }
    if (v !== v.trim()) err(p, 'leading/trailing whitespace');
    return true;
  };
  const strArr = (v, p) => {
    if (!Array.isArray(v)) { err(p, 'expected an array of strings'); return []; }
    v.forEach((s, i) => str(s, `${p}[${i}]`));
    const seen = new Set();
    for (const s of v) {
      if (typeof s !== 'string') continue;
      const k = s.toLowerCase();
      if (seen.has(k)) warn(p, `duplicate entry '${s}'`);
      seen.add(k);
    }
    return v.filter((s) => typeof s === 'string');
  };
  const gta = (v, p) => {
    if (v === undefined) return;
    if (typeof v !== 'string' || !GTA_GROUP.test(v)) err(p, `gtaGroup must match ${GTA_GROUP} (got ${JSON.stringify(v)})`);
  };
  const yearOrNull = (v, p) => {
    if (v === null) return null;
    if (!isYear(v)) { err(p, `expected a year ${MIN_YEAR}–${MAX_YEAR} or null, got ${JSON.stringify(v)}`); return undefined; }
    return v;
  };
  const slugCheck = (v, from, p, label) => {
    if (typeof v !== 'string' || !SLUG.test(v)) { err(p, `${label} slug must match ${SLUG} (got ${JSON.stringify(v)})`); return; }
    if (typeof from === 'string' && v !== slugify(from)) warn(p, `${label} slug '${v}' differs from slugify('${from}') = '${slugify(from)}'`);
  };

  if (bytes !== undefined && bytes > MAX_FILE_BYTES) err(file, `file is ${bytes} bytes (max ${MAX_FILE_BYTES})`);
  if (!isRec(raw)) { err(file, 'expected a make object'); return { errors, warnings, counts }; }
  keys(raw, MAKE_KEYS, file);
  for (const k of MAKE_KEYS) if (!(k in raw)) err(file, `missing '${k}'`);
  str(raw.make, `${file}.make`);
  slugCheck(raw.slug, raw.make, `${file}.slug`, 'make');
  const base = path.basename(file, '.json');
  if (typeof raw.slug === 'string' && raw.slug !== base) err(`${file}.slug`, `slug '${raw.slug}' must equal the file name '${base}'`);
  const dvla = strArr(raw.dvlaNames, `${file}.dvlaNames`);
  if (!dvla.length) err(`${file}.dvlaNames`, 'at least one DVLA spelling is required');
  for (const n of dvla) if (n !== n.toUpperCase()) err(`${file}.dvlaNames`, `'${n}' must be upper case`);
  for (const n of REQUIRED_DVLA_NAMES[raw.slug] ?? []) if (!dvla.includes(n)) err(`${file}.dvlaNames`, `must include '${n}' (Appendix 3 / §D.4)`);
  strArr(raw.aliases, `${file}.aliases`);
  if (!isRec(raw.verification)) err(`${file}.verification`, 'expected { status, sourceNote }');
  else {
    keys(raw.verification, VERIFICATION_KEYS, `${file}.verification`);
    if (raw.verification.status !== 'unverified') err(`${file}.verification.status`, `must be 'unverified' (got ${JSON.stringify(raw.verification.status)})`);
    str(raw.verification.sourceNote, `${file}.verification.sourceNote`);
  }
  if (!Array.isArray(raw.models) || !raw.models.length) { err(`${file}.models`, 'must be a non-empty array'); return { errors, warnings, counts }; }

  const modelSlugs = new Set();
  const aliasOwner = new Map();
  const nameOwner = new Map();
  for (const [i, m] of raw.models.entries()) {
    const p = `${file}.models[${i}]${isRec(m) && typeof m.slug === 'string' ? `(${m.slug})` : ''}`;
    if (!isRec(m)) { err(p, 'expected a model object'); continue; }
    counts.models += 1;
    keys(m, MODEL_KEYS, p);
    for (const k of ['name', 'slug', 'aliases', 'vehicleType', 'segment', 'years', 'generations']) if (!(k in m)) err(p, `missing '${k}'`);
    str(m.name, `${p}.name`);
    slugCheck(m.slug, m.name, `${p}.slug`, 'model');
    if (typeof m.slug === 'string') {
      if (modelSlugs.has(m.slug)) err(`${p}.slug`, `duplicate model slug '${m.slug}'`);
      modelSlugs.add(m.slug);
    }
    if (typeof m.name === 'string') {
      const k = m.name.toLowerCase();
      if (nameOwner.has(k)) err(`${p}.name`, `duplicate model name '${m.name}'`);
      nameOwner.set(k, m.slug);
    }
    for (const a of strArr(m.aliases, `${p}.aliases`)) {
      const k = a.toLowerCase();
      const other = aliasOwner.get(k);
      if (other !== undefined && other !== m.slug) err(`${p}.aliases`, `alias '${a}' is also an alias of model '${other}'`);
      aliasOwner.set(k, m.slug);
    }
    if (!VEHICLE_TYPES.includes(m.vehicleType)) err(`${p}.vehicleType`, `expected one of ${VEHICLE_TYPES.join(', ')}, got ${JSON.stringify(m.vehicleType)}`);
    if (!SEGMENTS.includes(m.segment)) err(`${p}.segment`, `expected one of ${SEGMENTS.join(', ')}, got ${JSON.stringify(m.segment)}`);
    gta(m.gtaGroup, `${p}.gtaGroup`);
    let yFrom;
    let yTo;
    if (!isRec(m.years)) err(`${p}.years`, 'expected { from, to }');
    else {
      keys(m.years, YEARS_KEYS, `${p}.years`);
      if (!isYear(m.years.from)) err(`${p}.years.from`, `expected a year ${MIN_YEAR}–${MAX_YEAR}, got ${JSON.stringify(m.years.from)}`);
      else yFrom = m.years.from;
      if (!('to' in m.years)) err(`${p}.years.to`, 'missing (use null while on sale)');
      else yTo = yearOrNull(m.years.to, `${p}.years.to`);
      if (yFrom !== undefined && typeof yTo === 'number' && yTo < yFrom) err(`${p}.years`, `to ${yTo} is before from ${yFrom}`);
    }
    if (!Array.isArray(m.generations) || !m.generations.length) { err(`${p}.generations`, 'must be a non-empty array'); continue; }
    let prevFrom = -Infinity;
    let minFrom = Infinity;
    let anyOpen = false;
    let maxTo = -Infinity;
    const genNames = new Set();
    for (const [j, g] of m.generations.entries()) {
      const gp = `${p}.generations[${j}]`;
      if (!isRec(g)) { err(gp, 'expected a generation object'); continue; }
      counts.generations += 1;
      keys(g, GEN_KEYS, gp);
      for (const k of ['name', 'from', 'to', 'bodies', 'trims', 'engines', 'fuels', 'transmissions']) if (!(k in g)) err(gp, `missing '${k}'`);
      if (str(g.name, `${gp}.name`)) {
        if (genNames.has(g.name)) err(`${gp}.name`, `duplicate generation name '${g.name}'`);
        genNames.add(g.name);
      }
      if (g.id !== undefined && (typeof g.id !== 'string' || !SLUG.test(g.id))) err(`${gp}.id`, `id must match ${SLUG}`);
      if (g.note !== undefined) str(g.note, `${gp}.note`);
      gta(g.gtaGroup, `${gp}.gtaGroup`);
      const gFrom = isYear(g.from) ? g.from : (err(`${gp}.from`, `expected a year ${MIN_YEAR}–${MAX_YEAR}, got ${JSON.stringify(g.from)}`), undefined);
      const gTo = 'to' in g ? yearOrNull(g.to, `${gp}.to`) : undefined;
      if (gFrom !== undefined) {
        if (typeof gTo === 'number' && gTo < gFrom) err(gp, `to ${gTo} is before from ${gFrom}`);
        if (gFrom < prevFrom) err(gp, `generations must be ordered by 'from' (${gFrom} after ${prevFrom})`);
        prevFrom = gFrom;
        minFrom = Math.min(minFrom, gFrom);
        if (yFrom !== undefined && gFrom < yFrom) err(gp, `from ${gFrom} is before the model's years.from ${yFrom}`);
        if (typeof yTo === 'number' && gFrom > yTo) err(gp, `from ${gFrom} is after the model's years.to ${yTo}`);
      }
      if (gTo === null) {
        anyOpen = true;
        if (typeof yTo === 'number') err(gp, `generation is still on sale (to null) but the model ended ${yTo}`);
      } else if (typeof gTo === 'number') {
        maxTo = Math.max(maxTo, gTo);
        if (typeof yTo === 'number' && gTo > yTo) err(gp, `to ${gTo} is after the model's years.to ${yTo}`);
      }

      // bodies
      // seats 1–9; a minibus model (vehicleType 'minibus', as the runtime loader reads it) up to 17
      const maxSeatsFor = () => (m.vehicleType === 'minibus' ? 17 : 9);
      if (!Array.isArray(g.bodies) || !g.bodies.length) err(`${gp}.bodies`, 'must be a non-empty array');
      else {
        const seenBodies = new Set();
        for (const [k, b] of g.bodies.entries()) {
          const bp = `${gp}.bodies[${k}]`;
          if (!isRec(b)) { err(bp, 'expected { body, doors, seats }'); continue; }
          counts.bodies += 1;
          keys(b, BODY_KEYS, bp);
          if (!BODIES.includes(b.body)) err(`${bp}.body`, `expected one of ${BODIES.join(', ')}, got ${JSON.stringify(b.body)}`);
          const sig = JSON.stringify([b.body, b.doors, b.seats]);
          if (seenBodies.has(sig)) warn(`${bp}.body`, `body '${b.body}' listed twice with the same doors and seats`);
          seenBodies.add(sig);
          if (!Array.isArray(b.doors) || !b.doors.length) err(`${bp}.doors`, 'must be a non-empty array');
          else for (const d of b.doors) if (!isInt(d) || d < 2 || d > 5) err(`${bp}.doors`, `doors must be in {2,3,4,5} (got ${JSON.stringify(d)})`);
          if (!Array.isArray(b.seats) || !b.seats.length) err(`${bp}.seats`, 'must be a non-empty array');
          else for (const s of b.seats) if (!isInt(s) || s < 1 || s > maxSeatsFor()) err(`${bp}.seats`, `seats must be 1–${maxSeatsFor()} for a ${m.vehicleType} model (got ${JSON.stringify(s)})`);
        }
      }

      // engines
      const engineFuels = new Set();
      const engineLabels = new Set();
      let electricCount = 0;
      if (!Array.isArray(g.engines) || !g.engines.length) err(`${gp}.engines`, 'must be a non-empty array');
      else {
        for (const [k, e] of g.engines.entries()) {
          const ep = `${gp}.engines[${k}]`;
          counts.engines += 1;
          if (typeof e === 'string') {
            const r = parseEngineString(e);
            if (r.error) { err(ep, `engine '${e}' does not parse: ${r.error}`); continue; }
            engineFuels.add(r.fuel);
            if (r.fuel === 'electric') electricCount += 1;
            if (engineLabels.has(e)) warn(ep, `engine '${e}' listed twice`);
            engineLabels.add(e);
          } else if (isRec(e)) {
            keys(e, ENGINE_KEYS, ep);
            str(e.label, `${ep}.label`);
            if (!FUELS.includes(e.fuel)) { err(`${ep}.fuel`, `expected one of ${FUELS.join(', ')}`); continue; }
            engineFuels.add(e.fuel);
            if (e.fuel === 'electric') electricCount += 1;
            for (const n of ['cc', 'powerPs', 'powerKw', 'batteryKwh']) if (e[n] !== undefined && !(typeof e[n] === 'number' && e[n] > 0)) err(`${ep}.${n}`, 'expected a positive number');
            if (e.transmissions !== undefined) {
              if (!Array.isArray(e.transmissions) || !e.transmissions.length) err(`${ep}.transmissions`, 'expected a non-empty array');
              else for (const t of e.transmissions) if (!TRANSMISSIONS.includes(t)) err(`${ep}.transmissions`, `unknown transmission ${JSON.stringify(t)}`);
              if (e.fuel === 'electric' && e.transmissions.some((t) => t !== 'automatic')) err(`${ep}.transmissions`, 'electric engines are automatic only');
            }
            if (e.from !== undefined && !isYear(e.from)) err(`${ep}.from`, 'expected a year');
            if (e.to !== undefined && e.to !== null && !isYear(e.to)) err(`${ep}.to`, 'expected a year or null');
            if (typeof e.label === 'string') engineLabels.add(e.label);
          } else err(ep, 'expected an engine string or object');
        }
      }

      // fuels = union of engine fuels
      if (!Array.isArray(g.fuels)) err(`${gp}.fuels`, 'expected an array');
      else {
        for (const f of g.fuels) if (!FUELS.includes(f)) err(`${gp}.fuels`, `unknown fuel ${JSON.stringify(f)}`);
        if (new Set(g.fuels).size !== g.fuels.length) err(`${gp}.fuels`, 'duplicate fuel');
        const declared = new Set(g.fuels);
        const missing = [...engineFuels].filter((f) => !declared.has(f));
        const extra = [...declared].filter((f) => !engineFuels.has(f));
        if (missing.length || extra.length) err(`${gp}.fuels`, `must equal the union of the engine fuels [${[...engineFuels].join(', ')}] (missing: ${missing.join(', ') || '-'}; extra: ${extra.join(', ') || '-'})`);
      }

      // transmissions
      if (!Array.isArray(g.transmissions) || !g.transmissions.length) err(`${gp}.transmissions`, 'must be a non-empty array');
      else {
        for (const t of g.transmissions) if (!TRANSMISSIONS.includes(t)) err(`${gp}.transmissions`, `unknown transmission ${JSON.stringify(t)}`);
        if (new Set(g.transmissions).size !== g.transmissions.length) err(`${gp}.transmissions`, 'duplicate transmission');
        const engineCount = Array.isArray(g.engines) ? g.engines.length : 0;
        if (electricCount && electricCount === engineCount && (g.transmissions.length !== 1 || g.transmissions[0] !== 'automatic')) {
          err(`${gp}.transmissions`, "an all-electric generation is ['automatic'] only");
        }
        if (electricCount && !g.transmissions.includes('automatic')) err(`${gp}.transmissions`, "electric engines need 'automatic'");
      }

      // trims
      if (!Array.isArray(g.trims)) err(`${gp}.trims`, 'expected an array');
      else {
        if (m.vehicleType === 'car' && !g.trims.length) err(`${gp}.trims`, 'a car generation needs at least one trim');
        const trimNames = new Set();
        for (const [k, t] of g.trims.entries()) {
          const tp = `${gp}.trims[${k}]`;
          counts.trims += 1;
          let name;
          if (typeof t === 'string') { if (str(t, tp)) name = t; }
          else if (isRec(t)) {
            keys(t, TRIM_KEYS, tp);
            if (str(t.name, `${tp}.name`)) name = t.name;
            if (t.from !== undefined && !isYear(t.from)) err(`${tp}.from`, 'expected a year');
            if (t.to !== undefined && t.to !== null && !isYear(t.to)) err(`${tp}.to`, 'expected a year or null');
            if (t.bodies !== undefined) {
              if (!Array.isArray(t.bodies)) err(`${tp}.bodies`, 'expected an array');
              else for (const b of t.bodies) if (!BODIES.includes(b)) err(`${tp}.bodies`, `unknown body ${JSON.stringify(b)}`);
            }
            if (t.engines !== undefined) for (const e of strArr(t.engines, `${tp}.engines`)) if (!engineLabels.has(e)) warn(`${tp}.engines`, `engine '${e}' is not an engine of this generation`);
            if (t.features !== undefined) for (const f of strArr(t.features, `${tp}.features`)) if (featureIds && !featureIds.has(f)) err(`${tp}.features`, `unknown feature id '${f}' (features.json)`);
            gta(t.gtaGroup, `${tp}.gtaGroup`);
          } else err(tp, 'expected a trim string or object');
          if (name !== undefined) {
            if (trimNames.has(name.toLowerCase())) warn(tp, `trim '${name}' listed twice`);
            trimNames.add(name.toLowerCase());
          }
        }
      }
    }
    if (yFrom !== undefined && minFrom !== Infinity && minFrom !== yFrom) err(`${p}.years.from`, `must equal the earliest generation from (${minFrom}), got ${yFrom}`);
    if (yTo === null && !anyOpen) warn(`${p}.years.to`, `model is open (null) but every generation has ended (last ${maxTo})`);
    if (typeof yTo === 'number' && maxTo !== -Infinity && maxTo !== yTo) warn(`${p}.years.to`, `model ends ${yTo} but its last generation ends ${maxTo}`);
  }
  return { errors, warnings, counts };
}

/** Validate features.json (§D.3). */
export function validateFeatures(raw, file = 'features.json') {
  const errors = [];
  const warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const ids = new Set();
  if (!isRec(raw)) { err(file, 'expected an object'); return { errors, warnings, ids, count: 0 }; }
  for (const k of Object.keys(raw)) if (!['schemaVersion', 'categories'].includes(k)) err(file, `unknown field '${k}'`);
  if (raw.schemaVersion !== 1) err(`${file}.schemaVersion`, 'must be 1');
  if (!Array.isArray(raw.categories)) { err(`${file}.categories`, 'expected an array'); return { errors, warnings, ids, count: 0 }; }
  const catIds = raw.categories.map((c) => c?.id);
  for (const id of FEATURE_CATEGORIES) if (!catIds.includes(id)) err(`${file}.categories`, `missing category '${id}'`);
  for (const id of catIds) if (!FEATURE_CATEGORIES.includes(id)) err(`${file}.categories`, `unknown category ${JSON.stringify(id)}`);
  if (new Set(catIds).size !== catIds.length) err(`${file}.categories`, 'duplicate category id');
  let count = 0;
  const labels = new Map();
  for (const [i, c] of raw.categories.entries()) {
    const p = `${file}.categories[${i}]`;
    if (!isRec(c)) { err(p, 'expected a category'); continue; }
    for (const k of Object.keys(c)) if (!['id', 'label', 'items'].includes(k)) err(p, `unknown field '${k}'`);
    if (typeof c.label !== 'string' || !c.label.trim()) err(`${p}.label`, 'expected a label');
    if (!Array.isArray(c.items) || !c.items.length) { err(`${p}.items`, 'must be a non-empty array'); continue; }
    for (const [j, it] of c.items.entries()) {
      const ip = `${p}.items[${j}]`;
      if (!isRec(it)) { err(ip, 'expected an item'); continue; }
      count += 1;
      for (const k of Object.keys(it)) if (!FEATURE_ITEM_KEYS.includes(k)) err(ip, `unknown field '${k}'`);
      if (typeof it.id !== 'string' || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(it.id)) err(`${ip}.id`, `id must be snake_case (got ${JSON.stringify(it.id)})`);
      else if (ids.has(it.id)) err(`${ip}.id`, `duplicate id '${it.id}'`);
      else ids.add(it.id);
      if (typeof it.label !== 'string' || !it.label.trim()) err(`${ip}.label`, 'expected a label');
      else {
        const k = it.label.toLowerCase();
        if (labels.has(k)) warnings.push(`${ip}.label: label '${it.label}' also used by '${labels.get(k)}'`);
        labels.set(k, it.id);
      }
      if (!FEATURE_KINDS.includes(it.kind)) err(`${ip}.kind`, `kind must be one of ${FEATURE_KINDS.join(', ')}`);
      if (it.aliases !== undefined && (!Array.isArray(it.aliases) || it.aliases.some((a) => typeof a !== 'string' || !a.trim()))) err(`${ip}.aliases`, 'expected an array of strings');
    }
  }
  if (count < 150) err(file, `at least 150 items are required (got ${count})`);
  return { errors, warnings, ids, count };
}

// ---------------------------------------------------------------------------
// Coverage against the DfT/DVLA licensing reference
// ---------------------------------------------------------------------------

/** Lower case, accents and punctuation removed, words separated by single spaces. */
export function normName(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
const squash = (s) => normName(s).replace(/ /g, '');

/**
 * Does the reference model name match a catalogue name/alias? Case/punctuation-insensitive: equal, the catalogue name is a
 * prefix of the reference ('FIESTA ZETEC' → Fiesta), or the reference is a whole-word prefix of the catalogue name
 * ('Q4' → 'Q4 e-tron').
 */
export function modelNameMatches(refModel, candidate) {
  const r = squash(refModel);
  const c = squash(candidate);
  if (!r || !c) return false;
  if (r === c) return true;
  if (normName(candidate).startsWith(`${normName(refModel)} `)) return true;
  if (!r.startsWith(c)) return false;
  // Very short names ('KA', 'Q3', 'i3', 'EX') only match on a word boundary ('KA STUDIO' yes, 'KADJAR' no), at a
  // letter→digit change ('EX30' → EX, 'M30' → M) or a digit→letter change ('Q3 SPORTBACK' → Q3, 'Q30' → not Q3).
  if (c.length <= 3) {
    const rn = normName(refModel);
    const cn = normName(candidate);
    const next = r.slice(c.length);
    return rn === cn || rn.startsWith(`${cn} `) || (/\d$/.test(c) && !/^\d/.test(next)) || (/^[a-z]+$/.test(c) && /^\d/.test(next));
  }
  return true;
}

export function findMake(makes, refMake) {
  const k = squash(refMake);
  return makes.find((m) => [m.make, m.slug, ...(m.dvlaNames ?? []), ...(m.aliases ?? [])].some((n) => squash(n) === k));
}

export function matchReferenceModel(make, refModel) {
  const names = make.models.flatMap((m) => [m.name, ...(m.aliases ?? [])].map((n) => [n, m]));
  const tries = [refModel];
  // The licensing data sometimes repeats the make in the model column ('GWM HAVAL JOLION', 'MERCEDES-BENZ SPRINTER').
  for (const mk of [make.make, ...(make.dvlaNames ?? []), ...(make.aliases ?? [])]) {
    const n = normName(mk);
    const r = normName(refModel);
    if (n && r.startsWith(`${n} `)) tries.push(r.slice(n.length + 1));
  }
  for (const t of tries) {
    const hit = names.find(([n]) => modelNameMatches(t, n));
    if (hit) return hit[1];
  }
  return undefined;
}

/**
 * §D.4: every unmatched reference entry needs a reason in README.md. The README lists them per make as
 * `**Make** (`slug`, …):` followed by `- *Reason* — MODEL, MODEL (note), …` bullets; an entry counts as explained when
 * its exact name follows `— ` or `, ` in that make's block and is followed by `,`, ` (` or the end of the line.
 */
export function unexplainedCoverage(perMake, readmeText) {
  const missing = [];
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const row of perMake) {
    if (!row.unmatched.length) continue;
    const start = readmeText.indexOf(`(\`${row.slug}\`,`);
    const end = start < 0 ? -1 : readmeText.indexOf('\n**', start + 1);
    const block = start < 0 ? '' : readmeText.slice(start, end < 0 ? undefined : end);
    for (const u of row.unmatched) {
      if (!new RegExp(`(— |, )${esc(u.model)}( \\(|,|$)`, 'm').test(block)) missing.push({ slug: row.slug, model: u.model });
    }
  }
  return missing;
}

export function coverage(makes, reference) {
  const perMake = new Map();
  const unmatchedMakes = [];
  for (const [refMake, models] of reference) {
    const make = findMake(makes, refMake);
    if (!make) { unmatchedMakes.push({ refMake, models: models.length }); continue; }
    const row = perMake.get(make.slug) ?? { slug: make.slug, refMakes: [], total: 0, matched: 0, unmatched: [] };
    row.refMakes.push(refMake);
    for (const [model, from, to, types] of models) {
      row.total += 1;
      if (matchReferenceModel(make, model)) row.matched += 1;
      else row.unmatched.push({ refMake, model, from, to, types });
    }
    perMake.set(make.slug, row);
  }
  return { perMake: [...perMake.values()].sort((a, b) => a.slug.localeCompare(b.slug)), unmatchedMakes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const opts = { dir: path.resolve(here, '../data/vehicle-catalogue'), reference: undefined, makes: undefined, quiet: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = path.resolve(argv[++i]);
    else if (a === '--reference') opts.reference = argv[++i];
    else if (a === '--make') opts.makes = argv[++i].split(',');
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: check-catalogue.mjs [--dir <dir>] [--reference <file>] [--make <slug,…>] [--quiet] [--json]');
      process.exit(0);
    } else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  if (opts.reference && !path.isAbsolute(opts.reference) && !existsSync(opts.reference)) opts.reference = path.join(opts.dir, opts.reference);
  return opts;
}

export function loadCatalogue(dir) {
  const makesDir = path.join(dir, 'makes');
  const files = existsSync(makesDir) ? readdirSync(makesDir).filter((f) => f.endsWith('.json')).sort() : [];
  const out = [];
  for (const f of files) {
    const full = path.join(makesDir, f);
    let raw;
    let parseError;
    try { raw = JSON.parse(readFileSync(full, 'utf8')); } catch (e) { parseError = e.message; }
    out.push({ file: `makes/${f}`, full, raw, parseError, bytes: statSync(full).size });
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const errors = [];
  const warnings = [];
  const log = (...a) => { if (!opts.json) console.log(...a); };

  // features.json
  let featureIds;
  const featFile = path.join(opts.dir, 'features.json');
  let featureCount = 0;
  if (!existsSync(featFile)) errors.push('features.json: missing');
  else {
    try {
      const r = validateFeatures(JSON.parse(readFileSync(featFile, 'utf8')));
      errors.push(...r.errors);
      warnings.push(...r.warnings);
      featureIds = r.ids;
      featureCount = r.count;
    } catch (e) { errors.push(`features.json: ${e.message}`); }
  }

  // make files
  const files = loadCatalogue(opts.dir);
  const rows = [];
  const makes = [];
  const dvlaOwner = new Map();
  const makeAliasOwner = new Map();
  for (const f of files) {
    if (f.parseError) { errors.push(`${f.file}: invalid JSON: ${f.parseError}`); continue; }
    const r = validateMake(f.raw, f.file, { featureIds, bytes: f.bytes });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    const slug = f.raw?.slug ?? path.basename(f.file, '.json');
    for (const n of f.raw?.dvlaNames ?? []) {
      if (dvlaOwner.has(n)) errors.push(`${f.file}.dvlaNames: '${n}' is also a DVLA name of ${dvlaOwner.get(n)}`);
      dvlaOwner.set(n, slug);
    }
    for (const n of [f.raw?.make, ...(f.raw?.aliases ?? [])]) {
      if (typeof n !== 'string') continue;
      const k = squash(n);
      const o = makeAliasOwner.get(k);
      if (o && o !== slug) warnings.push(`${f.file}.aliases: '${n}' also names make ${o}`);
      makeAliasOwner.set(k, slug);
    }
    rows.push({ slug, make: f.raw?.make, ...r.counts, kb: Math.round(f.bytes / 1024), errors: r.errors.length, warnings: r.warnings.length });
    if (f.raw && Array.isArray(f.raw.models)) makes.push(f.raw);
  }
  const slugs = new Set(rows.map((r) => r.slug));
  for (const s of REQUIRED_MAKES) if (!slugs.has(s)) errors.push(`makes/${s}.json: missing (Appendix 3)`);

  const totals = rows.reduce((t, r) => ({ makes: t.makes + 1, models: t.models + r.models, generations: t.generations + r.generations, trims: t.trims + r.trims, engines: t.engines + r.engines }), { makes: 0, models: 0, generations: 0, trims: 0, engines: 0 });

  if (!opts.quiet && !opts.json) {
    log('make                   models  gens  trims engines   KB  err warn');
    for (const r of rows) {
      if (opts.makes && !opts.makes.includes(r.slug)) continue;
      log(`${r.slug.padEnd(22)} ${String(r.models).padStart(6)} ${String(r.generations).padStart(5)} ${String(r.trims).padStart(6)} ${String(r.engines).padStart(7)} ${String(r.kb).padStart(4)} ${String(r.errors).padStart(4)} ${String(r.warnings).padStart(4)}`);
    }
  }
  log(`totals: ${totals.makes} makes, ${totals.models} models, ${totals.generations} generations, ${totals.trims} trims, ${totals.engines} engines; features.json ${featureCount} items`);

  let cov;
  if (opts.reference) {
    const reference = JSON.parse(readFileSync(opts.reference, 'utf8'));
    cov = coverage(makes, reference);
    log('');
    log(`coverage against ${path.basename(opts.reference)} (DfT/DVLA licensing statistics, OGL v3.0; years of manufacture)`);
    for (const row of cov.perMake) {
      if (opts.makes && !opts.makes.includes(row.slug)) continue;
      const pct = row.total ? (100 * row.unmatched.length) / row.total : 0;
      const flag = PRIORITY_MAKES.includes(row.slug) && pct > 5 ? '  ABOVE 5% (priority make)' : '';
      log(`${row.slug}: ${row.matched}/${row.total} reference models matched, ${row.unmatched.length} unmatched (${pct.toFixed(1)}%)${flag}`);
      for (const u of row.unmatched) log(`    ${u.refMake} ${u.model}  ${u.from}–${u.to}  [${u.types.join(', ')}]`);
    }
    if (!opts.makes) {
      log(`reference makes with no catalogue make (${cov.unmatchedMakes.length}): ${cov.unmatchedMakes.map((u) => `${u.refMake} (${u.models})`).join(', ')}`);
    }
    const readme = path.join(opts.dir, 'README.md');
    const rows = cov.perMake.filter((r) => !opts.makes || opts.makes.includes(r.slug));
    cov.unexplained = existsSync(readme) ? unexplainedCoverage(rows, readFileSync(readme, 'utf8')) : rows.flatMap((r) => r.unmatched.map((u) => ({ slug: r.slug, model: u.model })));
    log('');
    if (!cov.unexplained.length) log('README.md gives a reason for every unmatched reference model (§D.4)');
    else {
      log(`${cov.unexplained.length} unmatched reference model(s) without a reason in README.md (§D.4):`);
      for (const u of cov.unexplained) log(`    ${u.slug}: ${u.model}`);
    }
  }

  if (warnings.length && !opts.quiet && !opts.json) {
    log('');
    log(`${warnings.length} warning(s):`);
    for (const w of warnings) log(`  ${w}`);
  }
  if (opts.json) console.log(JSON.stringify({ totals, rows, errors, warnings, coverage: cov }, null, 1));
  if (errors.length) {
    console.error(`\n${errors.length} error(s):`);
    for (const e of errors.slice(0, 500)) console.error(`  ${e}`);
    if (errors.length > 500) console.error(`  … ${errors.length - 500} more`);
    process.exitCode = 1;
    return;
  }
  log('\nOK: no schema errors');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
