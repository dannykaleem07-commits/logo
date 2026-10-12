/**
 * Duplicate and near-duplicate detection (docs/SMART-INTAKE.md §4.13, improvement 5): the same bytes (a photo also in
 * the ZIP), the same text (a letter re-saved), a resized or re-compressed photo (perceptual hash), the same letter
 * twice with small changes (5-word shingles). Duplicates are linked to a primary — never filed twice, never counted
 * twice — and the owner can still file a copy.
 */
import type { BundleFileRole } from './types.js';
import { hamming } from './phash.js';

export interface DupInput {
  files: Array<{ fileId: string; position: number; sha256: string; textSha256: string | null; text: string | null; phash: string | null; pixels: number | null; role: BundleFileRole; parentFileId: string | null }>;
  nearMaxDistance: number;
  shingleMin: number;
}

export type DupKind = 'same_file' | 'same_text' | 'near_photo' | 'near_text';
export interface DupResult {
  links: Array<{ fileId: string; of: string; kind: DupKind; similarity: number }>;
}

const CONTAINERS = new Set<BundleFileRole>(['archive', 'pack']);

function shingles(text: string, n = 5): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9£.\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function findDuplicates(input: DupInput): DupResult {
  const files = [...input.files].filter((f) => !CONTAINERS.has(f.role)).sort((a, b) => a.position - b.position || a.fileId.localeCompare(b.fileId));
  const linkOf = new Map<string, { of: string; kind: DupKind; similarity: number }>();
  const primaryOf = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 20; i += 1) {
      const l = linkOf.get(cur);
      if (!l) return cur;
      cur = l.of;
    }
    return cur;
  };
  /** Earliest top-level file wins; among photos, the one with more pixels. */
  const pickPrimary = (group: typeof files, photo: boolean) =>
    [...group].sort((a, b) => (photo ? (b.pixels ?? 0) - (a.pixels ?? 0) : 0) || Number(Boolean(a.parentFileId)) - Number(Boolean(b.parentFileId)) || a.position - b.position || a.fileId.localeCompare(b.fileId))[0]!;
  const linkGroup = (group: typeof files, kind: DupKind, photo: boolean, sim: (a: (typeof files)[number], b: (typeof files)[number]) => number) => {
    const free = group.filter((f) => !linkOf.has(f.fileId));
    if (free.length < 2) return;
    const primary = pickPrimary(free, photo);
    for (const f of free) {
      if (f.fileId === primary.fileId) continue;
      linkOf.set(f.fileId, { of: primaryOf(primary.fileId), kind, similarity: Math.round(sim(f, primary) * 100) / 100 });
    }
  };

  // same bytes
  const bySha = new Map<string, typeof files>();
  for (const f of files) bySha.set(f.sha256, [...(bySha.get(f.sha256) ?? []), f]);
  for (const g of bySha.values()) if (g.length > 1) linkGroup(g, 'same_file', false, () => 1);

  // same text
  const byText = new Map<string, typeof files>();
  for (const f of files) if (f.textSha256 && !linkOf.has(f.fileId)) byText.set(f.textSha256, [...(byText.get(f.textSha256) ?? []), f]);
  for (const g of byText.values()) if (g.length > 1) linkGroup(g, 'same_text', false, () => 1);

  // near photos (single-link groups by pHash distance)
  const photos = files.filter((f) => f.phash && !linkOf.has(f.fileId));
  const visited = new Set<string>();
  for (const p of photos) {
    if (visited.has(p.fileId)) continue;
    const group = [p];
    visited.add(p.fileId);
    for (let i = 0; i < group.length; i += 1) {
      for (const q of photos) {
        if (visited.has(q.fileId)) continue;
        if (hamming(group[i]!.phash!, q.phash!) <= input.nearMaxDistance) {
          group.push(q);
          visited.add(q.fileId);
        }
      }
    }
    if (group.length > 1) linkGroup(group, 'near_photo', true, (a, b) => 1 - hamming(a.phash!, b.phash!) / 64);
  }

  // near texts (letters over 400 characters)
  const texts = files.filter((f) => f.text && f.text.length > 400 && !linkOf.has(f.fileId)).map((f) => ({ f, sh: shingles(f.text!) }));
  for (let i = 0; i < texts.length; i += 1) {
    const a = texts[i]!;
    if (linkOf.has(a.f.fileId)) continue;
    for (let j = i + 1; j < texts.length; j += 1) {
      const b = texts[j]!;
      if (linkOf.has(b.f.fileId)) continue;
      const s = jaccard(a.sh, b.sh);
      if (s >= input.shingleMin) linkOf.set(b.f.fileId, { of: primaryOf(a.f.fileId), kind: 'near_text', similarity: Math.round(s * 100) / 100 });
    }
  }

  return { links: [...linkOf.entries()].map(([fileId, l]) => ({ fileId, ...l })).sort((a, b) => a.fileId.localeCompare(b.fileId)) };
}
