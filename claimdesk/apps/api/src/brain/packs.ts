// owned by casework
/**
 * Brain packs (docs/SUPREME-DESIGN.md §E.5): import, validate, store and version the owner's private packs.
 *
 * Sources
 *   - `.ccbrain` file = zip with `manifest.json` + `entries/*.jsonl` + `docs/*.md` (read with fflate);
 *   - a folder with `manifest.json` (same layout, unzipped);
 *   - a skill folder (`SKILL.md` + `references/*.md`, e.g. the owner's "Danny Brain" skill): wrapped as
 *     strategy / knowledge / snippet entries split at headings; the owner reviews the preview, chooses the business
 *     tags and precedence, then activates.
 *
 * Every file is hashed (sha256); a manifest's `files` hashes must match. A version is stored under
 * `DATA_DIR/brain/packs/<id>/<version>/` (never the app folder, never the repo) and in `brain_pack_versions` /
 * `brain_entries`; versions sit side by side and `brain_packs.active_version` decides which one retrieval reads
 * (rollback = activate an older version). Imports and activations are audited (`brain.pack.import`,
 * `brain.pack.activate`, `brain.pack.deactivate`).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { BRAIN_ENTRY_KINDS, type BrainEntryKind, type BrainPackKind } from '@ccguk/domain';
import type { Actor, BrainPackRecord, BrainPackVersionRecord, NewBrainEntry } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, conflict } from '../errors.js';

export const BRAIN_PACK_SCHEMA = 'claimdesk.brainpack/1';
/** Hard limits on an import (zip bombs, runaway folders). */
export const MAX_PACK_FILES = 2_000;
export const MAX_PACK_BYTES = 200 * 1024 * 1024;
export const MAX_ENTRIES = 20_000;

export const BUSINESSES = ['ccguk', 'fixmyfile'] as const;
export type Business = (typeof BUSINESSES)[number];

/** Default precedence by pack kind (lower = higher authority: CCGUK rules L3 before the playbook L4, §E.1). */
export const DEFAULT_PRECEDENCE: Readonly<Record<BrainPackKind, number>> = { ccguk: 30, playbook: 40, learned: 50, other: 60 };

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export const manifestSchema = z
  .object({
    schema: z.literal(BRAIN_PACK_SCHEMA),
    id: z.string().regex(ID_RE, 'id: lower-case letters, digits, - and _ (max 64)'),
    name: z.string().min(1).max(200),
    version: z.string().regex(VERSION_RE, 'version: letters, digits and . + _ - (max 64)'),
    publisher: z.string().max(200).optional(),
    kind: z.enum(['ccguk', 'playbook', 'learned', 'other']).optional(),
    business: z.array(z.enum(BUSINESSES)).max(2).default([]),
    topics: z.array(z.string().max(80)).max(200).default([]),
    precedence: z.number().int().min(0).max(1000).optional(),
    requiresApp: z.string().max(40).optional(),
    licence: z.string().max(80).optional(),
    description: z.string().max(4000).optional(),
    files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/i, 'sha256 hex')).default({}),
  })
  .passthrough();
export type BrainManifest = z.infer<typeof manifestSchema>;

const entrySchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(BRAIN_ENTRY_KINDS as unknown as [BrainEntryKind, ...BrainEntryKind[]]),
    title: z.string().min(1).max(500),
    body: z.string().max(200_000).optional(),
    tags: z.array(z.string().max(80)).max(100).optional(),
    business: z.array(z.enum(BUSINESSES)).max(2).optional(),
    verification: z.enum(['verified', 'unverified', 'failed']).optional(),
  })
  .passthrough()
  .superRefine((e, ctx) => {
    if (e.kind === 'redLine') {
      const r = e as Record<string, unknown>;
      if (typeof r.pattern !== 'string' && r.condition === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a redLine needs a pattern or a condition' });
      if (r.action !== 'block' && r.action !== 'escalate') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a redLine action is block or escalate' });
      if (typeof r.pattern === 'string') {
        try {
          new RegExp(r.pattern, 'i');
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `redLine pattern is not a valid regular expression: ${r.pattern}` });
        }
      }
    }
  });

export type PackSourceKind = 'ccbrain' | 'folder' | 'skill';

