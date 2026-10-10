// owned by casework
/**
 * Facts and placeholders (docs/SUPREME-DESIGN.md §E.3). Drafts carry figures, dates, deadlines and references only as
 * `{{fact:<FactId>}}`; code replaces each with the Case Brief's `FactValue.display` (money `£1,287.00`, dates
 * `7 October 2026` in Europe/London). An unknown fact id is left in the text and reported, so the reviewer fails it.
 */
import { formatGBP, utcToLondonWall } from '@ccguk/domain';
import type { AppContext } from '../context.js';

export type FactId = string;

export interface FactValue {
  value: string | number | boolean | null;
  display: string;
  source: string;
  verified?: boolean;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Integer pence → "£1,287.00". */
export function moneyDisplay(pence: number): string {
  return formatGBP(Math.round(pence));
}

/** ISO date or date-time → "7 October 2026" (the Europe/London calendar day of an instant). */
export function dateDisplay(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const w = new Date(utcToLondonWall(t));
  return `${w.getUTCDate()} ${MONTHS[w.getUTCMonth()]} ${w.getUTCFullYear()}`;
}

/** London calendar day (YYYY-MM-DD) of an instant. */
export function londonIsoDate(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const w = new Date(utcToLondonWall(Date.parse(iso)));
  return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, '0')}-${String(w.getUTCDate()).padStart(2, '0')}`;
}

export const moneyFact = (pence: number, source: string, verified?: boolean): FactValue => ({ value: Math.round(pence), display: moneyDisplay(pence), source, ...(verified !== undefined ? { verified } : {}) });
export const dateFact = (iso: string, source: string): FactValue => ({ value: iso, display: dateDisplay(iso), source });
export const textFact = (text: string, source: string, verified?: boolean): FactValue => ({ value: text, display: text, source, ...(verified !== undefined ? { verified } : {}) });
export const numberFact = (n: number, source: string, unit?: string): FactValue => ({ value: n, display: unit ? `${n} ${unit}` : String(n), source });

/** `{{fact:<id>}}` with optional inner spaces. Ids: letters, digits, `_ . : -`. */
export const PLACEHOLDER_RE = /\{\{\s*fact:\s*([A-Za-z0-9_.:-]+)\s*\}\}/g;
export const hasPlaceholders = (text: string): boolean => new RegExp(PLACEHOLDER_RE.source).test(text);

export interface ResolveResult {
  text: string;
  /** Fact ids used (each once, in order of first use). */
  used: FactId[];
  /** Fact ids that do not exist in the brief (left in the text as written). */
  unknown: string[];
  /** The displays inserted (for the reviewer's facts tier: these figures are sourced). */
  inserted: Array<{ id: FactId; display: string }>;
}

/** Replace every `{{fact:<id>}}` with the brief's display value. */
export function resolvePlaceholders(text: string, brief: { facts: Record<FactId, FactValue> }): ResolveResult {
  const used: FactId[] = [];
  const unknown: string[] = [];
  const inserted: Array<{ id: FactId; display: string }> = [];
  const out = text.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (whole, id: string) => {
    const f = Object.prototype.hasOwnProperty.call(brief.facts, id) ? brief.facts[id] : undefined;
    if (!f) {
      if (!unknown.includes(id)) unknown.push(id);
      return whole;
    }
    if (!used.includes(id)) used.push(id);
    inserted.push({ id, display: f.display });
    return f.display;
  });
  return { text: out, used, unknown, inserted };
}

/** Placeholder ids written in a text (resolved or not). */
export function placeholderIds(text: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(PLACEHOLDER_RE.source, 'g'))].map((m) => m[1]!))];
}

/**
 * Remembers, per claim, the fact displays code inserted into drafts (so the reviewer can tell a sourced figure from a
 * typed one once the placeholders are gone). Process-local and bounded; the reviewer also re-derives from the brief.
 */
const insertedByClaim = new Map<string, Set<string>>();
export function rememberInserted(claimId: string, displays: string[]): void {
  let s = insertedByClaim.get(claimId);
  if (!s) {
    s = new Set();
    insertedByClaim.set(claimId, s);
    if (insertedByClaim.size > 500) insertedByClaim.delete(insertedByClaim.keys().next().value!);
  }
  for (const d of displays) s.add(d);
}
export function insertedDisplays(claimId: string): ReadonlySet<string> {
  return insertedByClaim.get(claimId) ?? new Set();
}

/** The resolver registered on ctx.services (gateway + mail call it with the claim id). */
export type ClaimPlaceholderResolver = (ctx: AppContext, claimId: string, text: string) => string;
