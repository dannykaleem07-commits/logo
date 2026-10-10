// owned by ap-clash
/**
 * Clash and eligibility routes (docs/SUPREME-AUTOPILOT.md §C.3–§C.5, §F, §H.4):
 *   POST /clashes/check                      live check (proposed booking when fleetUnitId is given, else the claim);
 *                                            persists findings for the claim; read-only for the claim's records
 *   GET  /claims/:id/clashes                 stored findings of a claim (open / acknowledged / overridden; ?all=1 for all)
 *   GET  /fleet/clashes                      open findings across the fleet (filters: code, severity, unit, claim, status)
 *   POST /clashes/:id/acknowledge      (H)   a warn the owner has read (reason) — it stops counting as green-blocking
 *   POST /clashes/:id/resolve          (H)   close a finding by hand (reason; audited)
 *   GET  /parties/:id/driver-profile         the driver profile (licence facts, DVLA check) and its assessment
 *   PUT  /parties/:id/driver-profile   (H)   save it (audited before/after); queues clash checks on the party's claims
 *   GET  /fleet/policies/:id/criteria        the policy's driver criteria, the default and which applies
 *   PUT  /fleet/policies/:id/criteria  (H)   set (or clear with null) a policy's own criteria; admin/approver
 *   GET  /claims/:id/hire-needs              the claim's hire needs (§F.3)
 *   PUT  /claims/:id/hire-needs              save them (merged over the current needs; audited)
 *   GET  /claims/:id/eligibility             the eligibility summary (drivers, need, means, roadworthiness, injury)
 *   POST /claims/:id/eligibility/assess      record the computed assessment (append-only; only kinds whose inputs changed)
 * (H) = human-only (agent perimeter). Messages never name another claim or another claim's people.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_DRIVER_CRITERIA,
  GREEN_BLOCKING_CLASH_CODES,
  type ClashFindingRecord,
  type ClashFindingStatus,
  type ClashSubject,
  type DriverProfile,
  type HireNeeds,
  type Id,
} from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError, conflict, notFound } from '../errors.js';
import { parse, isoDate, isoDateTime } from '../schemas/common.js';
import { params, requireClaim, requireRole } from './helpers.js';
import { autopilotSettingsOf, checkClashes, defaultPeriod, persistFindings, queueClashCheck } from '../clash/service.js';
import { driverContext, eligibilityFor, recordAcceptance, recordEligibility } from '../eligibility/service.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';
import { acceptanceFor, gatesFor, loadBundle } from '../services/claimView.js';

const country = z.enum(['GB', 'NI', 'EU_EEA', 'OTHER', 'unknown']);
const reasonBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

export const clashCheckBody = z
  .object({
    claimId: z.string().min(1).max(128),
    fleetUnitId: z.string().min(1).max(128).nullish(),
    startAt: isoDateTime.nullish(),
    expectedEndAt: isoDateTime.nullish(),
    use: z.enum(['credit_hire', 'self_drive', 'pco']).nullish(),
    hirerPartyId: z.string().min(1).max(128).nullish(),
    driverPartyIds: z.array(z.string().min(1).max(128)).max(10).nullish(),
    excludeReservationId: z.string().min(1).max(128).nullish(),
    stage: z.enum(['hold', 'confirm', 'handover']).nullish(),
    /** false = do not store (a pure preview). Default true (§H.2: clash_check persists findings for the claim). */
    persist: z.boolean().nullish(),
  })
  .strict();

