// owned by gateway
/**
 * Gateway tools (docs/SUPREME-DESIGN.md §B.4): the read tools over the existing routes, the draft tools for letters and
 * CCGUK Word templates, and the internal / lookup tools the gateway owns. Every tool goes through the dispatcher
 * (§B.3): input validated with its `zod/v4` schema, claim scope, `decide()`, then the existing HTTP route as the agent
 * principal (so validation, refusals, audit rows and clock recomputes all apply) — or an in-process read where noted.
 *
 * Inputs are strict: optional values are nullable-and-required; free-form maps are `{key, value}` pair lists (strict
 * schemas cannot hold open objects). Outputs are trimmed to the model-relevant fields, never HTML, PII-masked where
 * §K.3 says so, and cut at 20,000 characters by the dispatcher.
 *
 * `maskPii` is a minimal local masker (§K.3); the casework slice's `casework/mask.ts` supersedes it later.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod/v4';
import { listTemplates } from '@ccguk/documents';
import { ADVICE_TOPICS } from '@ccguk/kb';
import { gtaRate, type ActionDescriptor, type ClaimStatus, type Decision, type EvidenceKind, type HeadOfLoss, type PartyRole } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { NeedsYouInput, RunContext, ToolDef } from '../contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../contracts.js';
import { enqueueJob, createNeedsYou } from '../core.js';
import { agentUserId } from '../principal.js';
import { toolInputSchema } from '../../ai/strictSchema.js';
import { loadBundle } from '../../services/claimView.js';
import { hashFile, readEvidenceVerified } from '../../services/evidence.js';
import { listTemplateSummaries } from '../../services/docxTemplates.js';
import { listClaimsResponse } from '../../services/claimList.js';
import { assessTotalLoss } from '../../services/engineeringFallbacks.js';
import { gtaRatesFor } from '../../services/kb.js';

// ---------------------------------------------------------------------------
// PII masking (§K.3) — minimal local version
// ---------------------------------------------------------------------------

const lastN = (s: string, n: number): string => {
  const clean = s.replace(/\s+/g, '');
  return clean.length <= n ? '•'.repeat(clean.length) : `…${clean.slice(-n)}`;
};

/** j•••@example.test */
export function maskEmail(s: string): string {
  const at = s.indexOf('@');
  if (at <= 0) return '•••';
  return `${s[0]}•••${s.slice(at)}`;
}

/** 07••• •••123 */
export function maskPhone(s: string): string {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6) return '•••';
  return `${digits.slice(0, 2)}••• •••${digits.slice(-3)}`;
}

/** Postcode district (outward code): "E1 6AN" → "E1". */
export function postcodeDistrict(pc: string): string {
  const t = pc.trim().toUpperCase();
  const m = /^([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}$/.exec(t);
  return m ? m[1]! : t.split(/\s+/)[0] ?? '';
}

const KEY_RULES: Array<{ test: RegExp; mask: (v: string) => string }> = [
  { test: /^(dateOfBirth|dob|birthDate)$/i, mask: (v) => (/^\d{4}/.test(v) ? v.slice(0, 4) : '••••') },
  { test: /(drivingLicenceNumber|licenceNumber|licenseNumber|niNumber|nationalInsurance\w*|passport\w*)$/i, mask: (v) => lastN(v, 3) },
  { test: /^(accountNumber|bankAccount\w*|iban)$/i, mask: (v) => lastN(v, 4) },
  { test: /^sortCode$/i, mask: () => '••-••-••' },
  { test: /policyNumber$/i, mask: (v) => lastN(v, 4) },
  { test: /^(phone|mobile|telephone|tel|phoneNumber)$/i, mask: maskPhone },
  { test: /^(email|emailAddress)$/i, mask: maskEmail },
];

/**
 * Mask personal data in any JSON value (§K.3): DOB → year, licence/NI/passport → last 3, bank account → last 4, sort
 * code masked, policy numbers → last 4, phone/email partially masked, addresses → town + postcode district. Names are
 * kept. The `licence: { number }` shape is masked too.
 */
export function maskPii(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => maskPii(v, key));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (key && /address$/i.test(key) && ('postcode' in o || 'line1' in o || 'town' in o)) {
      return { town: typeof o.town === 'string' ? o.town : null, postcodeDistrict: typeof o.postcode === 'string' ? postcodeDistrict(o.postcode) : null };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if ((key === 'licence' || key === 'drivingLicence') && k === 'number' && typeof v === 'string') out[k] = lastN(v, 3);
      else out[k] = maskPii(v, k);
    }
    return out;
  }
  if (typeof value === 'string' && key) {
    const rule = KEY_RULES.find((r) => r.test.test(key));
    if (rule) return rule.mask(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyTool = ToolDef<any, any> & {
  // Gateway extensions understood by the dispatcher (see dispatcher.ts GatewayToolExtras).
  shapeWith?: (raw: unknown, input: any, rc: RunContext) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  afterHttp?: (input: any, body: unknown, rc: RunContext, ctx: AppContext) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>; // eslint-disable-line @typescript-eslint/no-explicit-any
  dailyLimit?: number;
};

const CLAIM_STATUSES = ['fnol', 'triage', 'declined', 'accepted', 'hire_active', 'repair', 'total_loss', 'payment_pack', 'chasing', 'disputed', 'complaint', 'pre_action', 'litigation', 'settled', 'closed'] as const satisfies readonly ClaimStatus[];
const PARTY_ROLES = ['claimant', 'driver', 'keeper', 'third_party', 'third_party_driver', 'witness', 'insurer', 'broker', 'engineer', 'repairer', 'recovery_agent', 'storage_yard', 'solicitor', 'supplier', 'salvage_buyer', 'council', 'police', 'other'] as const satisfies readonly PartyRole[];
const EVIDENCE_KINDS = ['photo', 'video', 'audio', 'document', 'pdf', 'screenshot', 'advert', 'bank_statement', 'payslip', 'licence', 'v5c', 'mot_certificate', 'insurance_certificate', 'estimate', 'invoice', 'engineer_report', 'correspondence', 'call_recording', 'cctv', 'dashcam', 'witness_statement', 'other'] as const satisfies readonly EvidenceKind[];
const HEADS = ['hire', 'recovery', 'storage', 'engineer_fee', 'pav', 'repair', 'salvage', 'excess', 'loss_of_use', 'diminution', 'personal_effects', 'loss_of_earnings', 'travel', 'misc'] as const satisfies readonly HeadOfLoss[];
const DOCUMENT_STATUSES = ['draft', 'blocked', 'approved', 'sent', 'signed', 'superseded', 'void'] as const;
const OFFER_CHANNELS = ['phone', 'email', 'letter', 'sms', 'whatsapp', 'portal', 'via_client'] as const;

/** Event types an agent may append (§B.4). */
export const AGENT_EVENT_TYPES = ['note', 'call', 'letter_in', 'email_in', 'handling_ref_received', 'inspection', 'estimate_received', 'repair_started', 'repair_completed', 'vehicle_returned', 'repair_delay'] as const;

const id = () => z.string().min(1).max(128);
const claimIdField = () => id().describe('ClaimDesk claim id');
const pairs = () =>
  z
    .array(z.strictObject({ key: z.string().min(1).max(128), value: z.string().max(20_000) }))
    .max(200)
    .nullable();
const toRecord = (p: Array<{ key: string; value: string }> | null | undefined): Record<string, string> | undefined => (p?.length ? Object.fromEntries(p.map((x) => [x.key, x.value])) : undefined);

function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const value = Array.isArray(v) ? v.join(',') : String(v);
    if (value) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}
const enc = encodeURIComponent;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Plain text from HTML (no markup ever reaches the model). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|table|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&pound;/g, '£')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const readDescribe =
  (kind: string) =>
  (i: { claimId?: string | null }, rc: RunContext): ActionDescriptor => ({ class: 'read', kind: `read.${kind}`, ...((i.claimId ?? rc.claimScope) ? { claimId: (i.claimId ?? rc.claimScope)! } : {}), confidence: 1 });

