/**
 * Typed loaders for ../data/*.json.
 *
 * Files are read with `fs.readFileSync` relative to `import.meta.url` (works under NodeNext from source and
 * from `dist/`), parsed once, validated with the hand-written validators below and cached. Validation throws
 * `KbValidationError` on any shape or enum error, so a bad data file fails at first load rather than in a
 * template. Nothing here upgrades a verification status (ARCHITECTURE convention 6).
 */
import { readFileSync } from 'node:fs';
import type { FeeBand, GtaRate, InsurerDirectoryEntry, KbEntry, Verification } from '@ccguk/domain';
import {
  COURT_FEE_KINDS,
  DUE_KINDS,
  KB_ENTRY_TYPES,
  LICENCES,
  PLAYBOOK_ACTION_CODES,
  PLAYBOOK_PRIORITIES,
  PLAYBOOK_STAGES,
  VERIFICATION_STATUSES,
} from './types.js';
import type { CourtFeeBand, PlaybookRule } from './types.js';

export class KbValidationError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'KbValidationError';
  }
}

export const DATA_FILES = {
  cases: 'cases.json',
  statutes: 'statutes.json',
  cpr: 'cpr.json',
  gta: 'gta.json',
  fca: 'fca.json',
  fos: 'fos.json',
  guidance: 'guidance.json',
  gtaRates: 'gta-rates.json',
  courtFees: 'court-fees.json',
  directory: 'insurer-directory.json',
  playbookRules: 'playbook-rules.json',
} as const;

export type KbDataFile = (typeof DATA_FILES)[keyof typeof DATA_FILES];

/** KbEntry data files, in the order `loadAll()` concatenates them. */
export const KB_ENTRY_FILES: readonly KbDataFile[] = [
  DATA_FILES.cases,
  DATA_FILES.statutes,
  DATA_FILES.cpr,
  DATA_FILES.gta,
  DATA_FILES.fca,
  DATA_FILES.fos,
  DATA_FILES.guidance,
];

const DATA_DIR = new URL('../data/', import.meta.url);

/** Absolute file URL of a data file (useful for tests and tooling). */
export function dataFileUrl(file: KbDataFile): URL {
  return new URL(file, DATA_DIR);
}

const rawCache = new Map<string, unknown>();

/** Read and parse a data file (uncached validation — callers cache the typed result). */
export function readDataFile(file: KbDataFile): unknown {
  const hit = rawCache.get(file);
  if (hit !== undefined) return hit;
  const text = readFileSync(dataFileUrl(file), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new KbValidationError(`invalid JSON: ${(err as Error).message}`, file);
  }
  rawCache.set(file, parsed);
  return parsed;
}

/** Drop every cache (tests only). */
export function resetKbCache(): void {
  rawCache.clear();
  typedCache.clear();
}

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string): never {
  throw new KbValidationError(message, path);
}

function requireRecord(v: unknown, path: string): Rec {
  if (!isRecord(v)) fail(path, `expected an object, got ${describe(v)}`);
  return v;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function requireString(v: unknown, path: string, opts: { nonEmpty?: boolean } = { nonEmpty: true }): string {
  if (typeof v !== 'string') fail(path, `expected a string, got ${describe(v)}`);
  if (opts.nonEmpty !== false && v.trim() === '') fail(path, 'must not be empty');
  return v;
}

function optionalString(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  return requireString(v, path, { nonEmpty: false });
}

function requireStringArray(v: unknown, path: string, opts: { allowEmpty?: boolean } = {}): string[] {
  if (!Array.isArray(v)) fail(path, `expected an array of strings, got ${describe(v)}`);
  if (!opts.allowEmpty && v.length === 0) fail(path, 'must not be empty');
  return v.map((item, i) => requireString(item, `${path}[${i}]`));
}

function optionalStringArray(v: unknown, path: string): string[] | undefined {
  if (v === undefined) return undefined;
  return requireStringArray(v, path, { allowEmpty: true });
}

function requireEnum<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(path, `expected one of ${allowed.map((a) => `'${a}'`).join(', ')}, got ${JSON.stringify(v)}`);
  }
  return v as T;
}

