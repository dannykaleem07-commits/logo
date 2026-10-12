// owned by intake-web
/**
 * A stand-in for the ClaimDesk API in the case-bundle tests: routes `fetch` calls by method and path to handlers and
 * records every call (method, path, query, JSON body). No network is ever used.
 */
import raw from './bundleDetail.json';
import type { BundleDetail } from '../../../../api/bundlesApi';

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export type Handler = (call: RecordedCall) => { status?: number; body: unknown } | unknown;

export function jsonResponse(body: unknown, status = 200): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => (text ? (JSON.parse(text) as unknown) : undefined),
    text: async () => text,
  } as unknown as Response;
}

/** A fresh copy of the synthetic bundle detail (tests may change it freely). */
export function bundleDetail(): BundleDetail {
  return structuredClone(raw) as unknown as BundleDetail;
}

/**
 * `routes` maps "METHOD /path" (path without /api; `:param` segments match anything) to a handler. A handler returns a
 * body, or `{status, body}` for an error / other status. Unknown routes answer `{items: []}`.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const table = Object.entries(routes).map(([k, h]) => {
    const [method, pattern] = k.split(' ') as [string, string];
    const re = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '[^/]+')}$`);
    return { method, re, h };
  });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api/, '');
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body) body = init.body;
    const call: RecordedCall = { method, path, query: Object.fromEntries(url.searchParams), body };
    calls.push(call);
    const hit = table.find((r) => r.method === method && r.re.test(path));
    if (!hit) return jsonResponse({ items: [] });
    const out = hit.h(call) as { status?: number; body?: unknown } | unknown;
    if (out && typeof out === 'object' && 'status' in (out as object) && 'body' in (out as object)) {
      const o = out as { status: number; body: unknown };
      return jsonResponse(o.body, o.status);
    }
    return jsonResponse(out);
  };
  return { calls, fetch: fetchImpl, find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}
