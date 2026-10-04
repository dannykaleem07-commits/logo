import type { FastifyInstance } from 'fastify';
import { mileageConflicts, normaliseRegistration, isValidUkRegistration } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { parse } from '../schemas/common.js';
import { lookupBody, mileageConflictsQuery, odometerReadingInput, vehicleInput, vehicleListQuery } from '../schemas/vehicles.js';
import { createLookupClients, lookupVehicle, manualLookupRecord, type LookupClients } from '../services/lookup.js';
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

  /** Manual vehicle entry — stored with a 'manual' LookupRecord (verification unverified). */
  app.post('/vehicles', async (request, reply) => {
    const body = parse(vehicleInput, request.body);
    const reg = normaliseRegistration(body.registration);
    if (!isValidUkRegistration(reg)) throw badRequest(`"${body.registration}" is not a valid UK registration format`);
    const now = ctx.now();
    const { odometer, ...fields } = body;
    const vehicle = ctx.db.transaction((tx) => {
      const existing = ctx.repos.findByRegistration(tx, reg);
      const v = ctx.repos.upsertVehicle(tx, {
        ...fields,
        registration: reg,
        odometer: odometer ?? [],
        lookups: [{ ...manualLookupRecord(fields, reg, { requestedAt: now, requestedBy: request.user.id }), id: ctx.repos.newId() }],
      });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: existing ? 'vehicle.update' : 'vehicle.create', entity: 'vehicles', entityId: v.id, after: { registration: reg, source: 'manual' }, at: now });
      return v;
    });
    return reply.status(201).send(vehicle);
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