function requireInteger(v: unknown, path: string, opts: { min?: number } = {}): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(path, `expected an integer, got ${describe(v)}`);
  if (opts.min !== undefined && v < opts.min) fail(path, `must be >= ${opts.min}`);
  return v;
}

function requireNumber(v: unknown, path: string, opts: { min?: number } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `expected a number, got ${describe(v)}`);
  if (opts.min !== undefined && v < opts.min) fail(path, `must be >= ${opts.min}`);
  return v;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD and a real calendar date. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function requireIsoDate(v: unknown, path: string): string {
  if (!isIsoDate(v)) fail(path, `expected an ISO date (YYYY-MM-DD), got ${JSON.stringify(v)}`);
  return v;
}

function optionalIsoDate(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  return requireIsoDate(v, path);
}

function optionalUrl(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  const s = requireString(v, path);
  if (!/^https?:\/\/\S+$/i.test(s)) fail(path, `expected an http(s) URL, got ${JSON.stringify(s)}`);
  return s;
}

function rejectUnknownKeys(rec: Rec, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
  }
}

// ---------------------------------------------------------------------------
// Validators (exported — the API uses them on PATCH too)
// ---------------------------------------------------------------------------

const VERIFICATION_KEYS = ['status', 'sourceUrl', 'sourceNote', 'verifiedAt', 'verifiedBy'] as const;
/** A verifiedBy that names a process rather than a person. Convention 6: only a human verifies. */
const AUTOMATED_VERIFIER = /\b(agent|bot|script|automation|automated|system|pipeline|crawler)\b/i;

export function validateVerification(v: unknown, path = 'verification'): Verification {
  const rec = requireRecord(v, path);
  rejectUnknownKeys(rec, path, VERIFICATION_KEYS);
  const status = requireEnum(rec.status, `${path}.status`, VERIFICATION_STATUSES);
  const sourceUrl = optionalUrl(rec.sourceUrl, `${path}.sourceUrl`);
  const out: Verification = { status };
  if (sourceUrl !== undefined) out.sourceUrl = sourceUrl;
  const sourceNote = optionalString(rec.sourceNote, `${path}.sourceNote`);
  if (sourceNote !== undefined) out.sourceNote = sourceNote;
  const verifiedAt = optionalIsoDate(rec.verifiedAt, `${path}.verifiedAt`);
  if (verifiedAt !== undefined) out.verifiedAt = verifiedAt;
  const verifiedBy = optionalString(rec.verifiedBy, `${path}.verifiedBy`);
  if (verifiedBy !== undefined) out.verifiedBy = verifiedBy;
  // Convention 6: 'verified' is a human assertion backed by a source. Enforce the minimum that makes it auditable.
  if (status === 'verified' && !out.sourceUrl) fail(`${path}.sourceUrl`, "a 'verified' status requires a sourceUrl");
  if (status === 'verified' && !out.verifiedAt) fail(`${path}.verifiedAt`, "a 'verified' status requires a verifiedAt date");
  if (status === 'verified' && !out.verifiedBy) fail(`${path}.verifiedBy`, "a 'verified' status requires verifiedBy (the person who checked the source)");
  if (status === 'verified' && out.verifiedBy && AUTOMATED_VERIFIER.test(out.verifiedBy)) {
    fail(`${path}.verifiedBy`, `only a human verifies (convention 6); ${JSON.stringify(out.verifiedBy)} names a process`);
  }
  return out;
}

const KB_ENTRY_KEYS = ['id', 'type', 'citation', 'title', 'principle', 'text', 'tags', 'topics', 'url', 'verification', 'licence'] as const;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Licence rule (ARCHITECTURE "Knowledge base"): CPR, FCA Handbook and GTA extracts are short quotes, not bulk copies. */
export const MAX_QUOTE_WORDS = 60;

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url);
  return m?.[1]?.toLowerCase();
}

