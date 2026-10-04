/**
 * suggestMapping(scan) — auto-mapping for uploaded templates (design doc §B.8).
 *
 * Tokens map by key (or alias); signature slots get policy `signature`; other slots are scored against every
 * type-compatible field's synonyms (exact slug match 1.0, token-set Jaccard ≥ 0.6 → 0.7·J + 0.3), with ±context for
 * hire/replacement/fleet, third-party/other-vehicle/other-driver and own-insurer sections. A suggestion is accepted
 * when it scores ≥ 0.75 and beats the runner-up by ≥ 0.1; everything else is left for the handler. Nothing is saved
 * here — the UI shows score and reason and the user presses Save.
 */
import { slugify } from '../text.js';
import type { DocxScan, DocxSlot } from '../types.js';
import { FIELD_DEFS, getFieldDef } from './dictionary.js';
import { selectOptions } from './format.js';
import type { FieldDef, SuggestedEntry } from './types.js';

export const ACCEPT_SCORE = 0.75;
export const MIN_GAP = 0.1;

const TEXT_LIKE = new Set(['text', 'multiline', 'date', 'datetime', 'time', 'money', 'int']);

function compatible(slot: DocxSlot, def: FieldDef): boolean {
  switch (slot.kind) {
    case 'checkbox':
      return def.type === 'bool';
    case 'choice':
      return (def.type === 'choice' || def.type === 'bool') && selectOptions(def.type === 'bool' ? { t: 'bool', v: true } : { t: 'choice', v: Object.keys(def.choices ?? {}) }, slot, def).length > 0;
    case 'table':
      return def.type === 'rows';
    case 'paragraphs':
      return def.type === 'list';
    case 'blank': {
      switch (slot.blank?.pattern) {
        case 'date':
        case 'datetime':
        case 'month-year':
          return def.type === 'date' || def.type === 'datetime';
        case 'time':
          return def.type === 'time' || def.type === 'datetime';
        case 'money':
          return def.type === 'money';
        case 'number':
        case 'percent':
        case 'eighths':
          return def.type === 'int';
        default:
          return TEXT_LIKE.has(def.type);
      }
    }
    default:
      return TEXT_LIKE.has(def.type);
  }
}

function tokens(slug: string): Set<string> {
  return new Set(slug.split('-').filter((t) => t && t !== 'and' && t !== 'of' && t !== 'the'));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Label phrases of a slot: the label, and the label prefixed by its qualifier / innermost section. */
function slotPhrases(slot: DocxSlot): string[] {
  const label = slot.labelSlug;
  const out = [label];
  if (slot.qualifier) out.push(`${slot.qualifier}-${label}`);
  const section = slot.sectionPath[slot.sectionPath.length - 1];
  if (section && section !== 'title') out.push(`${section.replace(/^\d+-/, '')}-${label}`);
  return out;
}

function contextScore(slot: DocxSlot, key: string): number {
  const ctx = [...slot.sectionPath, slot.qualifier ?? ''].join('/');
  const hireCtx = /hire|replacement|fleet/.test(ctx);
  const tpCtx = /third-party|other-vehicle|other-driver/.test(ctx);
  const ownCtx = /own-insurer/.test(ctx);
  const isHire = key.startsWith('hire') || key.startsWith('hireVehicle');
  const isTp = key.startsWith('tp.') || key.startsWith('tpInsurer.');
  const isOwn = key.startsWith('ownInsurer.');
  const isClientSide = key.startsWith('vehicle.') || key.startsWith('claimant.');
  let s = 0;
  if (hireCtx) s += isHire ? 0.2 : key.startsWith('vehicle.') ? -0.3 : 0;
  if (tpCtx) s += isTp ? 0.2 : isClientSide || isOwn ? -0.3 : 0;
  if (ownCtx) s += isOwn ? 0.2 : isTp ? -0.3 : 0;
  return s;
}

function baseScore(slot: DocxSlot, def: FieldDef): { score: number; reason: string } {
  const synonyms = [...new Set([def.label, ...def.synonyms].map((s) => slugify(s)))];
  let best = { score: 0, reason: '' };
  for (const phrase of slotPhrases(slot)) {
    const pt = tokens(phrase);
    for (const syn of synonyms) {
      if (phrase === syn) {
        if (best.score < 1) best = { score: 1, reason: `label "${phrase}" equals synonym "${syn}"` };
        continue;
      }
      const j = jaccard(pt, tokens(syn));
      if (j >= 0.6) {
        const sc = 0.7 * j + 0.3;
        if (sc > best.score) best = { score: sc, reason: `label "${phrase}" is close to "${syn}" (${j.toFixed(2)})` };
      }
    }
  }
  return best;
}

export function suggestMapping(scan: DocxScan): { entries: SuggestedEntry[]; unmapped: string[] } {
  const entries: SuggestedEntry[] = [];
  const unmapped: string[] = [];
  for (const slot of scan.slots) {
    if (slot.kind === 'token' && slot.token) {
      const def = getFieldDef(slot.token.key);
      if (def) entries.push({ slotId: slot.id, key: def.key, policy: slot.signature ? 'signature' : def.policy, score: 1, reason: `token {{${slot.token.key}}}` });
      else {
        entries.push({ slotId: slot.id, policy: 'handler', score: 0, reason: 'UNKNOWN_TOKEN' });
        unmapped.push(slot.id);
      }
      continue;
    }
    if (slot.signature) {
      entries.push({ slotId: slot.id, policy: 'signature', score: 1, reason: 'signature box — never filled' });
      continue;
    }
    const scored: Array<{ def: FieldDef; score: number; reason: string }> = [];
    for (const def of FIELD_DEFS) {
      if (!compatible(slot, def)) continue;
      const b = baseScore(slot, def);
      if (b.score === 0) continue;
      const ctx = contextScore(slot, def.key);
      scored.push({ def, score: Math.max(0, Math.min(1.2, b.score + ctx)), reason: ctx ? `${b.reason}; context ${ctx > 0 ? '+' : ''}${ctx.toFixed(1)}` : b.reason });
    }
    scored.sort((a, b) => b.score - a.score || a.def.key.localeCompare(b.def.key));
    const [top, next] = scored;
    if (top && top.score >= ACCEPT_SCORE && (!next || top.score - next.score >= MIN_GAP)) {
      entries.push({ slotId: slot.id, key: top.def.key, policy: top.def.policy, score: Math.min(1, Number(top.score.toFixed(3))), reason: top.reason });
    } else {
      entries.push({ slotId: slot.id, policy: 'handler', score: top ? Number(Math.min(1, top.score).toFixed(3)) : 0, reason: top ? (top.score >= ACCEPT_SCORE ? `AMBIGUOUS: ${top.def.key} vs ${next!.def.key}` : `NO_MATCH (best ${top.def.key})`) : 'NO_MATCH' });
      unmapped.push(slot.id);
    }
  }
  return { entries, unmapped };
}