/** A Needs-you item for an internal action the policy wants the owner to confirm. */
function askOwner(tool: string, title: (input: Record<string, unknown>) => string) {
  return (input: Record<string, unknown>, rc: RunContext, _ctx: AppContext, d: Decision): NeedsYouInput => ({
    kind: 'question',
    ...(typeof input.claimId === 'string' ? { claimId: input.claimId } : rc.claimScope ? { claimId: rc.claimScope } : {}),
    title: title(input),
    summary: `The ${rc.agent} agent wants to ${tool.replace(/_/g, ' ')}; the autonomy policy asks you first (${d.reasons.join('; ') || d.ruleIds.join(', ')}).`,
    payload: { tool, input: maskPii(input), decision: { outcome: d.outcome, ruleIds: d.ruleIds, reasons: d.reasons }, runId: rc.runId },
    priority: 'normal',
    createdBy: agentUserId(rc.agent),
    correlationId: rc.correlationId,
    dedupeKey: `ask:${rc.runId}:${tool}:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)}`,
  });
}

/** Build a tool; `strictSchema` is derived from the zod/v4 input (§B.5). */
function tool<S extends z.ZodType>(def: Omit<AnyTool, 'input' | 'strictSchema' | 'maxOutputChars'> & { input: S; maxOutputChars?: number }): AnyTool {
  return { ...def, strictSchema: toolInputSchema(def.input), maxOutputChars: def.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS } as AnyTool;
}

