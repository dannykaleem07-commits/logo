/**
 * In-app update check (docs/V03-MANAGER-MODE-HIRE-PRICING.md §F.3). The server asks GitHub for the ClaimDesk releases
 * (the page's CSP only allows `connect-src 'self'`), keeps the highest `claimdesk-v<version>` release — prereleases
 * included, since 0.1.x/0.2.x were published as prereleases and `/releases/latest` would skip them — and tells the
 * Settings → Updates card whether a newer Setup exists. It never throws and never blocks the app: no internet is
 * `offline`, anything unexpected is `error`, and `CLAIMDESK_UPDATE_CHECK=off` switches it off.
 */
import type { AppContext } from '../context.js';
import { appVersion } from '../routes/health.js';

export interface UpdateCheck {
  status: 'ok' | 'offline' | 'error' | 'disabled';
  current: string;
  latest?: string;
  updateAvailable: boolean;
  release?: { tag: string; name: string; publishedAt?: string; htmlUrl: string; notes?: string /* body, ≤ 4000 chars */ };
  download?: { name: string; url: string; size?: number; sha256?: string };
  checkedAt: string;
  message?: string;
}

export const DEFAULT_UPDATE_URL = 'https://api.github.com/repos/dannykaleem07-commits/logo/releases?per_page=30';
export const RELEASES_PAGE_URL = 'https://github.com/dannykaleem07-commits/logo/releases';
export const UPDATE_CHECK_TIMEOUT_MS = 6_000;
/** A normal check is answered from the cache for an hour. */
export const UPDATE_CACHE_MS = 60 * 60 * 1000;
/** "Check now" (force) goes back to GitHub at most once a minute. */
export const UPDATE_FORCE_MIN_MS = 60 * 1000;
/** An offline or failed check is kept only briefly: a PC that started before its network was up soon asks again. */
export const UPDATE_RETRY_MS = 5 * 60 * 1000;
const NOTES_MAX = 4000;

const TAG = /^claimdesk-v(\d+(?:\.\d+){0,3})$/;

/** 'claimdesk-v0.3.12' → '0.3.12'; anything else (other products' tags, 'callpilot-latest', …) → undefined. */
export function parseClaimDeskTag(tag: string): string | undefined {
  const m = TAG.exec(tag.trim());
  return m ? m[1] : undefined;
}

function parts(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]!
    .split('.')
    .map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** Numeric per part ('0.3.10' > '0.3.9'; missing parts count as 0). Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

interface GitHubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
  digest?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  body?: unknown;
  assets?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

function pickAsset(assets: unknown, version: string): UpdateCheck['download'] {
  if (!Array.isArray(assets)) return undefined;
  const list = assets as GitHubAsset[];
  const exact = `ClaimDesk-Setup-${version}.exe`.toLowerCase();
  const asset =
    list.find((a) => str(a.name)?.toLowerCase() === exact) ?? list.find((a) => /^claimdesk-setup-.*\.exe$/i.test(str(a.name) ?? ''));
  const name = str(asset?.name);
  const url = str(asset?.browser_download_url);
  if (!asset || !name || !url) return undefined;
  const out: NonNullable<UpdateCheck['download']> = { name, url };
  if (typeof asset.size === 'number' && Number.isFinite(asset.size) && asset.size > 0) out.size = asset.size;
  const digest = str(asset.digest);
  const sha = digest && /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  if (sha) out.sha256 = sha[1]!.toLowerCase();
  return out;
}

export interface CheckForUpdatesOptions {
  current: string;
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now: () => string;
}

