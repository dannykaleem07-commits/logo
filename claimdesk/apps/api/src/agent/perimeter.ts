/**
 * Perimeter guard (docs/SUPREME-DESIGN.md §B.2) — a `preHandler` that runs only for agent principals. The server
 * enforces; prompts only explain. Refusals are `403 AGENT_FORBIDDEN` with `details.rule`, audited as
 * `agent.tool.denied`, and reach the model as a tool error it can explain.
 *
 * Rules (the most specific is reported first):
 *  - `manager_mode`      any x-manager-override / x-manager-relaxed header (rule 2);
 *  - `destructive`       any DELETE (rule 6);
 *  - `human_only`        document approve / sign, estimate & PAV approve, engineer-report issue, directory verify (rule 5);
 *  - `money_settlement`  offer decision / reply fields, ledger kinds other than claimed / invoiced / offered or a
 *                        supersedesId, status → settled | closed | declined | pre_action | litigation (rule 4);
 *  - `claim_scope`       a run scoped to one claim naming another claim in params, query or body (rule 3);
 *  - `route_allowlist`   anything not declared by a registered tool, except /api/mcp (rule 1).
 *
 * Autopilot additions (docs/SUPREME-AUTOPILOT.md §H.5): more human-only routes (handover, return, mark-signed, pack
 * approval/sending/kiosk, accepted-by-phone, clash acknowledge/resolve, driver profiles, policy criteria, autopilot
 * pause/resume and step overrides, hire paperwork); `/api/kiosk/*` refuses every run token outright; claim scope
 * resolves the claim of `/api/bookings/:id`, `/api/hire-offers/:id`, `/api/packs/:id`, `/api/movements/:id` and
 * `/api/clashes/:id`; fleet-wide routes (`/fleet/availability`, `/fleet/calendar`) need the run's own claimId.
 */
import type { FastifyRequest } from 'fastify';
import { MANAGER_OVERRIDE_HEADER, MANAGER_RELAXED_HEADER } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { agentRouteAllowlist, MCP_ROUTE_PATTERNS } from './tools/index.js';

export type PerimeterRule = 'route_allowlist' | 'manager_mode' | 'claim_scope' | 'money_settlement' | 'human_only' | 'destructive';

export const FORBIDDEN_LEDGER_KINDS: ReadonlySet<string> = new Set(['reduced', 'written_off', 'adjustment', 'paid', 'interim_paid']);
export const FORBIDDEN_STATUSES: ReadonlySet<string> = new Set(['settled', 'closed', 'declined', 'pre_action', 'litigation']);

/** Human-only routes (rule 5), as `METHOD /api/pattern` (sign/* matched by prefix). */
export const HUMAN_ONLY_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/documents/:id/approve',
  'POST /api/documents/:id/sign/start',
  'POST /api/documents/:id/sign/verify',
  'POST /api/claims/:id/estimate/:eid/approve',
  'POST /api/claims/:id/pav/:pid/approve',
  'POST /api/claims/:id/engineer-report/:rid/issue',
  'PATCH /api/directory/:id/verify',
  // Autopilot (SUPREME-AUTOPILOT §H.5)
  'POST /api/bookings/:id/handover',
  'POST /api/bookings/:id/return',
  'POST /api/documents/:id/mark-signed',
  'POST /api/packs/:id/approve',
  'POST /api/packs/:id/send-for-signature',
  'POST /api/packs/:id/kiosk',
  'POST /api/hire-offers/:id/accept',
  'POST /api/clashes/:id/acknowledge',
  'POST /api/clashes/:id/resolve',
  'PUT /api/parties/:id/driver-profile',
  'PUT /api/fleet/policies/:id/criteria',
  'POST /api/claims/:id/autopilot/pause',
  'POST /api/claims/:id/autopilot/resume',
  'POST /api/claims/:id/autopilot/steps/:stepId/:action',
  'PATCH /api/claims/:id/hire/:hireId/paperwork',
  'PATCH /api/settings/autopilot',
]);

/** Token-authenticated kiosk routes (§E.2): never reachable with a run token. */
export const KIOSK_ROUTE_PREFIX = '/api/kiosk/';

/** Fleet-wide routes a claim-scoped run may call only for its own claim (§H.5). */
export const CLAIM_BOUND_FLEET_ROUTES: ReadonlySet<string> = new Set(['/api/fleet/availability', '/api/fleet/calendar']);

