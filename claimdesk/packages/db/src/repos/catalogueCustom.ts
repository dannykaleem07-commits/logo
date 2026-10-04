/**
 * User additions to the shipped vehicle catalogue (`vehicle_catalogue_custom`, migration 0003, TEMPLATES-VEHICLES-DESKTOP
 * §D.7). A row adds a make/model/generation/trim/engine, or (overridesBuiltin) adjusts the segment / GTA group of a
 * shipped entry. Deleting is soft. The API merges these rows into the shipped catalogue and audits each write.
 */
import { and, asc, eq, isNull, type SQL } from 'drizzle-orm';
import type { Id, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { vehicleCatalogueCustom, type VehicleCatalogueCustomRow } from '../schema.js';
import { newId, nowIso } from '../util.js';
import type { Actor } from './audit.js';

export type CustomCatalogueLevel = 'make' | 'model' | 'generation' | 'trim' | 'engine';
export const CUSTOM_CATALOGUE_LEVELS: readonly CustomCatalogueLevel[] = ['make', 'model', 'generation', 'trim', 'engine'];

export interface CustomCatalogueEntry {
  id: Id;
  level: CustomCatalogueLevel;
  make: string;
  makeSlug: string;
  model?: string;
  modelSlug?: string;
  generationId?: string;
  name: string;
  data: Record<string, unknown>;
  segment?: string;
  gtaGroup?: string;
  overridesBuiltin: boolean;
  createdAt: ISODateTime;
  createdBy: Id | 'system';
  deletedAt?: ISODateTime;
  deletedBy?: Id | 'system';
}

export interface CreateCustomCatalogueInput {
  level: CustomCatalogueLevel;
  make: string;
  makeSlug: string;
  model?: string;
  modelSlug?: string;
  generationId?: string;
  name: string;
  data?: Record<string, unknown>;
  segment?: string;
  gtaGroup?: string;
  overridesBuiltin?: boolean;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GROUP = /^[A-Z]{1,3}\d{0,2}$/;

function toEntry(row: VehicleCatalogueCustomRow): CustomCatalogueEntry {
  const out: CustomCatalogueEntry = {
    id: row.id,
    level: row.level,
    make: row.make,
    makeSlug: row.makeSlug,
    name: row.name,
    data: row.data ?? {},
    overridesBuiltin: row.overridesBuiltin,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
  if (row.model !== null) out.model = row.model;
  if (row.modelSlug !== null) out.modelSlug = row.modelSlug;
  if (row.generationId !== null) out.generationId = row.generationId;
  if (row.segment !== null) out.segment = row.segment;
  if (row.gtaGroup !== null) out.gtaGroup = row.gtaGroup;
  if (row.deletedAt !== null) out.deletedAt = row.deletedAt;
  if (row.deletedBy !== null) out.deletedBy = row.deletedBy;
  return out;
}

export function listCustomCatalogueEntries(db: Db, opts: { makeSlug?: string; modelSlug?: string; includeDeleted?: boolean } = {}): CustomCatalogueEntry[] {
  const where: SQL[] = [];
  if (!opts.includeDeleted) where.push(isNull(vehicleCatalogueCustom.deletedAt));
  if (opts.makeSlug) where.push(eq(vehicleCatalogueCustom.makeSlug, opts.makeSlug));
  if (opts.modelSlug) where.push(eq(vehicleCatalogueCustom.modelSlug, opts.modelSlug));
  return db
    .select()
    .from(vehicleCatalogueCustom)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(vehicleCatalogueCustom.createdAt), asc(vehicleCatalogueCustom.id))
    .all()
    .map(toEntry);
}

export function getCustomCatalogueEntry(db: Db, id: Id): CustomCatalogueEntry | undefined {
  const row = db.select().from(vehicleCatalogueCustom).where(eq(vehicleCatalogueCustom.id, id)).get();
  return row ? toEntry(row) : undefined;
}

export function createCustomCatalogueEntry(db: Db, input: CreateCustomCatalogueInput, actor: Actor): CustomCatalogueEntry {
  if (!CUSTOM_CATALOGUE_LEVELS.includes(input.level)) throw new ValidationError(`level must be one of ${CUSTOM_CATALOGUE_LEVELS.join(', ')}`);
  const make = (input.make ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!make) throw new ValidationError('make is required');
  if (!name) throw new ValidationError('name is required');
  if (!SLUG.test(input.makeSlug)) throw new ValidationError('makeSlug must be a slug (a-z, 0-9, hyphens)');
  if (input.modelSlug !== undefined && !SLUG.test(input.modelSlug)) throw new ValidationError('modelSlug must be a slug (a-z, 0-9, hyphens)');
  if (input.level !== 'make' && !input.modelSlug) throw new ValidationError(`a ${input.level} entry needs the model it belongs to`);
  if ((input.level === 'trim' || input.level === 'engine') && !input.generationId) throw new ValidationError(`a ${input.level} entry needs the generation it belongs to`);
  const gtaGroup = input.gtaGroup?.trim().toUpperCase();
  if (gtaGroup && !GROUP.test(gtaGroup)) throw new ValidationError(`GTA group "${input.gtaGroup}" must look like S1, M, M1 or CP2`);
  if (input.overridesBuiltin && !gtaGroup && !input.segment) throw new ValidationError('an override of a shipped entry must change its segment or GTA group');
  const id = newId();
  db.insert(vehicleCatalogueCustom)
    .values({
      id,
      level: input.level,
      make,
      makeSlug: input.makeSlug,
      model: input.model?.trim() || null,
      modelSlug: input.modelSlug ?? null,
      generationId: input.generationId ?? null,
      name,
      data: input.data ?? {},
      segment: input.segment ?? null,
      gtaGroup: gtaGroup || null,
      overridesBuiltin: input.overridesBuiltin ?? false,
      createdAt: nowIso(),
      createdBy: actor.userId,
    })
    .run();
  return getCustomCatalogueEntry(db, id)!;
}

/** Soft delete (deleted_at / deleted_by). Deleting twice keeps the first deletion. */
export function softDeleteCustomCatalogueEntry(db: Db, id: Id, actor: Actor): CustomCatalogueEntry {
  const before = getCustomCatalogueEntry(db, id);
  if (!before) throw new NotFoundError('catalogue entry', id);
  if (before.deletedAt) return before;
  db.update(vehicleCatalogueCustom).set({ deletedAt: nowIso(), deletedBy: actor.userId }).where(eq(vehicleCatalogueCustom.id, id)).run();
  return getCustomCatalogueEntry(db, id)!;
}
