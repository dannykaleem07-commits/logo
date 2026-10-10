// owned by knowledge-research
/**
 * The deterministic fetcher (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.3; used by source_fetch, source_search,
 * knowledge.fetch, knowledge.watch and the self-test). Code fetches; no model has web tools for it (KR-8).
 *
 *   egress guard (KR-7) → allow-list + licence (deny / link_only / FCL licence) → source enabled → budgets (global
 *   fetchesPerDay, per-domain per_day, per-domain per_minute token bucket) → robots.txt (cached 24 h) → GET with an
 *   injected fetch, no cookies, 20 s timeout, redirects followed only within allowed hosts, ≤ 5 MB, html / xml / json /
 *   pdf / text only → sha256 of the raw bytes → htmlToText (hidden text flagged) or PDF text → files under
 *   DATA_DIR\knowledge-store\snapshots\<sha[0..2]>\<sha256>.<ext> (+ .txt) → append-only `source_snapshots` row with
 *   `previous_id` / `changed` and injectionFlags() → knowledge_changes + audit_log (`knowledge.source.fetch`).
 * Every refusal is audited `knowledge.source.refused` (a URL refused by the egress guard is never written down).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { egressGuard, effectivePolicyKind, fetchAllowed, htmlToText, injectionFlags, parseRobots, plainToText, robotsAllows, sourceHost, type ClaimDictionary, type SourcePolicy } from '@ccguk/domain';
import type { Actor, SourceSnapshotRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { londonDay, londonDayStart } from '../../agent/core.js';
import { recordKnowledgeChange } from '../changes.js';
import { getKnowledgeSettings, knowledgeStoreDir } from '../settings.js';
import { claimDictionaryFor } from './dictionary.js';
import { FETCH_TIMEOUT_MS, MAX_FETCH_BYTES, MAX_REDIRECTS, knowledgeFetchOf, knowledgeUserAgent, type FetchResponseLike, type KnowledgeFetch } from './net.js';
import { effectiveSource, extraPolicies } from './sources.js';

export type FetchRefusalCode =
  | 'EGRESS_REFUSED' | 'NOT_ALLOWED' | 'SOURCE_DISABLED' | 'BUDGET_DAY' | 'BUDGET_DOMAIN_DAY' | 'RATE_LIMITED' | 'ROBOTS_DISALLOWED'
  | 'ROBOTS_UNAVAILABLE' | 'REDIRECT_REFUSED' | 'HTTP_ERROR' | 'CONTENT_TYPE' | 'TOO_LARGE' | 'NETWORK' | 'TIMEOUT';

export interface FetchRequest {
  url: string;
  reason: string;
  gapId?: string | null;
  jobId?: string | null;
  runId?: string | null;
  /** Who asked (agent:researcher, agent:supervisor or the owner). */
  createdBy: string;
  /** Reuse a snapshot of the same URL fetched within this many hours (default 0 = always fetch). */
  reuseWithinHours?: number;
  /** Skip robots.txt (only the robots fetch itself). */
  noRobots?: boolean;
}

export interface FetchDeps {
  fetch?: KnowledgeFetch;
  dict?: ClaimDictionary;
  signal?: AbortSignal;
}

export type FetchResult =
  | { ok: true; snapshot: SourceSnapshotRecord; reused: boolean; text: string }
  | { ok: false; code: FetchRefusalCode; reason: string; link: string | null; status?: number };

const BUCKETS = Symbol.for('claimdesk.knowledge.fetchBuckets');

/** Per-domain sliding one-minute window (in memory; the process is the only fetcher). */
export function takeToken(ctx: AppContext, domain: string, perMinute: number): boolean {
  const s = ctx.services as unknown as Record<symbol, Map<string, number[]> | undefined>;
  const buckets = (s[BUCKETS] ??= new Map<string, number[]>());
  const now = Date.parse(ctx.now());
  const recent = (buckets.get(domain) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= Math.max(1, perMinute)) {
    buckets.set(domain, recent);
    return false;
  }
  recent.push(now);
  buckets.set(domain, recent);
  return true;
}