/** A read tool over a GET route on one claim. */
function claimRead(name: string, title: string, description: string, suffix: string, shape?: (raw: unknown) => unknown): AnyTool {
  return tool({
    name,
    title,
    description,
    class: 'read',
    input: z.strictObject({ claimId: claimIdField() }),
    http: (i: { claimId: string }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}${suffix}` }),
    httpRoute: { method: 'GET', pattern: `/claims/:id${suffix}` },
    describe: readDescribe(name),
    ...(shape ? { shape } : {}),
  });
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const shapeClaimListItem = (c: Record<string, unknown>) => ({
  id: c.id,
  reference: c.reference,
  status: c.status,
  client: c.claimantName ?? null,
  registration: c.registration ?? null,
  insurer: c.insurerName ?? null,
  flags: c.openFlags ?? 0,
  outstandingPence: c.outstandingPence ?? null,
  nextDue: c.oldestOverdueClock ? pick(obj(c.oldestOverdueClock), ['label', 'dueAt', 'status', 'daysOverdue']) : null,
});

function shapeParty(p: unknown): Record<string, unknown> {
  const o = obj(p);
  return maskPii(pick(o, ['id', 'kind', 'name', 'roles', 'dateOfBirth', 'address', 'email', 'phone', 'companyNumber', 'vatRegistered', 'licence'])) as Record<string, unknown>;
}

function shapeVehicle(v: unknown): Record<string, unknown> {
  const o = obj(v);
  return pick(o, ['id', 'registration', 'make', 'model', 'variant', 'yearOfManufacture', 'fuelType', 'transmission', 'colour', 'ownership', 'gtaGroup', 'vin', 'firstRegistered', 'previousWriteOffCategory']);
}

function shapeClaimView(raw: unknown): unknown {
  const v = obj(raw);
  const claim = obj(v.claim);
  const accident = obj(claim.accident);
  return {
    claim: {
      ...pick(claim, ['id', 'reference', 'status', 'openedAt', 'liability', 'atFaultInsurerRef', 'gtaSubscriber', 'linkedClaimIds']),
      accident: { ...pick(accident, ['occurredAt', 'circumstances', 'policeAttended', 'cctvAvailable', 'dashcamAvailable', 'independentWitness', 'injuries', 'driveable']), town: accident.location ?? null, postcodeDistrict: typeof accident.postcode === 'string' ? postcodeDistrict(accident.postcode) : null },
    },
    claimant: v.claimant ? shapeParty(v.claimant) : null,
    driver: v.driver ? shapeParty(v.driver) : null,
    thirdParties: arr(v.thirdParties).map(shapeParty),
    atFaultInsurer: v.atFaultInsurer ? shapeParty(v.atFaultInsurer) : null,
    vehicle: v.vehicle ? shapeVehicle(v.vehicle) : null,
    thirdPartyVehicle: v.thirdPartyVehicle ? shapeVehicle(v.thirdPartyVehicle) : null,
    flags: arr(v.flags).map((f) => pick(f, ['code', 'severity', 'message', 'clearedAt'])),
    position: v.position ?? null,
    counts: { events: arr(v.events).length, documents: arr(v.documents).length, evidence: arr(v.evidence).length, offers: arr(v.offers).length, hire: arr(v.hire).length },
    hint: 'Use events_list, ledger_get, offers_list, hire_get, claim_clocks, claim_gates and documents_list for detail.',
  };
}

const shapeClock = (c: Record<string, unknown>) => pick(c, ['id', 'kind', 'label', 'basis', 'startsAt', 'dueAt', 'status', 'metAt', 'attributableTo']);
const shapeEvent = (e: Record<string, unknown>) => pick(e, ['id', 'type', 'at', 'summary', 'attributableTo', 'evidenceIds', 'documentId', 'createdBy']);
const shapeDocument = (d: Record<string, unknown>) => ({
  ...pick(d, ['id', 'claimId', 'templateId', 'templateVersion', 'title', 'recipientPartyId', 'status', 'sha256', 'createdAt', 'approvedAt', 'sentAt', 'sentVia', 'format']),
  consistency: d.consistency ? { blocked: obj(d.consistency).blocked ?? false, flags: arr(obj(d.consistency).flags).map((f) => pick(f, ['code', 'severity', 'message', 'cleared'])) } : null,
});

function kbVisible(e: Record<string, unknown>): boolean {
  return obj(e.verification).status !== 'failed';
}
function shapeKbEntry(e: Record<string, unknown>): Record<string, unknown> {
  const status = String(obj(e.verification).status ?? 'unverified');
  return { ...pick(e, ['id', 'type', 'citation', 'title', 'principle', 'topics', 'score']), verification: status, ...(status !== 'verified' ? { label: 'UNVERIFIED — say so if you rely on it' } : {}) };
}

function shapeDirectory(e: Record<string, unknown>): Record<string, unknown> {
  const ver = obj(e.verification);
  const verifiedAt = typeof ver.verifiedAt === 'string' ? ver.verifiedAt : null;
  return {
    ...pick(e, ['id', 'name', 'brands', 'group', 'claimsContact', 'postalAddress', 'directoryStatus', 'copycatDomains', 'copycatNumbers']),
    verification: { status: ver.status ?? 'unverified', verifiedAt, sourceUrl: ver.sourceUrl ?? null },
    verificationAgeDays: verifiedAt ? Math.floor((Date.now() - Date.parse(verifiedAt)) / 86_400_000) : null,
    ...(e.override ? { override: e.override } : {}),
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const claimsSearch = tool({
  name: 'claims_search',
  title: 'Search claims',
  description: 'Find claims by reference, client name, registration or insurer reference, optionally by status or flags. Returns a short summary per claim. Never changes anything.',
  class: 'read',
  input: z.strictObject({
    q: z.string().max(200).nullable(),
    status: z.array(z.enum(CLAIM_STATUSES)).max(15).nullable(),
    flagged: z.boolean().nullable(),
    limit: z.int().min(1).max(50).nullable(),
    offset: z.int().min(0).nullable(),
  }),
  // In-process read with the same repository query and summary as GET /claims, so the agents' route allow-list never
  // needs the unscoped claim list; a claim-scoped run only ever sees its own claim.
  run: async (i: { q: string | null; status: ClaimStatus[] | null; flagged: boolean | null; limit: number | null; offset: number | null }, rc: RunContext, ctx: AppContext) => {
    const items = ctx.repos.listClaims(ctx.db, {
      ...(i.status?.length ? { status: i.status.length === 1 ? i.status[0]! : i.status } : {}),
      ...(i.q ? { search: i.q } : {}),
      ...(i.flagged ? { flagged: true } : {}),
      limit: i.limit ?? 20,
      offset: i.offset ?? 0,
    });
    const scoped = rc.claimScope ? items.filter((c) => c.id === rc.claimScope) : items;
    const res = listClaimsResponse(ctx, scoped, []) as unknown as { items: unknown[] };
    return { items: arr(res.items).map(shapeClaimListItem), total: scoped.length };
  },
  describe: readDescribe('claims_search'),
});

const claimGet = claimRead('claim_get', 'Get a claim', 'The claim summary: status, liability, accident, parties (personal data masked), vehicles, open flags and the money position. Use the narrower tools for events, ledger, offers, hire, clocks and documents.', '', shapeClaimView);
const claimNextActions = claimRead('claim_next_actions', 'Next actions (playbook)', 'The playbook engine’s next actions for the claim with reasons, basis, priority, due date and template. Computed by code — cite these, never invent deadlines.', '/actions');
const claimClocks = claimRead('claim_clocks', 'Claim clocks', 'Deadline clocks (GTA benchmark, chasers, replies) with due dates and status, computed by code.', '/clocks', (raw) => ({ clocks: arr(obj(raw).clocks).map(shapeClock) }));
const claimGates = claimRead('claim_gates', 'Claim gates', 'The evidence gates (need, use, period, rate, enforceability…) with what is present and what is missing.', '/gates');
const claimAcceptance = claimRead('claim_acceptance', 'Case acceptance', 'The case-acceptance assessment: liability score, costs exposure, readiness, conditions and reasons.', '/acceptance');
const ledgerGet = claimRead('ledger_get', 'Ledger', 'The money ledger (integer pence): entries, sums, position per head and total paid. Read-only: agents never write paid/reduced/written-off rows.', '/ledger', (raw) => {
  const r = obj(raw);
  return { ...r, entries: arr(r.entries).map((e) => pick(e, ['id', 'head', 'kind', 'amountPence', 'vatPence', 'date', 'description', 'supersedesId'])) };
});
const offersList = claimRead('offers_list', 'Offers register', 'Intervention / settlement offers recorded on the claim with the client decision and the reply clocks. Read-only: decisions are the owner’s.', '/offers');
const hireGet = claimRead('hire_get', 'Hire', 'Hire agreements on the claim (dates, group, daily rate in pence, charges).', '/hire');
const storageGet = claimRead('storage_get', 'Storage', 'Storage records with the computed charges.', '/storage');
const recoveryGet = claimRead('recovery_get', 'Recovery', 'Recovery records with the computed charges.', '/recovery');

const hirePricingGuide = tool({
  name: 'hire_pricing_guide',
  title: 'Hire pricing guide',
  description: 'The hire pricing guide for the claim (GTA benchmark rates are an industry benchmark only — CCGUK is not a GTA subscriber). fleetUnitId null = the unit on the latest hire.',
  class: 'read',
  input: z.strictObject({ claimId: claimIdField(), fleetUnitId: id().nullable() }),
  http: (i: { claimId: string; fleetUnitId: string | null }, _rc: RunContext, ctx?: AppContext) => {
    let unit = i.fleetUnitId;
    if (!unit && ctx) {
      const hire = ctx.repos.listHire(ctx.db, i.claimId).sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
      unit = hire?.fleetUnitId ?? null;
    }
    return { method: 'GET', url: `/claims/${enc(i.claimId)}/hire/pricing-guide${qs({ fleetUnitId: unit })}` };
  },
  httpRoute: { method: 'GET', pattern: '/claims/:id/hire/pricing-guide' },
  describe: readDescribe('hire_pricing_guide'),
});

const eventsList = tool({
  name: 'events_list',
  title: 'Claim events',
  description: 'The claim chronology (newest last), optionally by type and since a date; paginate with limit/offset.',
  class: 'read',
  input: z.strictObject({ claimId: claimIdField(), type: z.string().max(64).nullable(), since: z.string().max(40).nullable(), limit: z.int().min(1).max(200).nullable(), offset: z.int().min(0).nullable() }),
  http: (i: { claimId: string; type: string | null; since: string | null }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}/events${qs({ type: i.type, since: i.since })}` }),
  httpRoute: { method: 'GET', pattern: '/claims/:id/events' },
  describe: readDescribe('events_list'),
  shapeWith: (raw: unknown, i: { limit: number | null; offset: number | null }) => {
    const all = arr(obj(raw).events);
    const offset = i.offset ?? 0;
    const limit = i.limit ?? 50;
    return { events: all.slice(offset, offset + limit).map(shapeEvent), total: all.length, offset, limit };
  },
});

