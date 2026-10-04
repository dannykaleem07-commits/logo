/**
 * Catalogue queries (TEMPLATES-VEHICLES-DESKTOP §D.5): model lists, generations for a year, matching a DVLA/TCC
 * make + model string to catalogue slugs, and free-text search for the picker.
 */
import { getCatalogueMake, listCatalogueMakes, loadAllCatalogueMakes } from './load.js';
import { bodiesOf } from './normalise.js';
import type {
  CatalogueMakeSummary,
  CatalogueMatch,
  CatalogueModelSummary,
  CatalogueSearchHit,
  CatalogueVehicleType,
  NormalisedGeneration,
  NormalisedMake,
  NormalisedModel,
} from './types.js';

/** Lower case, accents stripped, every run of non-alphanumerics → one space. 'Citroën C4 Picasso' → 'citroen c4 picasso'. */
export function catalogueKey(s: string): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const compactKey = (s: string): string => catalogueKey(s).replace(/ /g, '');

function yearInRange(year: number, from: number, to: number | null): boolean {
  return year >= from && (to === null || year <= to);
}

export function modelSummary(m: NormalisedModel, year?: number): CatalogueModelSummary {
  const gens = year === undefined ? m.generations : generationsForYear(m, year);
  const out: CatalogueModelSummary = {
    makeSlug: m.makeSlug,
    slug: m.slug,
    name: m.name,
    vehicleType: m.vehicleType,
    segment: m.segment,
    years: m.years,
    bodies: bodiesOf(gens.length ? gens : m.generations),
  };
  if (m.custom) out.custom = true;
  return out;
}

/** Generations on sale in `year` (to = null → still on sale). */
export function generationsForYear(model: NormalisedModel, year: number): NormalisedGeneration[] {
  return model.generations.filter((g) => yearInRange(year, g.from, g.to));
}

export function listCatalogueModels(makeSlug: string, opts: { year?: number; vehicleType?: CatalogueVehicleType } = {}): CatalogueModelSummary[] {
  const make = getCatalogueMake(makeSlug);
  if (!make) return [];
  return make.models
    .filter((m) => (opts.vehicleType ? m.vehicleType === opts.vehicleType : true))
    .filter((m) => (opts.year !== undefined ? yearInRange(opts.year, m.years.from, m.years.to) : true))
    .map((m) => modelSummary(m, opts.year))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { numeric: true }));
}

export function getCatalogueModel(makeSlug: string, modelSlug: string): NormalisedModel | undefined {
  return getCatalogueMake(makeSlug)?.models.find((m) => m.slug === modelSlug);
}

// ---------------------------------------------------------------------------
// matchCatalogue
// ---------------------------------------------------------------------------

function makeNames(s: Pick<CatalogueMakeSummary, 'make' | 'slug' | 'dvlaNames' | 'aliases'>): string[] {
  return [s.make, s.slug, ...s.dvlaNames, ...s.aliases].map(catalogueKey).filter(Boolean);
}

/** The make summary whose name, slug, DVLA spelling or alias equals `make` (accents/case/punctuation ignored). */
export function findCatalogueMake(make: string, makes: CatalogueMakeSummary[] = listCatalogueMakes()): CatalogueMakeSummary | undefined {
  const key = catalogueKey(make);
  if (!key) return undefined;
  const compact = key.replace(/ /g, '');
  return makes.find((s) => makeNames(s).includes(key)) ?? makes.find((s) => makeNames(s).some((n) => n.replace(/ /g, '') === compact));
}

