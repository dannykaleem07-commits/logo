// owned by intake
/**
 * Signed CCGUK form recognition (docs/SUPREME-DESIGN.md §G.2 step 3): a text fingerprint of the printed labels in the
 * built-in mappings (`packages/documents/src/docx/fields/builtin/*.mapping.json`), computed in code and given to the
 * extractor as a hint. The model still classifies; the fingerprint only says "this text carries most of the labels of
 * form X".
 */
import { BUILTIN_DOCX_TEMPLATES, builtinMapping } from '@ccguk/documents';

export interface FormFingerprint {
  templateId: string;
  title: string;
  /** matched / total distinctive labels. */
  score: number;
  matched: number;
  total: number;
}

/** Labels too generic to tell one form from another. */
const GENERIC = new Set(['date', 'name', 'signature', 'signed', 'reference', 'ref', 'address', 'email', 'telephone', 'phone', 'yes', 'no', 'other', 'notes', 'title', 'full name', 'postcode', 'mobile']);

const words = (slug: string): string => slug.toLowerCase().replace(/[-_]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

let cache: Array<{ templateId: string; title: string; labels: string[] }> | undefined;

/** Distinctive labels per built-in template (cached). Exposed for tests. */
export function formLabelSets(): Array<{ templateId: string; title: string; labels: string[] }> {
  if (cache) return cache;
  const out: Array<{ templateId: string; title: string; labels: string[] }> = [];
  for (const t of BUILTIN_DOCX_TEMPLATES) {
    if (t.kind === 'letter') continue; // the letterhead is not a form anyone signs and returns
    let labels: string[] = [];
    try {
      const m = builtinMapping(t.id);
      labels = m.entries
        .map((e) => (typeof e.slot === 'string' ? '' : (e.slot.label ?? '')))
        .map(words)
        .filter((l) => l.length >= 5 && !GENERIC.has(l));
    } catch {
      labels = [];
    }
    const unique = [...new Set(labels)];
    if (unique.length) out.push({ templateId: t.id, title: t.title, labels: unique });
  }
  cache = out;
  return out;
}

/** The best-matching built-in form for this text, when at least 6 labels and half of them appear. */
export function fingerprintCcgukForm(text: string): FormFingerprint | null {
  const hay = ` ${words(text)} `;
  if (hay.trim().length < 40) return null;
  let best: FormFingerprint | null = null;
  for (const set of formLabelSets()) {
    const matched = set.labels.filter((l) => hay.includes(` ${l} `)).length;
    const score = matched / set.labels.length;
    if (matched >= 6 && score >= 0.5 && (!best || score > best.score)) best = { templateId: set.templateId, title: set.title, score: Math.round(score * 100) / 100, matched, total: set.labels.length };
  }
  return best;
}