export interface ParsedPack {
  sourceKind: PackSourceKind;
  manifest: BrainManifest;
  kind: BrainPackKind;
  precedence: number;
  entries: NewBrainEntry[];
  /** path → bytes of every file in the pack (stored under DATA_DIR). */
  files: Map<string, Uint8Array>;
  /** sha256 over the sorted (path, sha256) list — identifies the exact pack content. */
  sha256: string;
  warnings: string[];
}

export class BrainPackError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, 'BRAIN_PACK_INVALID', message, details);
  }
}

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const utf8 = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b).replace(/^\uFEFF/, '');

/** Normalised relative path inside a pack, or undefined when unsafe (absolute, `..`, drive letters, empty). */
export function safePackPath(p: string): string | undefined {
  const s = p.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.includes('\0')) return undefined;
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..')) return undefined;
  return parts.join('/');
}

// ---------------------------------------------------------------------------
// Reading sources
// ---------------------------------------------------------------------------

/** Files of a `.ccbrain` zip (directories skipped; unsafe paths refused). */
export function readCcbrain(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength > MAX_PACK_BYTES) throw new BrainPackError(`The pack is larger than ${MAX_PACK_BYTES / 1024 / 1024} MB`);
  let raw: Record<string, Uint8Array>;
  let count = 0;
  let total = 0;
  try {
    raw = unzipSync(bytes, {
      filter: (f) => {
        count += 1;
        total += f.originalSize;
        if (count > MAX_PACK_FILES || total > MAX_PACK_BYTES) throw new BrainPackError('The pack has too many files or unpacks too large');
        return !f.name.endsWith('/');
      },
    });
  } catch (err) {
    if (err instanceof BrainPackError) throw err;
    throw new BrainPackError(`Not a readable .ccbrain (zip) file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(raw)) {
    const p = safePackPath(name);
    if (!p) throw new BrainPackError(`Unsafe path inside the pack: ${name}`);
    // a zip made by "Send to compressed folder" may wrap everything in one top folder
    out.set(p, data);
  }
  return unwrapSingleFolder(out);
}

/** When every file sits under one top-level folder that holds manifest.json or SKILL.md, drop that folder. */
function unwrapSingleFolder(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.has('manifest.json') || files.has('SKILL.md')) return files;
  const tops = new Set([...files.keys()].map((p) => p.split('/')[0]!));
  if (tops.size !== 1) return files;
  const top = [...tops][0]!;
  if (!files.has(`${top}/manifest.json`) && !files.has(`${top}/SKILL.md`)) return files;
  return new Map([...files].map(([p, b]) => [p.slice(top.length + 1), b]));
}

/** Files of a folder on this PC (recursive; hidden files and `node_modules` skipped). */
export function readFolder(dir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let total = 0;
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(a);
      if (st.isDirectory()) walk(a, r);
      else if (st.isFile()) {
        total += st.size;
        if (out.size >= MAX_PACK_FILES || total > MAX_PACK_BYTES) throw new BrainPackError('The folder has too many files or is too large to import as a pack');
        out.set(r, new Uint8Array(readFileSync(a)));
      }
    }
  };
  walk(dir, '');
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A file's sha256 per path, sorted by path, then the pack hash over the list. */
export function packHash(files: Map<string, Uint8Array>): { perFile: Record<string, string>; sha256: string } {
  const perFile: Record<string, string> = {};
  for (const p of [...files.keys()].sort()) perFile[p] = sha256(files.get(p)!);
  return { perFile, sha256: sha256(Object.entries(perFile).map(([p, h]) => `${p}\u0000${h}`).join('\n')) };
}

export interface Section {
  title: string;
  level: number;
  body: string;
}

/** Split Markdown at ATX headings (#, ##, ###). Text before the first heading is a section titled `fallbackTitle`. */
export function splitMarkdown(md: string, fallbackTitle: string): Section[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: Section[] = [];
  let cur: Section = { title: fallbackTitle, level: 0, body: '' };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m) {
      if (cur.body.trim() || cur.level > 0) out.push({ ...cur, body: cur.body.trim() });
      cur = { title: m[2]!.trim(), level: m[1]!.length, body: '' };
    } else cur.body += `${line}\n`;
  }
  if (cur.body.trim() || cur.level > 0) out.push({ ...cur, body: cur.body.trim() });
  return out.filter((s) => s.body.length > 0);
}

/** `---\nkey: value\n---` front matter (flat string values only). */
export function frontMatter(md: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { data: {}, body: md };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) data[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return { data, body: md.slice(m[0].length) };
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';

const SNIPPET_TITLE = /\b(template|snippet|wording|script|letter|email|phrase|sample)\b/i;

function sectionEntries(sections: Section[], prefix: string, kind: (s: Section) => BrainEntryKind, tags: string[]): NewBrainEntry[] {
  const used = new Map<string, number>();
  return sections.map((s) => {
    const base = `${prefix}/${slugify(s.title)}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { id: n === 1 ? base : `${base}-${n}`, kind: kind(s), title: s.title.slice(0, 500), body: s.body.slice(0, 200_000), tags, business: [], data: { headingLevel: s.level } };
  });
}