export const driverProfileBody = z
  .object({
    licenceNumber: z.string().trim().max(32).nullish(),
    licenceCountry: country,
    licenceType: z.enum(['full', 'provisional', 'international', 'unknown']),
    fullLicenceSince: isoDate.nullish(),
    licenceExpiry: isoDate.nullish(),
    categories: z.array(z.string().trim().min(1).max(8)).max(40).default([]),
    restrictionCodes: z.array(z.string().trim().min(1).max(8)).max(40).default([]),
    points: z.number().int().min(0).max(99).nullable(),
    endorsements: z.array(z.object({ code: z.string().trim().min(2).max(8), offenceDate: isoDate, points: z.number().int().min(0).max(12) }).strict()).max(40).default([]),
    disqualifiedUntil: isoDate.nullish(),
    disqualifications5y: z.number().int().min(0).max(20).nullable().default(null),
    faultAccidents3y: z.number().int().min(0).max(50).nullable().default(null),
    unspentConvictions: z.array(z.string().trim().min(1).max(200)).max(20).nullable().default(null),
    medicalConditionsDeclared: z.boolean().nullable().default(null),
    occupation: z.string().trim().max(200).nullish(),
    dvlaCheck: z.object({ checkedAt: isoDateTime, summary: z.string().trim().min(1).max(2000), evidenceId: z.string().min(1).max(128).nullish() }).strict().nullish(),
    source: z.enum(['declared', 'dvla_check', 'licence_scan', 'mixed']),
  })
  .strict();

const criteriaSchema = z
  .object({
    minAge: z.number().int().min(16).max(100),
    referBelowAge: z.number().int().min(16).max(100),
    maxAge: z.number().int().min(16).max(120),
    referAboveAge: z.number().int().min(16).max(120),
    minYearsFullLicence: z.number().min(0).max(80),
    referBelowYearsFullLicence: z.number().min(0).max(80),
    maxPointsEligible: z.number().int().min(0).max(50),
    maxPointsRefer: z.number().int().min(0).max(50),
    excludedEndorsementPrefixes: z.array(z.string().trim().min(1).max(8)).max(100),
    excludedLookbackYears: z.number().int().min(0).max(20),
    referEndorsementPrefixes: z.array(z.string().trim().min(1).max(8)).max(100),
    maxFaultAccidents3yEligible: z.number().int().min(0).max(20),
    maxFaultAccidents3yRefer: z.number().int().min(0).max(20),
    disqualificationLookbackYears: z.number().int().min(0).max(20),
    licenceCountriesEligible: z.array(country).max(5),
    licenceCountriesRefer: z.array(country).max(5),
    provisionalAllowed: z.literal(false),
    requireDvlaCheckWithinDays: z.number().int().min(1).max(90),
    unspentConvictionsRefer: z.boolean(),
    youngDriverExcessPence: z.number().int().min(0).nullable(),
  })
  .strict()
  .refine((c) => c.minAge <= c.referBelowAge && c.referBelowAge <= c.referAboveAge && c.referAboveAge <= c.maxAge, 'ages must satisfy min ≤ refer-below ≤ refer-above ≤ max')
  .refine((c) => c.minYearsFullLicence <= c.referBelowYearsFullLicence, 'minimum years must not exceed the refer-below years')
  .refine((c) => c.maxPointsEligible <= c.maxPointsRefer && c.maxFaultAccidents3yEligible <= c.maxFaultAccidents3yRefer, 'eligible limits must not exceed the refer limits');

const needsSource = z.enum(['intake_script', 'intake_extract', 'handler', 'client_reply']);
const addressSchema = z.object({ line1: z.string().min(1), line2: z.string().optional(), town: z.string().optional(), county: z.string().optional(), postcode: z.string().min(2), country: z.string().optional() }).strict();
export const hireNeedsBody = z
  .object({
    neededFrom: isoDateTime.nullable(),
    deliveryAddress: addressSchema.nullable(),
    deliveryPostcode: z.string().trim().max(10).nullable(),
    seatsMin: z.number().int().min(1).max(17).nullable(),
    automaticOnly: z.boolean(),
    automaticPreferred: z.boolean(),
    towbar: z.boolean(),
    wheelchairAccessible: z.boolean(),
    handControls: z.boolean(),
    isofixCount: z.number().int().min(0).max(6),
    evOk: z.boolean().nullable(),
    phvWork: z.boolean(),
    largeBoot: z.boolean(),
    occupation: z.string().trim().max(300).nullable(),
    journeys: z.string().trim().max(2000).nullable(),
    dependants: z.string().trim().max(1000).nullable(),
    otherVehicles: z.enum(['none', 'available', 'unknown']),
    ownInsurerCourtesyCar: z.enum(['offered', 'accepted', 'not_offered', 'unknown']),
    clientCoverType: z.enum(['comprehensive', 'tpft', 'tpo', 'unknown']),
    clientWantsHire: z.boolean().nullable(),
    notes: z.string().trim().max(4000).nullable(),
    source: z.record(z.string(), needsSource),
  })
  .partial()
  .strict();