const partyGet = tool({
  name: 'party_get',
  title: 'Get a party',
  description: 'A person or company on file (personal data masked: DOB → year, contact details partly hidden, address → town and postcode district).',
  class: 'read',
  input: z.strictObject({ partyId: id() }),
  http: (i: { partyId: string }) => ({ method: 'GET', url: `/parties/${enc(i.partyId)}` }),
  httpRoute: { method: 'GET', pattern: '/parties/:id' },
  describe: readDescribe('party_get'),
  shape: shapeParty,
});

const partySearch = tool({
  name: 'party_search',
  title: 'Search parties',
  description: 'Search people and companies by name (masked).',
  class: 'read',
  input: z.strictObject({ q: z.string().min(1).max(200), role: z.enum(PARTY_ROLES).nullable() }),
  http: (i: { q: string; role: string | null }) => ({ method: 'GET', url: `/parties${qs({ q: i.q, role: i.role, limit: 20 })}` }),
  httpRoute: { method: 'GET', pattern: '/parties' },
  describe: readDescribe('party_search'),
  shape: (raw) => ({ items: arr(obj(raw).items).map(shapeParty), total: obj(raw).total ?? null }),
});

const vehicleGet = tool({
  name: 'vehicle_get',
  title: 'Get a vehicle',
  description: 'A vehicle on file (registration, make/model, year, fuel, ownership, GTA group).',
  class: 'read',
  input: z.strictObject({ vehicleId: id() }),
  http: (i: { vehicleId: string }) => ({ method: 'GET', url: `/vehicles/${enc(i.vehicleId)}` }),
  httpRoute: { method: 'GET', pattern: '/vehicles/:id' },
  describe: readDescribe('vehicle_get'),
  shape: shapeVehicle,
});

const vehicleOnFile = tool({
  name: 'vehicle_on_file',
  title: 'Vehicle on file?',
  description: 'Is a registration already on file (and on which claims)?',
  class: 'read',
  input: z.strictObject({ registration: z.string().min(1).max(12) }),
  http: (i: { registration: string }) => ({ method: 'GET', url: `/vehicles/on-file${qs({ registration: i.registration })}` }),
  httpRoute: { method: 'GET', pattern: '/vehicles/on-file' },
  describe: readDescribe('vehicle_on_file'),
});

const evidenceList = tool({
  name: 'evidence_list',
  title: 'Evidence list',
  description: 'Evidence metadata on the claim (kind, filename, type, size, sha256, capture time). Use evidence_read to read one file.',
  class: 'read',
  input: z.strictObject({ claimId: claimIdField(), kind: z.enum(EVIDENCE_KINDS).nullable() }),
  http: (i: { claimId: string }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}/evidence` }),
  httpRoute: { method: 'GET', pattern: '/claims/:id/evidence' },
  describe: readDescribe('evidence_list'),
  shapeWith: (raw: unknown, i: { kind: string | null }) => ({
    items: arr(obj(raw).items)
      .filter((e) => !i.kind || e.kind === i.kind)
      .map((e) => pick(e, ['id', 'kind', 'filename', 'mime', 'bytes', 'sha256', 'capturedAt', 'uploadedAt', 'captureShot', 'description'])),
  }),
});

const evidenceRead = tool({
  name: 'evidence_read',
  title: 'Read an evidence file',
  description: 'Makes a verified copy of one evidence file for you to read: returns its path under the run folder (read it with the Read tool), type, size and sha256. Refused when the file is tampered with or not on this run’s claim.',
  class: 'read',
  input: z.strictObject({ evidenceId: id() }),
  describe: (_i: unknown, rc: RunContext) => ({ class: 'read', kind: 'read.evidence_read', ...(rc.claimScope ? { claimId: rc.claimScope } : {}), confidence: 1 }),
  run: async (i: { evidenceId: string }, rc: RunContext, ctx: AppContext) => {
    const ev = ctx.repos.getEvidence(ctx.db, i.evidenceId);
    if (!ev) throw Object.assign(new Error(`Evidence ${i.evidenceId} not found`), { code: 'NOT_FOUND' });
    if (rc.claimScope && ev.claimId !== rc.claimScope) throw Object.assign(new Error('That evidence is not on this run’s claim'), { code: 'CLAIM_SCOPE' });
    const verified = await readEvidenceVerified(ctx, ev);
    if (!verified) throw Object.assign(new Error('The evidence file is missing from the store'), { code: 'EVIDENCE_MISSING' });
    if (!verified.intact) throw Object.assign(new Error('The evidence file failed its integrity check (tampered); it was not copied'), { code: 'EVIDENCE_TAMPERED' });
    const inputDir = path.join(rc.runDir, 'input');
    mkdirSync(inputDir, { recursive: true });
    const safe = ev.filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';
    const target = path.join(inputDir, `${ev.id.slice(0, 8)}-${safe}`);
    copyFileSync(verified.absolutePath, target);
    // The copy is hashed as a stream; only files small enough to hand the model inline are ever read into memory.
    const sha = await hashFile(target);
    if (sha !== ev.sha256.toLowerCase()) throw Object.assign(new Error('The copy did not match the recorded hash'), { code: 'EVIDENCE_TAMPERED' });
    const out: Record<string, unknown> = { evidenceId: ev.id, path: path.relative(rc.runDir, target).split(path.sep).join('/'), absolutePath: target, mime: ev.mime, bytes: ev.bytes, sha256: ev.sha256, filename: ev.filename };
    const blocks: unknown[] = [];
    if (ev.bytes > EVIDENCE_READ_INLINE_MAX_BYTES) {
      out.note = `This file is ${Math.round(ev.bytes / 1048576)} MB — too large to give you inline; only its path and details are returned.`;
      Object.defineProperty(out, Symbol.for('claimdesk.tool.blocks'), { value: blocks, enumerable: false });
      return out;
    }
    const bytes = ev.mime.startsWith('text/') ? await readHead(target, 64 * 1024) : await readFile(target);
    if (ev.mime === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') }, title: ev.filename });
    else if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(ev.mime)) blocks.push({ type: 'image', source: { type: 'base64', media_type: ev.mime, data: bytes.toString('base64') } });
    else if (ev.mime.startsWith('text/')) out.text = bytes.toString('utf8').slice(0, 15_000);
    Object.defineProperty(out, Symbol.for('claimdesk.tool.blocks'), { value: blocks, enumerable: false });
    return out;
  },
});

/** Above this size evidence_read returns the path and details only (no base64 blocks): the model image/PDF limits. */
export const EVIDENCE_READ_INLINE_MAX_BYTES = 20 * 1024 * 1024;

async function readHead(file: string, max: number): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const documentsList = tool({
  name: 'documents_list',
  title: 'Documents on the claim',
  description: 'Generated documents on the claim: template, status, consistency flags, sha256, sent date.',
  class: 'read',
  input: z.strictObject({ claimId: claimIdField(), status: z.enum(DOCUMENT_STATUSES).nullable() }),
  http: (i: { claimId: string; status: string | null }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}/documents${qs({ status: i.status })}` }),
  httpRoute: { method: 'GET', pattern: '/claims/:id/documents' },
  describe: readDescribe('documents_list'),
  shape: (raw) => ({ items: arr(obj(raw).items).map(shapeDocument) }),
});

