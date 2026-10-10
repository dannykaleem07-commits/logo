// owned by knowledge-learners
/**
 * L3 owner corrections: token diff, categories and clustering (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.4). Pure and
 * deterministic: the same before/after always gives the same ops, categories and cluster key, so the corrections
 * capture is idempotent and the curator sees stable clusters.
 *
 *   tokenDiff            Myers O(ND) shortest edit script over word tokens (whitespace-separated), merged into runs
 *   diffStats            words inserted / deleted and the changed share of all words
 *   categoriseCorrection what kind of edit the owner made (figures, placeholders, greeting/sign-off, tone, …)
 *   clusterKeyOf         the curator's grouping key (agent · template or email kind · categories · recurring edit)
 *   recurringEdits       inserted / deleted phrases the owner made in at least `minSupport` separate corrections
 */
import { sha8 } from './keys.js';

export type DiffOp = { op: 'eq' | 'ins' | 'del'; text: string };
export type CorrectionCategory = 'figures' | 'placeholders' | 'greeting_signoff' | 'tone' | 'legal_terms' | 'facts' | 'structure' | 'recipient' | 'attachments' | 'length';

/** Every category, in the fixed order categoriseCorrection reports them. */
export const CORRECTION_CATEGORIES: readonly CorrectionCategory[] = ['figures', 'placeholders', 'greeting_signoff', 'tone', 'legal_terms', 'facts', 'structure', 'recipient', 'attachments', 'length'];

/** Word tokens (whitespace-separated). */
export function wordTokens(text: string): string[] {
  return (text ?? '').split(/\s+/).filter((t) => t.length > 0);
}

/** Above this many token pairs the diff falls back to a common prefix/suffix + one replacement (bounded work). */
const MAX_EDIT_DISTANCE = 4000;

/** Myers' shortest edit script over token arrays; returns per-token ops (unmerged). */
function myers(a: readonly string[], b: readonly string[]): { op: DiffOp['op']; tok: string }[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null;
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    v = next;
    if (found) {
      trace.push(v.slice());
      break;
    }
  }
  // Backtrack (trace[d] holds V before step d; trace[last] the final V).
  const out: { op: DiffOp['op']; tok: string }[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: 'eq', tok: a[x - 1]! });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) out.push({ op: 'ins', tok: b[y - 1]! });
    else out.push({ op: 'del', tok: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    out.push({ op: 'eq', tok: a[x - 1]! });
    x--;
    y--;
  }
  return out.reverse();
}

function merge(ops: readonly { op: DiffOp['op']; tok: string }[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (last && last.op === o.op) last.text = `${last.text} ${o.tok}`;
    else out.push({ op: o.op, text: o.tok });
  }
  return out;
}

/** Myers over word tokens, deterministic. Consecutive tokens of the same op are merged (joined by one space). */
export function tokenDiff(before: string, after: string): DiffOp[] {
  const a = wordTokens(before);
  const b = wordTokens(after);
  const ops = myers(a, b);
  if (ops) return merge(ops);
  // Bounded fallback: common prefix and suffix, the middle replaced.
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const raw: { op: DiffOp['op']; tok: string }[] = [
    ...a.slice(0, p).map((tok) => ({ op: 'eq' as const, tok })),
    ...a.slice(p, a.length - s).map((tok) => ({ op: 'del' as const, tok })),
    ...b.slice(p, b.length - s).map((tok) => ({ op: 'ins' as const, tok })),
    ...a.slice(a.length - s).map((tok) => ({ op: 'eq' as const, tok })),
  ];
  return merge(raw);
}

const countWords = (text: string): number => wordTokens(text).length;

export function diffStats(ops: DiffOp[]): { inserted: number; deleted: number; changedRatio: number } {
  let inserted = 0;
  let deleted = 0;
  let equal = 0;
  for (const o of ops) {
    const n = countWords(o.text);
    if (o.op === 'ins') inserted += n;
    else if (o.op === 'del') deleted += n;
    else equal += n;
  }
  const total = 2 * equal + inserted + deleted;
  const changedRatio = total === 0 ? 0 : Math.round(((inserted + deleted) / total) * 1000) / 1000;
  return { inserted, deleted, changedRatio };
}