function parseEntriesJsonl(file: string, text: string, warnings: string[]): NewBrainEntry[] {
  const out: NewBrainEntry[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new BrainPackError(`${file} line ${i + 1} is not valid JSON`);
    }
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success) throw new BrainPackError(`${file} line ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.') || 'entry'} ${x.message}`).join('; ')}`);
    const { id, kind, title, body, tags, business, verification, ...data } = parsed.data as z.infer<typeof entrySchema> & Record<string, unknown>;
    const text = body ?? summariseData(kind, data);
    if (kind === 'knowledge' && !verification) warnings.push(`${id}: knowledge entry without a verification status — treated as unverified`);
    out.push({ id, kind, title, body: text, tags: tags ?? [], business: business ?? [], data, verification: kind === 'knowledge' ? (verification ?? 'unverified') : (verification ?? null) });
  });
  return out;
}

/** Searchable text for an entry given as structured fields (strategy steps, letter style do/don't, …). */
function summariseData(kind: string, data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') parts.push(`${k}: ${v}`);
    else if (Array.isArray(v)) parts.push(`${k}: ${v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ')}`);
  }
  return parts.join('\n') || kind;
}

function kindFor(manifest: { kind?: BrainPackKind; business: string[] }): BrainPackKind {
  if (manifest.kind) return manifest.kind;
  if (manifest.business.length === 1 && manifest.business[0] === 'fixmyfile') return 'playbook';
  return 'other';
}

/** Parse a pack's files (manifest pack or skill folder). Throws BrainPackError with a readable reason. */
export function parsePack(files: Map<string, Uint8Array>, sourceKind: Exclude<PackSourceKind, 'skill'> | 'auto' = 'auto'): ParsedPack {
  if (!files.size) throw new BrainPackError('The pack is empty');
  const warnings: string[] = [];
  const hash = packHash(files);
  if (files.has('manifest.json')) {
    let raw: unknown;
    try {
      raw = JSON.parse(utf8(files.get('manifest.json')!));
    } catch {
      throw new BrainPackError('manifest.json is not valid JSON');
    }
    const m = manifestSchema.safeParse(raw);
    if (!m.success) throw new BrainPackError(`manifest.json: ${m.error.issues.map((x) => `${x.path.join('.') || 'manifest'} ${x.message}`).join('; ')}`, { issues: m.error.issues });
    const manifest = m.data;
    for (const [p, h] of Object.entries(manifest.files)) {
      const sp = safePackPath(p);
      if (!sp || !files.has(sp)) throw new BrainPackError(`manifest.json lists ${p}, which is not in the pack`);
      if (hash.perFile[sp] !== h.toLowerCase()) throw new BrainPackError(`${p} does not match its sha256 in manifest.json (the pack was changed or damaged)`);
    }
    const unlisted = [...files.keys()].filter((p) => p !== 'manifest.json' && !Object.keys(manifest.files).map((x) => safePackPath(x)).includes(p));
    if (unlisted.length) warnings.push(`${unlisted.length} file(s) have no sha256 in the manifest: ${unlisted.slice(0, 5).join(', ')}${unlisted.length > 5 ? '…' : ''}`);
    const entries: NewBrainEntry[] = [];
    for (const p of [...files.keys()].sort()) {
      if (/^entries\/[^/]+\.jsonl$/i.test(p)) entries.push(...parseEntriesJsonl(p, utf8(files.get(p)!), warnings));
      else if (/^docs\/.+\.md$/i.test(p)) {
        const name = path.posix.basename(p, path.posix.extname(p));
        entries.push(...sectionEntries(splitMarkdown(utf8(files.get(p)!), name), `doc/${slugify(name)}`, (s) => (SNIPPET_TITLE.test(s.title) ? 'snippet' : 'knowledge'), ['doc']).map((e) => ({ ...e, verification: e.kind === 'knowledge' ? 'unverified' : null })));
      }
    }
    return finish({ sourceKind: sourceKind === 'auto' ? 'folder' : sourceKind, manifest, kind: kindFor(manifest), precedence: manifest.precedence ?? DEFAULT_PRECEDENCE[kindFor(manifest)], entries, files, sha256: hash.sha256, warnings });
  }
  if (files.has('SKILL.md')) return parseSkill(files, hash, warnings);
  throw new BrainPackError('No manifest.json or SKILL.md found: this is not a brain pack or a skill folder');
}

