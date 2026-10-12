/**
 * Scanned-pack splitting (docs/SMART-INTAKE.md §4.14, improvement 6): one PDF holding several documents → page ranges,
 * each classified on its own. A new document starts at "Page 1 of M" (or when the previous one reached its M), when
 * the page type changes clearly and the header line changes, when the page size changes (A4 ↔ a licence scan), or after
 * a blank page (blank pages are dropped). Fewer than two segments → not a pack. AI-proposed segments (scanned PDFs)
 * must be contiguous, non-overlapping and cover every page.
 */
import type { DocType } from '../../agents/types.js';
import { DOC_TYPE_PLAIN } from './ranking.js';

export interface PageSignal {
  /** 1-based */
  index: number;
  chars: number;
  text: string;
  widthPt: number;
  heightPt: number;
  topType: DocType | null;
  topScore: number;
  secondScore: number;
  pageOfTotal: { n: number; m: number } | null;
  headerKey: string;
}

export interface Segment {
  fromPage: number;
  toPage: number;
  docType: DocType;
  confidence: number;
  title: string;
  why: string;
}

/** "Page 2 of 3" in a page's text. */
export function pageOfTotal(text: string): { n: number; m: number } | null {
  const m = /\bpage\s+(\d{1,3})\s*(?:of|\/)\s*(\d{1,3})\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const total = Number(m[2]);
  return n >= 1 && total >= n && total <= 500 ? { n, m: total } : null;
}

/** The first non-empty line, squashed (a header that repeats on every page of one document). */
export function headerKeyOf(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length >= 3) ?? '';
  return line.toLowerCase().replace(/page\s+\d+\s*(of|\/)\s*\d+/g, '').replace(/[^a-z]+/g, ' ').trim().slice(0, 60);
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function splitPages(pages: PageSignal[], opts: { minPages: number; minMargin: number }): Segment[] {
  if (pages.length < Math.max(2, opts.minPages)) return [];
  type Work = { pages: PageSignal[]; why: string; explicitStart: boolean };
  const segs: Work[] = [];
  let cur: Work | null = null;
  let afterBlank = false;
  for (const p of pages) {
    if (p.chars === 0 || !p.text.trim()) {
      afterBlank = true;
      continue;
    }
    let why = '';
    let explicit = false;
    if (cur) {
      const last = cur.pages[cur.pages.length - 1]!;
      const curType = dominant(cur.pages);
      if (p.pageOfTotal && p.pageOfTotal.n === 1) {
        why = '“Page 1 of …” starts a new document';
        explicit = true;
      } else if (last.pageOfTotal && last.pageOfTotal.n === last.pageOfTotal.m && !(p.pageOfTotal && p.pageOfTotal.n > 1)) {
        why = `the previous document ended at page ${last.pageOfTotal.m} of ${last.pageOfTotal.m}`;
        explicit = true;
      } else if (afterBlank) {
        why = 'a blank page separates the documents';
        explicit = true;
      } else if (Math.abs(p.widthPt - last.widthPt) > 20 || Math.abs(p.heightPt - last.heightPt) > 20) {
        why = 'the page size changes';
        explicit = true;
      } else if (p.topType && curType && p.topType !== curType && p.topScore - p.secondScore >= opts.minMargin && p.headerKey !== last.headerKey && !(p.pageOfTotal && p.pageOfTotal.n > 1)) {
        why = `the page reads as a ${DOC_TYPE_PLAIN[p.topType]} with a different heading`;
      }
    }
    if (!cur || why) {
      cur = { pages: [p], why: why || 'first page', explicitStart: explicit };
      segs.push(cur);
    } else cur.pages.push(p);
    afterBlank = false;
  }
  // merge adjacent segments of the same type without an explicit break
  const merged: Work[] = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && !s.explicitStart && dominant(prev.pages) === dominant(s.pages)) prev.pages.push(...s.pages);
    else merged.push(s);
  }
  if (merged.length < 2) return [];
  return merged.map((s) => {
    const type = dominant(s.pages) ?? 'other';
    const top = s.pages.reduce((n, p) => n + (p.topType === type ? p.topScore : 0), 0);
    const second = s.pages.reduce((n, p) => n + (p.topType === type ? p.secondScore : p.topScore), 0);
    const confidence = Math.min(0.85, Math.round((top / (top + second + 2)) * 100) / 100);
    const from = s.pages[0]!.index;
    const to = s.pages[s.pages.length - 1]!.index;
    return { fromPage: from, toPage: to, docType: type, confidence, title: `${capitalise(DOC_TYPE_PLAIN[type])} (page${from === to ? ` ${from}` : `s ${from}–${to}`})`, why: s.why };
  });
}

function dominant(pages: PageSignal[]): DocType | null {
  const score = new Map<DocType, number>();
  for (const p of pages) if (p.topType) score.set(p.topType, (score.get(p.topType) ?? 0) + p.topScore);
  let best: DocType | null = null;
  let n = 0;
  for (const [t, s] of score) if (s > n) [best, n] = [t, s];
  return best;
}

/** AI segments: contiguous, non-overlapping, covering 1..N, at least two — else null. */
export function validateSegments(segs: Segment[], pageCount: number): Segment[] | null {
  if (!Array.isArray(segs) || segs.length < 2 || pageCount < 2) return null;
  const sorted = [...segs].sort((a, b) => a.fromPage - b.fromPage);
  let next = 1;
  for (const s of sorted) {
    if (!Number.isInteger(s.fromPage) || !Number.isInteger(s.toPage)) return null;
    if (s.fromPage !== next || s.toPage < s.fromPage || s.toPage > pageCount) return null;
    next = s.toPage + 1;
  }
  return next === pageCount + 1 ? sorted : null;
}
