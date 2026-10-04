/**
 * resolveField(key, src) — the value a merge field resolves to for this merge source (design doc §B.3).
 *
 * Pure: reads time only from `src.now`; undefined when the data is absent (never 'unknown', 'n/a', 0 or today as a
 * stand-in); dates are taken in Europe/London; open hire/storage records never yield an end date, day count or total;
 * GTA money carries its verification status. Handler fields have no resolver and always resolve to undefined.
 */
import { getFieldDef } from './dictionary.js';
import type { MergeSource } from './source.js';
import type { FieldValue } from './types.js';

export function resolveField(key: string, src: MergeSource): FieldValue | undefined {
  const def = getFieldDef(key);
  if (!def?.resolve || def.policy === 'handler') return undefined;
  try {
    const v = def.resolve(src);
    if (!v) return undefined;
    if ((v.t === 'text' && v.v.trim() === '') || ((v.t === 'list' || v.t === 'rows' || v.t === 'choice') && v.v.length === 0)) return undefined;
    return v;
  } catch {
    // A malformed record (e.g. an invalid ISO date) is treated as absent data, never guessed.
    return undefined;
  }
}
