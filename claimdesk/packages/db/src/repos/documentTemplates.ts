/**
 * Word template library (migration 0004, TEMPLATES-VEHICLES-DESKTOP §C.3).
 *
 * One row per template: the ten built-ins (the row caches the scan of the shipped asset and holds a mapping override
 * layer) and uploaded templates (the file lives under TEMPLATES_DIR; `file_path` is relative to it). Every write is
 * audited (`docx_template.create|replace|mapping|patch|acknowledge|sync`). The scan and the mapping are stored as JSON
 * and typed `unknown` here: their shapes belong to @ccguk/documents, which this package does not depend on.
 */
import { asc, eq } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { documentTemplates, type DocumentTemplateDbRow } from '../schema.js';
import { nowIso } from '../util.js';
import { appendAudit, type Actor } from './audit.js';

/** Kinds a Word template may have (the HTML TemplateKind subset that makes sense for a .docx). */
export type DocxTemplateKind = 'letter' | 'form' | 'agreement' | 'statement' | 'report' | 'notice';
export const DOCX_TEMPLATE_KINDS: readonly DocxTemplateKind[] = ['letter', 'form', 'agreement', 'statement', 'report', 'notice'];
/** Who a template is normally addressed to (documents RecipientRole). */
export type DocxTemplateRecipientRole = 'at_fault_insurer' | 'client' | 'own_insurer' | 'court' | 'supplier' | 'other';

export type TemplateWarningCode =
  | 'LEGACY_DETAIL'
  | 'BANNED_PHRASE'
  | 'REGULATED_STATUS'
  | 'BRAND_CLAIM_IMAGE'
  | 'TRACKED_CHANGES'
  | 'COMMENTS'
  | 'LEGACY_FORM_FIELDS'
  | 'EXTERNAL_IMAGE'
  | 'EMBEDDED_OBJECT'
  | 'UNMAPPED_SLOTS'
  /** Additive: the built-in asset could not be read or scanned at boot (the template is inactive until a sync succeeds). */
  | 'SYNC_FAILED';

export interface TemplateWarning {
  code: TemplateWarningCode;
  message: string;
  excerpt?: string;
}

export interface DocumentTemplateRow {
  id: string;
  source: 'builtin' | 'uploaded';
  kind: DocxTemplateKind;
  title: string;
  description?: string;
  recipientRole?: DocxTemplateRecipientRole;
  fileName: string;
  filePath?: string;
  sha256: string;
  bytes: number;
  fileVersion: number;
  mappingRevision: number;
  scanVersion: number;
  /** JSON DocxScan without `text`. */
  scan: unknown;
  /** JSON TemplateMapping (uploads) | override layer (built-ins) | undefined. */
  mapping?: unknown;
  warnings: TemplateWarning[];
  warningsAcknowledgedAt?: string;
  warningsAcknowledgedBy?: string;
  active: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export type UpsertBuiltinTemplateInput = Omit<DocumentTemplateRow, 'createdAt' | 'updatedAt' | 'mapping' | 'mappingRevision' | 'active' | 'warningsAcknowledgedAt' | 'warningsAcknowledgedBy' | 'source' | 'createdBy' | 'updatedBy' | 'fileVersion'> & {
  /** Default true. A failed sync passes false (the template is shown inactive with a warning). */
  active?: boolean;
};

export type CreateUploadedTemplateInput = Omit<DocumentTemplateRow, 'source' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy' | 'fileVersion' | 'mappingRevision' | 'active' | 'warningsAcknowledgedAt' | 'warningsAcknowledgedBy' | 'filePath'> & {
  filePath: string;
  createdAt?: ISODateTime;
};

export interface ReplaceTemplateFileInput {
  fileName: string;
  filePath: string;
  sha256: string;
  bytes: number;
  scan: unknown;
  scanVersion: number;
  warnings: TemplateWarning[];
  /** Optional: the mapping carried over to the new file (exact ids that still exist). Bumps mapping_revision when given. */
  mapping?: unknown;
}

export interface PatchDocumentTemplateInput {
  title?: string;
  description?: string | null;
  active?: boolean;
  recipientRole?: DocxTemplateRecipientRole | null;
}

const actorId = (actor: Actor): string => actor.userId;

