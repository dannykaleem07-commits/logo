// @vitest-environment jsdom
/**
 * useExactModel: idle without a vehicle, loading → ready / none / error from the (faked) match call, one request per
 * vehicle while cached, paint from the colour, refresh re-asks. ExactModelView renders nothing without a model.
 */
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearExactModelCache, useExactModel, type ExactModelFetcher } from './useExactModel';
import { ExactModelView } from './index';
import type { Model3dMatch, Model3dView } from './exactApi';

const VIEW = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Fiesta Mk7',
  fileUrl: '/models3d/00000000-0000-4000-8000-000000000001/model.glb',
  zones: { n0p0: 'front_door_l' },
  assignment: { makeSlug: 'ford', make: 'Ford', modelSlug: 'fiesta', model: 'Fiesta' },
} as unknown as Model3dView;

afterEach(cleanup);
beforeEach(() => clearExactModelCache());

describe('useExactModel', () => {
  it('is idle without a vehicle to match', () => {
    const fetcher = vi.fn<ExactModelFetcher>();
    const { result } = renderHook(() => useExactModel({ model: 'Fiesta' }, { fetcher }));
    expect(result.current.status).toBe('idle');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('finds a model, builds its URL and paints in the vehicle colour', async () => {
    const fetcher = vi.fn<ExactModelFetcher>(async () => ({ model: VIEW, matchedOn: 'year' }) satisfies Model3dMatch);
    const { result } = renderHook(() => useExactModel({ make: 'FORD', model: 'FIESTA', year: 2014, colour: 'BLUE', registration: 'KX14ABC' }, { fetcher }));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.url).toBe('/api/models3d/00000000-0000-4000-8000-000000000001/model.glb');
    expect(result.current.matchedOn).toBe('year');
    expect(result.current.registration).toBe('KX14ABC');
    expect(result.current.paint.fallback).toBeFalsy();
    expect(fetcher).toHaveBeenCalledWith({ make: 'FORD', model: 'FIESTA', year: 2014 }, expect.anything());

    // a second component for the same vehicle uses the cache
    const again = renderHook(() => useExactModel({ make: 'FORD', model: 'FIESTA', year: 2014 }, { fetcher }));
    await waitFor(() => expect(again.result.current.status).toBe('ready'));
    expect(fetcher).toHaveBeenCalledTimes(1);

    // refresh asks again
    act(() => result.current.refresh());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('reports none and error without throwing', async () => {
    const none = renderHook(() => useExactModel({ make: 'VW', model: 'Golf' }, { fetcher: async () => ({ model: null, matchedOn: null }) }));
    await waitFor(() => expect(none.result.current.status).toBe('none'));
    const failing = renderHook(() => useExactModel({ make: 'VW', model: 'Polo' }, { fetcher: async () => Promise.reject(new Error('offline')) }));
    await waitFor(() => expect(failing.result.current.status).toBe('error'));
    expect(failing.result.current.error).toBe('offline');
  });

  it('does not look when disabled', () => {
    const fetcher = vi.fn<ExactModelFetcher>();
    const { result } = renderHook(() => useExactModel({ make: 'FORD', model: 'FIESTA' }, { fetcher, enabled: false }));
    expect(result.current.status).toBe('idle');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('ExactModelView', () => {
  it('renders nothing when there is no model (the caller keeps the generated one)', async () => {
    const exact = { status: 'none' as const, model: null, url: null, matchedOn: null, paint: { name: '', hex: '#ccc', finish: 'metallic' as const, fallback: true }, refresh: () => {} };
    const { container } = render(<ExactModelView exact={exact} damage={{}} hovered={null} selected={null} view="iso" viewNonce={0} onHover={() => {}} onPick={() => {}} />);
    await waitFor(() => expect(container.querySelector('.dm3-loading')).toBeNull());
    expect(container.textContent).toBe('');
  });
});
