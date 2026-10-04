/**
 * BM25 retrieval over the knowledge base.
 *
 * Fields indexed (with weights): citation, title, tags, topics, principle, text. Tokens are lower-cased,
 * split on non-alphanumerics, stop-worded and lightly stemmed (suffix stripping + 8-character truncation so
 * "impecuniosity" / "impecunious" and "mitigation" / "mitigate" collide). Scores are BM25F-style: weighted
 * term frequencies are summed across fields before saturation, so a hit in the title counts for more than one
 * in a long extract. No dependencies.
 */
import type { KbEntry, Verification } from '@ccguk/domain';
import { entryIndex, loadAll } from './load.js';
import type { SearchHit, SearchOptions } from './types.js';

// ---------------------------------------------------------------------------
// Tokenising and stemming
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'by', 'with', 'at', 'from', 'as', 'is', 'are', 'be', 'was', 'were',
  'it', 'its', 'this', 'that', 'these', 'those', 'or', 'not', 'no', 'nor', 'but', 'if', 'then', 'than', 'so', 'such', 'into',
  'under', 'over', 'any', 'all', 'where', 'which', 'who', 'whom', 'whose', 'what', 'when', 'v', 'vs', 'r', 're', 'ex', 'p',
  'has', 'have', 'had', 'does', 'do', 'did', 'may', 'must', 'can', 'will', 'would', 'should', 'shall', 'there', 'their', 'they',
  'he', 'his', 'she', 'her', 'we', 'our', 'you', 'your', 'i', 'per', 'via', 'also', 'only', 'other', 'each', 'own', 'same',
]);

const SUFFIXES = [
  'ability', 'ibility', 'ations', 'ation', 'ising', 'izing', 'ement', 'ments', 'ness', 'ment', 'ance', 'ence', 'ible', 'able', 'ally', 'ical',
  'ity', 'ies', 'ous', 'ive', 'ing', 'ers', 'ful', 'ism', 'ist', 'ise', 'ize', 'ate', 'ion', 'ial', 'ual', 'ary',
  'er', 'ed', 'es', 'ly', 'al', 's',
];

const MAX_STEM = 8;

/** Light stemmer: strip one known suffix (keeping at least 4 characters), then truncate to 8 characters. */
export function stem(token: string): string {
  let t = token;
  if (t.length > 4 && !/^\d+$/.test(t)) {
    for (const suf of SUFFIXES) {
      if (t.endsWith(suf) && t.length - suf.length >= 4) {
        t = t.slice(0, t.length - suf.length);
        break;
      }
    }
  }
  return t.length > MAX_STEM ? t.slice(0, MAX_STEM) : t;
}

/** Paragraph and rule numbers: "6.8.6", "4.14", "8.2.6r", "27.14", "2.7" — kept whole so a handler can search by them. */
const DOTTED_NUMBER = /\d+(?:\.\d+)+[a-z]?/g;
/** Boundary between a letter run and a digit run inside one token ("s172", "reg28", "cp1"). */
const LETTER_DIGIT_BOUNDARY = /(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)/;

/**
 * Lower-case, fold curly apostrophes, split on non-alphanumerics, drop stopwords and 1-char tokens, stem.
 * Dotted paragraph numbers are emitted as a single token (and again without a trailing rule letter, so
 * "8.2.6R" also matches "8.2.6"); mixed letter/digit tokens also emit their parts, so "s172" finds "s.172".
 */