const BAILII_HOST = /(^|\.)bailii\.org$/;
const FIND_CASE_LAW_HOST = /(^|\.)caselaw\.nationalarchives\.gov\.uk$/;

/** Validate one KbEntry. Throws KbValidationError on shape or enum errors. */
export function validateKbEntry(v: unknown, path = 'entry'): KbEntry {
  const rec = requireRecord(v, path);
  rejectUnknownKeys(rec, path, KB_ENTRY_KEYS);
  const id = requireString(rec.id, `${path}.id`);
  if (!ID_PATTERN.test(id)) fail(`${path}.id`, `id must be a lower-case slug, got ${JSON.stringify(id)}`);
  const p = `${path}(${id})`;
  const entry: KbEntry = {
    id,
    type: requireEnum(rec.type, `${p}.type`, KB_ENTRY_TYPES),
    citation: requireString(rec.citation, `${p}.citation`),
    title: requireString(rec.title, `${p}.title`),
    principle: requireString(rec.principle, `${p}.principle`),
    tags: requireStringArray(rec.tags, `${p}.tags`, { allowEmpty: true }),
    topics: requireStringArray(rec.topics, `${p}.topics`, { allowEmpty: true }),
    verification: validateVerification(rec.verification, `${p}.verification`),
  };
  const text = optionalString(rec.text, `${p}.text`);
  if (text !== undefined) entry.text = text;
  const url = optionalUrl(rec.url, `${p}.url`);
  if (url !== undefined) entry.url = url;
  if (rec.licence !== undefined) entry.licence = requireEnum(rec.licence, `${p}.licence`, LICENCES);
  // Licence rules (ARCHITECTURE "Knowledge base"): link-only sources carry no extract.
  if (entry.licence === 'link_only' && entry.text && entry.text.length > 0) {
    fail(`${p}.text`, "licence 'link_only' does not permit an extract; keep principle + url only");
  }
  // Find Case Law → principle + link only unless a computational-analysis licence is recorded (none is); BAILII → link only.
  if (entry.type === 'case' && entry.text && entry.text.length > 0) {
    fail(`${p}.text`, 'case entries are principle + link only (Find Case Law / BAILII licence rules); no judgment extract');
  }
  const host = hostOf(entry.url ?? entry.verification.sourceUrl);
  if (host && BAILII_HOST.test(host) && entry.licence !== 'link_only') {
    fail(`${p}.licence`, "BAILII sources are link-only: set licence 'link_only'");
  }
  if (entry.licence === 'Open Justice Licence' && !(host && FIND_CASE_LAW_HOST.test(host))) {
    fail(`${p}.licence`, "'Open Justice Licence' applies to Find Case Law (caselaw.nationalarchives.gov.uk) pages only");
  }
  // CPR / FCA Handbook / GTA: short quotes + link, never bulk copies.
  if (entry.licence === 'quote_only' && entry.text && wordCount(entry.text) > MAX_QUOTE_WORDS) {
    fail(`${p}.text`, `quote_only extracts are limited to ${MAX_QUOTE_WORDS} words (got ${wordCount(entry.text)}); link to the rest`);
  }
  return entry;
}

const DIRECTORY_KEYS = [
  'id',
  'name',
  'brands',
  'group',
  'thirdPartyClaimsPhone',
  'thirdPartyIvrPath',
  'policyholderClaimsPhone',
  'claimsEmail',
  'thirdPartyEmail',
  'complaintsEmail',
  'postalAddress',
  'portalUrl',
  'openingHours',
  'notes',
  'copycatDomains',
  'copycatNumbers',
  'verification',
  'lastUsedOk',
  'lastFailed',
] as const;

