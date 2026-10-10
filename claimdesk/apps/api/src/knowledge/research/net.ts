// owned by knowledge-research
/**
 * The fetcher's network seam (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.3, KR-11). Every fetch the Knowledge Builder makes
 * goes through `knowledgeFetchOf(ctx)`: tests inject a fake with `setKnowledgeFetch` (or pass `deps.fetch`), and a
 * process that forbids real AI / the network (CLAIMDESK_FORBID_REAL_AI=1, vitest) refuses to fall back to the real
 * global fetch, so no test ever reaches the network. GET only, no cookies, no credentials (an API key header only
 * where a source needs one).
 */
import type { AppContext } from '../../context.js';
import { appVersion } from '../../routes/health.js';
import { getKnowledgeSettings } from '../settings.js';

export interface FetchResponseLike {
  status: number;
  url?: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type KnowledgeFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal; credentials?: 'omit' }) => Promise<FetchResponseLike>;

export class NetworkForbiddenError extends Error {
  readonly code = 'NETWORK_FORBIDDEN';
  constructor() {
    super('This process may not reach the network (tests inject a fetch)');
  }
}

interface FetchServices {
  knowledgeFetch?: KnowledgeFetch;
}

/** Inject a fetch for this context (tests); returns a function that restores the previous one. */
export function setKnowledgeFetch(ctx: AppContext, fn: KnowledgeFetch | undefined): () => void {
  const s = ctx.services as unknown as FetchServices;
  const prev = s.knowledgeFetch;
  if (fn) s.knowledgeFetch = fn;
  else delete s.knowledgeFetch;
  return () => {
    if (prev) s.knowledgeFetch = prev;
    else delete s.knowledgeFetch;
  };
}

const networkForbidden = (): boolean => process.env.CLAIMDESK_FORBID_REAL_AI === '1' || Boolean(process.env.VITEST);

/** The fetch to use: an explicit override, the context's injected one, else the global fetch (never in tests). */
export function knowledgeFetchOf(ctx: AppContext, override?: KnowledgeFetch): KnowledgeFetch {
  if (override) return override;
  const injected = (ctx.services as unknown as FetchServices).knowledgeFetch;
  if (injected) return injected;
  if (networkForbidden()) {
    return async () => {
      throw new NetworkForbiddenError();
    };
  }
  return (url, init) => fetch(url, { ...init, credentials: 'omit' }) as unknown as Promise<FetchResponseLike>;
}

/** `ClaimDesk-KnowledgeBuilder/<version> (+<owner contact if set>)` (§7.3). */
export function knowledgeUserAgent(ctx: AppContext): string {
  const contact = getKnowledgeSettings(ctx).userAgentContact?.trim();
  return `ClaimDesk-KnowledgeBuilder/${appVersion()}${contact ? ` (+${contact.replace(/[\r\n()]/g, ' ').slice(0, 200)})` : ''}`;
}

export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