/** Empty needs (every answer unknown) — the base a partial PUT is merged over. */
export const EMPTY_HIRE_NEEDS: HireNeeds = {
  neededFrom: null,
  deliveryAddress: null,
  deliveryPostcode: null,
  seatsMin: null,
  automaticOnly: false,
  automaticPreferred: false,
  towbar: false,
  wheelchairAccessible: false,
  handControls: false,
  isofixCount: 0,
  evOk: null,
  phvWork: false,
  largeBoot: false,
  occupation: null,
  journeys: null,
  dependants: null,
  otherVehicles: 'unknown',
  ownInsurerCourtesyCar: 'unknown',
  clientCoverType: 'unknown',
  clientWantsHire: null,
  notes: null,
  source: {},
};

const STORED_STATUSES = ['open', 'acknowledged', 'overridden'] as const;

/** Claim references for a set of findings (the owner's views show them; agents never read this list). */
function withReferences(ctx: AppContext, rows: ClashFindingRecord[]): Array<ClashFindingRecord & { claimReference?: string; relatedClaims: Array<{ id: Id; reference: string }> }> {
  const refs = new Map<Id, string>();
  const ref = (id: Id): string => {
    if (!refs.has(id)) refs.set(id, ctx.repos.getClaim(ctx.db, id)?.reference ?? id);
    return refs.get(id)!;
  };
  return rows.map((f) => ({ ...f, ...(f.claimId ? { claimReference: ref(f.claimId) } : {}), relatedClaims: f.related.claimIds.map((id) => ({ id, reference: ref(id) })) }));
}

/** Claims on which a party is the claimant, driver or a booking's hirer/driver. */
function claimsOfParty(ctx: AppContext, partyId: Id): Id[] {
  const rows = ctx.handle.sqlite.prepare('SELECT id FROM claims WHERE claimant_id = ? OR driver_id = ?').all(partyId, partyId) as Array<{ id: string }>;
  const ids = new Set(rows.map((r) => r.id));
  for (const r of ctx.repos.listReservations(ctx.db, { status: ['held', 'confirmed', 'on_hire'] })) if (r.hirerPartyId === partyId || r.driverPartyIds.includes(partyId)) ids.add(r.claimId);
  return [...ids];
}

function afterChange(ctx: AppContext, claimIds: Id[], reason: string, actor: string): void {
  for (const id of claimIds) {
    queueClashCheck(ctx, { kind: 'claim', claimId: id }, actor);
    nudgeAutopilot(ctx, id, reason);
  }
}

