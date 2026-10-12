// @vitest-environment jsdom
/** useAiInput: a poll that brings a new status refreshes the panel and the history (their chips never lag behind). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimAiKeys, useAiInput } from './claimAiApi';
import { mockApi } from '../screens/intake/bundles/__fixtures__/mockApi';
import { catchUpDetail } from '../screens/claim/ai/__fixtures__/fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('useAiInput', () => {
  it('invalidates the panel and the history when the input status changes, not on every poll', async () => {
    const reading = { ...catchUpDetail(), status: 'reading' };
    let current: unknown = reading;
    vi.stubGlobal('fetch', vi.fn(mockApi({ 'GET /claims/:id/ai-input/:inputId': () => current }).fetch));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useAiInput('c1', reading.id), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe('reading'));
    await qc.refetchQueries({ queryKey: claimAiKeys.input('c1', reading.id) });
    expect(spy).not.toHaveBeenCalled(); // same status: nothing else refetched
    current = { ...reading, status: 'partly_applied' };
    await qc.refetchQueries({ queryKey: claimAiKeys.input('c1', reading.id) });
    await waitFor(() => expect(result.current.data?.status).toBe('partly_applied'));
    await waitFor(() => expect(spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toEqual(expect.arrayContaining([JSON.stringify(claimAiKeys.panel('c1')), JSON.stringify(['claim-ai', 'c1', 'history'])])));
  });
});