function parseSkill(files: Map<string, Uint8Array>, hash: { perFile: Record<string, string>; sha256: string }, warnings: string[]): ParsedPack {
  const skill = frontMatter(utf8(files.get('SKILL.md')!));
  const name = skill.data.name?.trim() || 'Imported skill';
  const id = slugify(name).replace(/-/g, '-').slice(0, 64).replace(/^[^a-z0-9]+/, '') || 'skill';
  const version = skill.data.version && VERSION_RE.test(skill.data.version) ? skill.data.version : `1.0.0+${hash.sha256.slice(0, 8)}`;
  const entries: NewBrainEntry[] = [];
  entries.push(...sectionEntries(splitMarkdown(skill.body, name), 'skill', (s) => (SNIPPET_TITLE.test(s.title) ? 'snippet' : 'strategy'), ['skill']));
  for (const p of [...files.keys()].sort()) {
    if (!/^references\/.+\.md$/i.test(p)) continue;
    const ref = path.posix.basename(p, path.posix.extname(p));
    entries.push(...sectionEntries(splitMarkdown(utf8(files.get(p)!), ref), `ref/${slugify(ref)}`, (s) => (SNIPPET_TITLE.test(s.title) ? 'snippet' : 'knowledge'), ['reference', slugify(ref)]).map((e) => ({ ...e, verification: e.kind === 'knowledge' ? 'unverified' : null })));
  }
  const ignored = [...files.keys()].filter((p) => p !== 'SKILL.md' && !/^references\/.+\.md$/i.test(p));
  if (ignored.length) warnings.push(`${ignored.length} file(s) are not SKILL.md or references/*.md and were stored but not indexed`);
  warnings.push('Skill folder: choose the business tags (CCGUK and/or Fixmyfile) and the precedence before activating');
  const manifest = manifestSchema.parse({
    schema: BRAIN_PACK_SCHEMA,
    id,
    name,
    version,
    publisher: 'owner',
    kind: 'playbook',
    business: [],
    topics: [],
    precedence: DEFAULT_PRECEDENCE.playbook,
    licence: 'private',
    description: skill.data.description?.slice(0, 4000),
    files: hash.perFile,
  });
  return finish({ sourceKind: 'skill', manifest, kind: 'playbook', precedence: DEFAULT_PRECEDENCE.playbook, entries, files, sha256: hash.sha256, warnings });
}

function finish(p: ParsedPack): ParsedPack {
  if (!p.entries.length) throw new BrainPackError('The pack has no entries (entries/*.jsonl, docs/*.md, or SKILL.md sections)');
  if (p.entries.length > MAX_ENTRIES) throw new BrainPackError(`The pack has ${p.entries.length} entries; the limit is ${MAX_ENTRIES}`);
  const seen = new Set<string>();
  for (const e of p.entries) {
    if (seen.has(e.id)) throw new BrainPackError(`Duplicate entry id ${e.id}`);
    seen.add(e.id);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Storage + database
// ---------------------------------------------------------------------------

/** `DATA_DIR/brain/packs` — private, inside the owner's data folder (never the app folder). */
export function packsRoot(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'brain', 'packs');
}

const fsSafe = (s: string): string => s.replace(/[^A-Za-z0-9._+-]/g, '_');

export interface PackPreview {
  packId: string;
  name: string;
  version: string;
  kind: BrainPackKind;
  sourceKind: PackSourceKind;
  business: string[];
  precedence: number;
  entries: number;
  byKind: Record<string, number>;
  sample: Array<{ id: string; kind: string; title: string }>;
  redLines: Array<{ id: string; title: string; action: string }>;
  warnings: string[];
  sha256: string;
}

export interface ImportResult {
  pack: BrainPackRecord;
  version: BrainPackVersionRecord;
  preview: PackPreview;
  duplicate: boolean;
}

function previewOf(p: ParsedPack, packId = p.manifest.id, version = p.manifest.version): PackPreview {
  const byKind: Record<string, number> = {};
  for (const e of p.entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return {
    packId,
    name: p.manifest.name,
    version,
    kind: p.kind,
    sourceKind: p.sourceKind,
    business: [...p.manifest.business],
    precedence: p.precedence,
    entries: p.entries.length,
    byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b))),
    sample: p.entries.slice(0, 12).map((e) => ({ id: e.id, kind: e.kind, title: e.title })),
    redLines: p.entries.filter((e) => e.kind === 'redLine').map((e) => ({ id: e.id, title: e.title, action: String((e.data as { action?: unknown }).action ?? '') })),
    warnings: p.warnings,
    sha256: p.sha256,
  };
}

