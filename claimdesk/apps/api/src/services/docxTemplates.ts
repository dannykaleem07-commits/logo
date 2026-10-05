/**
 * Word template library (TEMPLATES-VEHICLES-DESKTOP §C.1–§C.5): built-in sync at boot, the upload pipeline, the
 * summary/detail shapes the Templates screens read, mapping save/reset, replacement files and test fills.
 *
 * Built-ins are read-only files shipped with the app (`builtinAssetBytes`); their row caches the scan and holds a
 * mapping override layer (exact slot ids). Uploaded files live under TEMPLATES_DIR (`<id>/v<n>-<sha12>.docx`, immutable)
 * and are only ever resolved through `assertInsideStore`. The engine fills blanks; it never rewrites printed wording.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bannedPhraseCheck, legacyCheck } from '@ccguk/domain';
import {
  BUILTIN_DOCX_TEMPLATES,
  builtinAssetBytes,
  builtinMapping,
  buildFillPlan,
  checkDocxSafety,
  CONVERTER_ORDER,
  DocxError,
  FIELD_DEFS,
  fillDocx,
  findBannedPhrases,
  findBlockedStrings,
  getFieldDef,
  isBuiltinDocxTemplate,
  resolveSelectors,
  sampleMergeSource,
  scanDocx,
  SCANNER_VERSION,
  sha256Hex,
  slugify,
  suggestMapping,
  validateMapping,
  type ConverterStatus,
  type DocxBlock,
  type DocxIssue,
  type DocxPdfConverterId,
  type DocxScan,
  type DocxSlot,
  type FieldType,
  type FillPolicy,
  type FormatName,
  type MappingEntry,
  type MappingIssue,
  type SubjectKind,
  type TemplateMapping,
} from '@ccguk/documents';
import type { Actor, DocumentTemplateRow, DocxTemplateKind, DocxTemplateRecipientRole, TemplateWarning } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, HttpError, notFound, unprocessable } from '../errors.js';
import { assertInsideStore } from './evidence.js';
import { buildMergeSource, type DocUserLike } from './mergeSource.js';

// ---------------------------------------------------------------------------
// Response shapes (§C.5)
// ---------------------------------------------------------------------------

export interface DocxTemplateSummary {
  id: string;
  format: 'docx';
  source: 'builtin' | 'uploaded';
  kind: string;
  title: string;
  description?: string;
  recipientRole?: string;
  fileName: string;
  fileVersion: number;
  mappingRevision: number;
  sha256: string;
  bytes: number;
  slotCount: number;
  mappedCount: number;
  ignoredCount: number;
  unmappedCount: number;
  warnings: TemplateWarning[];
  warningsAcknowledged: boolean;
  active: boolean;
  subjects: SubjectKind[];
  variants: Array<{ id: string; label: string; default?: boolean }>;
  updatedAt: string;
}

export interface DocxTemplateMappingRow {
  slotId: string;
  key?: string;
  policy: FillPolicy;
  format?: FormatName;
  when?: string;
  required?: boolean;
  removeIfEmpty?: 'paragraph' | 'row';
  label?: string;
  origin: 'builtin' | 'saved' | 'suggested' | 'none';
  score?: number;
  ignored: boolean;
}

export interface DocxTemplateDetail extends DocxTemplateSummary {
  slots: DocxSlot[];
  blocks: DocxBlock[];
  outline: DocxScan['outline'];
  mapping: DocxTemplateMappingRow[];
  mappingIssues: MappingIssue[];
  fields: Array<{ key: string; group: string; label: string; type: FieldType; policy: FillPolicy }>;
  /** Replacement uploads only: mapped slot ids kept / dropped. */
  carriedOver?: string[];
  dropped?: string[];
}

/** What an uploaded template's mapping column holds: the mapping plus the auto-mapper's scores until a person saves. */
export type StoredUploadMapping = TemplateMapping & { suggestions?: Record<string, { score: number; reason: string }> };
/** What a built-in's mapping column holds: an override layer of exact-id entries and ignores. */
export interface BuiltinOverride {
  entries: MappingEntry[];
  ignore?: string[];
}

// ---------------------------------------------------------------------------
// Files and scans
// ---------------------------------------------------------------------------

/** Resolve an uploaded template's stored path under TEMPLATES_DIR (refused when it escapes the store). */
export function templateFilePath(ctx: AppContext, relative: string): string {
  const abs = path.isAbsolute(relative) ? relative : path.join(ctx.config.templatesDir, relative);
  return assertInsideStore(ctx.config.templatesDir, abs, 'template file path');
}

