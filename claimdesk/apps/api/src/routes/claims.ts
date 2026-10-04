/**
 * Claims: list/search, FNOL create (intake validation, cross-file registration check, liability score, injury routing,
 * script-guard offer capture), full bundle view, patch, status change, and the derived sub-resources.
 */
import type { FastifyInstance } from 'fastify';
import { crossFileRegistrationCheck, type Claim, type ClaimFlag, type ClaimStatus, type Id, type Party, type PartyRole, type Vehicle } from '@ccguk/domain';
import type { Actor, Db } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { parse } from '../schemas/common.js';
import { claimListQuery, claimPatchBody, clearFlagBody, createClaimBody, statusBody, type CreateClaimBody } from '../schemas/claims.js';
import type { PartyRef } from '../schemas/parties.js';
import type { VehicleRef } from '../schemas/vehicles.js';
import { acceptanceFor, actionsFor, buildClaimView, gatesFor, loadBundle, recomputeClocks } from '../services/claimView.js';
import { routeInjuryFor, scoreLiabilityFor, validateFnolInput, type FnolValidation, type LiabilityScore } from '../engines.js';
import { FNOL_DEFAULT_ROLES, isIndependentRelationship, normaliseFnol, toFnolInput, type NormalisedFnol, type ResolvedRefs } from '../services/intake.js';
import { manualLookupRecord, sourceLookupRecord } from '../services/lookup.js';
import { assertNoHardStop, params, requireClaim } from './helpers.js';

const STATUS_RANK: Record<ClaimStatus, number> = {
  fnol: 0, triage: 1, declined: 1, accepted: 2, hire_active: 3, repair: 3, total_loss: 3, payment_pack: 4, chasing: 5, disputed: 5, complaint: 6, pre_action: 7, litigation: 8, settled: 9, closed: 10,
};

function resolveParty(ctx: AppContext, tx: Db, ref: PartyRef, now: string, defaultRoles: readonly PartyRole[]): Party {
  if ('id' in ref) return ctx.repos.requireParty(tx, ref.id);
  const { roles, ...rest } = ref;
  return ctx.repos.createParty(tx, { ...rest, roles: roles?.length ? roles : [...defaultRoles], createdAt: now });
}

/** Read-only lookups of id references so the domain FNOL validation sees the party/vehicle facts behind them. */
function resolveRefsForValidation(ctx: AppContext, n: NormalisedFnol): ResolvedRefs {
  const party = (ref: PartyRef | undefined) => (ref && 'id' in ref ? ctx.repos.getParty(ctx.db, ref.id) : undefined);
  const vehicle = (ref: VehicleRef | undefined) => (ref && 'id' in ref ? ctx.repos.getVehicle(ctx.db, ref.id) : undefined);
  return { claimant: party(n.claimant), vehicle: vehicle(n.vehicle), thirdPartyVehicle: vehicle(n.thirdPartyVehicle), clientInsurer: party(n.clientInsurer), atFaultInsurer: party(n.atFaultInsurer) };
}

function resolveVehicle(ctx: AppContext, tx: Db, ref: VehicleRef, ownership: Vehicle['ownership'], actor: Actor, now: string): Vehicle {
  if ('id' in ref) return ctx.repos.requireVehicle(tx, ref.id);
  const { odometer, source, ...fields } = ref;
  const existing = ctx.repos.findByRegistration(tx, ref.registration);
  const meta = { requestedAt: now, requestedBy: actor.userId };
  // A source (catalogue pick / Total Car Check paste) is always recorded; a plain manual entry only when no live lookup exists.
  const lookups = source
    ? [{ ...sourceLookupRecord(source, ref.registration, meta), id: ctx.repos.newId() }]
    : existing?.lookups.some((l) => l.provider === 'dvla_ves' || l.provider === 'dvsa_mot' || l.provider === 'gateway')
      ? []
      : [{ ...manualLookupRecord(fields, ref.registration, meta), id: ctx.repos.newId() }];
  return ctx.repos.upsertVehicle(tx, {
    ...fields,
    make: fields.make || existing?.make || 'UNKNOWN',
    model: fields.model || existing?.model || 'UNKNOWN',
    ownership: existing?.ownership === 'fleet' ? 'fleet' : ownership,
    odometer: odometer ?? [],
    lookups,
  });
}