const UK_PHONE = /^(\+44\s?|0)[\d\s]{9,13}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function optionalPhone(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  const s = requireString(v, path);
  if (!UK_PHONE.test(s)) fail(path, `expected a UK phone number, got ${JSON.stringify(s)}`);
  return s;
}

function optionalEmail(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  const s = requireString(v, path);
  if (!EMAIL.test(s)) fail(path, `expected an email address, got ${JSON.stringify(s)}`);
  return s;
}

/** Validate one InsurerDirectoryEntry. Throws KbValidationError on shape or enum errors. */
export function validateDirectoryEntry(v: unknown, path = 'directoryEntry'): InsurerDirectoryEntry {
  const rec = requireRecord(v, path);
  rejectUnknownKeys(rec, path, DIRECTORY_KEYS);
  const id = requireString(rec.id, `${path}.id`);
  if (!ID_PATTERN.test(id)) fail(`${path}.id`, `id must be a lower-case slug, got ${JSON.stringify(id)}`);
  const p = `${path}(${id})`;
  const entry: InsurerDirectoryEntry = {
    id,
    name: requireString(rec.name, `${p}.name`),
    brands: requireStringArray(rec.brands, `${p}.brands`),
    copycatDomains: requireStringArray(rec.copycatDomains, `${p}.copycatDomains`, { allowEmpty: true }),
    copycatNumbers: requireStringArray(rec.copycatNumbers, `${p}.copycatNumbers`, { allowEmpty: true }),
    verification: validateVerification(rec.verification, `${p}.verification`),
  };
  const set = <K extends keyof InsurerDirectoryEntry>(key: K, value: InsurerDirectoryEntry[K] | undefined): void => {
    if (value !== undefined) entry[key] = value;
  };
  set('group', optionalString(rec.group, `${p}.group`));
  set('thirdPartyClaimsPhone', optionalPhone(rec.thirdPartyClaimsPhone, `${p}.thirdPartyClaimsPhone`));
  set('thirdPartyIvrPath', optionalString(rec.thirdPartyIvrPath, `${p}.thirdPartyIvrPath`));
  set('policyholderClaimsPhone', optionalPhone(rec.policyholderClaimsPhone, `${p}.policyholderClaimsPhone`));
  set('claimsEmail', optionalEmail(rec.claimsEmail, `${p}.claimsEmail`));
  set('thirdPartyEmail', optionalEmail(rec.thirdPartyEmail, `${p}.thirdPartyEmail`));
  set('complaintsEmail', optionalEmail(rec.complaintsEmail, `${p}.complaintsEmail`));
  set('postalAddress', optionalString(rec.postalAddress, `${p}.postalAddress`));
  set('portalUrl', optionalUrl(rec.portalUrl, `${p}.portalUrl`));
  set('openingHours', optionalString(rec.openingHours, `${p}.openingHours`));
  set('notes', optionalString(rec.notes, `${p}.notes`));
  set('lastUsedOk', optionalIsoDate(rec.lastUsedOk, `${p}.lastUsedOk`));
  set('lastFailed', optionalIsoDate(rec.lastFailed, `${p}.lastFailed`));
  for (const [i, d] of entry.copycatDomains.entries()) {
    if (/[\s/@:]/.test(d) || !d.includes('.')) fail(`${p}.copycatDomains[${i}]`, `expected a bare domain, got ${JSON.stringify(d)}`);
  }
  for (const [i, n] of entry.copycatNumbers.entries()) {
    if (!/^[\d\s+xX*]+$/.test(n)) fail(`${p}.copycatNumbers[${i}]`, `expected digits with optional x/* wildcards, got ${JSON.stringify(n)}`);
  }
  return entry;
}

const GTA_RATE_KEYS = ['group', 'description', 'dailyRatePence', 'period', 'effectiveFrom', 'effectiveTo', 'verification'] as const;
const GTA_GROUP = /^[A-Z]{1,3}\d{0,2}$/;
const PERIOD = /^\d{4}-\d{2}$/;