const FIGURE = /£|\d/;
const PLACEHOLDER = /\[[^\]]*\]|\{\{|\}\}|\bX{3,}\b|\bTBC\b/i;
const GREETING_SIGNOFF = /\b(?:dear|hi|hello|good\s+(?:morning|afternoon)|regards|kind|yours|sincerely|faithfully|thanks|thank|many|best|wishes|cheers)\b/i;
const TONE = /\b(?:please|kindly|unfortunately|regret|apologi[sz]e|sorry|urgent(?:ly)?|immediately|must|demand|appreciate|grateful|disappointed|unacceptable|frankly|simply|clearly|obviously|surely|hope|trust)\b|!/i;
const LEGAL = /\b(?:liability|liable|negligen\w*|section|s\.\s?\d|act|cpr|part\s?36|court|proceedings|without\s+prejudice|damages|mitigat\w*|gta|statute|judgment|claimant|defendant|indemnity|quantum|interest|limitation|pre[-\s]?action)\b/i;
const FACT = /\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b|\b(?=[A-Z0-9/-]*\d)(?=[A-Z0-9/-]*[A-Z])[A-Z0-9][A-Z0-9/-]{4,}\b/;
const RECIPIENT = /@|\b(?:to|cc|bcc)\s*:/i;
const ATTACHMENT = /\b(?:attach\w*|enclos\w*|pdf|docx?|invoice|pack)\b/i;

const paragraphs = (text: string): number => (text ?? '').split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;

/** What kind of edit the owner made (fixed order; deduplicated). An empty list means only whitespace changed. */
export function categoriseCorrection(before: string, after: string, ops: DiffOp[]): CorrectionCategory[] {
  const changed = ops.filter((o) => o.op !== 'eq').map((o) => o.text);
  const out = new Set<CorrectionCategory>();
  const any = (re: RegExp): boolean => changed.some((t) => re.test(t));
  if (any(FIGURE)) out.add('figures');
  if (any(PLACEHOLDER)) out.add('placeholders');
  if (any(GREETING_SIGNOFF)) out.add('greeting_signoff');
  if (any(TONE)) out.add('tone');
  if (any(LEGAL)) out.add('legal_terms');
  if (any(FACT)) out.add('facts');
  if (paragraphs(before) !== paragraphs(after)) out.add('structure');
  if (any(RECIPIENT)) out.add('recipient');
  if (any(ATTACHMENT)) out.add('attachments');
  const b = countWords(before);
  const a = countWords(after);
  if (Math.abs(a - b) >= 5 && Math.abs(a - b) / Math.max(b, 1) >= 0.25) out.add('length');
  return CORRECTION_CATEGORIES.filter((c) => out.has(c));
}

const keyPart = (s: string | null | undefined): string => (s ?? '').toLowerCase().trim().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || '-';

/**
 * The curator's cluster key: `corr:<agent>:<template id or email kind>:<categories>[:<insurer>][:<edit sha8>]`.
 * The insurer is part of the key only for insurer-specific edits (facts or recipients); the strongest recurring edit
 * (if any) splits a cluster so different habits are curated separately.
 */
export function clusterKeyOf(c: { agent: string | null; templateId: string | null; emailKind: string | null; insurerSlug: string | null; categories: CorrectionCategory[]; recurringEdits: string[] }): string {
  const cats = [...new Set(c.categories)].sort();
  const parts = ['corr', keyPart(c.agent), keyPart(c.templateId ?? c.emailKind), cats.length ? cats.join('+') : 'none'];
  if (c.insurerSlug && (cats.includes('facts') || cats.includes('recipient'))) parts.push(keyPart(c.insurerSlug));
  const edits = [...new Set(c.recurringEdits.map((e) => normalisePhrase(e)).filter(Boolean))].sort();
  if (edits.length) parts.push(sha8(edits[0]!));
  return parts.join(':');
}

/** Lower-case, single-spaced, trimmed of surrounding punctuation. */
export function normalisePhrase(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.,;:!?'"“”‘’()-]+|[\s.,;:!?'"“”‘’()-]+$/g, '');
}

/** Phrases inserted or deleted in at least `minSupport` separate corrections (support = number of corrections). */
export function recurringEdits(corrections: { ops: DiffOp[] }[], minSupport: number): { phrase: string; op: 'ins' | 'del'; support: number }[] {
  const counts = new Map<string, { phrase: string; op: 'ins' | 'del'; support: number }>();
  for (const c of corrections) {
    const seen = new Set<string>();
    for (const o of c.ops) {
      if (o.op === 'eq') continue;
      const phrase = normalisePhrase(o.text);
      if (!phrase || phrase.length > 300) continue;
      const key = `${o.op}\u0000${phrase}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = counts.get(key) ?? { phrase, op: o.op, support: 0 };
      cur.support += 1;
      counts.set(key, cur);
    }
  }
  return [...counts.values()].filter((e) => e.support >= Math.max(1, minSupport)).sort((a, b) => b.support - a.support || a.op.localeCompare(b.op) || a.phrase.localeCompare(b.phrase));
}
