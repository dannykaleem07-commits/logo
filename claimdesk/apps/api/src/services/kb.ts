/**
 * Knowledge-base access for the API: the JSON content in packages/kb/data (cases, statutes, CPR, GTA, FCA, FOS,
 * guidance, GTA rates, court fees, the insurer directory split across part files), a ranked search, the advisor and
 * the directory status computation (verification is data — nothing here upgrades `unverified` to `verified`).
 *
 * Entries, rates, directory and playbook rules come from the validated @ccguk/kb loaders (via ctx.kb); search and the
 * advisor delegate to @ccguk/kb. The local BM25 `searchKb` remains for callers that pass their own entry list.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultGtaRates, GTA_NON_SUBSCRIBER_NOTE, gtaGroupsOn, gtaRate, mergeGtaRates, type GtaRate, type InsurerDirectoryEntry, type ISODate, type KbEntry, type MergedGtaRate, type Verification } from '@ccguk/domain';
import type { DirectoryOverride } from '@ccguk/db';
import { advise as kbAdvise, citedEntries, CATALOGUE_SEGMENTS, loadGtaSegmentDefaults, search as kbSearch, type CatalogueSegment } from '@ccguk/kb';
import type { AppContext } from '../context.js';

export interface CourtFee {
  id: string;
  kind: string;
  bandLowPence?: number;
  bandHighPence?: number;
  feePence?: number;
  description?: string;
  verification?: Verification;
  [k: string]: unknown;
}

const cache = new Map<string, unknown>();

function readJsonArray<T>(dataDir: string | undefined, file: string, logger: AppContext['logger']): T[] {
  if (!dataDir) return [];
  const key = `${dataDir}/${file}`;
  if (cache.has(key)) return cache.get(key) as T[];
  const p = path.join(dataDir, file);
  let out: T[] = [];
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      out = Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch (err) {
      logger.warn(`kb: could not parse ${file}`, { error: String(err) });
    }
  }
  cache.set(key, out);
  return out;
}

/** Test hook: forget cached JSON (e.g. after pointing at another data dir). */
export function resetKbCache(): void {
  cache.clear();
}

