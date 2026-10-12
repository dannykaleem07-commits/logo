// owned by intake
/**
 * New claim from files (docs/SUPREME-DESIGN.md §G.3): the latest extraction of each chosen item → a `CreateClaimBody`
 * prefill (the shape `POST /claims` accepts — services/intake.ts `normaliseFnol`, web wizard spelling for the other
 * side) plus `sources: Record<fieldPath, {itemId, evidenceId, page, quote, confidence}>` for the "from V5C, page 1"
 * badges. Values are validated and normalised the same way as proposals; when two documents disagree, the higher
 * confidence wins and the other is listed in `conflicts`.
 *
 * The draft is never submitted by code: the owner opens the New Claim wizard with it (`?intakeDraft=<id>`), takes the
 * client's account cold, answers the script questions and clicks Create (a new client relationship is always confirmed).
 * Drafts are kept server-side as JSON under `<DATA_DIR>/intake/drafts/<id>.json` (no table: they are working copies).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DocType, ExtractedField } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { docTypeLabel } from './proposals.js';
import { targetDef } from './targets.js';
import { parseUkAddress } from './validators.js';

export interface DraftSource {
  itemId: string;
  evidenceId: string;
  page: number | null;
  quote: string | null;
  confidence: number;
  docType: string | null;
  /** "from V5C, page 1" */
  label: string;
}

/** A partial `CreateClaimBody` (the owner completes the account, disclosure and script questions in the wizard). */
export interface NewClaimDraftBody {
  claimant?: { kind: 'individual'; name?: string; phone?: string; email?: string; dateOfBirth?: string; drivingLicenceNumber?: string; address?: { line1: string; line2?: string; town?: string; postcode: string }; roles: Array<'claimant' | 'driver'> };
  driver?: { kind: 'individual'; name?: string; phone?: string; email?: string; dateOfBirth?: string; drivingLicenceNumber?: string; address?: { line1: string; line2?: string; town?: string; postcode: string }; roles: Array<'driver'> };
  vehicle?: { registration?: string; vin?: string; make?: string; model?: string; monthOfFirstRegistration?: string; colour?: string; ownership: 'client' };
  accident?: { occurredAt?: string; location?: string };
  atFaultInsurerRef?: string;
  thirdParty?: { registration?: string; driverName?: string; insurerPolicyNumber?: string; contact?: string };
}

export interface NewClaimDraft {
  id: string;
  createdAt: string;
  createdBy: string;
  itemIds: string[];
  body: NewClaimDraftBody;
  sources: Record<string, DraftSource>;
  /** Values that lost to a higher-confidence reading from another document. */
  conflicts: Array<{ fieldPath: string; kept: string; other: string; otherSource: DraftSource }>;
  /** Fields that failed their check (kept out of the body, listed for the owner). */
  rejected: Array<{ fieldPath: string; value: string; reason: string; source: DraftSource }>;
  /** What the owner must still do in the wizard. */
  stillNeeded: string[];
}

/** FieldTarget → path in the draft body. Driver fields go to `driver` (merged into the claimant when it is the same person). */
const PATHS: Record<string, string> = {
  'claim.accident.occurredAt': 'accident.occurredAt',
  'claim.accident.location': 'accident.location',
  'claim.atFaultInsurerRef': 'atFaultInsurerRef',
  'claim.thirdPartyPolicyNumber': 'thirdParty.insurerPolicyNumber',
  'vehicle:third_party.registration': 'thirdParty.registration',
  'party:third_party.name': 'thirdParty.driverName',
  'party:third_party.phone': 'thirdParty.contact',
};
for (const role of ['client', 'claimant', 'driver']) {
  for (const f of ['vin', 'registration', 'make', 'model', 'colour']) PATHS[`vehicle:${role}.${f}`] = `vehicle.${f}`;
  PATHS[`vehicle:${role}.firstRegistered`] = 'vehicle.monthOfFirstRegistration';
}
for (const f of ['name', 'address', 'phone', 'email', 'dateOfBirth', 'drivingLicenceNumber']) {
  PATHS[`party:client.${f}`] = `claimant.${f}`;
  PATHS[`party:claimant.${f}`] = `claimant.${f}`;
  PATHS[`party:driver.${f}`] = `driver.${f}`;
}

function draftsDir(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'intake', 'drafts');
}

const ID_RE = /^[a-f0-9-]{36}$/;

export function saveDraft(ctx: AppContext, draft: NewClaimDraft): void {
  const dir = draftsDir(ctx);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${draft.id}.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(draft, null, 2));
  renameSync(tmp, path.join(dir, `${draft.id}.json`));
}

