/**
 * Test support: re-scan a FILLED document with the template's slot map and return each slot's current preview.
 *
 * A filled value is no longer an empty cell / underscore blank / bracket, so a plain re-scan cannot find it again;
 * this helper locates every template slot's paragraph by its document-order index in the same part of the filled
 * document and strips the printed text around the slot. Valid when no paragraphs were inserted or removed before the
 * slot (tables/paragraphs overflow and removals are checked separately).
 */
import type { Element } from '@xmldom/xmldom';
import { scanPackage, type SlotTarget } from '../scan.js';
import { paragraphText } from '../text.js';
import { openDocx } from '../zip.js';
import { allParagraphs, closestW, partDom, wDescendants } from '../xml.js';

function lcp(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function lcs(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function paraOf(t: SlotTarget): Element | undefined {
  switch (t.t) {
    case 'range':
    case 'glyphs':
    case 'empty':
    case 'field':
      return t.para;
    case 'sdt':
      return closestW(t.sdt, 'p') ?? wDescendants(t.sdt, 'p')[0];
    default:
      return undefined;
  }
}

export function rescanPreviews(template: Uint8Array, filled: Uint8Array): Map<string, string> {
  const tpkg = openDocx(template);
  const fpkg = openDocx(filled);
  const { scan, targets } = scanPackage(tpkg);
  const out = new Map<string, string>();
  const tIndex = new Map<string, Element[]>();
  const fIndex = new Map<string, Element[]>();
  const paras = (pkg: typeof tpkg, cache: Map<string, Element[]>, part: string): Element[] => {
    let list = cache.get(part);
    if (!list) {
      list = allParagraphs(partDom(pkg, part));
      cache.set(part, list);
    }
    return list;
  };
  for (const slot of scan.slots) {
    const t = targets.get(slot.id)?.[0];
    if (!t) continue;
    const para = paraOf(t);
    if (!para) continue;
    const idx = paras(tpkg, tIndex, t.part).indexOf(para);
    const fpara = paras(fpkg, fIndex, t.part)[idx];
    if (idx < 0 || !fpara) continue;
    const T = paragraphText(para).text;
    const F = paragraphText(fpara).text;
    if (t.t === 'range') {
      const pre = Math.min(lcp(T, F), t.start);
      const suf = Math.min(lcs(T, F), T.length - t.end);
      out.set(slot.id, F.slice(pre, F.length - suf));
    } else if (t.t === 'glyphs') {
      out.set(slot.id, t.glyphs.map((g) => F[g] ?? '').join(''));
    } else if (t.t === 'empty') {
      out.set(slot.id, t.run ? F.slice(lcp(T, F)) : F);
    } else {
      out.set(slot.id, F);
    }
  }
  return out;
}