/** All insurer directory entries: `insurer-directory.json` plus any `insurer-directory.part-*.json`, de-duplicated by id. */
export function loadDirectory(ctx: AppContext): InsurerDirectoryEntry[] {
  const fromKb = ctx.kb.directory();
  if (fromKb.length) {
    return fromKb
      .map((e) => ({ ...e, copycatDomains: e.copycatDomains ?? [], copycatNumbers: e.copycatNumbers ?? [], brands: e.brands ?? [] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const dir = ctx.kb.dataDir;
  if (!dir) return [];
  const key = `${dir}/__directory__`;
  if (cache.has(key)) return cache.get(key) as InsurerDirectoryEntry[];
  const files = readdirSync(dir)
    .filter((f) => /^insurer-directory.*\.json$/.test(f))
    .sort();
  const byId = new Map<string, InsurerDirectoryEntry>();
  for (const f of files) {
    for (const e of readJsonArray<InsurerDirectoryEntry>(dir, f, ctx.logger)) {
      if (e && typeof e.id === 'string') byId.set(e.id, { ...e, copycatDomains: e.copycatDomains ?? [], copycatNumbers: e.copycatNumbers ?? [], brands: e.brands ?? [] });
    }
  }
  const out = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  cache.set(key, out);
  return out;
}

export function loadCourtFees(ctx: AppContext): CourtFee[] {
  return readJsonArray<CourtFee>(ctx.kb.dataDir, 'court-fees.json', ctx.logger);
}

export function kbEntries(ctx: AppContext): KbEntry[] {
  return ctx.kb.entries();
}

/** Citations the consistency engine compares against drafts (verified = a human recorded a source). */
export function kbCitations(ctx: AppContext): Array<{ citation: string; verified: boolean }> {
  const out: Array<{ citation: string; verified: boolean }> = [];
  for (const e of kbEntries(ctx)) {
    const verified = e.verification?.status === 'verified';
    out.push({ citation: e.citation, verified });
    if (e.title && e.title !== e.citation) out.push({ citation: e.title, verified });
  }
  return out;
}

/** The read-only knowledge-base rate table (packages/kb/data/gta-rates.json; the domain defaults if it is missing). */
export function kbGtaRates(ctx: AppContext): GtaRate[] {
  const fromKb = ctx.kb.gtaRates();
  return fromKb.length ? fromKb : defaultGtaRates;
}

/**
 * THE rate table every caller uses (TEMPLATES-VEHICLES-DESKTOP §F.3): KB rows, replaced or hidden per (group, period) by
 * the manual rows in Settings → GTA benchmark rates, plus manual-only rows. Benchmark only — CCGUK is not a subscriber.
 */
export function gtaRatesFor(ctx: AppContext): MergedGtaRate[] {
  return mergeGtaRates(kbGtaRates(ctx), ctx.repos.listGtaRates(ctx.db));
}

/** KB segment → group defaults (gta-segment-defaults.json), {} when the file cannot be read. */
export function kbSegmentDefaults(ctx: AppContext): Partial<Record<CatalogueSegment, string>> {
  try {
    return loadGtaSegmentDefaults();
  } catch (err) {
    ctx.logger.warn('kb: gta-segment-defaults.json could not be loaded', { error: String(err) });
    return {};
  }
}

/** Segment → GTA group starting suggestions: Settings overrides (DB) over the KB file. */
export function segmentDefaultsFor(ctx: AppContext): Record<string, string> {
  const out: Record<string, string> = { ...kbSegmentDefaults(ctx) };
  for (const row of ctx.repos.listGtaSegmentDefaults(ctx.db)) out[row.segment] = row.group;
  return out;
}

export const SEGMENT_LABELS: Record<CatalogueSegment, string> = {
  city: 'City car',
  supermini: 'Supermini',
  'small-family': 'Small family car',
  'large-family': 'Large family car',
  executive: 'Executive car',
  luxury: 'Luxury car',
  sports: 'Sports car',
  supercar: 'Supercar',
  'mpv-small': 'Small MPV',
  'mpv-large': 'Large MPV',
  'suv-small': 'Small SUV',
  'suv-medium': 'Medium SUV',
  'suv-large': 'Large SUV',
  'suv-luxury': 'Luxury SUV',
  pickup: 'Pick-up',
  'van-small': 'Small van',
  'van-medium': 'Medium van',
  'van-large': 'Large van',
  minibus: 'Minibus',
};

export { CATALOGUE_SEGMENTS };

export function gtaRatesOn(ctx: AppContext, date: ISODate, group?: string): { date: ISODate; items: GtaRate[]; groups: string[]; note: string } {
  const rates = gtaRatesFor(ctx);
  const groups = gtaGroupsOn(date, rates);
  const items = (group ? [group] : groups).map((g) => gtaRate(g, date, rates)).filter((r): r is GtaRate => Boolean(r));
  return { date, items, groups, note: GTA_NON_SUBSCRIBER_NOTE };
}

// ---------------------------------------------------------------------------
// Directory status
// ---------------------------------------------------------------------------

export const DIRECTORY_STALE_DAYS = 180;

export type DirectoryStatus = 'verified' | 'unverified' | 'failed' | 'stale';

export interface DirectoryStatusInfo {
  status: DirectoryStatus;
  /** Days since verification (when known). */
  ageDays?: number;
  warning?: string;
}

function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Verified entries age into 'stale' after 180 days; a failure more recent than the last success wins. */
export function directoryStatus(entry: InsurerDirectoryEntry, today: ISODate): DirectoryStatusInfo {
  const v = entry.verification ?? { status: 'unverified' as const };
  const lastOk = entry.lastUsedOk ?? v.verifiedAt;
  if (entry.lastFailed && (!lastOk || entry.lastFailed >= lastOk)) {
    return { status: 'failed', warning: `Reported failed on ${entry.lastFailed} — confirm the number/email on the insurer's own site before use.` };
  }
  if (v.status === 'failed') return { status: 'failed', warning: 'Verification failed — do not rely on these details.' };
  if (v.status === 'verified') {
    const age = v.verifiedAt ? daysBetween(v.verifiedAt, today) : undefined;
    if (age === undefined) return { status: 'stale', warning: 'Marked verified without a date — re-verify with a source URL.' };
    if (age > DIRECTORY_STALE_DAYS) return { status: 'stale', ageDays: age, warning: `Verified ${age} days ago (over ${DIRECTORY_STALE_DAYS}) — re-check before use.` };
    return { status: 'verified', ageDays: age };
  }
  if (v.status === 'stale') return { status: 'stale', warning: 'Marked stale — re-verify with a source URL.' };
  return { status: 'unverified', warning: 'UNVERIFIED — confirm on the insurer\'s own site or on the first live call before relying on it.' };
}

export interface DirectoryRow extends InsurerDirectoryEntry {
  directoryStatus: DirectoryStatus;
  statusInfo: DirectoryStatusInfo;
}

export function mergedDirectory(ctx: AppContext, overrides: DirectoryOverride[], today: ISODate): DirectoryRow[] {
  const merged = ctx.repos.applyDirectoryOverrides(loadDirectory(ctx), overrides);
  return merged.map((e) => {
    const statusInfo = directoryStatus(e, today);
    return { ...e, directoryStatus: statusInfo.status, statusInfo };
  });
}

export function filterDirectory(rows: DirectoryRow[], q: string | undefined): DirectoryRow[] {
  const needle = (q ?? '').trim().toLowerCase();
  if (!needle) return rows;
  const digits = needle.replace(/\D/g, '');
  return rows.filter((e) => {
    const hay = [e.id, e.name, e.group ?? '', ...(e.brands ?? []), e.claimsEmail ?? '', e.thirdPartyEmail ?? ''].join(' ').toLowerCase();
    if (hay.includes(needle)) return true;
    if (digits.length >= 4) {
      const nums = [e.thirdPartyClaimsPhone, e.policyholderClaimsPhone, ...(e.copycatNumbers ?? [])].filter(Boolean).map((n) => String(n).replace(/\D/g, ''));
      if (nums.some((n) => n.includes(digits))) return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Search (BM25-flavoured field-weighted ranking) and advisor
// ---------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'v', 'vs', 'by', 'at', 'with', 'be']);

export function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export interface KbSearchOptions {
  type?: string;
  topic?: string;
  limit?: number;
}

export interface KbSearchHit {
  entry: KbEntry;
  score: number;
}

const FIELD_WEIGHTS: Array<[(e: KbEntry) => string, number]> = [
  [(e) => e.citation, 5],
  [(e) => e.title, 3],
  [(e) => e.tags.join(' '), 2.5],
  [(e) => e.topics.join(' '), 2],
  [(e) => e.principle, 1.5],
  [(e) => e.text ?? '', 0.6],
];

export function searchKb(entries: KbEntry[], query: string, opts: KbSearchOptions = {}): KbSearchHit[] {
  const terms = tokenise(query);
  const n = entries.length || 1;
  const pool = entries.filter((e) => (!opts.type || e.type === opts.type) && (!opts.topic || e.topics.includes(opts.topic) || e.tags.includes(opts.topic)));
  if (terms.length === 0) return pool.slice(0, opts.limit ?? 20).map((entry) => ({ entry, score: 0 }));
  const df = new Map<string, number>();
  const docTokens = new Map<string, string[][]>();
  for (const e of pool) {
    const fields = FIELD_WEIGHTS.map(([get]) => tokenise(get(e)));
    docTokens.set(e.id, fields);
    const all = new Set(fields.flat());
    for (const t of all) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const phrase = query.trim().toLowerCase();
  const hits: KbSearchHit[] = [];
  for (const e of pool) {
    const fields = docTokens.get(e.id) ?? [];
    let score = 0;
    for (const term of terms) {
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      fields.forEach((tokens, i) => {
        const weight = FIELD_WEIGHTS[i]?.[1] ?? 1;
        const tf = tokens.filter((t) => t === term || (term.length > 4 && t.startsWith(term))).length;
        if (tf > 0) score += weight * idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (tokens.length / 40))));
      });
    }
    if (phrase.length > 3 && `${e.citation} ${e.title} ${e.principle}`.toLowerCase().includes(phrase)) score += 4;
    if (score > 0) hits.push({ entry: e, score: Math.round(score * 1000) / 1000 });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.citation.localeCompare(b.entry.citation));
  return hits.slice(0, opts.limit ?? 20);
}

export interface KbAdvice {
  topic: string;
  summary: string;
  points: Array<{ text: string; citations: string[]; verified: boolean }>;
  caveats: string[];
  entries: KbEntry[];
}

const TOPIC_SUMMARY: Record<string, string> = {
  credit_hire: 'Credit hire is recoverable as damages for loss of use (Giles v Thompson); the insurer attacks need, period, rate, impecuniosity, mitigation and enforceability — evidence each gate before the pack goes.',
  impecuniosity: 'Impecuniosity (Lagden v O\'Connor) lets the claimant recover the credit rate rather than the basic hire rate: bank statements, payslips and a statement of means must be on file before the point is argued.',
  bhr: 'The basic hire rate (Stevens v Equity Syndicate) is the comparator for a pecunious claimant: capture local rates manually with dated screenshots — never scraped — and keep the GTA rate as an industry benchmark only.',
  mitigation: 'A rejected offer is answered in writing within one working day, with the offer recorded exactly and the reasons (Copley v Lawn); never tell a client to ignore an offer.',
  pav: 'Pre-accident value is the retail cost of an equivalent vehicle (Darbishire v Warran): dated comparables, mileage normalisation, exclusions and an IQR band, with the engineer\'s reasoning on the face of the report.',
  complaints: 'Against the at-fault insurer the route is DISP 1 complaint (eight weeks) then letter before claim; the Financial Ombudsman is not open to a third-party claimant (DISP 2.7).',
  fos: 'The Financial Ombudsman Service is open to eligible complainants against their own insurer; a third-party claimant cannot refer the at-fault insurer (DISP 2.7).',
  gta: 'CCGUK is not a GTA subscriber: GTA rates and timescales are an industry benchmark (GTA 2.7(j)), never a legal entitlement, and must be cited as such.',
  enforceability: 'A credit hire agreement must survive the CCR 2013 and CCA checks (Dimond v Lovell; W v Veolia): cancellation information, Schedule 3 form, express request to start and s.60F compliance evidenced on the file.',
  pcn: 'Owner liability under the Road Traffic (Owner Liability) Regulations 2000 transfers to the hirer with a compliant statement of liability; keep the hire agreement and the keeper address current.',
  nip: 'A s.172 RTA 1988 request is answered honestly within 28 days from fleet records; s.172(4) is the defence where reasonable diligence cannot identify the driver — never nominate a driver who was not driving.',
  dsar: 'A data subject access request (UK GDPR Art 15) must be answered within one month; use it for call recordings and file notes, and redact third-party data before anything reaches the client.',
  interest: 'Interest runs under s.69 County Courts Act 1984 (simple) in litigation; for consumer insurance claims ICOBS 8.2.9R–8.2.11R adds base + 4% from the three-month breach; the GTA late-payment uplift is a benchmark only.',
  salvage: 'Salvage follows the ABI Code of Practice categories (A, B, S, N); the figure is the actual bid or offer, never a fixed percentage.',
  limitation: 'Six years for the tort and contract claims (Limitation Act 1980 ss.2, 5); three years where personal injury is involved (s.11) — injury is referred out, no fee.',
};

/**
 * KB verification overlay for the ranked search (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.5): knowledge-use registers it at
 * boot (`ctx.kb.entries` is wrapped directly); it applies the owner's recorded checks to every hit. Absent = static data.
 */
let kbSearchOverlay: ((entries: KbEntry[]) => KbEntry[]) | undefined;
export function setKbSearchOverlay(fn: ((entries: KbEntry[]) => KbEntry[]) | undefined): void {
  kbSearchOverlay = fn;
}

/** Ranked search over the whole knowledge base via @ccguk/kb (paragraph-aware BM25 with topic tags). */
export function searchKnowledgeBase(query: string, opts: KbSearchOptions = {}): Array<KbSearchHit & { highlights: string[] }> {
  const hits = kbSearch(query, {
    ...(opts.type ? { types: [opts.type as KbEntry['type']] } : {}),
    ...(opts.topic ? { topics: [opts.topic] } : {}),
    limit: opts.limit ?? 20,
  }).map((h) => ({ entry: h.entry, score: Math.round(h.score * 1000) / 1000, highlights: h.highlights }));
  if (!kbSearchOverlay || !hits.length) return hits;
  let overlaid: KbEntry[];
  try {
    overlaid = kbSearchOverlay(hits.map((h) => h.entry));
  } catch {
    return hits;
  }
  return hits.map((h, i) => ({ ...h, entry: overlaid[i] ?? h.entry }));
}

/** Cited guidance for a topic from the @ccguk/kb advisor. Human-approved before use; nothing here is sent automatically. */
export function adviseTopic(ctx: AppContext, topic: string): KbAdvice & { forumChecks: string[]; unverifiedCitations: string[] } {
  const advice = kbAdvise(topic);
  const entries = citedEntries(advice);
  const byId = new Map(kbEntries(ctx).map((e) => [e.id, e] as const));
  const points = advice.points.map((p) => ({
    text: p.text,
    citations: p.citations,
    verified: p.citations.length > 0 && p.citations.every((id) => byId.get(id)?.verification?.status === 'verified'),
  }));
  const caveats = [...advice.forumChecks, ...advice.caveats];
  if (advice.unverifiedCitations.length) {
    caveats.push(`${advice.unverifiedCitations.length} cited entries are UNVERIFIED — open the source URL and record it before relying on them in a letter.`);
  }
  caveats.push('Status line: Courtesy Cars Group UK Ltd is not a firm of solicitors and is not regulated by the SRA; this is guidance for the handler, not legal advice to the client.');
  return { topic: advice.topic, summary: advice.summary || TOPIC_SUMMARY[advice.topic] || '', points, caveats, entries, forumChecks: advice.forumChecks, unverifiedCitations: advice.unverifiedCitations };
}

export interface GetPaidFasterStep {
  code: string;
  day: string;
  action: string;
  basis: string[];
  templateId?: string;
}

/** The codified get-paid-faster ladder (BLUEPRINT §7), used when packages/kb has no playbook-rules.json. */
export const GET_PAID_FASTER: GetPaidFasterStep[] = [
  { code: 'SEND_NCAF', day: 'Day 1', action: 'Send the New Claim Advice Form to the at-fault insurer within one working day of services being agreed.', basis: ['GTA 4.1 (benchmark)', 'ICOBS 8.1'], templateId: 'letter.ncaf' },
  { code: 'REQUEST_CCTV', day: 'Days 1–7', action: 'Request CCTV/dashcam preservation from every operator before footage is overwritten.', basis: ['Pre-action conduct PD para 6'], templateId: 'letter.cctv_preservation' },
  { code: 'LOG_OFFERS', day: 'Always', action: 'Log every intervention offer (what/who/when) and reply in writing within one working day.', basis: ['Copley v Lawn [2009] EWCA Civ 580'], templateId: 'letter.intervention_reply' },
  { code: 'COLLECT_OR_PAY', day: 'Report day', action: 'On the engineer\'s report send the collect-or-pay notice; storage after report + 48 h is otherwise refused.', basis: ['GTA 4.x storage practice (benchmark)'], templateId: 'letter.collect_or_pay' },
  { code: 'SEND_PAYMENT_PACK', day: 'Hire end', action: 'Send the complete payment pack (covering letter, mitigation questionnaire, NCAF, hire period validation, engineer\'s report, storage/recovery/hire accounts) the day hire ends.', basis: ['GTA 6.1–6.3 (benchmark)'], templateId: 'pack.gta_payment' },
  { code: 'SPLIT_HEADS', day: 'Pack + 14', action: 'Ask for payment of the undisputed heads now and particulars of any dispute on the rest.', basis: ['ICOBS 8.1.1R'], templateId: 'letter.chaser_14' },
  { code: 'CHASER_7', day: 'Pack + 7', action: 'Confirm receipt and completeness of the pack.', basis: ['GTA 6.7 (benchmark)'], templateId: 'letter.chaser_7' },
  { code: 'CHASER_21', day: 'Pack + 21', action: 'Final chaser: payment or reasoned reply by a dated deadline, complaint to follow.', basis: ['ICOBS 8.1.1R'], templateId: 'letter.chaser_21' },
  { code: 'COMPLAINT', day: 'Pack + 28', action: 'Formal complaint under DISP 1 (eight-week final response clock).', basis: ['DISP 1.6'], templateId: 'letter.complaint_disp' },
  { code: 'DSAR', day: 'On dispute', action: 'DSAR for call recordings and file notes where the insurer\'s account differs from the register.', basis: ['UK GDPR Art 15'], templateId: 'letter.dsar' },
  { code: 'LBC', day: 'Final response / 8 weeks', action: 'Letter before claim for the claimant (litigant in person) to sign; then Part 36 and, if needed, proceedings issued by the claimant.', basis: ['PD Pre-Action Conduct', 'CPR 36'], templateId: 'letter.letter_before_claim' },
  { code: 'VENDOR_VERIFICATION', day: 'On bank refusal', action: 'Send the vendor-verification pack (registered name, number, bank letter) so Confirmation of Payee matches.', basis: ['File 1 lesson'], templateId: 'letter.vendor_verification_pack' },
];