function toRow(r: DocumentTemplateDbRow): DocumentTemplateRow {
  const out: DocumentTemplateRow = {
    id: r.id,
    source: r.source,
    kind: r.kind as DocxTemplateKind,
    title: r.title,
    fileName: r.fileName,
    sha256: r.sha256,
    bytes: r.bytes,
    fileVersion: r.fileVersion,
    mappingRevision: r.mappingRevision,
    scanVersion: r.scanVersion,
    scan: r.scan,
    warnings: Array.isArray(r.warnings) ? (r.warnings as TemplateWarning[]) : [],
    active: r.active,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
  if (r.description !== null) out.description = r.description;
  if (r.recipientRole !== null) out.recipientRole = r.recipientRole as DocxTemplateRecipientRole;
  if (r.filePath !== null) out.filePath = r.filePath;
  if (r.mapping !== null && r.mapping !== undefined) out.mapping = r.mapping;
  if (r.warningsAcknowledgedAt !== null) out.warningsAcknowledgedAt = r.warningsAcknowledgedAt;
  if (r.warningsAcknowledgedBy !== null) out.warningsAcknowledgedBy = r.warningsAcknowledgedBy;
  return out;
}

/** Audit summary of a row: never the scan or the mapping body (they are large); counts and hashes instead. */
function summary(r: DocumentTemplateRow | undefined): Record<string, unknown> | undefined {
  if (!r) return undefined;
  return {
    source: r.source,
    kind: r.kind,
    title: r.title,
    fileName: r.fileName,
    filePath: r.filePath,
    sha256: r.sha256,
    bytes: r.bytes,
    fileVersion: r.fileVersion,
    mappingRevision: r.mappingRevision,
    scanVersion: r.scanVersion,
    warnings: r.warnings.map((w) => w.code),
    warningsAcknowledgedAt: r.warningsAcknowledgedAt,
    active: r.active,
    recipientRole: r.recipientRole,
  };
}

function validateKind(kind: string): void {
  if (!(DOCX_TEMPLATE_KINDS as readonly string[]).includes(kind)) throw new ValidationError(`kind must be one of ${DOCX_TEMPLATE_KINDS.join(', ')} (got "${kind}")`);
}

function validateTitle(title: string | undefined): void {
  if (title !== undefined && !title.trim()) throw new ValidationError('title must not be empty');
}

export function listDocumentTemplates(db: Db, opts: { includeInactive?: boolean } = {}): DocumentTemplateRow[] {
  const rows = db
    .select()
    .from(documentTemplates)
    .where(opts.includeInactive ? undefined : eq(documentTemplates.active, true))
    .orderBy(asc(documentTemplates.source), asc(documentTemplates.id))
    .all();
  return rows.map(toRow);
}

export function getDocumentTemplate(db: Db, id: string): DocumentTemplateRow | undefined {
  const r = db.select().from(documentTemplates).where(eq(documentTemplates.id, id)).get();
  return r ? toRow(r) : undefined;
}

export function requireDocumentTemplate(db: Db, id: string): DocumentTemplateRow {
  const r = getDocumentTemplate(db, id);
  if (!r) throw new NotFoundError('document template', id);
  return r;
}

/**
 * Insert or refresh a built-in row from the shipped asset. Keeps the mapping override, the acknowledgement and the
 * active flag; the acknowledgement is reset when the sha256 changed (new wording must be reviewed again). Audited as
 * `docx_template.sync`; `opts.auditInsert: false` skips the row for the very first insert (the boot-time cache fill of
 * a fresh database is not a business change — every later refresh or failure is audited).
 */
export function upsertBuiltinTemplate(db: Db, row: UpsertBuiltinTemplateInput, actor: Actor, opts: { auditInsert?: boolean } = {}): DocumentTemplateRow {
  validateKind(row.kind);
  validateTitle(row.title);
  return db.transaction((tx) => {
    const before = getDocumentTemplate(tx, row.id);
    if (before && before.source !== 'builtin') throw new ValidationError(`template ${row.id} is an uploaded template, not a built-in`);
    const now = nowIso();
    const by = actorId(actor);
    if (!before) {
      tx.insert(documentTemplates)
        .values({
          id: row.id,
          source: 'builtin',
          kind: row.kind,
          title: row.title,
          description: row.description ?? null,
          recipientRole: row.recipientRole ?? null,
          fileName: row.fileName,
          filePath: null,
          sha256: row.sha256,
          bytes: row.bytes,
          fileVersion: 1,
          mappingRevision: 0,
          scanVersion: row.scanVersion,
          scan: row.scan,
          mapping: null,
          warnings: row.warnings,
          active: row.active ?? true,
          createdAt: now,
          createdBy: by,
          updatedAt: now,
          updatedBy: by,
        })
        .run();
    } else {
      const shaChanged = before.sha256 !== row.sha256;
      tx.update(documentTemplates)
        .set({
          kind: row.kind,
          title: row.title,
          description: row.description ?? null,
          recipientRole: row.recipientRole ?? null,
          fileName: row.fileName,
          sha256: row.sha256,
          bytes: row.bytes,
          fileVersion: shaChanged ? before.fileVersion + 1 : before.fileVersion,
          scanVersion: row.scanVersion,
          scan: row.scan,
          warnings: row.warnings,
          ...(shaChanged ? { warningsAcknowledgedAt: null, warningsAcknowledgedBy: null } : {}),
          // A failed sync deactivates; a later successful sync re-activates only what a failed sync deactivated
          // (a template a person switched off stays off).
          ...(row.active === false ? { active: false } : !before.active && isSyncFailure(before) ? { active: true } : {}),
          updatedAt: now,
          updatedBy: by,
        })
        .where(eq(documentTemplates.id, row.id))
        .run();
    }
    const after = requireDocumentTemplate(tx, row.id);
    if (before || opts.auditInsert !== false) appendAudit(tx, { actor, action: 'docx_template.sync', entity: 'document_templates', entityId: row.id, before: summary(before), after: summary(after), at: now });
    return after;
  });
}

function isSyncFailure(row: DocumentTemplateRow): boolean {
  return row.warnings.some((w) => w.code === 'SYNC_FAILED');
}

/** Insert an uploaded template (version 1, mapping revision 1 when a suggested mapping is stored). Audited `docx_template.create`. */
export function createUploadedTemplate(db: Db, row: CreateUploadedTemplateInput, actor: Actor): DocumentTemplateRow {
  validateKind(row.kind);
  validateTitle(row.title);
  if (!row.title?.trim()) throw new ValidationError('title is required');
  if (!row.filePath?.trim()) throw new ValidationError('filePath is required');
  return db.transaction((tx) => {
    if (getDocumentTemplate(tx, row.id)) throw new ValidationError(`template ${row.id} already exists`);
    const now = row.createdAt ?? nowIso();
    const by = actorId(actor);
    tx.insert(documentTemplates)
      .values({
        id: row.id,
        source: 'uploaded',
        kind: row.kind,
        title: row.title.trim(),
        description: row.description ?? null,
        recipientRole: row.recipientRole ?? null,
        fileName: row.fileName,
        filePath: row.filePath,
        sha256: row.sha256,
        bytes: row.bytes,
        fileVersion: 1,
        mappingRevision: row.mapping === undefined || row.mapping === null ? 0 : 1,
        scanVersion: row.scanVersion,
        scan: row.scan,
        mapping: row.mapping ?? null,
        warnings: row.warnings,
        active: true,
        createdAt: now,
        createdBy: by,
        updatedAt: now,
        updatedBy: by,
      })
      .run();
    const after = requireDocumentTemplate(tx, row.id);
    appendAudit(tx, { actor, action: 'docx_template.create', entity: 'document_templates', entityId: row.id, after: summary(after), at: now });
    return after;
  });
}

/** A new file for an uploaded template: file_version + 1, warnings replaced, acknowledgement reset. Audited `docx_template.replace`. */
export function replaceTemplateFile(db: Db, id: string, file: ReplaceTemplateFileInput, actor: Actor): DocumentTemplateRow {
  return db.transaction((tx) => {
    const before = requireDocumentTemplate(tx, id);
    if (before.source !== 'uploaded') throw new ValidationError('only an uploaded template can be given a new file; built-ins ship with the app');
    const now = nowIso();
    tx.update(documentTemplates)
      .set({
        fileName: file.fileName,
        filePath: file.filePath,
        sha256: file.sha256,
        bytes: file.bytes,
        scan: file.scan,
        scanVersion: file.scanVersion,
        warnings: file.warnings,
        fileVersion: before.fileVersion + 1,
        ...(file.mapping !== undefined ? { mapping: file.mapping, mappingRevision: before.mappingRevision + 1 } : {}),
        warningsAcknowledgedAt: null,
        warningsAcknowledgedBy: null,
        updatedAt: now,
        updatedBy: actorId(actor),
      })
      .where(eq(documentTemplates.id, id))
      .run();
    const after = requireDocumentTemplate(tx, id);
    appendAudit(tx, { actor, action: 'docx_template.replace', entity: 'document_templates', entityId: id, before: summary(before), after: summary(after), at: now });
    return after;
  });
}

/**
 * Save the mapping (uploads: the whole mapping; built-ins: the override layer; null = reset a built-in to its curated
 * default). mapping_revision + 1. Audited `docx_template.mapping`.
 */
export function saveTemplateMapping(db: Db, id: string, mapping: unknown, actor: Actor, opts: { warnings?: TemplateWarning[] } = {}): DocumentTemplateRow {
  return db.transaction((tx) => {
    const before = requireDocumentTemplate(tx, id);
    if (mapping === null && before.source === 'uploaded') throw new ValidationError('an uploaded template cannot have its mapping removed; save an empty mapping instead');
    const now = nowIso();
    tx.update(documentTemplates)
      // `opts.warnings` (additive): the caller may refresh UNMAPPED_SLOTS; the acknowledgement is kept
      .set({ mapping: mapping ?? null, mappingRevision: before.mappingRevision + 1, ...(opts.warnings ? { warnings: opts.warnings } : {}), updatedAt: now, updatedBy: actorId(actor) })
      .where(eq(documentTemplates.id, id))
      .run();
    const after = requireDocumentTemplate(tx, id);
    const entries = (m: unknown): number | undefined => (m && typeof m === 'object' && Array.isArray((m as { entries?: unknown }).entries) ? (m as { entries: unknown[] }).entries.length : undefined);
    appendAudit(tx, {
      actor,
      action: 'docx_template.mapping',
      entity: 'document_templates',
      entityId: id,
      before: { mappingRevision: before.mappingRevision, entries: entries(before.mapping) },
      after: { mappingRevision: after.mappingRevision, entries: entries(after.mapping), reset: mapping === null },
      at: now,
    });
    return after;
  });
}

/** Title, description, active flag, recipient role. Audited `docx_template.patch`. */
export function patchDocumentTemplate(db: Db, id: string, patch: PatchDocumentTemplateInput, actor: Actor): DocumentTemplateRow {
  validateTitle(patch.title);
  return db.transaction((tx) => {
    const before = requireDocumentTemplate(tx, id);
    const now = nowIso();
    const set: Partial<typeof documentTemplates.$inferInsert> = { updatedAt: now, updatedBy: actorId(actor) };
    if (patch.title !== undefined) set.title = patch.title.trim();
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.active !== undefined) set.active = patch.active;
    if (patch.recipientRole !== undefined) set.recipientRole = patch.recipientRole;
    tx.update(documentTemplates).set(set).where(eq(documentTemplates.id, id)).run();
    const after = requireDocumentTemplate(tx, id);
    appendAudit(tx, { actor, action: 'docx_template.patch', entity: 'document_templates', entityId: id, before: summary(before), after: { ...summary(after), patch }, at: now });
    return after;
  });
}