export function registerClashesRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- clashes -----------------------------------------------------------
  app.post('/clashes/check', async (request) => {
    const body = parse(clashCheckBody, request.body);
    const claim = requireClaim(ctx, body.claimId);
    let subject: ClashSubject;
    if (body.fleetUnitId) {
      if (!ctx.repos.getFleetUnit(ctx.db, body.fleetUnitId)) throw notFound('fleet unit', body.fleetUnitId);
      const period = defaultPeriod(ctx, body.startAt, body.expectedEndAt);
      if (Date.parse(period.expectedEndAt) <= Date.parse(period.startAt)) throw new HttpError(400, 'VALIDATION', 'The expected end must be after the start');
      const hirer = body.hirerPartyId ?? claim.driverId ?? claim.claimantId;
      subject = {
        kind: 'proposed_booking',
        claimId: claim.id,
        fleetUnitId: body.fleetUnitId,
        use: body.use ?? 'credit_hire',
        startAt: period.startAt,
        expectedEndAt: period.expectedEndAt,
        hirerPartyId: hirer,
        driverPartyIds: body.driverPartyIds?.length ? Array.from(new Set([hirer, ...body.driverPartyIds])) : [hirer],
        ...(body.excludeReservationId ? { excludeReservationId: body.excludeReservationId } : {}),
        stage: body.stage ?? 'hold',
      };
    } else {
      subject = { kind: 'claim', claimId: claim.id };
    }
    const { findings, blocks } = checkClashes(ctx, subject);
    let stored: ClashFindingRecord[] = [];
    if (body.persist !== false) {
      const res = ctx.db.transaction((tx) => persistFindings(ctx, tx, subject, findings));
      stored = [...res.inserted, ...res.seen];
    }
    const byKey = new Map(stored.map((r) => [r.dedupeKey, r]));
    const out = findings.map((f) => {
      const r = byKey.get(f.dedupeKey);
      return r ? { ...f, id: r.id, status: r.status } : f;
    });
    const settings = autopilotSettingsOf(ctx);
    const greenBlocking = out.filter((f) => f.severity === 'warn' && (f as { status?: string }).status !== 'acknowledged' && (f as { status?: string }).status !== 'overridden').map((f) => f.code);
    return { subject, findings: out, blocks: blocks.map((b) => b.code), greenBlocking: greenBlocking.filter((c) => GREEN_BLOCKING_CLASH_CODES.includes(c)), turnaroundMinutes: settings.booking.turnaroundMinutes };
  });

  app.get('/claims/:id/clashes', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const all = q.all === '1' || q.all === 'true';
    const rows = ctx.repos.listClashFindings(ctx.db, { claimId: id, ...(all ? {} : { status: [...STORED_STATUSES] }) });
    const open = rows.filter((f) => f.status === 'open' || f.status === 'acknowledged');
    return { findings: withReferences(ctx, rows), counts: { block: open.filter((f) => f.severity === 'block' && f.status === 'open').length, warn: open.filter((f) => f.severity === 'warn').length, info: open.filter((f) => f.severity === 'info').length } };
  });

  app.get('/fleet/clashes', async (request) => {
    const q = parse(
      z.object({ code: z.string().max(64).optional(), severity: z.enum(['block', 'warn', 'info']).optional(), unit: z.string().max(128).optional(), claim: z.string().max(128).optional(), status: z.enum(['open', 'acknowledged', 'overridden', 'resolved', 'active']).optional(), limit: z.coerce.number().int().min(1).max(2000).optional() }),
      request.query ?? {},
    );
    const status: ClashFindingStatus[] = !q.status || q.status === 'active' ? ['open', 'acknowledged'] : [q.status];
    const rows = ctx.repos.listClashFindings(ctx.db, { status, ...(q.code ? { code: q.code } : {}), ...(q.severity ? { severity: q.severity } : {}), ...(q.unit ? { fleetUnitId: q.unit } : {}), ...(q.claim ? { claimId: q.claim } : {}), limit: q.limit ?? 500 });
    const units = new Map(ctx.repos.listFleetUnits(ctx.db).map((u) => [u.id, u]));
    const regOf = (unitId?: string): string | undefined => {
      const u = unitId ? units.get(unitId) : undefined;
      return u ? ctx.repos.getVehicle(ctx.db, u.vehicleId)?.registration : undefined;
    };
    return { findings: withReferences(ctx, rows).map((f) => ({ ...f, ...(regOf(f.fleetUnitId) ? { registration: regOf(f.fleetUnitId) } : {}) })) };
  });

  app.post('/clashes/:id/acknowledge', async (request) => {
    const { id } = params<{ id: string }>(request);
    const { reason } = parse(reasonBody, request.body);
    const f = ctx.repos.getClashFinding(ctx.db, id);
    if (!f) throw notFound('clash finding', id);
    if (f.severity === 'block') throw conflict('CLASH_BLOCK', 'A block cannot be acknowledged: resolve the cause, or override it as a manager when you book.');
    if (f.status !== 'open') throw conflict('CLASH_NOT_OPEN', `This finding is ${f.status}`);
    const after = ctx.db.transaction((tx) => {
      const updated = ctx.repos.setClashFindingStatus(tx, id, { status: 'acknowledged', by: request.actor.userId, note: reason, at: ctx.now() });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'clash.acknowledge', entity: 'clash_findings', entityId: id, before: { status: f.status }, after: { status: 'acknowledged', code: f.code, reason }, at: ctx.now() });
      return updated;
    });
    if (f.claimId) nudgeAutopilot(ctx, f.claimId, `clash ${f.code} acknowledged`);
    return { finding: after };
  });

  app.post('/clashes/:id/resolve', async (request) => {
    const { id } = params<{ id: string }>(request);
    const { reason } = parse(reasonBody, request.body);
    const f = ctx.repos.getClashFinding(ctx.db, id);
    if (!f) throw notFound('clash finding', id);
    if (f.status === 'resolved') throw conflict('CLASH_NOT_OPEN', 'This finding is already resolved');
    const after = ctx.db.transaction((tx) => {
      const updated = ctx.repos.setClashFindingStatus(tx, id, { status: 'resolved', by: request.actor.userId, note: reason, at: ctx.now() });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'clash.resolve', entity: 'clash_findings', entityId: id, before: { status: f.status }, after: { status: 'resolved', code: f.code, reason }, at: ctx.now() });
      return updated;
    });
    if (f.claimId) nudgeAutopilot(ctx, f.claimId, `clash ${f.code} resolved`);
    return { finding: after };
  });

  // ---- driver profiles ---------------------------------------------------
  app.get('/parties/:id/driver-profile', async (request) => {
    const { id } = params<{ id: string }>(request);
    const party = ctx.repos.getParty(ctx.db, id);
    if (!party) throw notFound('party', id);
    return { partyId: id, name: party.name, dateOfBirth: party.dateOfBirth ?? null, drivingLicenceNumber: party.drivingLicenceNumber ?? null, profile: ctx.repos.getDriverProfile(ctx.db, id) ?? null };
  });

  app.put('/parties/:id/driver-profile', async (request) => {
    const { id } = params<{ id: string }>(request);
    if (!ctx.repos.getParty(ctx.db, id)) throw notFound('party', id);
    const body = parse(driverProfileBody, request.body);
    const before = ctx.repos.getDriverProfile(ctx.db, id) ?? null;
    const now = ctx.now();
    const profile: DriverProfile = {
      ...(body.licenceNumber ? { licenceNumber: body.licenceNumber } : {}),
      ...(body.fullLicenceSince ? { fullLicenceSince: body.fullLicenceSince } : {}),
      ...(body.licenceExpiry ? { licenceExpiry: body.licenceExpiry } : {}),
      ...(body.disqualifiedUntil ? { disqualifiedUntil: body.disqualifiedUntil } : {}),
      ...(body.occupation ? { occupation: body.occupation } : {}),
      partyId: id,
      licenceCountry: body.licenceCountry,
      licenceType: body.licenceType,
      categories: body.categories,
      restrictionCodes: body.restrictionCodes,
      points: body.points,
      endorsements: body.endorsements,
      disqualifications5y: body.disqualifications5y,
      faultAccidents3y: body.faultAccidents3y,
      unspentConvictions: body.unspentConvictions,
      medicalConditionsDeclared: body.medicalConditionsDeclared,
      ...(body.dvlaCheck ? { dvlaCheck: { checkedAt: body.dvlaCheck.checkedAt, checkedBy: request.actor.userId, summary: body.dvlaCheck.summary, ...(body.dvlaCheck.evidenceId ? { evidenceId: body.dvlaCheck.evidenceId } : {}) } } : {}),
      source: body.source,
      updatedBy: request.actor.userId,
      updatedAt: now,
    };
    const saved = ctx.db.transaction((tx) => {
      const p = ctx.repos.putDriverProfile(tx, profile);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'driver_profile.update', entity: 'driver_profiles', entityId: id, before, after: p, at: now });
      return p;
    });
    afterChange(ctx, claimsOfParty(ctx, id), 'driver profile changed', request.actor.userId);
    return { profile: saved };
  });

  // ---- policy criteria ---------------------------------------------------
  app.get('/fleet/policies/:id/criteria', async (request) => {
    const { id } = params<{ id: string }>(request);
    const policy = ctx.repos.getPolicy(ctx.db, id);
    if (!policy) throw notFound('policy', id);
    const defaults = autopilotSettingsOf(ctx).eligibility.defaultCriteria;
    return { policyId: id, criteria: policy.driverCriteria ?? null, defaults, builtIn: DEFAULT_DRIVER_CRITERIA, effective: policy.driverCriteria ?? defaults, source: policy.driverCriteria ? 'policy' : 'settings_default', notice: 'These are generic UK hire-insurer norms. Check them against your fleet policy wording.' };
  });

  app.put('/fleet/policies/:id/criteria', async (request) => {
    requireRole(request);
    const { id } = params<{ id: string }>(request);
    const policy = ctx.repos.getPolicy(ctx.db, id);
    if (!policy) throw notFound('policy', id);
    const body = parse(z.object({ criteria: criteriaSchema.nullable() }).strict(), request.body);
    const now = ctx.now();
    const updated = ctx.db.transaction((tx) => {
      const p = ctx.repos.updatePolicy(tx, id, { driverCriteria: (body.criteria ?? null) as never });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'policy.driver_criteria', entity: 'insurance_policies', entityId: id, before: { driverCriteria: policy.driverCriteria ?? null }, after: { driverCriteria: body.criteria }, at: now });
      return p;
    });
    for (const u of ctx.repos.listFleetUnits(ctx.db).filter((x) => x.policyId === id)) queueClashCheck(ctx, { kind: 'fleet_unit', fleetUnitId: u.id }, request.actor.userId);
    return { policyId: id, criteria: updated.driverCriteria ?? null };
  });

  // ---- hire needs --------------------------------------------------------
  app.get('/claims/:id/hire-needs', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const rec = ctx.repos.getHireNeeds(ctx.db, id);
    return { claimId: id, needs: rec?.needs ?? null, updatedBy: rec?.updatedBy ?? null, updatedAt: rec?.updatedAt ?? null };
  });

  app.put('/claims/:id/hire-needs', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(hireNeedsBody, request.body);
    const before = ctx.repos.getHireNeeds(ctx.db, id)?.needs ?? null;
    const isAgent = request.actor.userId.startsWith('agent:');
    const source: HireNeeds['source'] = { ...(before?.source ?? {}) };
    for (const k of Object.keys(body)) if (k !== 'source') source[k] = body.source?.[k] ?? (isAgent ? 'intake_extract' : 'handler');
    const needs: HireNeeds = { ...EMPTY_HIRE_NEEDS, ...(before ?? {}), ...(body as Partial<HireNeeds>), source };
    const now = ctx.now();
    const saved = ctx.db.transaction((tx) => {
      const rec = ctx.repos.putHireNeeds(tx, id, needs, request.actor.userId, now);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'claim.hire_needs', entity: 'claims', entityId: id, before, after: needs, at: now });
      return rec;
    });
    afterChange(ctx, [id], 'hire needs changed', request.actor.userId);
    return { claimId: id, needs: saved.needs, updatedBy: saved.updatedBy, updatedAt: saved.updatedAt };
  });

  // ---- eligibility -------------------------------------------------------
  app.get('/claims/:id/eligibility', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const summary = eligibilityFor(ctx, id);
    const dc = driverContext(ctx, id);
    const kinds = ['driver', 'need', 'means', 'roadworthiness', 'injury', 'acceptance', 'overall'] as const;
    const latest = Object.fromEntries(kinds.map((k) => [k, ctx.repos.latestEligibilityAssessment(ctx.db, id, k) ?? null]));
    return {
      claimId: id,
      summary,
      criteria: dc?.criteria ?? autopilotSettingsOf(ctx).eligibility.defaultCriteria,
      criteriaSource: dc?.criteriaSource ?? 'settings_default',
      policyId: dc?.policy?.id ?? null,
      assessedAt: dc?.at ?? null,
      latest,
      notice: 'Driver criteria are generic UK hire-insurer norms unless the fleet policy has its own. Check them against your policy wording.',
    };
  });

  app.post('/claims/:id/eligibility/assess', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(z.object({ acceptance: z.boolean().nullish() }).strict(), request.body ?? {});
    if (body.acceptance) {
      const bundle = loadBundle(ctx, id);
      recordAcceptance(ctx, id, acceptanceFor(ctx, bundle, gatesFor(bundle)) as unknown as { decision: string } & Record<string, unknown>, request.actor.userId);
    }
    const { summary, written } = recordEligibility(ctx, id, request.actor.userId);
    if (written.length) queueClashCheck(ctx, { kind: 'claim', claimId: id }, request.actor.userId);
    return { claimId: id, summary, written };
  });
}