function restoreCase(remainder: string): string {
  const r = remainder.trim();
  if (!r) return r;
  if (r !== r.toUpperCase()) return r;
  // All capitals (DVLA style): title-case words of four letters or more, keep short grades and codes (GTI, SE, ST, 320D).
  return r
    .split(' ')
    .map((w) => (/^[A-Z]{4,}$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** Words of `original` after the first `n` words of its key form. */
function wordsAfter(original: string, nKeyWords: number): string {
  const words = original.trim().split(/\s+/);
  // Key words and original words line up except where punctuation split a word ("T-ROC" → "t roc"): walk both.
  let consumed = 0;
  let i = 0;
  while (i < words.length && consumed < nKeyWords) {
    consumed += catalogueKey(words[i]!).split(' ').filter(Boolean).length || 0;
    i += 1;
  }
  return words.slice(i).join(' ');
}

function matchModel(make: NormalisedMake, model: string): { model: NormalisedModel; remainder: string; exactName: boolean } | undefined {
  const key = catalogueKey(model);
  if (!key) return undefined;
  const keyWords = key.split(' ');
  let best: { model: NormalisedModel; len: number; nameLen: number | undefined } | undefined;
  for (const m of make.models) {
    const nameKey = catalogueKey(m.name);
    const candidates = [nameKey, catalogueKey(m.slug), ...m.aliases.map(catalogueKey)].filter(Boolean);
    for (const c of candidates) {
      const cw = c.split(' ');
      const hit = cw.length <= keyWords.length && cw.every((w, i) => keyWords[i] === w);
      // Spacing differences: 'C 220' vs the alias 'C220', 'TROC' vs 'T-Roc'.
      let compactLen = 0;
      if (!hit) {
        const cc = compactKey(c);
        for (let k = 1; k <= Math.min(3, keyWords.length) && !compactLen; k += 1) if (keyWords.slice(0, k).join('') === cc) compactLen = k;
      }
      if (!hit && !compactLen) continue;
      const len = hit ? cw.length : compactLen;
      if (!best || len > best.len || (len === best.len && c === nameKey)) {
        const nameWords = nameKey.split(' ');
        const startsWithName = nameWords.length <= keyWords.length && nameWords.every((w, i) => keyWords[i] === w);
        best = { model: m, len, nameLen: startsWithName ? nameWords.length : undefined };
      }
    }
  }
  if (!best) return undefined;
  // The remainder is what follows the model NAME ('GOLF GTI' matched by the alias 'Golf GTI' leaves 'GTI'); when an
  // alias that is not the name matched ('320D M SPORT' → 3 Series via '320d'), the whole string is the variant.
  const cut = best.nameLen ?? 0;
  return { model: best.model, remainder: restoreCase(wordsAfter(model, cut)), exactName: best.nameLen !== undefined };
}

/** 'FORD', 'FIESTA ZETEC' → ford/fiesta + 'Zetec'. Score: 0 nothing, 0.5 make only, 1 make and model. */
export function matchCatalogue(make: string, model?: string): CatalogueMatch {
  const summary = findCatalogueMake(make);
  if (!summary) return { score: 0 };
  const full = getCatalogueMake(summary.slug);
  if (!model || !full) return { make: summary, score: 0.5 };
  const m = matchModel(full, model);
  if (!m) return { make: summary, score: 0.5, variantRemainder: restoreCase(model.trim()) || undefined };
  const out: CatalogueMatch = { make: summary, model: modelSummary(m.model), score: m.exactName ? 1 : 0.9 };
  if (m.remainder) out.variantRemainder = m.remainder;
  return out;
}

// ---------------------------------------------------------------------------
// searchCatalogue
// ---------------------------------------------------------------------------

/** Indices in `q` where `phrase` occurs as whole words (the last query word may be a prefix of the phrase's last word). */
function findPhrase(q: string[], phrase: string[], used: boolean[]): number[] | undefined {
  if (!phrase.length || phrase.length > q.length) return undefined;
  for (let start = 0; start + phrase.length <= q.length; start += 1) {
    let ok = true;
    for (let i = 0; i < phrase.length && ok; i += 1) {
      const qi = start + i;
      const word = q[qi]!;
      if (used[qi]) ok = false;
      else if (word === phrase[i]) continue;
      else if (qi === q.length - 1 && i === phrase.length - 1 && word.length >= 2 && phrase[i]!.startsWith(word)) continue;
      else ok = false;
    }
    if (ok) return phrase.map((_p, i) => start + i);
  }
  return undefined;
}

function bestPhrase(q: string[], phrases: string[], used: boolean[]): number[] | undefined {
  let best: number[] | undefined;
  for (const p of phrases) {
    const hit = findPhrase(q, p.split(' ').filter(Boolean), used);
    if (hit && (!best || hit.length > best.length)) best = hit;
  }
  return best;
}

/** Free-text search: 'golf gti 2019', 'vw polo match', 'transit custom'. Highest score first. */
export function searchCatalogue(q: string, limit = 20): CatalogueSearchHit[] {
  const words = catalogueKey(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  const yearIdx = words.findIndex((w) => /^(19|20)\d{2}$/.test(w));
  const year = yearIdx >= 0 ? Number(words[yearIdx]) : undefined;
  const total = words.length;
  const hits: CatalogueSearchHit[] = [];
  for (const make of loadAllCatalogueMakes()) {
    const used = words.map((_w, i) => i === yearIdx);
    const makeHit = bestPhrase(words, makeNames(make), used);
    if (makeHit) for (const i of makeHit) used[i] = true;
    let anyModel = false;
    for (const model of make.models) {
      if (year !== undefined && !yearInRange(year, model.years.from, model.years.to)) continue;
      const mUsed = [...used];
      // The name first, so 'golf gti' leaves 'gti' for the trims; aliases only when the name is not in the query.
      const modelHit = bestPhrase(words, [model.name, model.slug.replace(/-/g, ' ')].map(catalogueKey), mUsed) ?? bestPhrase(words, model.aliases.map(catalogueKey), mUsed);
      if (!modelHit) continue;
      anyModel = true;
      for (const i of modelHit) mUsed[i] = true;
      const consumed = mUsed.filter(Boolean).length;
      const baseScore = consumed / total;
      const label = `${make.make} ${model.name}`;
      // Trim hits for the remaining words.
      const rest = words.filter((_w, i) => !mUsed[i]);
      let trimHits = 0;
      if (rest.length) {
        const gens = year !== undefined ? generationsForYear(model, year) : model.generations;
        for (const g of gens) {
          for (const t of g.trims) {
            const tUsed = [...mUsed];
            const th = findPhrase(words, catalogueKey(t.name).split(' '), tUsed);
            if (!th) continue;
            trimHits += 1;
            const score = Math.round(((consumed + th.length) / total) * 1000 + 50) / 1000;
            hits.push({ makeSlug: make.slug, make: make.make, modelSlug: model.slug, model: model.name, generationId: g.id, trimId: t.id, score, label: `${label} ${t.name} — ${g.name}` });
          }
        }
      }
      const genForYear = year !== undefined ? generationsForYear(model, year)[0] : undefined;
      const hit: CatalogueSearchHit = { makeSlug: make.slug, make: make.make, modelSlug: model.slug, model: model.name, score: Math.round(baseScore * 1000 + (trimHits ? 0 : 20)) / 1000, label: genForYear ? `${label} — ${genForYear.name}` : label };
      if (genForYear) hit.generationId = genForYear.id;
      hits.push(hit);
    }
    if (makeHit && !anyModel) hits.push({ makeSlug: make.slug, make: make.make, score: Math.round((makeHit.length / total) * 1000) / 1000, label: make.make });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, 'en-GB', { numeric: true }))
    .slice(0, Math.max(1, limit));
}