const documentGet = tool({
  name: 'document_get',
  title: 'Get a document',
  description: 'One generated document: status, consistency flags, sha256, sent date and a plain-text excerpt of its body (never HTML).',
  class: 'read',
  input: z.strictObject({ documentId: id() }),
  http: (i: { documentId: string }) => ({ method: 'GET', url: `/documents/${enc(i.documentId)}${qs({ html: 'true' })}` }),
  httpRoute: { method: 'GET', pattern: '/documents/:id' },
  describe: (_i: unknown, rc: RunContext) => ({ class: 'read', kind: 'read.document_get', ...(rc.claimScope ? { claimId: rc.claimScope } : {}), confidence: 1 }),
  shape: (raw) => {
    const d = obj(raw);
    const text = typeof d.html === 'string' ? htmlToText(d.html) : '';
    return { ...shapeDocument(d), bodyExcerpt: text.slice(0, 12_000), bodyTruncated: text.length > 12_000 };
  },
});

const templatesList = tool({
  name: 'templates_list',
  title: 'Templates',
  description: 'Letter templates (html) and CCGUK Word templates (docx) with their ids, titles and recipients. format null = both.',
  class: 'read',
  input: z.strictObject({ format: z.enum(['html', 'docx']).nullable() }),
  describe: readDescribe('templates_list'),
  run: async (i: { format: 'html' | 'docx' | null }, _rc: RunContext, ctx: AppContext) => {
    const html = i.format === 'docx' ? [] : listTemplates().map((t) => ({ id: t.id, format: 'html', kind: t.kind, title: t.title, recipientRole: t.recipientRole ?? null, description: t.description ?? null }));
    const docx = i.format === 'html' ? [] : listTemplateSummaries(ctx, false).map((t) => ({ id: t.id, format: 'docx', kind: t.kind, title: t.title, recipientRole: (t as { recipientRole?: string }).recipientRole ?? null, warnings: (t.warnings ?? []).map((w) => w.code) }));
    return { items: [...html, ...docx] };
  },
});

