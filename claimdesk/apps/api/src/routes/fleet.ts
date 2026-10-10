/**
 * Fleet routes: units CRUD (+ vehicle + alerts), compliance alerts, class-of-use allocation guard, policies,
 * penalties CRUD + stage transitions, PCN liability-transfer / s.172 response documents.
 */
import type { FastifyInstance } from 'fastify';
import { gtaRate, londonDate, normaliseRegistration, type Address, type FleetUnit, type GtaSuggestion, type HireAgreement, type Party, type PenaltyNotice, type Vehicle, type VehicleSourceInput } from '@ccguk/domain';
import type { Settings } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, unprocessable } from '../errors.js';
import { gateFor, NEW_ENTITY, type OverrideTarget } from '../services/override.js';
import { parse } from '../schemas/common.js';
import { allocateCheckBody, fleetUnitBody, fleetUnitPatchBody, penaltyBody, penaltyDocumentBody, penaltyListQuery, penaltyPatchBody, penaltyTransitionBody, policyBody } from '../schemas/services.js';
import { gtaSuggestionFor } from '../services/catalogue.js';
import { createStandaloneDocument } from '../services/documents.js';
import { gtaRatesFor } from '../services/kb.js';
import { differsFromVerified, sourceLookupRecord } from '../services/lookup.js';
import { canAllocateFor } from '../engines.js';
import { allowedStages, complianceAlerts, liabilityTransferParticulars, penaltyTransition, s172ResponseData, S172RefusalError } from '../services/fleetFallbacks.js';
import { params } from './helpers.js';
import { periodAllocateBody } from '../schemas/bookings.js';
import { allocateCheckForPeriod } from '../booking/service.js';

/** GTA group stored on a fleet unit saved in manager mode without a group (0.3 §A.6 B09). */
export const UNGROUPED = 'UNGROUPED';

/** Courtesy Cars Group UK Ltd registered office, used only when Settings has none (§H defaults set it). */
export const CCGUK_REGISTERED_OFFICE_LINES = ['44 Syon Lane', 'Isleworth', 'London', 'TW7 5NQ'] as const;

function addressLines(a: Address): string[] {
  return [a.line1, a.line2, a.town, a.county, a.postcode].filter((x): x is string => Boolean(x && x.trim()));
}

/** Keeper address lines for PCN/s.172 letters when the V5C keeper address is not recorded: the registered office. */
export function registeredOfficeLines(settings: Pick<Settings, 'registeredOffice'>): string[] {
  const ro = settings.registeredOffice;
  const lines = ro ? addressLines(ro) : [];
  return lines.length ? lines : [...CCGUK_REGISTERED_OFFICE_LINES];
}

/** The provenance of fleet vehicle details: the explicit source, else 'catalogue' when catalogue ids are present, else 'manual'. */
function fleetSource(source: VehicleSourceInput | undefined, spec: Vehicle['spec'] | undefined): VehicleSourceInput {
  if (source) return source;
  return { provider: spec?.catalogue ? 'catalogue' : 'manual' };
}