/** One check against the releases list. Never throws. */
export async function checkForUpdates(opts: CheckForUpdatesOptions): Promise<UpdateCheck> {
  const { current } = opts;
  const base = (status: UpdateCheck['status'], message?: string): UpdateCheck => ({
    status,
    current,
    updateAvailable: false,
    checkedAt: opts.now(),
    ...(message ? { message } : {}),
  });
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS);
  let text: string;
  try {
    let res: Response;
    try {
      res = await fetchImpl(opts.url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ClaimDesk/${current}` },
        signal: controller.signal,
      });
    } catch {
      return base('offline', 'Could not reach the update server (no internet connection?).');
    }
    if (res.status !== 200) return base('error', `The update server answered ${res.status}.`);
    try {
      text = await res.text();
    } catch {
      return base('offline', 'The connection to the update server was interrupted.');
    }
  } finally {
    clearTimeout(timer);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return base('error', 'The update server sent something that is not a list of releases.');
  }
  if (!Array.isArray(data)) return base('error', 'The update server sent something that is not a list of releases.');

  let best: { version: string; release: GitHubRelease } | undefined;
  for (const r of data as GitHubRelease[]) {
    if (!r || typeof r !== 'object' || r.draft === true) continue;
    const tag = str(r.tag_name);
    const version = tag ? parseClaimDeskTag(tag) : undefined;
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, release: r };
  }
  if (!best) return { ...base('ok', 'No ClaimDesk releases were found.') };

  const r = best.release;
  const tag = str(r.tag_name)!;
  const notes = str(r.body);
  const release: NonNullable<UpdateCheck['release']> = {
    tag,
    name: str(r.name) ?? `ClaimDesk ${best.version}`,
    htmlUrl: str(r.html_url) ?? `${RELEASES_PAGE_URL}/tag/${encodeURIComponent(tag)}`,
  };
  const publishedAt = str(r.published_at);
  if (publishedAt) release.publishedAt = publishedAt;
  if (notes) release.notes = notes.length > NOTES_MAX ? `${notes.slice(0, NOTES_MAX - 1)}…` : notes;
  const out: UpdateCheck = { ...base('ok'), latest: best.version, updateAvailable: compareVersions(best.version, current) > 0, release };
  const download = pickAsset(r.assets, best.version);
  if (download) out.download = download;
  return out;
}

export interface UpdatesServiceOptions {
  /** Test seam (default globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Default process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface UpdatesService {
  check(force?: boolean): Promise<UpdateCheck>;
}

interface CacheState {
  result?: UpdateCheck;
  /** ms (ctx.now) of the last check that went to the network. */
  at?: number;
  inFlight?: Promise<UpdateCheck>;
}

const caches = new WeakMap<AppContext, CacheState>();

/** Whether CLAIMDESK_UPDATE_CHECK switches the check off ('off', 'false', '0', 'no', 'disabled'). */
export function updateChecksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CLAIMDESK_UPDATE_CHECK?.trim().toLowerCase();
  return v === 'off' || v === 'false' || v === '0' || v === 'no' || v === 'disabled';
}

/**
 * The per-process update checker: answers from a 1 h cache, `force` re-checks at most once a minute, concurrent
 * callers share one request. The cache lives with the AppContext (one per process, one per test app).
 */
export function updatesServiceFor(ctx: AppContext, options: UpdatesServiceOptions = {}): UpdatesService {
  let state = caches.get(ctx);
  if (!state) {
    state = {};
    caches.set(ctx, state);
  }
  const s = state;
  return {
    async check(force = false) {
      const env = options.env ?? process.env;
      const current = appVersion(env);
      if (updateChecksDisabled(env)) {
        return { status: 'disabled', current, updateAvailable: false, checkedAt: ctx.now(), message: 'Update checks are switched off on this computer.' };
      }
      const nowMs = Date.parse(ctx.now());
      if (s.inFlight) return s.inFlight;
      if (s.result && s.at !== undefined && s.result.current === current) {
        const age = nowMs - s.at;
        const ttl = force ? UPDATE_FORCE_MIN_MS : s.result.status === 'ok' ? UPDATE_CACHE_MS : UPDATE_RETRY_MS;
        if (age >= 0 && age < ttl) return s.result;
      }
      const url = env.CLAIMDESK_UPDATE_URL?.trim() || DEFAULT_UPDATE_URL;
      s.inFlight = checkForUpdates({ current, url, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, now: ctx.now })
        .then((result) => {
          s.result = result;
          s.at = nowMs;
          if (result.status !== 'ok') ctx.logger.info('update check did not complete', { status: result.status, message: result.message });
          return result;
        })
        .finally(() => {
          s.inFlight = undefined;
        });
      return s.inFlight;
    },
  };
}