/** Preview for an already-stored version (Settings list). */
export function storedPreview(ctx: AppContext, packId: string, version: string): PackPreview {
  const pack = ctx.repos.requireBrainPack(ctx.db, packId);
  const v = ctx.repos.requireBrainPackVersion(ctx.db, packId, version);
  const entries = ctx.repos.listBrainEntries(ctx.db, { packId, version, limit: 5000 });
  const m = (v.manifest ?? {}) as Partial<BrainManifest> & { sourceKind?: PackSourceKind; warnings?: string[] };
  return {
    packId,
    name: pack.name,
    version,
    kind: pack.kind,
    sourceKind: m.sourceKind ?? 'folder',
    business: [...(m.business ?? pack.business)],
    precedence: pack.precedence,
    entries: v.entries,
    byKind: ctx.repos.countBrainEntriesByKind(ctx.db, packId, version),
    sample: entries.slice(0, 12).map((e) => ({ id: e.id, kind: e.kind, title: e.title })),
    redLines: entries.filter((e) => e.kind === 'redLine').map((e) => ({ id: e.id, title: e.title, action: String((e.data as { action?: unknown }).action ?? '') })),
    warnings: m.warnings ?? [],
    sha256: v.sha256,
  };
}

export type PackInput = { kind: 'bytes'; filename: string; bytes: Uint8Array; source: string } | { kind: 'path'; path: string; source?: string };

/** Read + parse a pack source (no side effects). */
export function loadPackSource(input: PackInput): ParsedPack {
  if (input.kind === 'bytes') {
    if (/\.md$/i.test(input.filename)) throw new BrainPackError('A single Markdown file is not a pack: import the skill folder (SKILL.md + references) instead');
    return parsePack(readCcbrain(input.bytes), 'ccbrain');
  }
  const p = input.path;
  if (!path.isAbsolute(p)) throw badRequest('The path must be a full path on this PC (for example C:\\Users\\you\\Documents\\my-pack)');
  if (!existsSync(p)) throw new HttpError(404, 'NOT_FOUND', `Nothing found at ${p}`);
  const st = statSync(p);
  if (st.isDirectory()) return parsePack(readFolder(p), 'folder');
  if (/\.(ccbrain|zip)$/i.test(p)) return parsePack(readCcbrain(new Uint8Array(readFileSync(p))), 'ccbrain');
  throw new BrainPackError('Choose a .ccbrain file, a pack folder (with manifest.json) or a skill folder (with SKILL.md)');
}

/**
 * Import a pack: parse, store the files under DATA_DIR/brain/packs/<id>/<version>/, record the version and its entries
 * (inactive), audit. The same content imported again returns the stored version (`duplicate: true`).
 */