export function validateGtaRate(v: unknown, path = 'gtaRate'): GtaRate {
  const rec = requireRecord(v, path);
  rejectUnknownKeys(rec, path, GTA_RATE_KEYS);
  const group = requireString(rec.group, `${path}.group`);
  if (!GTA_GROUP.test(group)) fail(`${path}.group`, `expected a GTA group code such as S1, M, M1, CP1, got ${JSON.stringify(group)}`);
  const p = `${path}(${group})`;
  const rate: GtaRate = {
    group,
    dailyRatePence: requireInteger(rec.dailyRatePence, `${p}.dailyRatePence`, { min: 1 }),
    period: requireString(rec.period, `${p}.period`),
    effectiveFrom: requireIsoDate(rec.effectiveFrom, `${p}.effectiveFrom`),
    effectiveTo: requireIsoDate(rec.effectiveTo, `${p}.effectiveTo`),
    verification: validateVerification(rec.verification, `${p}.verification`),
  };
  if (!PERIOD.test(rate.period)) fail(`${p}.period`, `expected a period such as '2026-27', got ${JSON.stringify(rate.period)}`);
  if (rate.effectiveTo < rate.effectiveFrom) fail(`${p}.effectiveTo`, 'must not be before effectiveFrom');
  const description = optionalString(rec.description, `${p}.description`);
  if (description !== undefined) rate.description = description;
  return rate;
}

const COURT_FEE_KEYS = ['kind', 'fromPence', 'toPence', 'feePence', 'pct', 'capPence', 'verification', 'note'] as const;

export function validateCourtFeeBand(v: unknown, path = 'courtFee'): CourtFeeBand {
  const rec = requireRecord(v, path);
  rejectUnknownKeys(rec, path, COURT_FEE_KEYS);
  const kind = requireEnum(rec.kind, `${path}.kind`, COURT_FEE_KINDS);
  const p = `${path}(${kind})`;
  const band: CourtFeeBand = {
    kind,
    fromPence: requireInteger(rec.fromPence, `${p}.fromPence`, { min: 0 }),
    toPence: rec.toPence === null ? null : requireInteger(rec.toPence, `${p}.toPence`, { min: 0 }),
    verification: validateVerification(rec.verification, `${p}.verification`),
  };
  if (band.toPence !== null && band.toPence < band.fromPence) fail(`${p}.toPence`, 'must not be below fromPence');
  if (rec.feePence !== undefined) band.feePence = requireInteger(rec.feePence, `${p}.feePence`, { min: 0 });
  if (rec.pct !== undefined) band.pct = requireNumber(rec.pct, `${p}.pct`, { min: 0 });
  if (rec.capPence !== undefined) band.capPence = requireInteger(rec.capPence, `${p}.capPence`, { min: 0 });
  if (band.feePence === undefined && band.pct === undefined) fail(p, 'a fee band needs feePence or pct');
  const note = optionalString(rec.note, `${p}.note`);
  if (note !== undefined) band.note = note;
  return band;
}

const PLAYBOOK_RULE_KEYS = [
  'code',
  'order',
  'blueprintStep',
  'stage',
  'title',
  'why',
  'basis',
  'templateId',
  'priority',
  'trigger',
  'due',
  'blockedBy',
  'benchmarkOnly',
  'valueNote',
  'forumCheck',
  'notes',
] as const;
const TEMPLATE_ID = /^[a-z]+\.[a-z0-9_]+$/;