export interface IntakeReport {
  validation: FnolValidation;
  crossFile: ReturnType<typeof crossFileRegistrationCheck>;
  liability: LiabilityScore;
  injury?: { referredTo: string; message: string; feeTaken: false };
  offer?: { id: Id; replyDueBy: string };
  witnesses?: Array<{ partyId: Id; name: string; independent: boolean; reasons: string[] }>;
  flags: ClaimFlag[];
}

/**
 * The created claim. The web client reads it as a `Claim` (top-level fields); the intake report rides along as `intake`
 * and the claim is repeated under `claim` for callers written against `{ claim, intake }`.
 */
export type CreatedClaim = Claim & { claim: Claim; intake: IntakeReport };

export function createClaimFromFnol(ctx: AppContext, body: CreateClaimBody, actor: Actor): CreatedClaim {
  const n = normaliseFnol(body);
  const validation = validateFnolInput(toFnolInput(n, resolveRefsForValidation(ctx, n)));
  if (!validation.ok) {
    throw badRequest('FNOL is missing mandatory fields', { missing: validation.missing, errors: validation.errors, incomplete: validation.incomplete, warnings: validation.warnings });
  }
  if (n.interventionOffer && (n.interventionOffer as { clientToldToIgnore?: unknown }).clientToldToIgnore === true) {
    throw badRequest('Script guard: never tell the client to ignore an offer — record what was offered, by whom and when');
  }
  const now = ctx.now();

  const result = ctx.db.transaction((tx) => {
    const claimant = resolveParty(ctx, tx, n.claimant, now, n.driver ? FNOL_DEFAULT_ROLES.claimantWithDriver : FNOL_DEFAULT_ROLES.claimant);
    const driver = n.driver ? resolveParty(ctx, tx, n.driver, now, FNOL_DEFAULT_ROLES.driver) : undefined;
    const vehicle = resolveVehicle(ctx, tx, n.vehicle, 'client', actor, now);
    const tpVehicle = n.thirdPartyVehicle ? resolveVehicle(ctx, tx, n.thirdPartyVehicle, 'third_party', actor, now) : undefined;
    const thirdParties = n.thirdParties.map((p) => resolveParty(ctx, tx, p, now, FNOL_DEFAULT_ROLES.thirdParty));
    const witnesses = (n.witnesses ?? []).map((w) => ({ w, party: resolveParty(ctx, tx, w.party, now, FNOL_DEFAULT_ROLES.witness) }));
    const atFaultInsurer = n.atFaultInsurer ? resolveParty(ctx, tx, n.atFaultInsurer, now, FNOL_DEFAULT_ROLES.insurer) : undefined;
    const clientInsurer = n.clientInsurer ? resolveParty(ctx, tx, n.clientInsurer, now, FNOL_DEFAULT_ROLES.insurer) : undefined;

    // Cross-file registration check (lessons f, h): other claims + fleet units on this registration.
    const allClaims = ctx.repos.listClaims(tx, { limit: 100_000 });
    const allVehicles = ctx.repos.listVehicles(tx, { limit: 100_000 });
    const fleetUnits = ctx.repos.listFleetUnits(tx);
    const crossFile = crossFileRegistrationCheck(vehicle.registration, allClaims, allVehicles, fleetUnits);
    const flags: ClaimFlag[] = [];
    if (crossFile.isFleetUnit) {
      flags.push({ code: 'FLEET_UNIT_AS_CLIENT_VEHICLE', severity: 'block', message: crossFile.message, raisedAt: now, raisedBy: 'system' });
    }
    if (crossFile.duplicateClaimIds.length) {
      flags.push({ code: 'DUPLICATE_REGISTRATION', severity: 'warn', message: crossFile.message, raisedAt: now, raisedBy: 'system' });
    }

    const liability = scoreLiabilityFor(n.accident, { liability: n.liability, priorClaimsOnRegistration: crossFile.duplicateClaimIds.length });

    const injury = routeInjuryFor(n.accident, n.injuryReferralTo);
    if (injury) {
      flags.push({ code: 'INJURY_REFERRAL', severity: 'warn', message: injury.message, raisedAt: now, raisedBy: 'system' });
    }

    // Witnesses: the connected-party check against the claimant/driver (lesson g) — never presented as independent when linked.
    const witnessReports = witnesses.map(({ w, party }) => {
      const reasons: string[] = [];
      if (w.independent === false) reasons.push('recorded at FNOL as not independent');
      if (w.relationship && !isIndependentRelationship(w.relationship)) reasons.push(`relationship to the claimant: ${w.relationship}`);
      const linked = ctx.repos.findConnections(tx, { partyId: party.id }).filter((c) => c.party.id === claimant.id || (driver !== undefined && c.party.id === driver.id));
      if (linked.length) reasons.push(`shares ${[...new Set(linked.flatMap((c) => c.matchedOn))].join(', ')} with the ${linked.some((c) => c.party.id === claimant.id) ? 'claimant' : 'driver'}`);
      const independent = reasons.length === 0;
      if (!independent) {
        flags.push({ code: 'NON_INDEPENDENT_WITNESS', severity: 'warn', message: `Witness ${party.name}: ${reasons.join('; ')} (lesson g). Do not present this witness as independent; seek CCTV, dashcam or an unconnected witness before relying on liability.`, raisedAt: now, raisedBy: 'system' });
      }
      return { partyId: party.id, name: party.name, independent, reasons };
    });

    if (validation.incomplete.length) {
      flags.push({
        code: 'INTAKE_INCOMPLETE',
        severity: 'warn',
        message: `FNOL questions still open (BLUEPRINT §3.1): ${validation.incomplete.map((i) => `${i.field} — ${i.message}`).join(' | ')}`,
        raisedAt: now,
        raisedBy: 'system',
      });
    }

    const claim = ctx.repos.createClaim(tx, {
      accident: n.accident,
      liability: n.liability,
      liabilityScore: liability.score,
      claimantId: claimant.id,
      driverId: driver?.id,
      clientVehicleId: vehicle.id,
      thirdPartyIds: [...thirdParties, ...witnesses.map((x) => x.party)].map((p) => p.id),
      thirdPartyVehicleId: tpVehicle?.id,
      atFaultInsurerId: atFaultInsurer?.id,
      atFaultInsurerRef: n.atFaultInsurerRef,
      clientInsurerId: clientInsurer?.id,
      clientPolicyNumber: n.clientPolicyNumber,
      handlerId: n.handlerId ?? actor.userId,
      injuryReferral: injury ? { referredTo: injury.referredTo, referredAt: now, feeTaken: false } : undefined,
      linkedClaimIds: crossFile.duplicateClaimIds,
      flags,
      openedAt: n.fnolAt ?? now,
    });
    for (const other of crossFile.duplicateClaimIds) ctx.repos.linkClaims(tx, claim.id, other);

    const fnolAt = n.fnolAt ?? now;
    ctx.repos.appendEvent(tx, {
      claimId: claim.id,
      type: 'fnol',
      at: fnolAt,
      summary: `FNOL taken from ${claimant.name}: ${n.accident.location} on ${n.accident.occurredAt.slice(0, 10)}`,
      data: {
        liabilityScore: liability.score,
        liabilityBand: liability.band,
        liabilityReasons: liability.reasons,
        callRecordingDisclosed: n.callRecordingDisclosed ?? false,
        callRecordingReadAt: n.callRecordingReadAt,
        channel: n.channel,
        takenCold: n.takenCold,
        services: n.services,
        thirdPartyPolicyNumber: n.thirdPartyPolicyNumber,
        thirdPartyContact: n.thirdPartyContact,
        witnesses: witnessReports.length ? witnessReports : undefined,
        intakeIncomplete: validation.incomplete.map((i) => i.field),
        notes: n.notes,
      },
      attributableTo: 'client',
      createdBy: actor.userId,
      recordedAt: now,
    });
    if (n.servicesAgreedAt) {
      ctx.repos.appendEvent(tx, { claimId: claim.id, type: 'services_agreed', at: n.servicesAgreedAt, summary: 'Services agreed with the client', attributableTo: 'client', createdBy: actor.userId, recordedAt: now });
    }
    if (injury) {
      ctx.repos.appendEvent(tx, {
        claimId: claim.id,
        type: 'note',
        at: now,
        summary: `Injury element referred out to ${injury.referredTo} — no fee taken`,
        data: { task: 'INJURY_REFERRAL', title: injury.task.title, basis: injury.task.basis, referredTo: injury.referredTo, feeTaken: false, notes: n.injuryNotes },
        attributableTo: 'ccguk',
        createdBy: actor.userId,
        recordedAt: now,
      });
    }

    let offerSummary: IntakeReport['offer'];
    if (n.interventionOffer) {
      const o = n.interventionOffer;
      const offer = ctx.repos.createOffer(tx, {
        claimId: claim.id,
        receivedAt: o.receivedAt ?? fnolAt,
        channel: o.channel,
        offerorPartyId: o.offerorPartyId,
        offerorName: o.offerorName,
        vehicleClassOffered: o.vehicleClassOffered,
        dailyRatePence: o.dailyRatePence,
        rateIncludesVat: o.rateIncludesVat,
        terms: o.terms ?? {},
      });
      ctx.repos.appendEvent(tx, {
        claimId: claim.id,
        type: 'intervention_offer',
        at: offer.receivedAt,
        summary: `Intervention offer from ${o.offerorName} (${o.channel}) captured at FNOL — client asked what, by whom, when`,
        data: { offerId: offer.id, dailyRatePence: o.dailyRatePence, vehicleClassOffered: o.vehicleClassOffered },
        attributableTo: 'insurer',
        createdBy: actor.userId,
        recordedAt: now,
      });
      ctx.repos.appendAudit(tx, { actor, action: 'offer.create', entity: 'intervention_offers', entityId: offer.id, after: { claimId: claim.id, offerorName: o.offerorName, source: 'fnol_script_guard' }, at: now });
      offerSummary = { id: offer.id, replyDueBy: '' };
    }

    ctx.repos.appendAudit(tx, {
      actor,
      action: 'claim.create',
      entity: 'claims',
      entityId: claim.id,
      after: { reference: claim.reference, claimantId: claimant.id, vehicleId: vehicle.id, flags: flags.map((f) => f.code), crossFile: crossFile.severity, liabilityScore: liability.score, intakeIncomplete: validation.incomplete.map((i) => i.field) },
      at: now,
    });
    const intake: IntakeReport = {
      validation,
      crossFile,
      liability,
      injury: injury ? { referredTo: injury.referredTo, message: injury.message, feeTaken: false } : undefined,
      offer: offerSummary,
      witnesses: witnessReports.length ? witnessReports : undefined,
      flags,
    };
    return { claim, intake };
  });

  const clocks = recomputeClocks(ctx, result.claim.id);
  if (result.intake.offer) {
    const reply = clocks.find((c) => c.kind === 'intervention_reply_1wd');
    if (reply) result.intake.offer.replyDueBy = reply.dueAt;
  }
  const claim = ctx.repos.requireClaim(ctx.db, result.claim.id);
  return { ...claim, claim, intake: result.intake };
}

