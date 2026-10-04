import type { FastifyInstance } from 'fastify';
import { mileageConflicts, normaliseRegistration, isValidUkRegistration } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { parse } from '../schemas/common.js';
import { lookupBody, mileageConflictsQuery, odometerReadingInput, onFileQuery, vehicleInput, vehicleListQuery, vehiclePatchBody } from '../schemas/vehicles.js';
import { createLookupClients, differsFromVerified, lookupVehicle, manualLookupRecord, sourceLookupRecord, type LookupClients } from '../services/lookup.js';
import { onFileMatches } from '../services/vehicleSearch.js';
import { params } from './helpers.js';

export interface VehiclesRouteOptions {
  clients?: LookupClients;
}

export function registerVehiclesRoutes(app: FastifyInstance, ctx: AppContext, options: VehiclesRouteOptions = {}): void {
  const clients = options.clients ?? createLookupClients({ keys: ctx.config.keys, timeoutMs: ctx.config.lookupTimeoutMs });

  app.get('/vehicles', async (request) => {
    const q = parse(vehicleListQuery, request.query);
    const items = q.q?.trim() ? ctx.repos.searchVehicles(ctx.db, q.q, q.limit ?? 50) : ctx.repos.listVehicles(ctx.db, { ownership: q.ownership, limit: q.limit, offset: q.offset });
    return { items, total: items.length };
  });

  /**
   * Manual vehicle entry — stored with an unverified LookupRecord whose provider is `source.provider` (default 'manual':
   * typed by hand; 'catalogue': picked from the vehicle catalogue; 'totalcarcheck_manual': copied from Total Car Check).
   */
  app.post('/vehicles', async (request, reply) => {
    const body = parse(vehicleInput, request.body);
    const reg = normaliseRegistration(body.registration);
    if (!isValidUkRegistration(reg)) throw badRequest(`"${body.registration}" is not a valid UK registration format`);
    const now = ctx.now();
    const { odometer, source, ...fields } = body;
    const meta = { requestedAt: now, requestedBy: request.user.id };
    const lookup = source ? sourceLookupRecord(source, reg, meta) : manualLookupRecord(fields, reg, meta);
    const vehicle = ctx.db.transaction((tx) => {
      const existing = ctx.repos.findByRegistration(tx, reg);
      const v = ctx.repos.upsertVehicle(tx, {
        ...fields,
        registration: reg,
        odometer: odometer ?? [],
        lookups: [{ ...lookup, id: ctx.repos.newId() }],
      });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: existing ? 'vehicle.update' : 'vehicle.create', entity: 'vehicles', entityId: v.id, after: { registration: reg, source: source?.provider ?? 'manual' }, at: now });
      return v;
    });
    return reply.status(201).send(vehicle);
  });

  /** What ClaimDesk already holds for a registration (exact, then partial ≥ 4 characters). Read-only (§E.1). */
  app.get('/vehicles/on-file', async (request) => {
    const q = parse(onFileQuery, request.query);
    return { items: onFileMatches(ctx, q.registration, q.limit ?? 10) };
  });

  /**
   * Save details a person supplied for an existing vehicle (§E.4): the fields, plus an unverified LookupRecord saying
   * where they came from. Values that differ from a verified DVLA/DVSA lookup are saved (handler intent) and returned as
   * DIFFERS_FROM_VERIFIED warnings; verified lookups are never changed. Registration cannot be changed here.
   */
  app.patch('/vehicles/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(vehiclePatchBody, request.body);
    const { source, ...fields } = body;
    const before = ctx.repos.requireVehicle(ctx.db, id);
    const warnings = differsFromVerified(before, fields);
    const now = ctx.now();
    const changed = Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined);
    const result = ctx.db.transaction((tx) => {
      ctx.repos.updateVehicle(tx, id, fields);
      const lookup = ctx.repos.addLookup(tx, id, { ...sourceLookupRecord(source, before.registration, { requestedAt: now, requestedBy: request.user.id }), id: ctx.repos.newId() });
      const beforeValues = Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null]));
      ctx.repos.appendAudit(tx, {
        actor: request.actor,
        action: 'vehicle.update',
        entity: 'vehicles',
        entityId: id,
        before: beforeValues,
        after: { ...fields, source: source.provider, appliedFields: source.appliedFields, lookupId: lookup.id, warnings: warnings.length ? warnings : undefined },
        at: now,
      });
      return { vehicle: ctx.repos.requireVehicle(tx, id), lookupId: lookup.id };
    });
    return { ...result.vehicle, vehicle: result.vehicle, lookupId: result.lookupId, warnings };
  });

  app.post('/vehicles/lookup', async (request) => {
    const body = parse(lookupBody, request.body);
    const reg = normaliseRegistration(body.registration);
    if (!isValidUkRegistration(reg)) throw badRequest(`"${body.registration}" is not a valid UK registration format`);
    return lookupVehicle(ctx, clients, { registration: reg, ownership: body.ownership, providers: body.providers }, request.actor);
  });

  app.get('/vehicles/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const vehicle = ctx.repos.requireVehicle(ctx.db, id);
    return { ...vehicle, mileageConflicts: mileageConflicts(vehicle.odometer), claims: ctx.repos.listClaimsForRegistration(ctx.db, vehicle.registration).map((c) => ({ id: c.id, reference: c.reference, status: c.status })) };
  });

  app.post('/vehicles/:id/odometer', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const reading = parse(odometerReadingInput, request.body);
    const vehicle = ctx.db.transaction((tx) => {
      const v = ctx.repos.addOdometer(tx, id, reading);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'vehicle.odometer', entity: 'vehicles', entityId: id, after: reading, at: ctx.now() });
      return v;
    });
    return reply.status(201).send({ vehicle, conflicts: mileageConflicts(vehicle.odometer) });
  });

  app.get('/vehicles/:id/mileage-conflicts', async (request) => {
    const { id } = params<{ id: string }>(request);
    const q = parse(mileageConflictsQuery, request.query);
    const vehicle = ctx.repos.requireVehicle(ctx.db, id);
    return { vehicleId: id, registration: vehicle.registration, readings: vehicle.odometer, conflicts: mileageConflicts(vehicle.odometer, q) };
  });
}