export function validatePlaybookRule(v: unknown, path = 'playbookRule'): PlaybookRule {
  const rec = requireRecord(v, path);
  rejectUnknownKeys(rec, path, PLAYBOOK_RULE_KEYS);
  const code = requireEnum(rec.code, `${path}.code`, PLAYBOOK_ACTION_CODES);
  const p = `${path}(${code})`;
  let templateId: string | null;
  if (rec.templateId === null) templateId = null;
  else {
    templateId = requireString(rec.templateId, `${p}.templateId`);
    if (!TEMPLATE_ID.test(templateId)) fail(`${p}.templateId`, `expected 'kind.name', got ${JSON.stringify(templateId)}`);
  }
  let due: PlaybookRule['due'] = null;
  if (rec.due !== null && rec.due !== undefined) {
    const d = requireRecord(rec.due, `${p}.due`);
    rejectUnknownKeys(d, `${p}.due`, ['kind', 'n', 'from']);
    const kind = requireEnum(d.kind, `${p}.due.kind`, DUE_KINDS);
    due = { kind, from: requireString(d.from, `${p}.due.from`) };
    if (d.n !== undefined) due.n = requireInteger(d.n, `${p}.due.n`, { min: 0 });
    if (kind !== 'immediate' && due.n === undefined) fail(`${p}.due.n`, `required for due.kind '${kind}'`);
  } else if (rec.due === undefined) fail(`${p}.due`, 'required (use null for no due rule)');
  const rule: PlaybookRule = {
    code,
    order: requireInteger(rec.order, `${p}.order`, { min: 0 }),
    blueprintStep: requireInteger(rec.blueprintStep, `${p}.blueprintStep`, { min: 1 }),
    stage: requireEnum(rec.stage, `${p}.stage`, PLAYBOOK_STAGES),
    title: requireString(rec.title, `${p}.title`),
    why: requireString(rec.why, `${p}.why`),
    basis: requireStringArray(rec.basis, `${p}.basis`),
    templateId,
    priority: requireEnum(rec.priority, `${p}.priority`, PLAYBOOK_PRIORITIES),
    trigger: requireString(rec.trigger, `${p}.trigger`),
    due,
  };
  if (rule.blueprintStep > 8) fail(`${p}.blueprintStep`, 'BLUEPRINT §7 has steps 1–8');
  const blockedBy = optionalStringArray(rec.blockedBy, `${p}.blockedBy`);
  if (blockedBy !== undefined) rule.blockedBy = blockedBy;
  if (rec.benchmarkOnly !== undefined) {
    if (typeof rec.benchmarkOnly !== 'boolean') fail(`${p}.benchmarkOnly`, 'expected a boolean');
    rule.benchmarkOnly = rec.benchmarkOnly;
  }
  const valueNote = optionalString(rec.valueNote, `${p}.valueNote`);
  if (valueNote !== undefined) rule.valueNote = valueNote;
  const forumCheck = optionalString(rec.forumCheck, `${p}.forumCheck`);
  if (forumCheck !== undefined) rule.forumCheck = forumCheck;
  const notes = optionalString(rec.notes, `${p}.notes`);
  if (notes !== undefined) rule.notes = notes;
  return rule;
}

// ---------------------------------------------------------------------------
// Array loaders with caching
// ---------------------------------------------------------------------------

const typedCache = new Map<string, unknown>();

function loadArray<T>(file: KbDataFile, validate: (v: unknown, path: string) => T, uniqueKey?: (t: T) => string): T[] {
  const cached = typedCache.get(file) as T[] | undefined;
  if (cached) return cached;
  const raw = readDataFile(file);
  if (!Array.isArray(raw)) fail(file, `expected a top-level array, got ${describe(raw)}`);
  const out = raw.map((item, i) => validate(item, `${file}[${i}]`));
  if (uniqueKey) {
    const seen = new Set<string>();
    for (const item of out) {
      const key = uniqueKey(item);
      if (seen.has(key)) fail(file, `duplicate id '${key}'`);
      seen.add(key);
    }
  }
  typedCache.set(file, out);
  return out;
}

const byId = (e: { id: string }): string => e.id;

export function loadEntries(file: KbDataFile): KbEntry[] {
  return loadArray(file, validateKbEntry, byId);
}