/** Fetches attempted today (London day), all domains: the global `budgets.fetchesPerDay`. */
export function fetchesToday(ctx: AppContext): number {
  const since = londonDayStart(ctx.now());
  const row = ctx.handle.sqlite.prepare(`SELECT count(*) AS c FROM knowledge_changes WHERE action = 'knowledge.source.fetch' AND at >= ?`).get(since) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

const actorOf = (req: FetchRequest): Actor => ({ userId: req.createdBy, ...(req.runId && req.createdBy.startsWith('agent:') ? { runId: req.runId } : {}) });

function refuse(ctx: AppContext, req: FetchRequest, code: FetchRefusalCode, reason: string, opts: { link?: string | null; logUrl?: boolean; status?: number } = {}): FetchResult {
  const at = ctx.now();
  const host = sourceHost(req.url);
  try {
    ctx.db.transaction((tx) =>
      recordKnowledgeChange(ctx, tx, actorOf(req), at, {
        action: 'knowledge.source.refused',
        after: { code, host, ...(opts.logUrl === false ? {} : { url: req.url.slice(0, 500) }), gapId: req.gapId ?? null },
        reason,
        runId: req.runId ?? null,
        jobId: req.jobId ?? null,
      }),
    );
  } catch (err) {
    ctx.logger.warn('could not audit a refused fetch', { error: String(err) });
  }
  return { ok: false, code, reason, link: opts.link ?? null, ...(opts.status !== undefined ? { status: opts.status } : {}) };
}

const ALLOWED_TYPES: Array<{ re: RegExp; ext: string; kind: 'html' | 'xml' | 'json' | 'pdf' | 'text' }> = [
  { re: /^text\/html|^application\/xhtml\+xml/i, ext: 'html', kind: 'html' },
  { re: /^application\/pdf/i, ext: 'pdf', kind: 'pdf' },
  { re: /^(?:application|text)\/(?:[\w.+-]+\+)?xml|^application\/atom\+xml/i, ext: 'xml', kind: 'xml' },
  { re: /^application\/(?:[\w.+-]+\+)?json/i, ext: 'json', kind: 'json' },
  { re: /^text\/plain/i, ext: 'txt', kind: 'text' },
];

async function pdfText(bytes: Uint8Array, maxPages = 80): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push((content.items as Array<{ str?: string }>).map((it) => it.str ?? '').join(' '));
      page.cleanup();
    }
    return pages.join('\n');
  } finally {
    await task.destroy();
  }
}

export async function readBody(res: FetchResponseLike): Promise<Uint8Array | null> {
  const len = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > MAX_FETCH_BYTES) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength > MAX_FETCH_BYTES ? null : buf;
}

/** robots.txt for the URL's host: cached 24 h on the source row; 4xx = allow all; 5xx / network = unavailable. */
export async function robotsCheck(ctx: AppContext, url: URL, row: { domain: string; robots: string | null; robotsCheckedAt: string | null } | undefined, doFetch: KnowledgeFetch, signal: AbortSignal, ua: string): Promise<'allow' | 'disallow' | 'unavailable'> {
  const fresh = row?.robotsCheckedAt && Date.parse(ctx.now()) - Date.parse(row.robotsCheckedAt) < 24 * 3_600_000;
  let text: string | null = fresh ? row!.robots : null;
  if (!fresh) {
    try {
      const res = await doFetch(`${url.protocol}//${url.host}/robots.txt`, { method: 'GET', headers: { 'User-Agent': ua, Accept: 'text/plain' }, redirect: 'manual', signal, credentials: 'omit' });
      if (res.status >= 200 && res.status < 300) text = new TextDecoder().decode((await readBody(res)) ?? new Uint8Array()).slice(0, 500_000);
      else if (res.status >= 400 && res.status < 500) text = '';
      else text = null;
    } catch {
      text = null;
    }
    if (row) {
      const at = ctx.now();
      ctx.repos.updateKnowledgeSource(ctx.db, row.domain, { robots: text, robotsCheckedAt: text === null ? null : at, updatedBy: 'agent:supervisor', updatedAt: at });
    }
  }
  if (text === null) return 'unavailable';
  return robotsAllows(parseRobots(text), ua, `${url.pathname}${url.search}`) ? 'allow' : 'disallow';
}