const docxTemplateValues = tool({
  name: 'docx_template_values',
  title: 'Word template values',
  description: 'The values ClaimDesk would put in each slot of a CCGUK Word template for this claim, with source and confidence.',
  class: 'read',
  input: z.strictObject({ claimId: claimIdField(), templateId: z.string().min(1).max(128), variant: z.string().max(64).nullable() }),
  http: (i: { claimId: string; templateId: string; variant: string | null }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}/docx-templates/${enc(i.templateId)}/values${qs({ variant: i.variant })}` }),
  httpRoute: { method: 'GET', pattern: '/claims/:id/docx-templates/:templateId/values' },
  describe: readDescribe('docx_template_values'),
  shape: (raw) => {
    const r = obj(raw);
    const t = obj(r.template);
    return { ...r, template: pick(t, ['id', 'title', 'kind', 'slotCount', 'mappedCount', 'warnings']) };
  },
});

const kbSearch = tool({
  name: 'kb_search',
  title: 'Search the knowledge base',
  description: 'Search the legal/GTA/FOS knowledge base. Entries that failed verification are excluded; unverified entries are labelled — say so when you rely on one. Cite entries by id.',
  class: 'read',
  input: z.strictObject({ q: z.string().min(1).max(300), type: z.string().max(40).nullable(), topic: z.string().max(60).nullable(), limit: z.int().min(1).max(20).nullable() }),
  http: (i: { q: string; type: string | null; topic: string | null; limit: number | null }) => ({ method: 'GET', url: `/kb/search${qs({ q: i.q, type: i.type, topic: i.topic, limit: i.limit ?? 8 })}` }),
  httpRoute: { method: 'GET', pattern: '/kb/search' },
  describe: readDescribe('kb_search'),
  shape: (raw) => ({ items: arr(obj(raw).items).filter(kbVisible).map(shapeKbEntry) }),
});

const kbEntry = tool({
  name: 'kb_entry',
  title: 'Knowledge-base entry',
  description: 'One knowledge-base entry by id, with its verification status (failed entries are refused).',
  class: 'read',
  input: z.strictObject({ id: z.string().min(1).max(128) }),
  http: (i: { id: string }) => ({ method: 'GET', url: `/kb/entries/${enc(i.id)}` }),
  httpRoute: { method: 'GET', pattern: '/kb/entries/:id' },
  describe: readDescribe('kb_entry'),
  shape: (raw) => {
    const e = obj(raw);
    if (!kbVisible(e)) return { id: e.id, excluded: true, reason: 'This entry failed verification and must not be cited.' };
    return { ...shapeKbEntry(e), ...pick(e, ['tags', 'appliesTo', 'notes']) };
  },
});

const kbAdvise = tool({
  name: 'kb_advise',
  title: 'Topic advice',
  description: 'The knowledge-base advisor for one topic: points with citations and their verification status.',
  class: 'read',
  input: z.strictObject({ topic: z.enum(ADVICE_TOPICS) }),
  http: (i: { topic: string }) => ({ method: 'GET', url: `/kb/advise${qs({ topic: i.topic })}` }),
  httpRoute: { method: 'GET', pattern: '/kb/advise' },
  describe: readDescribe('kb_advise'),
});

const directorySearch = tool({
  name: 'directory_search',
  title: 'Insurer directory search',
  description: 'Insurer claims contacts with their verification status and age. Unverified/stale entries must be confirmed before use; copycat numbers are for recognition only.',
  class: 'read',
  input: z.strictObject({ q: z.string().min(1).max(200) }),
  http: (i: { q: string }) => ({ method: 'GET', url: `/directory${qs({ q: i.q, limit: 10 })}` }),
  httpRoute: { method: 'GET', pattern: '/directory' },
  describe: readDescribe('directory_search'),
  shape: (raw) => ({ items: arr(obj(raw).items).map(shapeDirectory), total: obj(raw).total ?? null }),
});

const directoryGet = tool({
  name: 'directory_get',
  title: 'Insurer directory entry',
  description: 'One insurer directory entry with contacts, verification status and age.',
  class: 'read',
  input: z.strictObject({ id: z.string().min(1).max(128) }),
  http: (i: { id: string }) => ({ method: 'GET', url: `/directory/${enc(i.id)}` }),
  httpRoute: { method: 'GET', pattern: '/directory/:id' },
  describe: readDescribe('directory_get'),
  shape: (raw) => ({ ...shapeDirectory(obj(raw)), notes: obj(raw).notes ?? null }),
});

const totalLossAssess = tool({
  name: 'total_loss_assess',
  title: 'Total loss assessment (compute only)',
  description: 'Repair vs total-loss economics from the estimate, PAV, salvage and hire/storage costs on file. Compute only: nothing is stored. Missing inputs are reported, never guessed.',
  class: 'read',
  input: z.strictObject({ claimId: claimIdField() }),
  describe: readDescribe('total_loss_assess'),
  run: async (i: { claimId: string }, _rc: RunContext, ctx: AppContext) => {
    const bundle = loadBundle(ctx, i.claimId);
    const missing: string[] = [];
    const repairNet = bundle.estimate?.totals.netPence;
    const pav = bundle.pav?.pavPence;
    const salvage = bundle.report?.salvageValuePence;
    if (repairNet === undefined) missing.push('repair estimate (net)');
    if (pav === undefined) missing.push('PAV assessment');
    if (salvage === undefined) missing.push('salvage value (actual bid/offer or the engineer’s estimate)');
    if (repairNet === undefined || pav === undefined || salvage === undefined) return { computed: false, missing };
    const hire = [...bundle.hire].sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
    const group = hire?.gtaGroup ?? bundle.vehicle.gtaGroup ?? 'S1';
    const benchmark = gtaRate(group, ctx.now(), gtaRatesFor(ctx));
    const estimateHours = bundle.estimate ? bundle.estimate.totals.labourHours + bundle.estimate.totals.paintHours : 0;
    const assessment = assessTotalLoss({
      repairNetPence: repairNet,
      projectedRepairWorkingDays: bundle.report?.repairDurationWorkingDays ?? (estimateHours ? Math.ceil(estimateHours / 6) + 5 : 10),
      hireDailyRatePence: hire?.dailyRatePence ?? benchmark?.dailyRatePence ?? 0,
      storageDailyRatePence: bundle.storage[0]?.dailyRatePence ?? ctx.settings().rateCard.storageDailyPence,
      storageOpen: bundle.storage.some((s) => !s.endAt),
      pavPence: pav,
      salvagePence: salvage,
      salvageSource: 'estimate',
      salvageCategory: bundle.report?.salvageCategory,
      daysToPavPayment: 10,
    });
    return { computed: true, assessment, gtaBenchmark: benchmark ? { group, dailyRatePence: benchmark.dailyRatePence, note: 'industry benchmark — CCGUK is not a GTA subscriber' } : null };
  },
});

// ---------------------------------------------------------------------------
// Draft tools
// ---------------------------------------------------------------------------

/** Optional placeholder resolver registered by casework (`ctx.services.resolvePlaceholders`, §E.3). */
type PlaceholderResolver = (ctx: AppContext, claimId: string, text: string) => string;
function resolveExtras(ctx: AppContext, claimId: string, extras: Record<string, string> | undefined): Record<string, string> | undefined {
  const resolver = (ctx.services as { resolvePlaceholders?: PlaceholderResolver }).resolvePlaceholders;
  if (!extras || !resolver) return extras;
  return Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, resolver(ctx, claimId, v)]));
}

function enqueueReview(ctx: AppContext, rc: RunContext, targetKind: 'document' | 'docx', targetId: string, claimId: string): string | undefined {
  try {
    const job = enqueueJob(ctx, {
      type: 'review.check',
      payload: { targetKind, targetId, loop: 0 },
      claimId,
      parentJobId: rc.jobId,
      correlationId: rc.correlationId,
      idempotencyKey: `review.check:${targetKind}:${targetId}:0`,
      createdBy: agentUserId(rc.agent),
    });
    return job.id;
  } catch (err) {
    ctx.logger.warn('could not enqueue review.check', { error: String(err), targetId });
    return undefined;
  }
}

const documentDraft = tool({
  name: 'document_draft',
  title: 'Draft a letter',
  description:
    'Create a DRAFT letter from an HTML template. Write only free text in extras; figures, dates, deadlines and references go in as {{fact:<id>}} placeholders that code fills. Nothing is sent or approved: the draft is reviewed first. Returns documentId, status and consistency flags.',
  class: 'draft',
  input: z.strictObject({ claimId: claimIdField(), templateId: z.string().min(3).max(128), extras: pairs(), recipientPartyId: id().nullable() }),
  http: (i: { claimId: string; templateId: string; extras: Array<{ key: string; value: string }> | null; recipientPartyId: string | null }, _rc: RunContext, ctx?: AppContext) => {
    const extras = toRecord(i.extras);
    const data = ctx ? resolveExtras(ctx, i.claimId, extras) : extras;
    return { method: 'POST', url: `/claims/${enc(i.claimId)}/documents`, body: { templateId: i.templateId, ...(data ? { data } : {}), ...(i.recipientPartyId ? { recipientPartyId: i.recipientPartyId } : {}) } };
  },
  httpRoute: { method: 'POST', pattern: '/claims/:id/documents' },
  describe: (i: { claimId: string; templateId: string }) => ({ class: 'draft', kind: `document.${i.templateId}`, claimId: i.claimId, templateId: i.templateId, confidence: 1 }),
  afterHttp: (i: { claimId: string }, body: unknown, rc: RunContext, ctx: AppContext) => {
    const docId = String(obj(body).id ?? '');
    const reviewJobId = docId ? enqueueReview(ctx, rc, 'document', docId, i.claimId) : undefined;
    return reviewJobId ? { reviewJobId } : {};
  },
  shape: (raw) => {
    const d = obj(raw);
    return { documentId: d.id, status: d.status, templateId: d.templateId, consistency: shapeDocument(d).consistency, reviewJobId: d.reviewJobId ?? null };
  },
});

const docxDocumentDraft = tool({
  name: 'docx_document_draft',
  title: 'Draft a CCGUK Word document',
  description: 'Create a DRAFT from a CCGUK Word template (the template is filled, never rewritten). values overrides individual slots (free text only). Nothing is sent or approved: the draft is reviewed first.',
  class: 'draft',
  input: z.strictObject({ claimId: claimIdField(), templateId: z.string().min(1).max(128), variant: z.string().max(64).nullable(), values: pairs() }),
  http: (i: { claimId: string; templateId: string; variant: string | null; values: Array<{ key: string; value: string }> | null }, _rc: RunContext, ctx?: AppContext) => {
    const raw = toRecord(i.values);
    const values = ctx ? resolveExtras(ctx, i.claimId, raw) : raw;
    return { method: 'POST', url: `/claims/${enc(i.claimId)}/docx-documents`, body: { templateId: i.templateId, ...(i.variant ? { variant: i.variant } : {}), ...(values ? { values } : {}) } };
  },
  httpRoute: { method: 'POST', pattern: '/claims/:id/docx-documents' },
  describe: (i: { claimId: string; templateId: string }) => ({ class: 'draft', kind: `docx.${i.templateId}`, claimId: i.claimId, templateId: i.templateId, confidence: 1 }),
  afterHttp: (i: { claimId: string }, body: unknown, rc: RunContext, ctx: AppContext) => {
    const docId = String(obj(body).id ?? obj(obj(body).document).id ?? '');
    const reviewJobId = docId ? enqueueReview(ctx, rc, 'docx', docId, i.claimId) : undefined;
    return reviewJobId ? { reviewJobId } : {};
  },
  shape: (raw) => {
    const d = obj(raw);
    const doc = obj(d.document ?? d);
    return { documentId: doc.id ?? null, status: doc.status ?? null, templateId: doc.templateId ?? null, warnings: d.warnings ?? null, reviewJobId: d.reviewJobId ?? null };
  },
});

// ---------------------------------------------------------------------------
// Internal tools
// ---------------------------------------------------------------------------

const eventAppend = tool({
  name: 'event_append',
  title: 'Add an event to the chronology',
  description: `Append an event to the claim chronology (types: ${AGENT_EVENT_TYPES.join(', ')}). The chronology is append-only; side effects (clocks) run. Never use it for payments, offers or settlements.`,
  class: 'internal',
  input: z.strictObject({
    claimId: claimIdField(),
    type: z.enum(AGENT_EVENT_TYPES),
    at: z.string().min(10).max(40).describe('ISO 8601 date-time'),
    summary: z.string().min(1).max(2000),
    data: pairs(),
    attributableTo: z.enum(['insurer', 'client', 'ccguk', 'repairer', 'engineer', 'third_party', 'none']).nullable(),
    evidenceIds: z.array(id()).max(50).nullable(),
  }),
  http: (i: { claimId: string; type: string; at: string; summary: string; data: Array<{ key: string; value: string }> | null; attributableTo: string | null; evidenceIds: string[] | null }) => ({
    method: 'POST',
    url: `/claims/${enc(i.claimId)}/events`,
    body: { type: i.type, at: i.at, summary: i.summary, ...(i.data?.length ? { data: toRecord(i.data) } : {}), ...(i.attributableTo ? { attributableTo: i.attributableTo } : {}), ...(i.evidenceIds?.length ? { evidenceIds: i.evidenceIds } : {}) },
  }),
  httpRoute: { method: 'POST', pattern: '/claims/:id/events' },
  describe: (i: { claimId: string; type: string }) => ({ class: 'internal', kind: `event.${i.type}`, claimId: i.claimId, confidence: 1 }),
  onAsk: askOwner('event_append', (i) => `Add a ${String(i.type)} event to the claim?`),
  shape: (raw) => {
    const r = obj(raw);
    const e = obj(r.event ?? r);
    return { eventId: e.id ?? null, type: e.type ?? null, at: e.at ?? null };
  },
});

const offerRecord = tool({
  name: 'offer_record',
  title: 'Record an offer',
  description:
    'Record an offer received from an insurer in the offers register (starts the reply clock) and raise an offer_decision item for the owner; an offer analysis is queued. You never accept, counter or reject: the owner decides.',
  class: 'internal',
  input: z.strictObject({
    claimId: claimIdField(),
    head: z.enum(HEADS),
    amountPence: z.int().min(0).nullable(),
    receivedAt: z.string().min(10).max(40).describe('ISO 8601 date-time'),
    from: z.string().min(1).max(200),
    channel: z.enum(OFFER_CHANNELS).nullable(),
    terms: z.string().max(4000).nullable(),
    evidenceIds: z.array(id()).max(50),
  }),
  http: (i: { claimId: string; head: string; amountPence: number | null; receivedAt: string; from: string; channel: string | null; terms: string | null; evidenceIds: string[] }) => ({
    method: 'POST',
    url: `/claims/${enc(i.claimId)}/offers`,
    body: {
      receivedAt: i.receivedAt,
      channel: i.channel ?? 'email',
      offerorName: i.from,
      terms: { otherTerms: [`Offer on ${i.head}${i.amountPence !== null ? ` of ${i.amountPence} pence` : ''}`, i.terms].filter(Boolean).join('. ') },
      ...(i.evidenceIds.length ? { evidenceIds: i.evidenceIds } : {}),
    },
  }),
  httpRoute: { method: 'POST', pattern: '/claims/:id/offers' },
  describe: (i: { claimId: string; head: string }) => ({ class: 'internal', kind: `offer.record.${i.head}`, claimId: i.claimId, confidence: 1 }),
  onAsk: (i: Record<string, unknown>, rc: RunContext, _ctx: AppContext, d: Decision): NeedsYouInput => ({
    kind: 'offer_decision',
    claimId: String(i.claimId),
    title: `Offer received from ${String(i.from)} (${String(i.head)}) — not yet recorded`,
    summary: `An offer${i.amountPence !== null ? ` of £${(Number(i.amountPence) / 100).toFixed(2)}` : ''} on ${String(i.head)} was received on ${String(i.receivedAt).slice(0, 10)}. The policy asked you before recording it (${d.reasons.join('; ') || d.ruleIds.join(', ')}). Record it in the offers register and decide; agents never decide offers.`,
    payload: { recorded: false, input: maskPii(i), runId: rc.runId },
    priority: 'urgent',
    createdBy: agentUserId(rc.agent),
    correlationId: rc.correlationId,
  }),
  afterHttp: (i: { claimId: string; head: string; amountPence: number | null; receivedAt: string; from: string; terms: string | null; evidenceIds: string[] }, body: unknown, rc: RunContext, ctx: AppContext) => {
    const offer = obj(obj(body).offer);
    const offerId = String(offer.id ?? '');
    const replyClock = obj(obj(body).replyClock);
    const ny = createNeedsYou(ctx, {
      kind: 'offer_decision',
      claimId: i.claimId,
      title: `Offer from ${i.from} (${i.head})${i.amountPence !== null ? `: £${(i.amountPence / 100).toFixed(2)}` : ''}`,
      summary: `Recorded in the offers register; the written reply is due ${typeof replyClock.dueAt === 'string' ? replyClock.dueAt : 'within 1 working day'}. An analysis with a recommendation follows. You decide — agents never accept, counter or reject.`,
      payload: { recorded: true, offerId, head: i.head, amountPence: i.amountPence, receivedAt: i.receivedAt, from: i.from, terms: i.terms, evidenceIds: i.evidenceIds, replyDueAt: replyClock.dueAt ?? null },
      priority: 'urgent',
      ...(typeof replyClock.dueAt === 'string' ? { dueAt: replyClock.dueAt } : {}),
      createdBy: agentUserId(rc.agent),
      correlationId: rc.correlationId,
      dedupeKey: `offer_decision:${offerId}`,
      runId: rc.runId,
    });
    let analyseJobId: string | undefined;
    try {
      analyseJobId = enqueueJob(ctx, {
        type: 'offer.analyse',
        payload: { offerId, claimId: i.claimId, head: i.head, amountPence: i.amountPence, needsYouId: ny.id },
        claimId: i.claimId,
        priority: 0,
        parentJobId: rc.jobId,
        correlationId: rc.correlationId,
        idempotencyKey: `offer.analyse:${offerId}`,
        createdBy: agentUserId(rc.agent),
      }).id;
    } catch (err) {
      ctx.logger.warn('could not enqueue offer.analyse', { error: String(err), offerId });
    }
    return { needsYouId: ny.id, ...(analyseJobId ? { analyseJobId } : {}) };
  },
  shape: (raw) => {
    const r = obj(raw);
    return { offerId: obj(r.offer).id ?? null, replyDueAt: obj(r.replyClock).dueAt ?? null, needsYouId: r.needsYouId ?? null, analyseJobId: r.analyseJobId ?? null, status: 'recorded; the owner decides' };
  },
});

function directoryReport(name: 'directory_report_failed' | 'directory_used_ok'): AnyTool {
  const failed = name === 'directory_report_failed';
  return tool({
    name,
    title: failed ? 'Report a failed insurer contact' : 'Report an insurer contact that worked',
    description: failed ? 'Tell the directory a contact (email/phone/address) failed (bounced, wrong number). Never verifies an entry — verification is the owner’s.' : 'Tell the directory a contact worked today. Never verifies an entry — verification is the owner’s.',
    class: 'internal',
    input: z.strictObject({ id: z.string().min(1).max(128), note: z.string().max(1000).nullable() }),
    http: (i: { id: string; note: string | null }) => ({ method: 'POST', url: `/directory/${enc(i.id)}/${failed ? 'report-failed' : 'used-ok'}`, body: failed ? { ...(i.note ? { note: i.note } : {}) } : {} }),
    httpRoute: { method: 'POST', pattern: `/directory/:id/${failed ? 'report-failed' : 'used-ok'}` },
    describe: (_i: unknown, rc: RunContext) => ({ class: 'internal', kind: `directory.${failed ? 'report_failed' : 'used_ok'}`, ...(rc.claimScope ? { claimId: rc.claimScope } : {}), confidence: 1 }),
    onAsk: askOwner(name, (i) => `${failed ? 'Mark a directory contact as failed' : 'Mark a directory contact as working'}: ${String(i.id)}?`),
    shape: (raw) => ({ ok: true, entry: obj(raw).id ?? null }),
  });
}

const vehicleLookup = tool({
  name: 'vehicle_lookup',
  title: 'DVLA / DVSA vehicle lookup',
  description: 'Look a registration up with DVLA (VES) and DVSA (MOT history). External call, limited to 20 a day across all agents.',
  // Catalogue class: external_send (it leaves the PC). The policy sees a lookup (no message is sent), so it is `auto`.
  class: 'external_send',
  input: z.strictObject({ registration: z.string().min(2).max(15) }),
  http: (i: { registration: string }) => ({ method: 'POST', url: '/vehicles/lookup', body: { registration: i.registration } }),
  httpRoute: { method: 'POST', pattern: '/vehicles/lookup' },
  describe: (_i: unknown, rc: RunContext) => ({ class: 'read', kind: 'lookup.vehicle', ...(rc.claimScope ? { claimId: rc.claimScope } : {}), confidence: 1 }),
  dailyLimit: 20,
});

/** Every gateway tool (registered by agent/tools/index.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own input/output types
export const coreTools: ToolDef<any, any>[] = [
  claimsSearch,
  claimGet,
  claimNextActions,
  claimClocks,
  claimGates,
  claimAcceptance,
  eventsList,
  ledgerGet,
  offersList,
  hireGet,
  storageGet,
  recoveryGet,
  hirePricingGuide,
  partyGet,
  partySearch,
  vehicleGet,
  vehicleOnFile,
  evidenceList,
  evidenceRead,
  documentsList,
  documentGet,
  templatesList,
  docxTemplateValues,
  kbSearch,
  kbEntry,
  kbAdvise,
  directorySearch,
  directoryGet,
  totalLossAssess,
  documentDraft,
  docxDocumentDraft,
  eventAppend,
  offerRecord,
  directoryReport('directory_report_failed'),
  directoryReport('directory_used_ok'),
  vehicleLookup,
];