/** "I have reviewed this wording": records who and when. Audited `docx_template.acknowledge`. */
export function acknowledgeTemplateWarnings(db: Db, id: string, actor: Actor): DocumentTemplateRow {
  if (actor.userId === 'system') throw new ValidationError('template warnings are acknowledged by a person, never by the system');
  return db.transaction((tx) => {
    const before = requireDocumentTemplate(tx, id);
    const now = nowIso();
    tx.update(documentTemplates)
      .set({ warningsAcknowledgedAt: now, warningsAcknowledgedBy: actorId(actor), updatedAt: now, updatedBy: actorId(actor) })
      .where(eq(documentTemplates.id, id))
      .run();
    const after = requireDocumentTemplate(tx, id);
    appendAudit(tx, {
      actor,
      action: 'docx_template.acknowledge',
      entity: 'document_templates',
      entityId: id,
      before: { warningsAcknowledgedAt: before.warningsAcknowledgedAt, warningsAcknowledgedBy: before.warningsAcknowledgedBy },
      after: { warningsAcknowledgedAt: now, warningsAcknowledgedBy: actorId(actor), sha256: after.sha256, warnings: after.warnings.map((w) => w.code) },
      at: now,
    });
    return after;
  });
}

/** True when the template can be used for generation without an acknowledgement (no warnings) or it was acknowledged. */
export function templateWarningsAcknowledged(row: Pick<DocumentTemplateRow, 'warnings' | 'warningsAcknowledgedAt'>): boolean {
  return row.warnings.length === 0 || Boolean(row.warningsAcknowledgedAt);
}