export function registerClaimsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims', async (request) => {
    const q = parse(claimListQuery, request.query);
    const statuses = q.status ? (q.status.split(',').map((s) => s.trim()).filter(Boolean) as ClaimStatus[]) : undefined;
    const flagged = q.flagged === undefined ? undefined : q.flagged === 'true' ? true : q.flagged === 'false' ? undefined : q.flagged;
    const items = ctx.repos.listClaims(ctx.db, {
      status: statuses && statuses.length === 1 ? statuses[0] : statuses,
      handlerId: q.handlerId,
      atFaultInsurerId: q.atFaultInsurerId,
      claimantId: q.claimantId,
      search: q.search ?? q.q,
      flagged,
      limit: q.limit,
      offset: q.offset,
    });
    const partyIds = [...new Set(items.map((c) => c.claimantId))];
    const parties = new Map(ctx.repos.getParties(ctx.db, partyIds).map((p) => [p.id, p]));
    const vehicleIds = [...new Set(items.map((c) => c.clientVehicleId))];
    const vehicles = new Map(vehicleIds.map((id) => [id, ctx.repos.getVehicle(ctx.db, id)]));
    return {
      items: items.map((c) => ({
        ...c,
        claimantName: parties.get(c.claimantId)?.name,
        registration: vehicles.get(c.clientVehicleId)?.registration,
        openFlags: c.flags.filter((f) => !f.clearedAt).length,
      })),
      total: items.length,
      byStatus: ctx.repos.countClaimsByStatus(ctx.db),
    };
  });

  app.post('/claims', async (request, reply) => {
    const body = parse(createClaimBody, request.body);
    const created = createClaimFromFnol(ctx, body, request.actor);
    return reply.status(201).send(created);
  });

  app.get('/claims/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return buildClaimView(ctx, id);
  });

  app.patch('/claims/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(claimPatchBody, request.body);
    const before = requireClaim(ctx, id);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      patch[k] = k === 'accident' ? { ...before.accident, ...(v as object) } : v;
    }
    if (patch.accident && !body.liabilityScore) {
      const liability = (patch.liability as Claim['liability'] | undefined) ?? before.liability;
      patch.liabilityScore = scoreLiabilityFor(patch.accident as Claim['accident'], { liability }).score;
    }
    const claim = ctx.db.transaction((tx) => {
      // Nullable fields in the patch body map to undefined → compact() drops them; use explicit null writes for clears.
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) set[k] = v === null ? null : v;
      const updated = ctx.repos.updateClaim(tx, id, set as Parameters<typeof ctx.repos.updateClaim>[2]);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'claim.patch', entity: 'claims', entityId: id, before: pick(before, Object.keys(patch)), after: patch, at: ctx.now() });
      return updated;
    });
    return claim;
  });

  app.post('/claims/:id/status', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(statusBody, request.body);
    const claim = requireClaim(ctx, id);
    if (claim.status === body.status) return claim;
    const progressing = STATUS_RANK[body.status] >= STATUS_RANK.accepted && !['declined', 'closed'].includes(body.status);
    if (progressing) assertNoHardStop(claim);
    if (['pre_action', 'litigation'].includes(body.status) && !body.reason) {
      throw badRequest('A reason is required when moving to pre_action or litigation (litigation documents are drafts for the claimant to sign)');
    }
    return ctx.repos.setClaimStatus(ctx.db, id, body.status, request.actor, body.reason);
  });

  app.post('/claims/:id/flags/:code/clear', async (request) => {
    const { id, code } = params<{ id: string; code: string }>(request);
    const body = parse(clearFlagBody, request.body);
    return ctx.repos.clearClaimFlag(ctx.db, id, code, request.actor, body.reason);
  });

  app.get('/claims/:id/clocks', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return { clocks: recomputeClocks(ctx, id) };
  });

  app.get('/claims/:id/gates', async (request) => {
    const { id } = params<{ id: string }>(request);
    return { gates: gatesFor(loadBundle(ctx, id)) };
  });

  app.get('/claims/:id/actions', async (request) => {
    const { id } = params<{ id: string }>(request);
    const clocks = recomputeClocks(ctx, id);
    const bundle = { ...loadBundle(ctx, id), clocks };
    const gates = gatesFor(bundle);
    return { actions: actionsFor(ctx, bundle, gates) };
  });

  app.get('/claims/:id/acceptance', async (request) => {
    const { id } = params<{ id: string }>(request);
    const bundle = loadBundle(ctx, id);
    const gates = gatesFor(bundle);
    return acceptanceFor(ctx, bundle, gates);
  });

  app.get('/claims/:id/audit', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return { entries: ctx.repos.listAudit(ctx.db, { entityId: id, limit: 500 }) };
  });
}

function pick<T extends object>(obj: T, keys: string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (obj as Record<string, unknown>)[k];
  return out as Partial<T>;
}

