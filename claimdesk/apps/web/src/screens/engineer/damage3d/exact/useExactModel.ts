/**
 * useExactModel(vehicle): is there an imported, licensed 3D model for this make / model / generation (/ body)?
 *
 *   const exact = useExactModel({ make: 'FORD', model: 'FIESTA', year: 2014, colour: 'Magnetic Grey', registration: 'KX14ABC' });
 *   exact.status === 'ready' → <ExactModelView exact={exact} … /> instead of the generated model.
 *
 * No react-query (the damage model is also rendered outside a QueryClientProvider): a small module cache keyed by the
 * match query keeps one request per vehicle for 60 seconds. Never throws: any failure reads as 'none' / 'error' and
 * the caller keeps the generated model.
 */
import { useEffect, useMemo, useState } from 'react';
import { paintFor, type Paint } from '../paint';
import { apiUrl, models3dApi, type MatchedOn, type Model3dMatch, type Model3dMatchQuery, type Model3dView } from './exactApi';
import { matchKey, matchQueryFor, type ExactModelVehicle } from './exactModel';

export type ExactModelStatus = 'idle' | 'loading' | 'none' | 'ready' | 'error';

export interface ExactModelState {
  status: ExactModelStatus;
  /** The matched model (status 'ready'). */
  model: Model3dView | null;
  /** Same-origin URL of the model's GLB. */
  url: string | null;
  matchedOn: MatchedOn | null;
  /** The vehicle's paint (paintFor(colour)); `fallback` = colour unknown → the model keeps its own colour. */
  paint: Paint;
  registration?: string;
  error?: string;
  /** Re-run the match (after an upload or an edit in Settings). */
  refresh: () => void;
}

export type ExactModelFetcher = (q: Model3dMatchQuery, signal: AbortSignal) => Promise<Model3dMatch>;

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; promise: Promise<Model3dMatch> }>();

/** Forget cached matches (Settings calls this after an upload, edit or delete). */
export function clearExactModelCache(): void {
  cache.clear();
}

function cachedMatch(key: string, q: Model3dMatchQuery, fetcher: ExactModelFetcher): Promise<Model3dMatch> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  // the cached request is not tied to one component's signal; a component that unmounts just ignores the answer
  const promise = fetcher(q, new AbortController().signal).catch((e: unknown) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  return promise;
}

export interface UseExactModelOptions {
  /** false = do not look (e.g. the 2D fallback, print). Default true. */
  enabled?: boolean;
  /** Replace the network call (tests, demos). */
  fetcher?: ExactModelFetcher;
}

export function useExactModel(vehicle: ExactModelVehicle | null | undefined, opts: UseExactModelOptions = {}): ExactModelState {
  const enabled = opts.enabled ?? true;
  const q = useMemo(() => matchQueryFor(vehicle), [vehicle?.make, vehicle?.model, vehicle?.makeSlug, vehicle?.modelSlug, vehicle?.generation, vehicle?.generationId, vehicle?.body, vehicle?.bodyType, vehicle?.year, vehicle?.yearOfManufacture, vehicle?.spec?.catalogue?.makeSlug, vehicle?.spec?.catalogue?.modelSlug, vehicle?.spec?.catalogue?.generationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = matchKey(q);
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<{ key: string; match?: Model3dMatch; error?: string } | null>(null);
  const fetcher = opts.fetcher ?? ((query, signal) => models3dApi.match(query, signal));

  useEffect(() => {
    if (!enabled || !q) return;
    let live = true;
    cachedMatch(key, q, fetcher)
      .then((match) => {
        if (live) setResult({ key, match });
      })
      .catch((e: unknown) => {
        if (live) setResult({ key, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [enabled, key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const paint = useMemo(() => paintFor(vehicle?.colour), [vehicle?.colour]);
  const refresh = useMemo(
    () => () => {
      cache.delete(key);
      setNonce((n) => n + 1);
    },
    [key]
  );

  const base = { paint, refresh, ...(vehicle?.registration ? { registration: vehicle.registration } : {}) };
  if (!enabled || !q) return { status: 'idle', model: null, url: null, matchedOn: null, ...base };
  if (!result || result.key !== key) return { status: 'loading', model: null, url: null, matchedOn: null, ...base };
  if (result.error) return { status: 'error', model: null, url: null, matchedOn: null, error: result.error, ...base };
  const m = result.match?.model ?? null;
  if (!m) return { status: 'none', model: null, url: null, matchedOn: null, ...base };
  return { status: 'ready', model: m, url: apiUrl(m.fileUrl), matchedOn: result.match?.matchedOn ?? null, ...base };
}