export function loadCases(): KbEntry[] {
  return loadEntries(DATA_FILES.cases);
}
export function loadStatutes(): KbEntry[] {
  return loadEntries(DATA_FILES.statutes);
}
export function loadCpr(): KbEntry[] {
  return loadEntries(DATA_FILES.cpr);
}
export function loadGta(): KbEntry[] {
  return loadEntries(DATA_FILES.gta);
}
export function loadFca(): KbEntry[] {
  return loadEntries(DATA_FILES.fca);
}
export function loadFos(): KbEntry[] {
  return loadEntries(DATA_FILES.fos);
}
export function loadGuidance(): KbEntry[] {
  return loadEntries(DATA_FILES.guidance);
}

const ALL_KEY = '__all__';

/** Every KbEntry across the seven content files; ids are unique across files. */
export function loadAll(): KbEntry[] {
  const cached = typedCache.get(ALL_KEY) as KbEntry[] | undefined;
  if (cached) return cached;
  const all = KB_ENTRY_FILES.flatMap((f) => loadEntries(f));
  const seen = new Map<string, string>();
  for (const f of KB_ENTRY_FILES) {
    for (const e of loadEntries(f)) {
      const prev = seen.get(e.id);
      if (prev) fail(f, `id '${e.id}' is also defined in ${prev}`);
      seen.set(e.id, f);
    }
  }
  typedCache.set(ALL_KEY, all);
  return all;
}

const INDEX_KEY = '__index__';

/** id → entry map over `loadAll()`. */
export function entryIndex(): ReadonlyMap<string, KbEntry> {
  const cached = typedCache.get(INDEX_KEY) as Map<string, KbEntry> | undefined;
  if (cached) return cached;
  const map = new Map<string, KbEntry>();
  for (const e of loadAll()) map.set(e.id, e);
  typedCache.set(INDEX_KEY, map);
  return map;
}

export function getEntry(id: string): KbEntry | undefined {
  return entryIndex().get(id);
}

export function loadGtaRates(): GtaRate[] {
  return loadArray(DATA_FILES.gtaRates, validateGtaRate);
}

export function loadCourtFees(): CourtFeeBand[] {
  return loadArray(DATA_FILES.courtFees, validateCourtFeeBand);
}

/**
 * Court-fee bands in the domain `FeeBand` shape (open bands become `Number.MAX_SAFE_INTEGER`), limited to the
 * kinds `quantum.courtFee` understands. Pass the result as its `fees` argument.
 */
export function toDomainFeeBands(bands: CourtFeeBand[] = loadCourtFees()): FeeBand[] {
  const out: FeeBand[] = [];
  for (const b of bands) {
    const band: FeeBand = {
      kind: b.kind,
      fromPence: b.fromPence,
      toPence: b.toPence ?? Number.MAX_SAFE_INTEGER,
      verification: b.verification,
    };
    if (b.feePence !== undefined) band.feePence = b.feePence;
    if (b.pct !== undefined) band.pct = b.pct;
    if (b.capPence !== undefined) band.capPence = b.capPence;
    if (b.note !== undefined) band.note = b.note;
    out.push(band);
  }
  return out;
}

export function loadDirectory(): InsurerDirectoryEntry[] {
  return loadArray(DATA_FILES.directory, validateDirectoryEntry, byId);
}

export function loadPlaybookRules(): PlaybookRule[] {
  const rules = loadArray(DATA_FILES.playbookRules, validatePlaybookRule, (r) => r.code);
  return [...rules].sort((a, b) => a.order - b.order);
}

/** Verification bookkeeping for the build report and the KB screen. */
export interface VerificationCounts {
  total: number;
  verified: number;
  unverified: number;
  failed: number;
  stale: number;
}

export function countVerification(items: readonly { verification: Verification }[]): VerificationCounts {
  const c: VerificationCounts = { total: items.length, verified: 0, unverified: 0, failed: 0, stale: 0 };
  for (const i of items) c[i.verification.status] += 1;
  return c;
}