/** The stored text of a snapshot (null when the file was pruned or never written). */
export function readSnapshotText(ctx: AppContext, snap: Pick<SourceSnapshotRecord, 'textPath'>): string | null {
  if (!snap.textPath) return null;
  const p = path.isAbsolute(snap.textPath) ? snap.textPath : path.join(knowledgeStoreDir(ctx), snap.textPath);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

/** Fetch `req.url` as ClaimDesk (never a model) and store a dated copy. */
export async function fetchSource(ctx: AppContext, req: FetchRequest, deps: FetchDeps = {}): Promise<FetchResult> {
  const settings = getKnowledgeSettings(ctx);
  const dict = deps.dict ?? claimDictionaryFor(ctx);
  const guard = egressGuard(req.url, dict);
  if (!guard.ok) return refuse(ctx, req, 'EGRESS_REFUSED', `the address carries personal data or a claim identifier (${guard.kinds.join(', ')}); nothing was sent`, { logUrl: false });

  const extra = extraPolicies(ctx);
  const allowed = fetchAllowed(req.url, 'code', extra, settings);
  const source = effectiveSource(ctx, req.url);
  if (!allowed.ok) return refuse(ctx, req, 'NOT_ALLOWED', allowed.reason, { link: source && source.policy.policy !== 'deny' ? req.url : null });
  const policy: SourcePolicy = source!.policy;
  const row = source!.row;
  if (row && !row.enabled) return refuse(ctx, req, 'SOURCE_DISABLED', `${policy.domain} is switched off in Knowledge ▸ Sources`);

  if (req.reuseWithinHours && req.reuseWithinHours > 0) {
    const last = ctx.repos.latestSourceSnapshot(ctx.db, req.url);
    if (last && Date.parse(ctx.now()) - Date.parse(last.fetchedAt) < req.reuseWithinHours * 3_600_000) {
      const text = readSnapshotText(ctx, last);
      if (text !== null) return { ok: true, snapshot: last, reused: true, text };
    }
  }

  if (fetchesToday(ctx) >= settings.budgets.fetchesPerDay) return refuse(ctx, req, 'BUDGET_DAY', `today's fetch budget (${settings.budgets.fetchesPerDay}) is used up`);
  const day = londonDay(ctx.now());
  const perDay = Math.min(policy.perDay, row?.perDay ?? policy.perDay);
  if (row && row.fetchDay === day && row.fetchesToday >= perDay) return refuse(ctx, req, 'BUDGET_DOMAIN_DAY', `${policy.domain} has had its ${perDay} fetches today`);
  const perMinute = Math.min(policy.perMinute || settings.budgets.perDomainPerMinute, settings.budgets.perDomainPerMinute);
  if (!takeToken(ctx, policy.domain, perMinute)) return refuse(ctx, req, 'RATE_LIMITED', `${policy.domain} allows ${perMinute} fetches a minute; try again shortly`);

  const doFetch = knowledgeFetchOf(ctx, deps.fetch);
  const ua = knowledgeUserAgent(ctx);
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  deps.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const at = ctx.now();
  const countAttempt = (status: number | null, extraAfter: Record<string, unknown> = {}): void => {
    ctx.db.transaction((tx) => {
      recordKnowledgeChange(ctx, tx, actorOf(req), at, { action: 'knowledge.source.fetch', after: { url: req.url.slice(0, 500), domain: policy.domain, status, ...extraAfter }, reason: req.reason.slice(0, 500), runId: req.runId ?? null, jobId: req.jobId ?? null });
      if (row) ctx.repos.countKnowledgeSourceFetch(tx, row.domain, day, at, status);
    });
  };
  try {
    let current = new URL(req.url);
    if (!req.noRobots) {
      const robots = await robotsCheck(ctx, current, row, doFetch, ac.signal, ua);
      if (robots === 'disallow') return refuse(ctx, req, 'ROBOTS_DISALLOWED', `${current.host}'s robots.txt does not allow this page`, { link: req.url });
      if (robots === 'unavailable') return refuse(ctx, req, 'ROBOTS_UNAVAILABLE', `${current.host}'s robots.txt could not be read, so nothing was fetched`, { link: req.url });
    }
    let res: FetchResponseLike | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      res = await doFetch(current.toString(), { method: 'GET', headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,application/xml,application/json,application/pdf,text/plain;q=0.8' }, redirect: 'manual', signal: ac.signal, credentials: 'omit' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location')!, current);
        const ok = fetchAllowed(next.toString(), 'code', extra, settings);
        const g = egressGuard(next.toString(), dict);
        if (!ok.ok || !g.ok) {
          countAttempt(res.status, { redirectRefused: true });
          return refuse(ctx, req, 'REDIRECT_REFUSED', `the page redirects outside the allowed sources (${next.host})`, { link: req.url, logUrl: g.ok });
        }
        current = next;
        continue;
      }
      break;
    }
    if (!res || (res.status >= 300 && res.status < 400)) {
      countAttempt(res?.status ?? null);
      return refuse(ctx, req, 'REDIRECT_REFUSED', 'too many redirects', { link: req.url });
    }
    if (res.status < 200 || res.status >= 300) {
      countAttempt(res.status);
      return refuse(ctx, req, 'HTTP_ERROR', `${current.host} answered ${res.status}`, { link: req.url, status: res.status });
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const type = ALLOWED_TYPES.find((t) => t.re.test(contentType));
    if (!type) {
      countAttempt(res.status, { contentType });
      return refuse(ctx, req, 'CONTENT_TYPE', `${contentType || 'unknown content'} is not fetched (html, xml, json, pdf or text only)`, { link: req.url });
    }
    const body = await readBody(res);
    if (!body) {
      countAttempt(res.status, { tooLarge: true });
      return refuse(ctx, req, 'TOO_LARGE', 'the page is larger than 5 MB', { link: req.url });
    }
    const sha = createHash('sha256').update(body).digest('hex');
    const raw = type.kind === 'pdf' ? '' : new TextDecoder('utf-8').decode(body);
    let parsed: { text: string; title: string | null; hiddenText: boolean };
    if (type.kind === 'html' || type.kind === 'xml') parsed = htmlToText(raw);
    else if (type.kind === 'json') {
      let pretty = raw;
      try {
        pretty = JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        /* keep raw */
      }
      parsed = plainToText(pretty);
    } else if (type.kind === 'pdf') {
      let t = '';
      try {
        t = await pdfText(body);
      } catch (err) {
        ctx.logger.warn('could not read PDF text', { error: String(err) });
      }
      parsed = plainToText(t);
    } else parsed = plainToText(raw);

    const flags = new Set(injectionFlags(parsed.text, type.kind === 'html' || type.kind === 'xml' ? raw : null));
    if (parsed.hiddenText) flags.add('hidden_text');
    const textSha = createHash('sha256').update(parsed.text, 'utf8').digest('hex');
    const rel = path.join('snapshots', sha.slice(0, 2));
    const dir = path.join(knowledgeStoreDir(ctx), rel);
    mkdirSync(dir, { recursive: true });
    const rawRel = path.join(rel, `${sha}.${type.ext}`);
    const textRel = path.join(rel, `${sha}.txt`);
    if (!existsSync(path.join(knowledgeStoreDir(ctx), rawRel))) writeFileSync(path.join(knowledgeStoreDir(ctx), rawRel), body);
    if (!existsSync(path.join(knowledgeStoreDir(ctx), textRel))) writeFileSync(path.join(knowledgeStoreDir(ctx), textRel), parsed.text, 'utf8');
    const previous = ctx.repos.latestSourceSnapshot(ctx.db, req.url);
    const changed = previous ? (previous.textSha256 ?? previous.sha256) !== textSha : false;
    const effective = effectivePolicyKind(policy, settings);
    const snapshot = ctx.db.transaction((tx) => {
      const s = ctx.repos.insertSourceSnapshot(tx, {
        url: req.url,
        finalUrl: current.toString(),
        domain: policy.domain,
        fetchedAt: at,
        httpStatus: res!.status,
        contentType: contentType || null,
        bytes: body.byteLength,
        sha256: sha,
        storagePath: rawRel,
        textPath: textRel,
        textSha256: textSha,
        title: parsed.title,
        licence: policy.licence,
        extractAllowed: policy.extractAllowed && (row?.extractAllowed ?? true),
        previousId: previous?.id ?? null,
        changed,
        injectionFlags: [...flags],
        reason: req.reason.slice(0, 500),
        gapId: req.gapId ?? null,
        jobId: req.jobId ?? null,
        runId: req.runId ?? null,
        createdBy: req.createdBy,
      });
      recordKnowledgeChange(ctx, tx, actorOf(req), at, { action: 'knowledge.source.fetch', after: { url: req.url.slice(0, 500), domain: policy.domain, status: res!.status, snapshotId: s.id, changed, flags: [...flags], policy: effective }, reason: req.reason.slice(0, 500), runId: req.runId ?? null, jobId: req.jobId ?? null });
      if (row) ctx.repos.countKnowledgeSourceFetch(tx, row.domain, day, at, res!.status);
      return s;
    });
    return { ok: true, snapshot, reused: false, text: parsed.text };
  } catch (err) {
    const aborted = ac.signal.aborted;
    const code = (err as { code?: string }).code;
    if (code === 'NETWORK_FORBIDDEN') return refuse(ctx, req, 'NETWORK', 'this process may not reach the network', { link: req.url });
    countAttempt(null, { error: aborted ? 'timeout' : String(err).slice(0, 200) });
    return refuse(ctx, req, aborted ? 'TIMEOUT' : 'NETWORK', aborted ? 'the page took longer than 20 seconds' : `the page could not be fetched (${err instanceof Error ? err.message : String(err)})`.slice(0, 300), { link: req.url });
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}
