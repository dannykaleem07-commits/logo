/**
 * Vehicle catalogue routes (TEMPLATES-VEHICLES-DESKTOP §D.8): makes/models/detail from the shipped catalogue merged
 * with the user's additions, DVLA-string matching, free-text search, the features vocabulary, custom entries and the
 * GTA group suggestion. Catalogue data is unverified reference data; GTA figures are an industry benchmark only.
 *
 * The read-only catalogue routes send `cache-control: private, max-age=3600`. After adding or deleting a custom entry a
 * client that must see it at once re-requests with a cache-busting query parameter (e.g. `?v=<timestamp>`).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { londonDate } from '@ccguk/domain';
import { CATALOGUE_SEGMENTS, CATALOGUE_VEHICLE_TYPES, loadFeatureVocabulary, slugify, vehicleDimensionsOrDefault } from '@ccguk/kb';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { fuelType } from '../schemas/vehicles.js';
import { getModel, gtaSuggestionFor, listMakes, listModels, makeSlugFor, matchVehicle, modelSlugFor, searchVehicles } from '../services/catalogue.js';
import { configRolesOnly, params } from './helpers.js';

const CACHE = 'private, max-age=3600';
const cached = (reply: FastifyReply): void => {
  reply.header('cache-control', CACHE);
};

const modelsQuery = z.object({
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  vehicleType: z.enum(CATALOGUE_VEHICLE_TYPES as unknown as [string, ...string[]]).optional(),
  v: z.string().optional(),
});
const matchQuery = z.object({ make: z.string().trim().min(1).max(80), model: z.string().trim().max(160).optional(), v: z.string().optional() });
const searchQuery = z.object({ q: z.string().max(200).default(''), limit: z.coerce.number().int().min(1).max(100).optional(), v: z.string().optional() });

const dimensionsQuery = z.object({
  make: z.string().trim().max(80).default(''),
  model: z.string().trim().max(160).default(''),
  generation: z.string().trim().max(160).optional(),
  body: z.string().trim().max(60).optional(),
  doors: z.coerce.number().int().min(2).max(5).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  v: z.string().optional(),
});

const GROUP = /^[A-Z]{1,3}\d{0,2}$/;
const customBody = z.object({
  level: z.enum(['make', 'model', 'generation', 'trim', 'engine']),
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120).optional(),
  generationId: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(160),
  data: z.record(z.unknown()).optional(),
  segment: z.enum(CATALOGUE_SEGMENTS as unknown as [string, ...string[]]).optional(),
  gtaGroup: z
    .string()
    .trim()
    .transform((g) => g.toUpperCase())
    .pipe(z.string().regex(GROUP, 'expected a GTA group code like M1'))
    .optional(),
  overridesBuiltin: z.boolean().optional(),
});

const suggestQuery = z.object({
  make: z.string().trim().max(80).optional(),
  model: z.string().trim().max(160).optional(),
  generationId: z.string().trim().max(160).optional(),
  trimId: z.string().trim().max(64).optional(),
  segment: z.string().trim().max(32).optional(),
  bodyType: z.string().trim().max(60).optional(),
  engineCapacityCc: z.coerce.number().int().min(1).max(20_000).optional(),
  fuelType: fuelType.optional(),
  variant: z.string().trim().max(120).optional(),
  recordedGroup: z.string().trim().max(8).optional(),
  yearOfManufacture: z.coerce.number().int().min(1900).max(2100).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
});

export function registerCatalogueRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/catalogue/makes', async (_request, reply) => {
    cached(reply);
    return { items: listMakes(ctx) };
  });

  app.get('/catalogue/makes/:make/models', async (request, reply) => {
    const { make } = params<{ make: string }>(request);
    const q = parse(modelsQuery, request.query);
    cached(reply);
    return { items: listModels(ctx, make, { year: q.year, vehicleType: q.vehicleType as (typeof CATALOGUE_VEHICLE_TYPES)[number] | undefined }) };
  });

  app.get('/catalogue/makes/:make/models/:model', async (request, reply) => {
    const { make, model } = params<{ make: string; model: string }>(request);
    const m = getModel(ctx, make, model);
    if (!m) throw notFound('catalogue model', `${make}/${model}`);
    cached(reply);
    return m;
  });

  app.get('/catalogue/match', async (request, reply) => {
    const q = parse(matchQuery, request.query);
    cached(reply);
    return matchVehicle(ctx, q.make, q.model);
  });

  app.get('/catalogue/search', async (request, reply) => {
    const q = parse(searchQuery, request.query);
    cached(reply);
    return { items: searchVehicles(ctx, q.q, q.limit ?? 20) };
  });

  app.get('/catalogue/features', async (_request, reply) => {
    cached(reply);
    return loadFeatureVocabulary();
  });

  /**
   * Exterior dimensions for the 3D damage model (packages/kb vehicle-dimensions). `dims` is the resolved body record;
   * `source: 'default'` means nothing is on file and body-type proportions were used. Unverified reference data.
   */
  app.get('/catalogue/dimensions', async (request, reply) => {
    const q = parse(dimensionsQuery, request.query);
    const { v: _v, ...query } = q;
    cached(reply);
    return vehicleDimensionsOrDefault(query);
  });

  app.get('/catalogue/custom', async () => ({ items: ctx.repos.listCustomCatalogueEntries(ctx.db) }));

  app.post('/catalogue/custom', { preHandler: configRolesOnly }, async (request, reply) => {
    const body = parse(customBody, request.body);
    if (body.level !== 'make' && !body.model) throw badRequest(`A ${body.level} entry needs the model it belongs to`);
    if ((body.level === 'trim' || body.level === 'engine') && !body.generationId) throw badRequest(`A ${body.level} entry needs the generation it belongs to`);
    const makeSlug = makeSlugFor(body.make);
    const modelSlug = body.model ? modelSlugFor(makeSlug, body.model) : body.level === 'model' ? slugify(body.name) : undefined;
    const now = ctx.now();
    const entry = ctx.db.transaction((tx) => {
      const e = ctx.repos.createCustomCatalogueEntry(
        tx,
        {
          level: body.level,
          make: body.make,
          makeSlug,
          ...(body.model ? { model: body.model } : {}),
          ...(modelSlug ? { modelSlug } : {}),
          ...(body.generationId ? { generationId: body.generationId } : {}),
          name: body.name,
          data: body.data ?? {},
          ...(body.segment ? { segment: body.segment } : {}),
          ...(body.gtaGroup ? { gtaGroup: body.gtaGroup } : {}),
          overridesBuiltin: body.overridesBuiltin ?? false,
        },
        request.actor,
      );
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'catalogue.custom.create', entity: 'vehicle_catalogue_custom', entityId: e.id, after: e, at: now });
      return e;
    });
    return reply.status(201).send(entry);
  });

  app.delete('/catalogue/custom/:id', { preHandler: configRolesOnly }, async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const before = ctx.repos.getCustomCatalogueEntry(ctx.db, id);
    if (!before || before.deletedAt) throw notFound('catalogue entry', id);
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      ctx.repos.softDeleteCustomCatalogueEntry(tx, id, request.actor);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'catalogue.custom.delete', entity: 'vehicle_catalogue_custom', entityId: id, before, at: now });
    });
    return reply.status(204).send();
  });

  /** Suggested GTA group and benchmark rate for a vehicle (§D.6). A suggestion only: CCGUK is not a GTA subscriber. */
  app.get('/gta/suggest', async (request) => {
    const q = parse(suggestQuery, request.query);
    return gtaSuggestionFor(ctx, { ...q, date: q.date ?? londonDate(ctx.now()) });
  });
}