/** The template's bytes: the shipped asset (built-ins) or the uploaded file. 404 when the file is gone. */
export function templateBytes(ctx: AppContext, row: DocumentTemplateRow): Uint8Array {
  if (row.source === 'builtin') {
    try {
      return builtinAssetBytes(row.id);
    } catch {
      throw notFound('template file', row.id);
    }
  }
  if (!row.filePath) throw notFound('template file', row.id);
  const abs = templateFilePath(ctx, row.filePath);
  if (!existsSync(abs)) throw notFound('template file', row.id);
  return new Uint8Array(readFileSync(abs));
}

const scanCache = new Map<string, DocxScan>();

/** scanDocx with a per-process cache keyed by content hash (scans are pure). */
export function scanCached(bytes: Uint8Array, sha?: string): DocxScan {
  const key = `${sha ?? sha256Hex(Buffer.from(bytes))}:${SCANNER_VERSION}`;
  let s = scanCache.get(key);
  if (!s) {
    s = scanDocx(bytes);
    scanCache.set(key, s);
    if (scanCache.size > 64) scanCache.delete(scanCache.keys().next().value!);
  }
  return s;
}

/** The scan stored on the row (without `text`), or a fresh one when the scanner version moved on. */
export function rowScan(ctx: AppContext, row: DocumentTemplateRow, bytes?: Uint8Array): DocxScan {
  if (row.scanVersion === SCANNER_VERSION && row.scan && typeof row.scan === 'object' && Array.isArray((row.scan as DocxScan).slots)) {
    const cached = scanCache.get(`${row.sha256}:${SCANNER_VERSION}`);
    return cached ?? { ...(row.scan as Omit<DocxScan, 'text'>), text: '' };
  }
  return scanCached(bytes ?? templateBytes(ctx, row), row.sha256);
}