/** Routes naming an Autopilot record by id: the table and column holding its claim (§H.5 claim scope). */
const RECORD_CLAIM_LOOKUP: ReadonlyArray<{ prefix: string; table: string }> = [
  { prefix: '/api/bookings/:id', table: 'fleet_reservations' },
  { prefix: '/api/hire-offers/:id', table: 'hire_offers' },
  { prefix: '/api/packs/:id', table: 'document_packs' },
  { prefix: '/api/movements/:id', table: 'fleet_movements' },
  { prefix: '/api/clashes/:id', table: 'clash_findings' },
];

export interface PerimeterVerdict {
  rule: PerimeterRule;
  message: string;
}

const present = (v: unknown): boolean => v !== undefined && v !== null;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Body keys that carry bank or payment details. */
const BANK_KEY = /bank|sort_?code|account_?number|iban|payee/i;

function claimsReferencingParty(ctx: AppContext, partyId: string): string[] {
  const rows = ctx.handle.sqlite
    .prepare(
      `SELECT id FROM claims WHERE claimant_id = @p OR driver_id = @p OR at_fault_insurer_id = @p OR client_insurer_id = @p
         OR EXISTS (SELECT 1 FROM json_each(claims.third_party_ids) WHERE json_each.value = @p)`,
    )
    .all({ p: partyId }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function claimsReferencingVehicle(ctx: AppContext, vehicleId: string): string[] {
  return (ctx.handle.sqlite.prepare('SELECT id FROM claims WHERE client_vehicle_id = ? OR third_party_vehicle_id = ?').all(vehicleId, vehicleId) as Array<{ id: string }>).map((r) => r.id);
}

/** The claim ids a request names (params, query, body), with where each came from. */
function namedClaimIds(ctx: AppContext, route: string, request: FastifyRequest): Array<{ where: string; id: string }> {
  const out: Array<{ where: string; id: string }> = [];
  const params = obj(request.params);
  const query = obj(request.query);
  const body = obj(request.body);
  if (route.startsWith('/api/claims/:id') && typeof params.id === 'string') out.push({ where: 'params.id', id: params.id });
  if (typeof params.claimId === 'string') out.push({ where: 'params.claimId', id: params.claimId });
  if (typeof query.claimId === 'string') out.push({ where: 'query.claimId', id: query.claimId });
  if (typeof body.claimId === 'string') out.push({ where: 'body.claimId', id: body.claimId });
  // Document routes name a document: its claim must be the run's claim too.
  if (route.startsWith('/api/documents/:id') && typeof params.id === 'string') {
    const doc = ctx.repos.getDocument(ctx.db, params.id, { includeHtml: false });
    if (doc?.claimId) out.push({ where: 'document.claimId', id: doc.claimId });
  }
  // Autopilot records (bookings, hire offers, packs, movements, clash findings) carry their claim.
  if (typeof params.id === 'string') {
    const lookup = RECORD_CLAIM_LOOKUP.find((l) => route === l.prefix || route.startsWith(`${l.prefix}/`));
    if (lookup) {
      const row = ctx.handle.sqlite.prepare(`SELECT claim_id AS claimId FROM ${lookup.table} WHERE id = ?`).get(params.id) as { claimId: string | null } | undefined;
      if (row?.claimId) out.push({ where: `${lookup.table}.claim_id`, id: row.claimId });
    }
  }
  return out;
}

/** Decide whether an agent request may proceed (undefined = allowed). Pure apart from the document, party and vehicle lookups. */
export function perimeterVerdict(ctx: AppContext, request: FastifyRequest, allowlist: ReadonlySet<string> = agentRouteAllowlist()): PerimeterVerdict | undefined {
  const method = request.method.toUpperCase();
  const route = request.routeOptions.url ?? '';
  const key = `${method} ${route}`;
  const body = obj(request.body);

  // Rule 2: no manager mode.
  if (request.headers[MANAGER_OVERRIDE_HEADER] !== undefined || request.headers[MANAGER_RELAXED_HEADER] !== undefined) {
    return { rule: 'manager_mode', message: 'Agents never use manager mode (override headers are refused)' };
  }
  // Rule 6: nothing destructive.
  if (method === 'DELETE' && !MCP_ROUTE_PATTERNS.includes(route)) return { rule: 'destructive', message: 'Agents cannot delete anything' };
  // Rule 5: human-only steps (the kiosk is the client's and the handler's, never an agent's).
  if (route.startsWith(KIOSK_ROUTE_PREFIX)) return { rule: 'human_only', message: 'The signing kiosk is never available to agents' };
  if (HUMAN_ONLY_ROUTES.has(key) || (method === 'POST' && route.startsWith('/api/documents/:id/sign/'))) {
    return { rule: 'human_only', message: `${key} is a human-only step` };
  }
  // Rule 4: money and settlement.
  if (method === 'PATCH' && route === '/api/claims/:id/offers/:oid' && (present(body.clientDecision) || present(body.replySentAt))) {
    return { rule: 'money_settlement', message: 'Offer decisions and replies are recorded by the owner only' };
  }
  if (method === 'PATCH' && route === '/api/claims/:id/settlement-offers/:oid' && (present(body.status) || present(body.decisionNote) || present(body.decidedAt))) {
    return { rule: 'money_settlement', message: 'Settlement offer decisions are recorded by the owner only' };
  }
  if (method === 'POST' && route === '/api/claims/:id/ledger' && ((typeof body.kind === 'string' && FORBIDDEN_LEDGER_KINDS.has(body.kind)) || present(body.supersedesId))) {
    return { rule: 'money_settlement', message: `Agents cannot write ledger entries of kind ${String(body.kind)}${present(body.supersedesId) ? ' or supersede entries' : ''} — propose them to the owner` };
  }
  if ((route === '/api/claims/:id/status' || route === '/api/claims/:id') && typeof body.status === 'string' && FORBIDDEN_STATUSES.has(body.status)) {
    return { rule: 'money_settlement', message: `Agents cannot move a claim to ${body.status}` };
  }
  // Bank or payment details on a party are the owner's to change (payment diversion risk).
  if ((method === 'PATCH' || method === 'POST' || method === 'PUT') && (route === '/api/parties' || route === '/api/parties/:id') && Object.keys(body).some((k) => BANK_KEY.test(k))) {
    return { rule: 'money_settlement', message: 'Agents cannot write bank or payment details — the owner checks and records them' };
  }
  // Rule 3: claim scope.
  const scope = request.agent?.claimScope;
  if (scope) {
    const named = namedClaimIds(ctx, route, request);
    const other = named.find((c) => c.id !== scope);
    if (other) return { rule: 'claim_scope', message: `This run is limited to claim ${scope}; ${other.where} names another claim` };
    if (CLAIM_BOUND_FLEET_ROUTES.has(route) && !named.some((c) => c.id === scope)) {
      return { rule: 'claim_scope', message: `This run is limited to claim ${scope}; ${route} must name that claim (claimId)` };
    }
    // A party or vehicle written by a claim-scoped run must belong to that claim.
    const params = obj(request.params);
    if (method !== 'GET' && (route === '/api/parties/:id' || route === '/api/vehicles/:id') && typeof params.id === 'string') {
      const claims = route === '/api/parties/:id' ? claimsReferencingParty(ctx, params.id) : claimsReferencingVehicle(ctx, params.id);
      if (!claims.includes(scope)) return { rule: 'claim_scope', message: `This run is limited to claim ${scope}; that ${route === '/api/parties/:id' ? 'party' : 'vehicle'} is not on it` };
    }
  }
  // Rule 1: the route allow-list.
  if (!route || !allowlist.has(key)) return { rule: 'route_allowlist', message: `${method} ${route || request.url} is not available to agents` };
  return undefined;
}

/** The preHandler: refuse (audited) or let the request through. Non-agent requests are untouched. */
export function agentPerimeter(ctx: AppContext): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    if (!request.agent) return;
    const verdict = perimeterVerdict(ctx, request);
    if (!verdict) return;
    const route = request.routeOptions.url ?? null;
    try {
      ctx.repos.appendAudit(ctx.db, {
        actor: request.actor,
        action: 'agent.tool.denied',
        entity: 'agent_runs',
        entityId: request.agent.runId,
        after: { rule: verdict.rule, message: verdict.message, method: request.method, route, url: request.url, agent: request.agent.name, jobId: request.agent.jobId, claimScope: request.agent.claimScope ?? null, requestId: request.requestId },
        at: ctx.now(),
      });
    } catch (err) {
      ctx.logger.error('could not audit an agent refusal', { error: String(err) });
    }
    throw new HttpError(403, 'AGENT_FORBIDDEN', verdict.message, { rule: verdict.rule });
  };
}
