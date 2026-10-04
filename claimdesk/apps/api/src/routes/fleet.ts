/**
 * Fleet routes: units CRUD (+ vehicle + alerts), compliance alerts, class-of-use allocation guard, policies,
 * penalties CRUD + stage transitions, PCN liability-transfer / s.172 response documents.
 */
import type { FastifyInstance } from 'fastify';
import type { FleetUnit, HireAgreement, Party, PenaltyNotice, Vehicle } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest, conflict } from '../errors.js';
import { parse } from '../schemas/common.js';
import { allocateCheckBody, fleetUnitBody, fleetUnitPatchBody, penaltyBody, penaltyDocumentBody, penaltyListQuery, penaltyPatchBody, penaltyTransitionBody, policyBody } from '../schemas/services.js';
import { createStandaloneDocument } from '../services/documents.js';
import { canAllocateFor } from '../engines.js';
import { allowedStages, complianceAlerts, liabilityTransferParticulars, penaltyTransition, s172ResponseData, S172RefusalError } from '../services/fleetFallbacks.js';
import { params } from './helpers.js';

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
    if (!check.ok) throw conflict('TRANSITION_REFUSED', check.reasons.join('; '), { reasons: check.reasons, allowed: check.allowed });
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
    const keeperAddressLines = unit.keeperAddressOnV5C ? [unit.keeperAddressOnV5C.line1, unit.keeperAddressOnV5C.line2, unit.keeperAddressOnV5C.town, unit.keeperAddressOnV5C.postcode].filter((x): x is string => Boolean(x)) : ro ? [ro.line1, ro.line2, ro.town, ro.postcode].filter((x): x is string => Boolean(x)) : ['[registered office]'];
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
      if (!hire || !hirer || !hireRecord) throw conflict('NO_HIRER', 'No hire agreement covers the contravention time — liability cannot be transferred without the hirer (lesson l: do not guess)');
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

  app.post('/fleet', async (request, reply) => {
    const body = parse(fleetUnitBody, request.body);
    const now = ctx.now();
    const unit = ctx.db.transaction((tx) => {
      let vehicleId = body.vehicleId;
      if (!vehicleId && body.vehicle) {
        const existing = ctx.repos.findByRegistration(tx, body.vehicle.registration);
        const v = ctx.repos.upsertVehicle(tx, { ...body.vehicle, make: body.vehicle.make || existing?.make || 'UNKNOWN', model: body.vehicle.model || existing?.model || 'UNKNOWN', gtaGroup: body.vehicle.gtaGroup ?? body.gtaGroup, ownership: 'fleet', odometer: [], lookups: [] });
        vehicleId = v.id;
      }
      if (!vehicleId) throw badRequest('vehicleId or vehicle is required');
      const vehicle = ctx.repos.requireVehicle(tx, vehicleId);
      if (ctx.repos.listClaimsForRegistration(tx, vehicle.registration).some((c) => c.clientVehicleId === vehicleId)) {
        throw conflict('REGISTRATION_ON_CLAIM', `${vehicle.registration} is a client vehicle on an open claim — a fleet unit cannot also be a client vehicle (lessons f, h)`);
      }
      if (body.policyId) ctx.repos.requirePolicy(tx, body.policyId);
      const { vehicle: _v, ...rest } = body;
      const u = ctx.repos.createFleetUnit(tx, { ...rest, vehicleId, keeperAddressCurrent: body.keeperAddressCurrent ?? true });
      if (vehicle.ownership !== 'fleet') ctx.repos.updateVehicle(tx, vehicleId, { ownership: 'fleet' });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet_unit.create', entity: 'fleet_units', entityId: u.id, after: { vehicleId, registration: vehicle.registration, declaredUses: u.declaredUses, policyId: u.policyId }, at: now });
      return u;
    });
    return reply.status(201).send(unitRow(unit, allAlerts()));
  });

  app.patch('/fleet/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(fleetUnitPatchBody, request.body);
    const before = ctx.repos.requireFleetUnit(ctx.db, id);
    if (body.policyId) ctx.repos.requirePolicy(ctx.db, body.policyId);
    const now = ctx.now();
    const unit = ctx.db.transaction((tx) => {
      const patch = { ...body, policyId: body.policyId === null ? undefined : body.policyId };
      const u = ctx.repos.updateFleetUnit(tx, id, patch);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet_unit.update', entity: 'fleet_units', entityId: id, before: { declaredUses: before.declaredUses, policyId: before.policyId, status: before.status }, after: body, at: now });
      return u;
    });
    return unitRow(unit, allAlerts());
  });

  app.delete('/fleet/:id', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const u = ctx.repos.requireFleetUnit(ctx.db, id);
    if (ctx.repos.activeHireForFleetUnit(ctx.db, id)) throw conflict('UNIT_ON_HIRE', 'Unit is on hire — end the hire first');
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      ctx.repos.updateFleetUnit(tx, id, { status: 'disposed' });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet_unit.dispose', entity: 'fleet_units', entityId: id, before: { status: u.status }, after: { status: 'disposed' }, at: now });
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
    const result = canAllocateFor(unit, body.use, policies, at, vehicle);
    if (ctx.repos.activeHireForFleetUnit(ctx.db, id)) {
      result.ok = false;
      result.reasons.push('Unit is currently on hire');
    }
    if (body.claimId) {
      const claim = ctx.repos.requireClaim(ctx.db, body.claimId);
      if (vehicle && claim.clientVehicleId === vehicle.id) {
        result.ok = false;
        result.reasons.push('This fleet unit is the client vehicle on the claim (lessons f, h)');
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