function storedScan(scan: DocxScan): Omit<DocxScan, 'text'> {
  const { text: _text, ...rest } = scan;
  return rest;
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

const slotIdOf = (e: MappingEntry): string | undefined => (typeof e.slot === 'string' ? e.slot : e.slot.id);

/** A selector mapping resolved to exact slot ids (built-in JSON → the form overrides are layered on). */
export function exactMapping(mapping: TemplateMapping, scan: DocxScan): TemplateMapping {
  const { bySlot, ignored } = resolveSelectors(mapping, scan);
  return { ...mapping, entries: [...bySlot].map(([id, e]) => ({ ...e, slot: id })), ignore: [...ignored] };
}

/** Override entries/ignores replace the base for the same slot id. */
export function applyOverride(base: TemplateMapping, override: BuiltinOverride): TemplateMapping {
  const touched = new Set<string>([...override.entries.map((e) => slotIdOf(e)).filter((x): x is string => !!x), ...(override.ignore ?? [])]);
  return {
    ...base,
    entries: [...base.entries.filter((e) => !touched.has(slotIdOf(e) ?? '')), ...override.entries],
    ignore: [...(base.ignore ?? []).filter((s) => typeof s !== 'string' || !touched.has(s)), ...(override.ignore ?? [])],
  };
}

function isBuiltinOverride(v: unknown): v is BuiltinOverride {
  return !!v && typeof v === 'object' && Array.isArray((v as BuiltinOverride).entries);
}

export interface EffectiveMapping {
  mapping: TemplateMapping;
  /** Built-ins: the curated mapping (selectors). */
  base?: TemplateMapping;
  override?: BuiltinOverride;
  issues: MappingIssue[];
}

/** Built-in JSON ⊕ override, or the saved upload mapping (§C.6 step 2). */
export function effectiveMapping(row: DocumentTemplateRow, scan: DocxScan): EffectiveMapping {
  if (row.source === 'builtin') {
    const base = builtinMapping(row.id);
    const override = isBuiltinOverride(row.mapping) ? row.mapping : undefined;
    if (!override || (!override.entries.length && !(override.ignore ?? []).length)) return { mapping: base, base, issues: validateMapping(base, scan) };
    const mapping = applyOverride(exactMapping(base, scan), override);
    return { mapping, base, override, issues: [...validateMapping(base, scan), ...validateMapping(mapping, scan)] };
  }
  const stored = row.mapping as StoredUploadMapping | undefined;
  const mapping: TemplateMapping = stored && Array.isArray(stored.entries) ? { schemaVersion: 1, templateId: row.id, entries: stored.entries, ...(stored.ignore ? { ignore: stored.ignore } : {}), ...(stored.subjects ? { subjects: stored.subjects } : {}), ...(stored.guards ? { guards: stored.guards } : {}), ...(stored.variants ? { variants: stored.variants } : {}) } : { schemaVersion: 1, templateId: row.id, entries: [] };
  return { mapping, issues: validateMapping(mapping, scan) };
}

function builtinMeta(id: string) {
  return BUILTIN_DOCX_TEMPLATES.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// Warnings (§C.4 step 5)
// ---------------------------------------------------------------------------

const SAFETY_WARNING_CODES: Record<string, TemplateWarning['code']> = {
  TRACKED_CHANGES: 'TRACKED_CHANGES',
  COMMENTS: 'COMMENTS',
  LEGACY_FORM_FIELDS: 'LEGACY_FORM_FIELDS',
  EXTERNAL_IMAGE: 'EXTERNAL_IMAGE',
  EMBEDDED_OBJECT: 'EMBEDDED_OBJECT',
};

/** Wording and package warnings for a template's text (legacy details, banned phrases, regulated status, safety report). */
export function textWarnings(text: string, safetyWarnings: DocxIssue[] = []): TemplateWarning[] {
  const out: TemplateWarning[] = [];
  const seen = new Set<string>();
  const add = (w: TemplateWarning) => {
    const k = `${w.code}|${(w.excerpt ?? w.message).toLowerCase().replace(/\s+/g, ' ')}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(w);
  };
  for (const h of findBlockedStrings(text)) add({ code: 'LEGACY_DETAIL', message: `Legacy detail "${h.needle}" is printed in the template wording.`, excerpt: h.excerpt });
  for (const f of legacyCheck(text)) if (!out.some((w) => w.code === 'LEGACY_DETAIL' && f.draftValue && w.message.toLowerCase().includes(f.draftValue.toLowerCase()))) add({ code: 'LEGACY_DETAIL', message: f.message, ...(f.excerpt ? { excerpt: f.excerpt } : {}) });
  for (const h of findBannedPhrases(text)) add({ code: 'BANNED_PHRASE', message: `Banned phrase "${h.needle}" is printed in the template wording.`, excerpt: h.excerpt });
  for (const f of bannedPhraseCheck(text)) {
    const code: TemplateWarning['code'] = f.code === 'REGULATED_STATUS_IMPLIED' ? 'REGULATED_STATUS' : 'BANNED_PHRASE';
    if (code === 'BANNED_PHRASE' && out.some((w) => w.code === 'BANNED_PHRASE' && f.draftValue && w.message.toLowerCase().includes(f.draftValue.toLowerCase()))) continue;
    add({ code, message: f.message, ...(f.excerpt ? { excerpt: f.excerpt } : {}) });
  }
  for (const s of safetyWarnings) {
    const code = SAFETY_WARNING_CODES[s.code];
    if (code) add({ code, message: s.message, ...(s.part ? { excerpt: s.part } : {}) });
  }
  return out;
}

function unmappedWarning(count: number): TemplateWarning {
  return { code: 'UNMAPPED_SLOTS', message: `${count} blank${count === 1 ? ' is' : 's are'} not mapped to a claim field: the handler types ${count === 1 ? 'it' : 'them'} in (or map ${count === 1 ? 'it' : 'them'} on the template screen).` };
}

function withUnmapped(warnings: TemplateWarning[], unmapped: number): TemplateWarning[] {
  const rest = warnings.filter((w) => w.code !== 'UNMAPPED_SLOTS');
  return unmapped > 0 ? [...rest, unmappedWarning(unmapped)] : rest;
}

// ---------------------------------------------------------------------------
// Built-in sync (§C.4, boot)
// ---------------------------------------------------------------------------

/**
 * Hash each built-in asset; when the row is missing, the sha256 changed or the scan is stale, re-scan and upsert.
 * Never throws: a failure logs and marks the template inactive with a SYNC_FAILED warning.
 */
export function syncBuiltinTemplates(ctx: AppContext): { synced: string[]; failed: string[] } {
  const synced: string[] = [];
  const failed: string[] = [];
  const actor: Actor = { userId: 'system' };
  let rows: Map<string, DocumentTemplateRow>;
  try {
    rows = new Map(ctx.repos.listDocumentTemplates(ctx.db, { includeInactive: true }).map((r) => [r.id, r]));
  } catch (err) {
    ctx.logger.error('docx templates: cannot read document_templates (migration 0004 missing?)', { error: String(err) });
    return { synced, failed: BUILTIN_DOCX_TEMPLATES.map((t) => t.id) };
  }
  for (const meta of BUILTIN_DOCX_TEMPLATES) {
    const existing = rows.get(meta.id);
    try {
      const bytes = builtinAssetBytes(meta.id);
      const sha256 = sha256Hex(Buffer.from(bytes));
      const failedBefore = existing?.warnings.some((w) => w.code === 'SYNC_FAILED');
      if (existing && existing.sha256 === sha256 && existing.scanVersion >= SCANNER_VERSION && !failedBefore) continue;
      const safety = checkDocxSafety(bytes);
      if (!safety.ok) throw new Error(`asset failed the safety check: ${safety.errors.map((e) => e.code).join(', ')}`);
      const scan = scanCached(bytes, sha256);
      const known: TemplateWarning[] = meta.knownWarnings.map((w) => ({ code: w.code, message: w.message }));
      const computed = textWarnings(scan.text, safety.warnings).filter((w) => !known.some((k) => k.code === w.code && !w.excerpt));
      const warnings = [...known, ...computed];
      ctx.repos.upsertBuiltinTemplate(
        ctx.db,
        { id: meta.id, kind: meta.kind as DocxTemplateKind, title: meta.title, recipientRole: meta.recipientRole as DocxTemplateRecipientRole, fileName: meta.file, sha256, bytes: bytes.byteLength, scanVersion: scan.scannerVersion, scan: storedScan(scan), warnings, active: true },
        actor,
        // The first fill of a fresh database is a cache of shipped files, not a change anyone made: not audited.
        { auditInsert: false },
      );
      synced.push(meta.id);
    } catch (err) {
      failed.push(meta.id);
      ctx.logger.warn('docx templates: built-in sync failed; template marked inactive', { templateId: meta.id, error: err instanceof Error ? err.message : String(err) });
      try {
        const warning: TemplateWarning = { code: 'SYNC_FAILED', message: `Sync failed: ${err instanceof Error ? err.message : String(err)}. The template is unavailable until the app files are repaired.` };
        ctx.repos.upsertBuiltinTemplate(
          ctx.db,
          {
            id: meta.id,
            kind: meta.kind as DocxTemplateKind,
            title: meta.title,
            recipientRole: meta.recipientRole as DocxTemplateRecipientRole,
            fileName: meta.file,
            sha256: existing?.sha256 ?? '',
            bytes: existing?.bytes ?? 0,
            scanVersion: existing?.scanVersion ?? 0,
            scan: existing?.scan ?? { slots: [], blocks: [], outline: [], warnings: [] },
            warnings: [...(existing?.warnings ?? []).filter((w) => w.code !== 'SYNC_FAILED'), warning],
            active: false,
          },
          actor,
        );
      } catch (inner) {
        ctx.logger.error('docx templates: could not record the sync failure', { templateId: meta.id, error: String(inner) });
      }
    }
  }
  return { synced, failed };
}

// ---------------------------------------------------------------------------
// Summary and detail
// ---------------------------------------------------------------------------

export function warningsAcknowledged(row: DocumentTemplateRow): boolean {
  return row.warnings.length === 0 || Boolean(row.warningsAcknowledgedAt);
}

function counts(scan: DocxScan, mapping: TemplateMapping): { mapped: Set<string>; ignored: Set<string> } {
  const { bySlot, ignored } = resolveSelectors(mapping, scan);
  const ids = new Set(scan.slots.map((s) => s.id));
  return { mapped: new Set([...bySlot.keys()].filter((k) => ids.has(k) && !ignored.has(k))), ignored: new Set([...ignored].filter((k) => ids.has(k))) };
}

export function templateSummary(ctx: AppContext, row: DocumentTemplateRow, prepared?: { scan: DocxScan; eff: EffectiveMapping }): DocxTemplateSummary {
  const scan = prepared?.scan ?? rowScan(ctx, row);
  const eff = prepared?.eff ?? effectiveMapping(row, scan);
  const { mapped, ignored } = counts(scan, eff.mapping);
  const meta = row.source === 'builtin' ? builtinMeta(row.id) : undefined;
  const variants = (eff.mapping.variants ?? meta?.variants ?? []).map((v) => ({ id: v.id, label: v.label, ...(v.default ? { default: true } : {}) }));
  const out: DocxTemplateSummary = {
    id: row.id,
    format: 'docx',
    source: row.source,
    kind: row.kind,
    title: row.title,
    fileName: row.fileName,
    fileVersion: row.fileVersion,
    mappingRevision: row.mappingRevision,
    sha256: row.sha256,
    bytes: row.bytes,
    slotCount: scan.slots.length,
    mappedCount: mapped.size,
    ignoredCount: ignored.size,
    unmappedCount: scan.slots.filter((s) => !mapped.has(s.id) && !ignored.has(s.id)).length,
    warnings: row.warnings,
    warningsAcknowledged: warningsAcknowledged(row),
    active: row.active,
    subjects: [...(eff.mapping.subjects ?? meta?.subjects ?? [])],
    variants,
    updatedAt: row.updatedAt,
  };
  if (row.description) out.description = row.description;
  if (row.recipientRole) out.recipientRole = row.recipientRole;
  return out;
}

export function templateDetail(ctx: AppContext, row: DocumentTemplateRow): DocxTemplateDetail {
  const scan = rowScan(ctx, row);
  const eff = effectiveMapping(row, scan);
  const summary = templateSummary(ctx, row, { scan, eff });
  const { bySlot, ignored } = resolveSelectors(eff.mapping, scan);
  const overrideIds = new Set<string>([...(eff.override?.entries ?? []).map((e) => slotIdOf(e) ?? ''), ...(eff.override?.ignore ?? [])]);
  const suggestions = row.source === 'uploaded' ? ((row.mapping as StoredUploadMapping | undefined)?.suggestions ?? {}) : {};
  const mapping: DocxTemplateMappingRow[] = scan.slots.map((slot) => {
    const entry = bySlot.get(slot.id);
    const isIgnored = ignored.has(slot.id);
    const def = entry?.key ? getFieldDef(entry.key) : undefined;
    const policy: FillPolicy = slot.signature ? 'signature' : isIgnored ? 'never' : (entry?.policy ?? def?.policy ?? 'handler');
    let origin: DocxTemplateMappingRow['origin'] = 'none';
    if (entry || isIgnored) {
      if (row.source === 'builtin') origin = overrideIds.has(slot.id) ? 'saved' : 'builtin';
      else origin = suggestions[slot.id] ? 'suggested' : 'saved';
    }
    const r: DocxTemplateMappingRow = { slotId: slot.id, policy, origin, ignored: isIgnored };
    if (entry?.key) r.key = entry.key;
    if (entry?.format) r.format = entry.format;
    if (entry?.when) r.when = entry.when;
    if (entry?.required) r.required = true;
    if (entry?.removeIfEmpty) r.removeIfEmpty = entry.removeIfEmpty;
    if (entry?.label) r.label = entry.label;
    if (origin === 'suggested') r.score = suggestions[slot.id]!.score;
    return r;
  });
  return {
    ...summary,
    slots: scan.slots,
    blocks: scan.blocks,
    outline: scan.outline,
    mapping,
    mappingIssues: eff.issues,
    fields: FIELD_DEFS.map((f) => ({ key: f.key, group: f.group, label: f.label, type: f.type, policy: f.policy })),
  };
}

export function listTemplateSummaries(ctx: AppContext, includeInactive: boolean): DocxTemplateSummary[] {
  return ctx.repos.listDocumentTemplates(ctx.db, { includeInactive }).map((row) => templateSummary(ctx, row));
}

// ---------------------------------------------------------------------------
// Upload (§C.4)
// ---------------------------------------------------------------------------

export interface UploadInput {
  bytes: Uint8Array;
  fileName: string;
  title: string;
  kind: DocxTemplateKind;
  description?: string;
  recipientRole?: DocxTemplateRecipientRole;
}

/** Steps 2–3 of the pipeline: safety gate and scan. */
export function inspectUpload(fileName: string, bytes: Uint8Array): { scan: DocxScan; safetyWarnings: DocxIssue[]; sha256: string } {
  if (!/\.(docx|dotx)$/i.test(fileName)) throw new HttpError(400, 'INVALID_DOCX', 'Only Word .docx or .dotx files can be uploaded (macro-enabled .docm/.dotm are refused)', { issues: [{ code: 'EXTENSION', message: `File name ${fileName} does not end in .docx or .dotx` }] });
  if (bytes.byteLength === 0) throw new HttpError(400, 'INVALID_DOCX', 'The uploaded file is empty', { issues: [{ code: 'EMPTY', message: 'empty file' }] });
  const safety = checkDocxSafety(bytes);
  if (!safety.ok) throw new HttpError(400, 'INVALID_DOCX', `This file cannot be used as a template: ${safety.errors.map((e) => e.message).join('; ')}`, { issues: safety.errors, warnings: safety.warnings });
  let scan: DocxScan;
  try {
    scan = scanDocx(bytes);
  } catch (err) {
    if (err instanceof DocxError) throw new HttpError(400, 'INVALID_DOCX', `This file cannot be read as a Word document: ${err.message}`, { issues: [{ code: err.code, message: err.message, ...(err.part ? { part: err.part } : {}) }] });
    throw err;
  }
  if (!scan.slots.length) {
    throw unprocessable('NO_FILLABLE_SLOTS', 'No places to fill were found in this document. Add {{claim.reference}}-style tokens, [brackets], ____ blanks or empty cells next to labels.');
  }
  return { scan, safetyWarnings: safety.warnings, sha256: scan.sha256 };
}

function suggestedMapping(templateId: string, scan: DocxScan): StoredUploadMapping {
  const suggested = suggestMapping(scan);
  const entries: MappingEntry[] = [];
  const suggestions: Record<string, { score: number; reason: string }> = {};
  for (const s of suggested.entries) {
    // Only confident suggestions are stored (§C.4 step 6); signature boxes are always recorded as signed by hand.
    if (s.score < 0.75) continue;
    if (!s.key && s.policy !== 'signature') continue;
    entries.push({ slot: s.slotId, ...(s.key ? { key: s.key } : {}), policy: s.policy });
    suggestions[s.slotId] = { score: Math.round(s.score * 100) / 100, reason: s.reason };
  }
  return { schemaVersion: 1, templateId, entries, suggestions };
}

function newTemplateId(kind: string, title: string): string {
  const slug = slugify(title, 24).replace(/-/g, '_');
  return `${kind}.user_${slug}_${randomBytes(2).toString('hex')}`;
}

function relativeFilePath(templateId: string, fileVersion: number, sha256: string): string {
  return path.posix.join(templateId, `v${fileVersion}-${sha256.slice(0, 12)}.docx`);
}

function writeTemplateFile(ctx: AppContext, rel: string, bytes: Uint8Array): void {
  const abs = templateFilePath(ctx, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  if (existsSync(abs)) {
    // Immutable files: an identical file at the same path is fine; anything else is refused.
    if (sha256Hex(readFileSync(abs)) === sha256Hex(Buffer.from(bytes))) return;
    throw conflict('TEMPLATE_FILE_EXISTS', `A different file already exists at ${rel}`);
  }
  writeFileSync(abs, bytes, { flag: 'wx' });
}

function assertNotDuplicate(ctx: AppContext, sha256: string, exceptId?: string): void {
  const dup = ctx.repos.listDocumentTemplates(ctx.db, { includeInactive: false }).find((t) => t.source === 'uploaded' && t.sha256 === sha256 && t.id !== exceptId);
  if (dup) throw conflict('TEMPLATE_DUPLICATE', `This file is already uploaded as "${dup.title}"`, { id: dup.id });
}

export function uploadTemplate(ctx: AppContext, input: UploadInput, actor: Actor): DocxTemplateDetail {
  const { scan, safetyWarnings, sha256 } = inspectUpload(input.fileName, input.bytes);
  assertNotDuplicate(ctx, sha256);
  const id = newTemplateId(input.kind, input.title);
  const mapping = suggestedMapping(id, scan);
  const unmapped = scan.slots.filter((s) => !mapping.entries.some((e) => e.slot === s.id)).length;
  const warnings = withUnmapped(textWarnings(scan.text, safetyWarnings), unmapped);
  const rel = relativeFilePath(id, 1, sha256);
  writeTemplateFile(ctx, rel, input.bytes);
  scanCache.set(`${sha256}:${SCANNER_VERSION}`, scan);
  const row = ctx.repos.createUploadedTemplate(
    ctx.db,
    {
      id,
      kind: input.kind,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.recipientRole ? { recipientRole: input.recipientRole } : {}),
      fileName: path.basename(input.fileName),
      filePath: rel,
      sha256,
      bytes: input.bytes.byteLength,
      scanVersion: scan.scannerVersion,
      scan: storedScan(scan),
      mapping,
      warnings,
      createdAt: ctx.now(),
    },
    actor,
  );
  return templateDetail(ctx, row);
}

/** POST /docx-templates/:id/file — a new version of an uploaded template; mapped slot ids that still exist carry over. */
export function replaceTemplate(ctx: AppContext, id: string, input: { bytes: Uint8Array; fileName: string }, actor: Actor): DocxTemplateDetail {
  const row = ctx.repos.requireDocumentTemplate(ctx.db, id);
  if (row.source !== 'uploaded') throw badRequest('Built-in templates ship with the app and cannot be replaced; upload your own version as a new template');
  const { scan, safetyWarnings, sha256 } = inspectUpload(input.fileName, input.bytes);
  if (sha256 === row.sha256) throw conflict('TEMPLATE_DUPLICATE', 'This is the file the template already uses', { id: row.id });
  assertNotDuplicate(ctx, sha256, row.id);
  const ids = new Set(scan.slots.map((s) => s.id));
  const old = effectiveMapping(row, rowScan(ctx, row)).mapping;
  const oldSuggestions = (row.mapping as StoredUploadMapping | undefined)?.suggestions ?? {};
  const carried = old.entries.filter((e) => ids.has(slotIdOf(e) ?? ''));
  const dropped = old.entries.map((e) => slotIdOf(e) ?? '').filter((s) => s && !ids.has(s));
  const carriedIgnore = (old.ignore ?? []).filter((s): s is string => typeof s === 'string' && ids.has(s));
  // New slots get the auto-mapper's confident suggestions.
  const fresh = suggestedMapping(row.id, scan);
  const taken = new Set([...carried.map((e) => slotIdOf(e)!), ...carriedIgnore]);
  const added = fresh.entries.filter((e) => !taken.has(slotIdOf(e)!));
  const suggestions: Record<string, { score: number; reason: string }> = {};
  for (const e of carried) if (oldSuggestions[slotIdOf(e)!]) suggestions[slotIdOf(e)!] = oldSuggestions[slotIdOf(e)!]!;
  for (const e of added) suggestions[slotIdOf(e)!] = fresh.suggestions![slotIdOf(e)!]!;
  const mapping: StoredUploadMapping = { schemaVersion: 1, templateId: row.id, entries: [...carried, ...added], ...(carriedIgnore.length ? { ignore: carriedIgnore } : {}), ...(Object.keys(suggestions).length ? { suggestions } : {}) };
  const unmapped = scan.slots.filter((s) => !taken.has(s.id) && !added.some((e) => e.slot === s.id)).length;
  const warnings = withUnmapped(textWarnings(scan.text, safetyWarnings), unmapped);
  const rel = relativeFilePath(row.id, row.fileVersion + 1, sha256);
  writeTemplateFile(ctx, rel, input.bytes);
  scanCache.set(`${sha256}:${SCANNER_VERSION}`, scan);
  const updated = ctx.repos.replaceTemplateFile(ctx.db, row.id, { fileName: path.basename(input.fileName), filePath: rel, sha256, bytes: input.bytes.byteLength, scan: storedScan(scan), scanVersion: scan.scannerVersion, warnings, mapping }, actor);
  return { ...templateDetail(ctx, updated), carriedOver: carried.map((e) => slotIdOf(e)!), dropped };
}

// ---------------------------------------------------------------------------
// Mapping save / reset (§C.5)
// ---------------------------------------------------------------------------

function entryEquals(a: MappingEntry, b: MappingEntry): boolean {
  const norm = (e: MappingEntry) => JSON.stringify({ ...e, slot: slotIdOf(e) });
  return norm(a) === norm(b);
}

export function saveMapping(ctx: AppContext, id: string, body: { entries: MappingEntry[]; ignore?: string[] }, actor: Actor): DocxTemplateDetail {
  const row = ctx.repos.requireDocumentTemplate(ctx.db, id);
  const scan = rowScan(ctx, row);
  const slotIds = new Set(scan.slots.map((s) => s.id));
  const unknown = [...body.entries.map((e) => slotIdOf(e) ?? ''), ...(body.ignore ?? [])].filter((s) => !slotIds.has(s));
  const preIssues: MappingIssue[] = unknown.map((s) => ({ code: 'SELECTOR_NO_MATCH', entry: body.entries.findIndex((e) => slotIdOf(e) === s), detail: `slot ${s} is not in this template` }));
  for (const [i, e] of body.entries.entries()) {
    const slot = scan.slots.find((s) => s.id === slotIdOf(e));
    if (slot?.signature && e.key) preIssues.push({ code: 'KIND_MISMATCH', entry: i, detail: `${slot.id} is a signature box: it is signed by hand and is never filled` });
  }
  if (preIssues.length) throw new HttpError(400, 'MAPPING_INVALID', 'The mapping does not fit this template', { issues: preIssues });

  if (row.source === 'builtin') {
    const base = exactMapping(builtinMapping(row.id), scan);
    const baseById = new Map(base.entries.map((e) => [slotIdOf(e)!, e]));
    const baseIgnored = new Set((base.ignore ?? []).filter((s): s is string => typeof s === 'string'));
    // Store only what differs from the curated default, so unchanged rows keep their "Built-in" status.
    // The editor sends the columns it shows (key, policy, format, when, required, remove-if-empty, label); a row that
    // keeps the curated field keeps the curated extras it cannot show (onlyIf, variants, option blanks, notes).
    const entries = body.entries
      .map((e) => {
        const b = baseById.get(slotIdOf(e)!);
        return b && b.key === e.key ? ({ ...b, ...e, slot: slotIdOf(e)! } as MappingEntry) : e;
      })
      .filter((e) => {
        const b = baseById.get(slotIdOf(e)!);
        return !b || !entryEquals(b, e) || baseIgnored.has(slotIdOf(e)!);
      });
    const ignore = (body.ignore ?? []).filter((s) => !baseIgnored.has(s));
    const override: BuiltinOverride = { entries, ...(ignore.length ? { ignore } : {}) };
    const merged = applyOverride(base, override);
    const issues = validateMapping(merged, scan);
    if (issues.length) throw new HttpError(400, 'MAPPING_INVALID', 'The mapping does not fit this template', { issues });
    const saved = ctx.repos.saveTemplateMapping(ctx.db, id, entries.length || ignore.length ? override : null, actor);
    return templateDetail(ctx, saved);
  }
  const mapping: StoredUploadMapping = { schemaVersion: 1, templateId: row.id, entries: body.entries.map((e) => ({ ...e })), ...(body.ignore?.length ? { ignore: body.ignore } : {}) };
  const prev = row.mapping as StoredUploadMapping | undefined;
  if (prev?.subjects) mapping.subjects = prev.subjects;
  if (prev?.guards) mapping.guards = prev.guards;
  if (prev?.variants) mapping.variants = prev.variants;
  const issues = validateMapping(mapping, scan);
  if (issues.length) throw new HttpError(400, 'MAPPING_INVALID', 'The mapping does not fit this template', { issues });
  const { mapped, ignored } = counts(scan, mapping);
  const unmapped = scan.slots.filter((s) => !mapped.has(s.id) && !ignored.has(s.id)).length;
  const saved = ctx.repos.saveTemplateMapping(ctx.db, id, mapping, actor, { warnings: withUnmapped(row.warnings, unmapped) });
  return templateDetail(ctx, saved);
}

/** DELETE /docx-templates/:id/mapping — built-ins back to the curated default; refused for uploads. */
export function resetMapping(ctx: AppContext, id: string, actor: Actor): DocxTemplateDetail {
  const row = ctx.repos.requireDocumentTemplate(ctx.db, id);
  if (row.source !== 'builtin') throw badRequest('Only a built-in template can be reset to its default mapping; edit or re-save an uploaded template’s mapping instead');
  return templateDetail(ctx, ctx.repos.saveTemplateMapping(ctx.db, id, null, actor));
}

// ---------------------------------------------------------------------------
// Test fill (not stored)
// ---------------------------------------------------------------------------

export function testFill(ctx: AppContext, id: string, input: { claimId?: string; variant?: string }, user: DocUserLike): { docx: Uint8Array; sha256: string; fileName: string } {
  const row = ctx.repos.requireDocumentTemplate(ctx.db, id);
  const bytes = templateBytes(ctx, row);
  const scan = scanCached(bytes, row.sha256);
  const { mapping } = effectiveMapping(row, scan);
  let source = sampleMergeSource();
  if (input.claimId) {
    ctx.repos.requireClaim(ctx.db, input.claimId);
    source = buildMergeSource(ctx, input.claimId, user, {}, { ...(row.recipientRole ? { recipientRole: row.recipientRole } : {}) });
  }
  const plan = buildFillPlan(scan, mapping, source, { ...(input.variant ? { variant: input.variant } : {}) });
  if (plan.issues.some((i) => i.code === 'UNKNOWN_VARIANT')) throw badRequest(`Unknown variant "${input.variant}"`);
  const now = new Date(ctx.now());
  const { docx, sha256 } = fillDocx(bytes, plan.instructions, {
    removeBlocks: plan.removeBlocks,
    coreProps: { title: `${row.title} — test copy`, subject: row.title, keywords: [source.claim.reference, row.id, 'test copy'], created: now, modified: now },
    now,
    ...(mapping.style?.valueRun ? { valueRunStyle: mapping.style.valueRun } : {}),
    inheritValueStyle: row.source !== 'builtin',
  });
  return { docx, sha256, fileName: `${safeFileName(row.title)} (test copy).docx` };
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document';
}

// ---------------------------------------------------------------------------
// Converters (§A.11)
// ---------------------------------------------------------------------------

export function converterOrderFor(preference: 'auto' | DocxPdfConverterId): DocxPdfConverterId[] {
  return preference === 'auto' ? [...CONVERTER_ORDER] : [preference, ...CONVERTER_ORDER.filter((c) => c !== preference)];
}

export type ConverterAvailability = Record<DocxPdfConverterId, ConverterStatus>;

export { isBuiltinDocxTemplate };