export function registerFleetRoutes(app: FastifyInstance, ctx: AppContext): void {
  const unitRow = (u: FleetUnit, alerts?: ReturnType<typeof complianceAlerts>) => {
    const vehicle = ctx.repos.getVehicle(ctx.db, u.vehicleId);
    const policy = u.policyId ? ctx.repos.getPolicy(ctx.db, u.policyId) : undefined;
    return { ...u, vehicle, registration: vehicle?.registration, policy, alerts: alerts?.filter((a) => a.fleetUnitId === u.id) };
  };
  const allAlerts = () => {
    const units = ctx.repos.listFleetUnits(ctx.db);
    const vehicles = units.map((u) => ctx.repos.getVehicle(ctx.db, u.vehicleId)).filter((v): v is Vehicle => Boolean(v));
    return complianceAlerts({ units, vehicles, policies: ctx.repos.listPolicies(ctx.db), penalties: ctx.repos.listPenalties(ctx.db, { open: true }), now: ctx.now() });
  };

  app.get('/fleet', async () => {
    const alerts = allAlerts();
    return { items: ctx.repos.listFleetUnits(ctx.db).map((u) => unitRow(u, alerts)) };
  });

  app.get('/fleet/alerts', async () => ({ items: allAlerts() }));

  app.get('/fleet/policies', async () => ({ items: ctx.repos.listPolicies(ctx.db) }));
  app.post('/fleet/policies', async (request, reply) => {
    const body = parse(policyBody, request.body);
    const now = ctx.now();
    const policy = ctx.db.transaction((tx) => {
      const p = ctx.repos.createPolicy(tx, body);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'policy.create', entity: 'insurance_policies', entityId: p.id, after: body, at: now });
      return p;
    });
    return reply.status(201).send(policy);
  });

  app.get('/fleet/penalties', async (request) => {
    const q = parse(penaltyListQuery, request.query);
    return { items: ctx.repos.listPenalties(ctx.db, { open: q.open === 'true' ? true : undefined, stage: q.stage, fleetUnitId: q.fleetUnitId }) };
  });
  app.post('/fleet/penalties', async (request, reply) => {
    const body = parse(penaltyBody, request.body);
    ctx.repos.requireFleetUnit(ctx.db, body.fleetUnitId);
    if (body.hireAgreementId) ctx.repos.requireHire(ctx.db, body.hireAgreementId);
    const now = ctx.now();
    const penalty = ctx.db.transaction((tx) => {
      const p = ctx.repos.createPenalty(tx, body);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'penalty.create', entity: 'penalty_notices', entityId: p.id, after: { kind: p.kind, issuer: p.issuer, noticeNumber: p.noticeNumber, responseDeadline: p.responseDeadline }, at: now });
      return p;
    });
    return reply.status(201).send({ ...penalty, hireMatch: matchHire(penalty).hire?.id ?? null });
  });
  app.get('/fleet/penalties/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const p = ctx.repos.requirePenalty(ctx.db, id);
    return { ...p, hireMatch: matchHire(p).hire ?? null, allowedTransitions: allowedStages({ penalty: p, hire: matchHire(p).hire, now: ctx.now() }) };
  });
  app.patch('/fleet/penalties/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(penaltyPatchBody, request.body);
    const before = ctx.repos.requirePenalty(ctx.db, id);
    if (body.stage && body.stage !== before.stage) throw badRequest('Use POST /fleet/penalties/:id/transition to change the stage');
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const { stage: _s, ...patch } = body;
      const p = ctx.repos.updatePenalty(tx, id, patch);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'penalty.update', entity: 'penalty_notices', entityId: id, before: { notes: before.notes, hireAgreementId: before.hireAgreementId }, after: patch, at: now });
      return p;
    });
  });

  app.post('/fleet/penalties/:id/transition', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(penaltyTransitionBody, request.body);
    const penalty = ctx.repos.requirePenalty(ctx.db, id);
    const hireId = body.hireAgreementId ?? penalty.hireAgreementId ?? matchHire(penalty).hire?.id;
    const hire = hireId ? ctx.repos.getHire(ctx.db, hireId) : undefined;
    const now = ctx.now();
    const check = penaltyTransition(body.stage, { penalty, hire, now });
    if (!check.ok) {
      const err = conflict('TRANSITION_REFUSED', check.reasons.join('; '), { reasons: check.reasons, allowed: check.allowed });
      // Naming the hirer or transferring liability needs the hire records (s.172, lesson l): never overridable (class C).
      if (body.stage === 'hirer_identified' || body.stage === 'liability_transferred') throw err;
      const target: OverrideTarget = { entity: 'penalty_notices', entityId: id };
      if (hire?.claimId) target.claimId = hire.claimId;
      gateFor(ctx, request).refuse(err, target);
    }
    return ctx.db.transaction((tx) => {
      const p = ctx.repos.setPenaltyStage(tx, id, body.stage, { hireAgreementId: hire?.id, documentId: body.documentId, notes: body.note ? [penalty.notes, `${now.slice(0, 10)}: ${body.note}`].filter(Boolean).join('\n') : undefined });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'penalty.transition', entity: 'penalty_notices', entityId: id, before: { stage: penalty.stage }, after: { stage: body.stage, hireAgreementId: hire?.id, documentId: body.documentId, note: body.note }, at: now });
      if (hire?.claimId && (body.stage === 'liability_transferred' || body.stage === 'hirer_identified')) {
        ctx.repos.appendEvent(tx, { claimId: hire.claimId, type: body.stage === 'liability_transferred' ? 'pcn_liability_transferred' : 'pcn_received', at: now, summary: `${penalty.kind} ${penalty.noticeNumber} from ${penalty.issuer}: ${body.stage.replace('_', ' ')}`, data: { penaltyId: id, stage: body.stage }, attributableTo: 'ccguk', createdBy: request.user.id, recordedAt: now });
      }
      return p;
    });
  });

  app.post('/fleet/penalties/:id/documents', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(penaltyDocumentBody, request.body);
    const penalty = ctx.repos.requirePenalty(ctx.db, id);
    const unit = ctx.repos.requireFleetUnit(ctx.db, penalty.fleetUnitId);
    const vehicle = ctx.repos.requireVehicle(ctx.db, unit.vehicleId);
    const match = matchHire(penalty);
    const hire = match.hire;
    const hirer = match.hirer;
    const settings = ctx.settings();
    const ro = settings.registeredOffice;
    const keeperAddressLines = unit.keeperAddressOnV5C ? addressLines(unit.keeperAddressOnV5C) : registeredOfficeLines({ registeredOffice: ro });
    const extra = body.data ?? {};
    const x = (k: string): unknown => extra[k];
    const str = (k: string): string | undefined => (typeof x(k) === 'string' && (x(k) as string).trim() ? (x(k) as string) : undefined);
    const ourReference = `FLT-${penalty.kind === 'nip_s172' ? 'NIP' : 'PCN'}-${penalty.contraventionAt.slice(0, 4)}-${penalty.id.slice(0, 4).toUpperCase()}`;
    const recipient = { name: str('issuerName') ?? penalty.issuer, attention: str('issuerAttention') ?? (penalty.kind === 'nip_s172' ? 'Central Ticket Office' : 'Representations'), addressLines: (Array.isArray(x('issuerAddressLines')) ? (x('issuerAddressLines') as string[]) : undefined) ?? ['[issuer address]'], email: str('issuerEmail') };
    const vehicleBlock = { registration: vehicle.registration, make: vehicle.make, model: [vehicle.model, vehicle.variant].filter(Boolean).join(' ') };
    const hireRecord = hire ? { agreementNumber: hire.agreementNumber, startAt: hire.startAt, endAt: hire.endAt, expectedEnd: 'until repair of the hirer’s own vehicle or settlement of the claim', signedAt: hire.signedAt ?? hire.startAt } : undefined;
    let data: Record<string, unknown>;
    const particulars = liabilityTransferParticulars({ penalty, unit, vehicle, hire, hirer, keeperName: settings.companyName, keeperAddressLines });
    if (body.templateId === 'notice.pcn_liability_transfer') {
      if (!hire || !hirer || !hireRecord) throw conflict('NO_HIRER', 'No hire agreement covers the contravention time — liability cannot be transferred without the hirer (do not guess)');
      const licence = (x('hirerLicence') as { number?: string; countryOfIssue?: string; expiresOn?: string } | undefined) ?? {};
      data = {
        ourReference,
        recipient,
        kind: penalty.kind === 'pcn_private' ? 'private' : 'council',
        notice: { number: penalty.noticeNumber, noticeType: str('noticeType') ?? (penalty.kind === 'pcn_private' ? 'Parking Charge Notice' : 'Penalty Charge Notice'), issuer: penalty.issuer, contraventionAt: penalty.contraventionAt, location: str('location'), contravention: str('contravention'), amountPence: penalty.amountPence, receivedAt: penalty.receivedAt },
        vehicle: vehicleBlock,
        hirer: { name: hirer.name, addressLines: hirer.address ? [hirer.address.line1, hirer.address.line2, hirer.address.town, hirer.address.postcode].filter((l): l is string => Boolean(l)) : ['[address to be confirmed]'], dateOfBirth: hirer.dateOfBirth, email: hirer.email, phone: hirer.phone, licence: { number: licence.number ?? hirer.drivingLicenceNumber, countryOfIssue: licence.countryOfIssue ?? 'United Kingdom', expiresOn: licence.expiresOn } },
        hire: hireRecord,
        confirmationRequestedBy: penalty.responseDeadline,
        enclosures: (Array.isArray(x('enclosures')) ? (x('enclosures') as string[]) : undefined) ?? [`Hire agreement ${hire.agreementNumber} (signed statement of liability)`, 'Copy of the hirer’s driving licence'],
        particulars,
      };
    } else {
      const cannotIdentify = x('cannotIdentify') === true;
      const driverName = str('driverName') ?? (hirer && !cannotIdentify ? hirer.name : undefined);
      if (cannotIdentify && driverName) throw badRequest('s.172: you cannot both say the driver could not be identified (s.172(4)) and name a driver', { code: 'S172_REFUSAL' });
      let s172: ReturnType<typeof s172ResponseData>;
      try {
        s172 = s172ResponseData({ penalty, unit, vehicle, hire, hirer, additionalDrivers: hire ? ctx.repos.getParties(ctx.db, hire.additionalDrivers.map((d) => d.partyId)) : [], keeperName: settings.companyName, keeperAddressLines, cannotIdentify, driverName, driverAddressLines: x('driverAddressLines') as string[] | undefined, driverLicenceNumber: str('driverLicenceNumber'), diligence: Array.isArray(x('diligence')) ? (x('diligence') as string[]) : [] });
      } catch (err) {
        if (err instanceof S172RefusalError) throw badRequest(err.message, { code: 'S172_REFUSAL' });
        throw err;
      }
      const recordsSearched = Array.isArray(x('recordsSearched')) ? (x('recordsSearched') as unknown[]) : (Array.isArray(x('diligence')) ? (x('diligence') as string[]) : []).map((d) => ({ record: d, searchedOn: ctx.now().slice(0, 10), searchedBy: request.user.name, result: 'Does not identify the driver' }));
      data = {
        ourReference,
        recipient,
        notice: { reference: penalty.noticeNumber, dated: str('noticeDated') ?? penalty.receivedAt.slice(0, 10), receivedAt: penalty.receivedAt, offenceAt: penalty.contraventionAt, location: str('location'), allegedOffence: str('allegedOffence') },
        vehicle: vehicleBlock,
        responseDueBy: penalty.responseDeadline,
        cannotIdentify,
        driver: driverName && hirer ? { name: driverName, addressLines: (x('driverAddressLines') as string[] | undefined) ?? (hirer.address ? [hirer.address.line1, hirer.address.line2, hirer.address.town, hirer.address.postcode].filter((l): l is string => Boolean(l)) : ['[address to be confirmed]']), dateOfBirth: hirer.dateOfBirth, licence: hirer.drivingLicenceNumber ? { number: hirer.drivingLicenceNumber, countryOfIssue: 'United Kingdom' } : undefined, role: 'hirer' } : undefined,
        hire: hireRecord,
        recordsSearched: cannotIdentify ? recordsSearched : undefined,
        diligenceNote: str('diligenceNote'),
        enclosures: Array.isArray(x('enclosures')) ? (x('enclosures') as string[]) : hire ? [`Hire agreement ${hire.agreementNumber}`] : undefined,
        s172,
      };
    }
    let doc;
    try {
      doc = createStandaloneDocument(ctx, { templateId: body.templateId, data, user: request.user, actor: request.actor, claimId: hire?.claimId, recipientPartyId: undefined });
    } catch (err) {
      if (err instanceof Error && (err.name === 'DriverNominationError' || err.name === 'CertificateDateError')) throw badRequest(err.message, { code: 'S172_REFUSAL' });
      throw err;
    }
    ctx.db.transaction((tx) => {
      ctx.repos.updatePenalty(tx, id, { documentIds: [...penalty.documentIds, doc.id] });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'penalty.document', entity: 'penalty_notices', entityId: id, after: { documentId: doc.id, templateId: body.templateId }, at: ctx.now() });
    });
    return reply.status(201).send(doc);
  });

  app.get('/fleet/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const u = ctx.repos.requireFleetUnit(ctx.db, id);
    return { ...unitRow(u, allAlerts()), hires: ctx.repos.listHireForFleetUnit(ctx.db, id), penalties: ctx.repos.listPenalties(ctx.db, { fleetUnitId: id }) };
  });

  /**
   * Add a fleet unit (§F.2). `gtaGroup` and `dailyRatePence` are optional: when omitted the server uses the GTA
   * suggestion (recorded group → catalogue → segment default → heuristic) and its benchmark rate, or answers 422
   * GTA_SUGGESTION_UNAVAILABLE. The vehicle details are recorded with an unverified LookupRecord (catalogue/manual/TCC).
   */
  /** Suggestion bases good enough to record on the vehicle itself. */
  const CONFIDENT_SUGGESTION_BASES: ReadonlySet<string> = new Set(['recorded', 'custom_override', 'catalogue_trim', 'catalogue_generation', 'catalogue_model']);

  app.post('/fleet', async (request, reply) => {
    const body = parse(fleetUnitBody, request.body);
    const now = ctx.now();
    const date = londonDate(now);
    const known: Vehicle | undefined = body.vehicleId ? ctx.repos.requireVehicle(ctx.db, body.vehicleId) : body.vehicle ? ctx.repos.findByRegistration(ctx.db, body.vehicle.registration) : undefined;
    let gtaGroup = body.gtaGroup?.trim().toUpperCase();
    let dailyRatePence = body.dailyRatePence;
    let suggestion: GtaSuggestion | undefined;
    if (!gtaGroup || dailyRatePence === undefined) {
      const v = body.vehicle;
      const spec = v?.spec ?? known?.spec;
      suggestion = gtaSuggestionFor(ctx, {
        make: spec?.catalogue?.makeSlug ?? v?.make ?? known?.make,
        model: spec?.catalogue?.modelSlug ?? v?.model ?? known?.model,
        generationId: spec?.catalogue?.generationId,
        trimId: spec?.catalogue?.trimId,
        segment: spec?.segment,
        bodyType: v?.bodyType ?? known?.bodyType,
        engineCapacityCc: v?.engineCapacityCc ?? known?.engineCapacityCc,
        fuelType: v?.fuelType ?? known?.fuelType,
        variant: v?.variant ?? known?.variant,
        recordedGroup: gtaGroup ?? v?.gtaGroup ?? known?.gtaGroup,
        ...((v?.yearOfManufacture ?? known?.yearOfManufacture) !== undefined ? { yearOfManufacture: (v?.yearOfManufacture ?? known?.yearOfManufacture)! } : {}),
        date,
      });
      // An explicit "no group yet" never takes a guessed (or previously recorded) group.
      gtaGroup = gtaGroup ?? (body.gtaGroupUnknown ? undefined : (suggestion.group ?? undefined));
      if (dailyRatePence === undefined && gtaGroup) {
        dailyRatePence = suggestion.group === gtaGroup && suggestion.rate ? suggestion.rate.dailyRatePence : gtaRate(gtaGroup, date, gtaRatesFor(ctx))?.dailyRatePence;
      }
      if (!gtaGroup || dailyRatePence === undefined) {
        const err = unprocessable('GTA_SUGGESTION_UNAVAILABLE', 'Choose a GTA group and daily rate', { suggestion });
        // No daily rate: the user has to type one (C-input). A typed rate with no group: manager mode saves UNGROUPED.
        if (dailyRatePence === undefined) throw err;
        gateFor(ctx, request).refuse(err, { entity: 'fleet_units', entityId: body.vehicle ? normaliseRegistration(body.vehicle.registration) : (body.vehicleId ?? NEW_ENTITY) });
        gtaGroup = UNGROUPED;
      }
    }
    const group = gtaGroup;
    const rate = dailyRatePence;
    const unit = ctx.db.transaction((tx) => {
      let vehicleId = body.vehicleId;
      if (!vehicleId && body.vehicle) {
        const { source, ...fields } = body.vehicle;
        const existing = ctx.repos.findByRegistration(tx, fields.registration);
        const provenance = sourceLookupRecord(fleetSource(source, fields.spec), fields.registration, { requestedAt: now, requestedBy: request.user.id });
        const gtaSuggestion = body.gtaSuggestion ?? (suggestion ? { group: suggestion.group, basis: suggestion.basis, rateGroup: suggestion.rate?.group ?? null, ratePeriod: suggestion.rate?.period ?? null } : undefined);
        const raw = { ...(provenance.raw as Record<string, unknown>), ...(gtaSuggestion ? { gtaSuggestion } : {}) };
        const v = ctx.repos.upsertVehicle(tx, {
          ...fields,
          make: fields.make || existing?.make || 'UNKNOWN',
          model: fields.model || existing?.model || 'UNKNOWN',
          // Only a group the user chose, or one that came from the vehicle's record or the catalogue, is written onto
          // the vehicle; a low-confidence guess (segment default, heuristic) stays on the unit only.
          gtaGroup: fields.gtaGroup ?? (group !== UNGROUPED && (body.gtaGroup !== undefined || (suggestion && CONFIDENT_SUGGESTION_BASES.has(suggestion.basis))) ? group : undefined),
          ownership: 'fleet',
          odometer: [],
          lookups: [{ ...provenance, raw, id: ctx.repos.newId() }],
        });
        vehicleId = v.id;
      }
      if (!vehicleId) throw badRequest('vehicleId or vehicle is required');
      const vehicle = ctx.repos.requireVehicle(tx, vehicleId);
      const onClaim = ctx.repos.listClaimsForRegistration(tx, vehicle.registration).find((c) => c.clientVehicleId === vehicleId);
      if (onClaim) {
        gateFor(ctx, request).refuse(conflict('REGISTRATION_ON_CLAIM', `${vehicle.registration} is a client vehicle on an open claim — a fleet unit cannot also be a client vehicle`), { claimId: onClaim.id, entity: 'vehicles', entityId: vehicleId });
      }
      if (body.policyId) ctx.repos.requirePolicy(tx, body.policyId);
      const { vehicle: _v, gtaSuggestion: _g, gtaGroupUnknown: _u, ...rest } = body;
      const u = ctx.repos.createFleetUnit(tx, { ...rest, gtaGroup: group, dailyRatePence: rate, vehicleId, keeperAddressCurrent: body.keeperAddressCurrent ?? true });
      if (vehicle.ownership !== 'fleet') ctx.repos.updateVehicle(tx, vehicleId, { ownership: 'fleet' });
      ctx.repos.appendAudit(tx, {
        actor: request.actor,
        action: 'fleet_unit.create',
        entity: 'fleet_units',
        entityId: u.id,
        after: { vehicleId, registration: vehicle.registration, declaredUses: u.declaredUses, policyId: u.policyId, gtaGroup: group, dailyRatePence: rate, gtaSuggestion: suggestion ? { group: suggestion.group, basis: suggestion.basis, rate: suggestion.rate?.dailyRatePence ?? null } : undefined },
        at: now,
      });
      return u;
    });
    return reply.status(201).send({ ...unitRow(unit, allAlerts()), ...(suggestion ? { gtaSuggestion: suggestion } : {}) });
  });

  app.patch('/fleet/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(fleetUnitPatchBody, request.body);
    const before = ctx.repos.requireFleetUnit(ctx.db, id);
    if (body.policyId) ctx.repos.requirePolicy(ctx.db, body.policyId);
    const now = ctx.now();
    const { vehicle: vehiclePatch, ...unitPatch } = body;
    const vehicleBefore = vehiclePatch ? ctx.repos.requireVehicle(ctx.db, before.vehicleId) : undefined;
    const warnings = vehiclePatch && vehicleBefore ? differsFromVerified(vehicleBefore, vehiclePatch) : [];
    const unit = ctx.db.transaction((tx) => {
      const patch = { ...unitPatch, policyId: unitPatch.policyId === null ? undefined : unitPatch.policyId };
      const u = ctx.repos.updateFleetUnit(tx, id, patch);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet_unit.update', entity: 'fleet_units', entityId: id, before: { declaredUses: before.declaredUses, policyId: before.policyId, status: before.status }, after: unitPatch, at: now });
      // Vehicle changes (make, MOT, tax, spec …) go to the vehicle record with their provenance (§F.2).
      if (vehiclePatch && vehicleBefore) {
        const { source, ...fields } = vehiclePatch;
        ctx.repos.updateVehicle(tx, vehicleBefore.id, fields);
        const lookup = ctx.repos.addLookup(tx, vehicleBefore.id, { ...sourceLookupRecord(fleetSource(source, fields.spec ?? undefined), vehicleBefore.registration, { requestedAt: now, requestedBy: request.user.id }), id: ctx.repos.newId() });
        const changed = Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined);
        ctx.repos.appendAudit(tx, {
          actor: request.actor,
          action: 'vehicle.update',
          entity: 'vehicles',
          entityId: vehicleBefore.id,
          before: Object.fromEntries(changed.map((k) => [k, (vehicleBefore as unknown as Record<string, unknown>)[k] ?? null])),
          after: { ...fields, source: source?.provider ?? (fields.spec?.catalogue ? 'catalogue' : 'manual'), lookupId: lookup.id, fleetUnitId: id, warnings: warnings.length ? warnings : undefined },
          at: now,
        });
      }
      return u;
    });
    return { ...unitRow(unit, allAlerts()), ...(vehiclePatch ? { warnings } : {}) };
  });

  app.delete('/fleet/:id', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const u = ctx.repos.requireFleetUnit(ctx.db, id);
    const openHire = ctx.repos.activeHireForFleetUnit(ctx.db, id);
    if (openHire) {
      // Manager mode (0.3 §A.6 B10): the car is disposed, the open hire is left running and its claim is flagged.
      gateFor(ctx, request).refuse(conflict('UNIT_ON_HIRE', 'Unit is on hire — end the hire first', { hireAgreementId: openHire.id, agreementNumber: openHire.agreementNumber }), { claimId: openHire.claimId, entity: 'fleet_units', entityId: id });
    }
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      ctx.repos.updateFleetUnit(tx, id, { status: 'disposed' });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet_unit.dispose', entity: 'fleet_units', entityId: id, before: { status: u.status }, after: { status: 'disposed', ...(openHire ? { openHireId: openHire.id, claimId: openHire.claimId } : {}) }, at: now });
      if (openHire) {
        const registration = ctx.repos.getVehicle(tx, u.vehicleId)?.registration ?? id;
        ctx.repos.addClaimFlag(tx, openHire.claimId, {
          code: 'HIRE_ON_DISPOSED_UNIT',
          severity: 'warn',
          message: `Fleet car ${registration} was disposed in manager mode while hire ${openHire.agreementNumber ?? openHire.id} was still open. End the hire with its real date.`,
          raisedAt: now,
          raisedBy: request.user.id,
        });
      }
    });
    return reply.status(204).send();
  });

  app.post('/fleet/:id/allocate-check', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(allocateCheckBody, request.body);
    const unit = ctx.repos.requireFleetUnit(ctx.db, id);
    const policies = ctx.repos.listPolicies(ctx.db);
    const at = body.at ?? ctx.now();
    const vehicle = ctx.repos.getVehicle(ctx.db, unit.vehicleId);
    // Period-aware (SUPREME-AUTOPILOT §B.10, ap-booking): the diary decides "on hire", not today's open hire.
    const period = parse(periodAllocateBody, request.body);
    const startAt = period.startAt ?? at;
    const result = canAllocateFor({ ...unit, status: unit.status === 'on_hire' ? 'available' : unit.status }, body.use, policies, startAt, vehicle);
    const forPeriod = allocateCheckForPeriod(ctx, id, { use: body.use, ...(body.claimId ? { claimId: body.claimId } : {}), startAt, expectedEndAt: period.expectedEndAt ?? new Date(Date.parse(startAt) + 60_000).toISOString() });
    for (const r of forPeriod.reasons) if (!result.reasons.includes(r)) result.reasons.push(r);
    for (const w of forPeriod.warnings) if (!result.warnings.includes(w)) result.warnings.push(w);
    result.ok = result.reasons.length === 0;
    if (body.claimId) {
      const claim = ctx.repos.requireClaim(ctx.db, body.claimId);
      if (vehicle && claim.clientVehicleId === vehicle.id) {
        result.ok = false;
        result.reasons.push('This fleet unit is the client vehicle on the claim');
      }
    }
    const policy = unit.policyId ? policies.find((p) => p.id === unit.policyId) : undefined;
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'fleet_unit.allocate_check', entity: 'fleet_units', entityId: id, after: { use: body.use, claimId: body.claimId, ok: result.ok, reasons: result.reasons, warnings: result.warnings }, at: ctx.now() });
    return { allowed: result.ok, ok: result.ok, reasons: result.reasons, warnings: result.warnings, policy: policy ? { id: policy.id, insurerName: policy.insurerName, coveredUses: policy.coveredUses } : undefined };
  });

  /** The hire agreement (and hirer) that had the unit at the contravention time. */
  function matchHire(penalty: PenaltyNotice): { hire?: HireAgreement; hirer?: Party } {
    const hire = penalty.hireAgreementId
      ? ctx.repos.getHire(ctx.db, penalty.hireAgreementId)
      : ctx.repos.listHireForFleetUnit(ctx.db, penalty.fleetUnitId).find((h) => penalty.contraventionAt >= h.startAt && (!h.endAt || penalty.contraventionAt <= h.endAt));
    if (!hire) return {};
    const claim = ctx.repos.getClaim(ctx.db, hire.claimId);
    const hirer = claim ? ctx.repos.getParty(ctx.db, claim.claimantId) : undefined;
    return { hire, hirer };
  }

}