export function importPack(ctx: AppContext, input: PackInput, actor: Actor): ImportResult {
  const parsed = loadPackSource(input);
  const existing = ctx.repos.findBrainPackVersionBySha(ctx.db, parsed.sha256);
  if (existing) {
    const pack = ctx.repos.requireBrainPack(ctx.db, existing.packId);
    return { pack, version: existing, preview: storedPreview(ctx, existing.packId, existing.version), duplicate: true };
  }
  const { manifest } = parsed;
  if (ctx.repos.getBrainPackVersion(ctx.db, manifest.id, manifest.version)) {
    throw conflict('BRAIN_PACK_VERSION_EXISTS', `Pack ${manifest.id} already has a different version ${manifest.version}; raise the version number in the pack before importing it again`);
  }
  const dir = path.join(packsRoot(ctx), fsSafe(manifest.id), fsSafe(manifest.version));
  for (const [rel, bytes] of parsed.files) {
    const target = path.join(dir, ...rel.split('/'));
    if (!target.startsWith(dir + path.sep)) throw new BrainPackError(`Unsafe path ${rel}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  if (!parsed.files.has('manifest.json')) writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const source = input.kind === 'bytes' ? input.source : (input.source ?? 'path');
  const now = ctx.now();
  const result = ctx.db.transaction((tx) => {
    const pack = ctx.repos.ensureBrainPack(tx, { id: manifest.id, name: manifest.name, kind: parsed.kind, business: manifest.business, precedence: parsed.precedence, now });
    const version = ctx.repos.insertBrainPackVersion(tx, {
      packId: manifest.id,
      version: manifest.version,
      sha256: parsed.sha256,
      source,
      storagePath: dir,
      manifest: { ...manifest, sourceKind: parsed.sourceKind, warnings: parsed.warnings },
      importedBy: actor.userId,
      entries: parsed.entries,
      now,
    });
    ctx.repos.appendAudit(tx, { actor, action: 'brain.pack.import', entity: 'brain_packs', entityId: manifest.id, after: { version: manifest.version, sha256: parsed.sha256, entries: parsed.entries.length, sourceKind: parsed.sourceKind, source }, at: now });
    return { pack, version };
  });
  return { ...result, preview: previewOf(parsed), duplicate: false };
}

export interface ActivateInput {
  version?: string;
  business?: Business[];
  precedence?: number;
  useForCcguk?: boolean;
  name?: string;
}

/** Activate a version (default: the newest import) with the owner's business tags / precedence choices; audited. */
export function activatePack(ctx: AppContext, packId: string, input: ActivateInput, actor: Actor): BrainPackRecord {
  const pack = ctx.repos.requireBrainPack(ctx.db, packId);
  const version = input.version ?? ctx.repos.listBrainPackVersions(ctx.db, packId)[0]?.version;
  if (!version) throw conflict('BRAIN_PACK_EMPTY', `Pack ${packId} has no imported version`);
  ctx.repos.requireBrainPackVersion(ctx.db, packId, version);
  const business = input.business ?? (pack.business as Business[]);
  if (!business.length) throw badRequest('Choose at least one business for this pack (CCGUK and/or Fixmyfile) before activating it');
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    const updated = ctx.repos.updateBrainPack(tx, packId, {
      activeVersion: version,
      business,
      ...(input.precedence !== undefined ? { precedence: input.precedence } : {}),
      ...(input.useForCcguk !== undefined ? { useForCcguk: input.useForCcguk } : {}),
      ...(input.name ? { name: input.name } : {}),
      now,
    });
    ctx.repos.appendAudit(tx, { actor, action: 'brain.pack.activate', entity: 'brain_packs', entityId: packId, before: { activeVersion: pack.activeVersion ?? null, business: pack.business, precedence: pack.precedence, useForCcguk: pack.useForCcguk }, after: { activeVersion: version, business: updated.business, precedence: updated.precedence, useForCcguk: updated.useForCcguk, rollback: isOlder(ctx, packId, version, pack.activeVersion) }, at: now });
    return updated;
  });
}

/** Is `version` an older import than `than` (a rollback)? */
function isOlder(ctx: AppContext, packId: string, version: string, than: string | undefined): boolean {
  if (!than || than === version) return false;
  const order = ctx.repos.listBrainPackVersions(ctx.db, packId).map((v) => v.version); // newest first
  return order.indexOf(version) > order.indexOf(than);
}

export function deactivatePack(ctx: AppContext, packId: string, actor: Actor): BrainPackRecord {
  const pack = ctx.repos.requireBrainPack(ctx.db, packId);
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    const updated = ctx.repos.updateBrainPack(tx, packId, { activeVersion: null, now });
    ctx.repos.appendAudit(tx, { actor, action: 'brain.pack.deactivate', entity: 'brain_packs', entityId: packId, before: { activeVersion: pack.activeVersion ?? null }, after: { activeVersion: null }, at: now });
    return updated;
  });
}