export function getDraft(ctx: AppContext, id: string): NewClaimDraft | undefined {
  if (!ID_RE.test(id)) return undefined;
  const file = path.join(draftsDir(ctx), `${id}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as NewClaimDraft;
  } catch {
    return undefined;
  }
}

export function requireDraft(ctx: AppContext, id: string): NewClaimDraft {
  const d = getDraft(ctx, id);
  if (!d) throw notFound('new-claim draft', id);
  return d;
}

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Build (and store) a draft from intake items. */
export function buildNewClaimDraft(ctx: AppContext, itemIds: string[], createdBy: string): NewClaimDraft {
  const ids = [...new Set(itemIds)];
  if (!ids.length) throw badRequest('Choose at least one intake item');
  const now = ctx.now();
  type Candidate = { fieldPath: string; value: string; source: DraftSource };
  const best = new Map<string, Candidate>();
  const conflicts: NewClaimDraft['conflicts'] = [];
  const rejected: NewClaimDraft['rejected'] = [];

  for (const itemId of ids) {
    const item = ctx.repos.getIntakeItem(ctx.db, itemId);
    if (!item) throw notFound('intake item', itemId);
    const ex = ctx.repos.latestIntakeExtraction(ctx.db, itemId);
    if (!ex) continue;
    const fields = (Array.isArray(ex.fields) ? ex.fields : []) as ExtractedField[];
    const docType = item.docType ?? null;
    for (const f of fields) {
      if (!f.target || f.value === null || f.value === undefined || !String(f.value).trim()) continue;
      const fieldPath = PATHS[f.target];
      const def = targetDef(f.target);
      if (!fieldPath || !def) continue;
      const source: DraftSource = {
        itemId,
        evidenceId: item.evidenceId,
        page: f.page ?? null,
        quote: f.quote ?? null,
        confidence: Math.max(0, Math.min(1, f.confidence)),
        docType,
        label: `from ${docTypeLabel(docType as DocType | undefined)}${f.page ? `, page ${f.page}` : ''}`,
      };
      const v = def.validate(String(f.value), { now });
      if (!v.ok) {
        rejected.push({ fieldPath, value: String(f.value), reason: v.errors.join('; '), source });
        continue;
      }
      const value = v.value ?? String(f.value).trim();
      const prev = best.get(fieldPath);
      if (!prev) best.set(fieldPath, { fieldPath, value, source });
      else if (norm(prev.value) !== norm(value)) {
        const [keep, lose] = source.confidence > prev.source.confidence ? [{ fieldPath, value, source }, prev] : [prev, { fieldPath, value, source }];
        best.set(fieldPath, keep);
        conflicts.push({ fieldPath, kept: keep.value, other: lose.value, otherSource: lose.source });
      } else if (source.confidence > prev.source.confidence) best.set(fieldPath, { fieldPath, value, source });
    }
  }

  // The driver is the claimant unless a different name was read.
  const claimantName = best.get('claimant.name')?.value;
  const driverName = best.get('driver.name')?.value;
  const driverIsClaimant = !driverName || (claimantName !== undefined && norm(claimantName) === norm(driverName));
  if (driverIsClaimant) {
    for (const [k, c] of [...best.entries()]) {
      if (!k.startsWith('driver.')) continue;
      const target = `claimant.${k.slice('driver.'.length)}`;
      const existing = best.get(target);
      if (!existing || c.source.confidence > existing.source.confidence) best.set(target, { ...c, fieldPath: target });
      best.delete(k);
    }
  }

  const body: Record<string, unknown> = {};
  const sources: Record<string, DraftSource> = {};
  for (const c of best.values()) {
    let value: unknown = c.value;
    if (c.fieldPath.endsWith('.address')) value = parseUkAddress(c.value).value;
    if (c.fieldPath === 'vehicle.registration' || c.fieldPath === 'thirdParty.registration') value = c.value.replace(/\s+/g, '');
    setPath(body, c.fieldPath, value);
    sources[c.fieldPath] = c.source;
  }
  if (body.claimant) Object.assign(body.claimant as object, { kind: 'individual', roles: driverIsClaimant ? ['claimant', 'driver'] : ['claimant'] });
  if (body.driver) Object.assign(body.driver as object, { kind: 'individual', roles: ['driver'] });
  if (body.vehicle) Object.assign(body.vehicle as object, { ownership: 'client' });

  const b = body as NewClaimDraftBody;
  const stillNeeded: string[] = [];
  if (!b.claimant?.name) stillNeeded.push('the claimant’s name');
  if (!b.vehicle?.registration) stillNeeded.push('the client vehicle’s registration');
  if (!b.accident?.occurredAt) stillNeeded.push('the accident date and time');
  if (!b.accident?.location) stillNeeded.push('the accident location');
  stillNeeded.push('the client’s own account of the accident (taken cold)', 'the call-recording disclosure and the script questions');

  const draft: NewClaimDraft = { id: randomUUID(), createdAt: now, createdBy, itemIds: ids, body: b, sources, conflicts, rejected, stillNeeded };
  saveDraft(ctx, draft);
  return draft;
}
