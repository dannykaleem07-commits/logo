/**
 * suggestMapping(scan) — auto-mapping for uploaded templates (design doc §B.8).
 *
 * Tokens map by key (or alias); signature slots get policy `signature`; other slots are scored against every
 * type-compatible field's synonyms (exact slug match 1.0, token-set Jaccard ≥ 0.6 → 0.7·J + 0.3), with ±context for
 * hire/handover, third-party, own-insurer, witness, accident and "signed for CCGUK" sections (a witness statement's
 * name boxes are the witness's, the name under "Yours …" is the handler's); a bare Date beside a signature box is
 * proposed as signed by hand. A suggestion is accepted
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
  return new Set(slug.split('-').filter(Boolean));
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

/** What the document around a slot says about whose detail it is (§B.8 context). */
interface DocContext {
  /** Opening text of the document (its title block), lower case. */
  head: string;
  /** Section keys (sectionPath joined) that hold a signature box. */
  signatureSections: Set<string>;
  /** Plain text of the unfilled template. */
  text: string;
}

function docContext(scan: DocxScan): DocContext {
  return {
    head: scan.text.slice(0, 400).toLowerCase(),
    signatureSections: new Set(scan.slots.filter((s) => s.signature).map((s) => s.sectionPath.join('/'))),
    text: scan.text
  };
}

/** Up to 160 characters of template text before this slot's placeholder (its nth occurrence), lower case. */
function textBefore(slot: DocxSlot, doc: DocContext): string {
  const needle = slot.preview.trim();
  if (needle.length < 3) return '';
  let at = -1;
  for (let i = 0; i < Math.max(1, slot.ordinal); i++) {
    at = doc.text.indexOf(needle, at + 1);
    if (at < 0) return '';
  }
  return doc.text.slice(Math.max(0, at - 160), at).toLowerCase();
}

const party = (key: string): string => key.split('.')[0] ?? '';

function contextScore(slot: DocxSlot, key: string, doc: DocContext): number {
  const ctx = [...slot.sectionPath, slot.qualifier ?? '', ...slot.sectionTitles.map((t) => slugify(t)), slot.qualifierTitle ? slugify(slot.qualifierTitle) : ''].join('/');
  const witnessDoc = /witness statement/.test(doc.head);
  const witnessCtx = /witness/.test(ctx) || (witnessDoc && !/client|claimant|customer|hirer/.test(ctx));
  const hireCtx = /hire|replacement|fleet|handover|condition-report|release|return|vehicle-out|vehicle-in/.test(ctx);
  const tpCtx = /third-party|other-vehicle|other-driver/.test(ctx);
  const ownCtx = /own-insurer/.test(ctx);
  const accidentCtx = /accident|collision|incident/.test(ctx);
  // the person signing for CCGUK: a "for CCGUK" box, the office-use panel, or the name under "Yours sincerely/faithfully"
  const signerCtx = !witnessCtx && (/for-ccguk|ccguk-confirmation|on-behalf-of-ccguk|office-use|file-opened-by|checked-by/.test(ctx) || /yours\W{0,3}(sincerely|faithfully|\[sincerely)/.test(textBefore(slot, doc)));
  // "For the attention of [Name of handler]": the recipient's person, not ours
  const before = textBefore(slot, doc);
  const attentionCtx = /(for the attention of|\bf\.?a\.?o\.?)\W*$/.test(before.trimEnd()) || /attention/.test(ctx);
  const p = party(key);
  const isHire = p === 'hire' || p === 'hireVehicle';
  const isTp = p === 'tp' || p === 'tpInsurer';
  const isOwn = p === 'ownInsurer';
  const isClient = p === 'claimant';
  const isClientSide = p === 'vehicle' || isClient;
  let s = 0;
  if (hireCtx) s += isHire ? 0.2 : p === 'vehicle' ? -0.3 : 0;
  if (tpCtx) s += isTp ? 0.2 : isClientSide || isOwn ? -0.3 : 0;
  if (ownCtx) s += isOwn ? 0.2 : isTp ? -0.3 : 0;
  if (witnessCtx) s += p === 'witness' ? 0.3 : isClient ? -0.5 : key === 'doc.body.paragraphs' ? -0.3 : 0;
  else if (p === 'witness') s -= 0.3;
  if (signerCtx) s += p === 'handler' ? 0.3 : isClient || p === 'witness' ? -0.5 : 0;
  if (attentionCtx) s += p === 'recipient' ? 0.3 : p === 'handler' ? -0.5 : 0;
  if (accidentCtx) s += p === 'accident' ? 0.2 : key === 'doc.date' || key === 'doc.dateToday' ? -0.4 : 0;
  // hire-side people and dates only where the section or the document is about the hire
  if (p === 'hire' && !hireCtx && !/hire/.test(doc.head)) s -= 0.3;
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
  const doc = docContext(scan);
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
    // A bare "Date" beside a signature box is the date it is signed: dated by hand, never today's date.
    if (/^date(-signed)?$/.test(slot.labelSlug) && !slot.qualifier && doc.signatureSections.has(slot.sectionPath.join('/'))) {
      entries.push({ slotId: slot.id, policy: 'signature', score: 0.8, reason: 'date beside a signature — dated by hand when signed' });
      continue;
    }
    const scored: Array<{ def: FieldDef; score: number; reason: string }> = [];
    for (const def of FIELD_DEFS) {
      if (!compatible(slot, def)) continue;
      const b = baseScore(slot, def);
      if (b.score === 0) continue;
      const ctx = contextScore(slot, def.key, doc);
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