export function tokenise(text: string): string[] {
  const out: string[] = [];
  const normalised = text.toLowerCase().replace(/[‘’'`]/g, '').replace(/[–—]/g, '-');
  for (const m of normalised.match(DOTTED_NUMBER) ?? []) {
    out.push(m);
    if (/[a-z]$/.test(m)) out.push(m.slice(0, -1));
  }
  for (const raw of normalised.split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
    if (/\d/.test(raw) && /[a-z]/.test(raw)) {
      for (const part of raw.split(LETTER_DIGIT_BOUNDARY)) {
        if (part.length >= 2 && !STOPWORDS.has(part)) out.push(stem(part));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

type Field = 'citation' | 'title' | 'tags' | 'topics' | 'principle' | 'text';

const FIELD_WEIGHTS: Record<Field, number> = {
  citation: 3,
  title: 3,
  tags: 2.5,
  topics: 2,
  principle: 1.2,
  text: 1,
};

const K1 = 1.2;
const B = 0.75;

interface IndexedDoc {
  entry: KbEntry;
  /** stem → weighted term frequency (sum over fields of weight × count). */
  tf: Map<string, number>;
  /** Weighted document length. */
  length: number;
}

export interface SearchIndex {
  docs: IndexedDoc[];
  /** stem → number of documents containing it. */
  df: Map<string, number>;
  avgLength: number;
}

function fieldText(entry: KbEntry, field: Field): string {
  switch (field) {
    case 'citation':
      return entry.citation;
    case 'title':
      return entry.title;
    case 'tags':
      return entry.tags.join(' ');
    case 'topics':
      return entry.topics.join(' ').replace(/_/g, ' ');
    case 'principle':
      return entry.principle;
    case 'text':
      return entry.text ?? '';
  }
}

/** Build a BM25 index over the given entries (defaults to every KB entry). */
export function buildIndex(entries: readonly KbEntry[] = loadAll()): SearchIndex {
  const docs: IndexedDoc[] = [];
  const df = new Map<string, number>();
  let totalLength = 0;
  for (const entry of entries) {
    const tf = new Map<string, number>();
    let length = 0;
    for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
      const weight = FIELD_WEIGHTS[field];
      const tokens = tokenise(fieldText(entry, field));
      length += weight * tokens.length;
      for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + weight);
    }
    for (const tok of tf.keys()) df.set(tok, (df.get(tok) ?? 0) + 1);
    docs.push({ entry, tf, length });
    totalLength += length;
  }
  return { docs, df, avgLength: docs.length ? totalLength / docs.length : 1 };
}

let defaultIndex: SearchIndex | undefined;

function getIndex(): SearchIndex {
  if (!defaultIndex) defaultIndex = buildIndex();
  return defaultIndex;
}

/** Drop the default index (tests only). */
export function resetSearchIndex(): void {
  defaultIndex = undefined;
}

function idf(index: SearchIndex, term: string): number {
  const n = index.df.get(term) ?? 0;
  const N = index.docs.length;
  return Math.log(1 + (N - n + 0.5) / (n + 0.5));
}

function bm25(index: SearchIndex, doc: IndexedDoc, terms: readonly string[]): number {
  let score = 0;
  for (const term of terms) {
    const tf = doc.tf.get(term);
    if (!tf) continue;
    const norm = K1 * (1 - B + (B * doc.length) / index.avgLength);
    score += idf(index, term) * ((tf * (K1 + 1)) / (tf + norm));
  }
  return score;
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

const HIGHLIGHT_FIELDS: Field[] = ['citation', 'title', 'principle', 'text', 'tags'];
const MAX_HIGHLIGHTS = 3;
const SNIPPET_RADIUS = 90;

function sentenceAround(text: string, at: number): string {
  let start = at;
  while (start > 0 && !/[.;!?]/.test(text[start - 1] ?? '')) start--;
  let end = at;
  while (end < text.length && !/[.;!?]/.test(text[end] ?? '')) end++;
  if (end < text.length) end++;
  if (end - start > SNIPPET_RADIUS * 2) {
    start = Math.max(start, at - SNIPPET_RADIUS);
    end = Math.min(end, at + SNIPPET_RADIUS);
    return `…${text.slice(start, end).trim()}…`;
  }
  return text.slice(start, end).trim();
}

/** Field-prefixed snippets of the places the query stems occur in an entry. */
export function highlightsFor(entry: KbEntry, queryStems: readonly string[]): string[] {
  const out: string[] = [];
  const stems = new Set(queryStems);
  for (const field of HIGHLIGHT_FIELDS) {
    const text = fieldText(entry, field);
    if (!text) continue;
    const lower = text.toLowerCase().replace(/[‘’'`]/g, '');
    // Walk the words of the field and pick the first whose stem is in the query.
    const re = /[a-z0-9]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const word = m[0];
      if (word.length < 2 || STOPWORDS.has(word)) continue;
      if (stems.has(stem(word))) {
        const snippet = field === 'tags' || field === 'citation' || field === 'title' ? text : sentenceAround(text, m.index);
        out.push(`${field}: ${snippet}`);
        break;
      }
    }
    if (out.length >= MAX_HIGHLIGHTS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * BM25 search. Filters by `types` and `topics` (any-of) before ranking. Returns at most `limit` (default 10)
 * hits with a positive score, ordered by score then id for a stable result.
 */
export function search(query: string, opts: SearchOptions = {}, index: SearchIndex = getIndex()): SearchHit[] {
  const terms = [...new Set(tokenise(query))];
  if (terms.length === 0) return [];
  const limit = opts.limit ?? 10;
  const types = opts.types && opts.types.length ? new Set(opts.types) : undefined;
  const topics = opts.topics && opts.topics.length ? new Set(opts.topics) : undefined;
  const hits: SearchHit[] = [];
  for (const doc of index.docs) {
    if (types && !types.has(doc.entry.type)) continue;
    if (topics && !doc.entry.topics.some((t) => topics.has(t))) continue;
    const score = bm25(index, doc, terms);
    if (score <= 0) continue;
    hits.push({ entry: doc.entry, score, highlights: highlightsFor(doc.entry, terms) });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return hits.slice(0, Math.max(0, limit));
}

function normaliseCitation(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Entries whose citation or title contains the fragment (case-, whitespace- and apostrophe-insensitive), e.g.
 * "Lagden v O'Connor", "[2003] UKHL 64", "GTA para 6.7", "ICOBS 8.2.6R".
 */
export function findByCitation(citationFragment: string, entries: readonly KbEntry[] = loadAll()): KbEntry[] {
  const needle = normaliseCitation(citationFragment);
  if (!needle) return [];
  return entries.filter((e) => normaliseCitation(e.citation).includes(needle) || normaliseCitation(e.title).includes(needle));
}

/** The verification status of an entry, or undefined when the id is unknown. */
export function verificationStatus(entryId: string): Verification['status'] | undefined {
  return entryIndex().get(entryId)?.verification.status;
}

/** The full verification record of an entry, or undefined when the id is unknown. */
export function verificationOf(entryId: string): Verification | undefined {
  return entryIndex().get(entryId)?.verification;
}

/** Ids from the list that are not 'verified' — unknown ids are included, since they cannot be relied on either. */
export function unverifiedAmong(entryIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of new Set(entryIds)) {
    if (verificationStatus(id) !== 'verified') out.push(id);
  }
  return out;
}
