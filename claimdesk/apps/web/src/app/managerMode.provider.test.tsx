// @vitest-environment jsdom
/**
 * ManagerModeProvider (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.5.2): the body class, the header the client sends,
 * the idle switch-off and the heartbeat — with fake timers and a fake server behind `fetch`.
 */
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../api/client';
import { getManagerOverrideReason } from '../api/client';
import type { ManagerModeView } from '../api/managerApi';
import { renderWithProviders } from '../test/harness';
import { HEARTBEAT_MAX_MS, IDLE_CHECK_MS, ManagerModeProvider, useManagerMode } from './managerMode';
import { clearSignedInState } from './session';

const ADMIN: AuthUser = { id: 'courtesycars', name: 'Courtesy Cars', username: 'courtesycars', email: 'claims@courtesycars.net', role: 'admin' };
const HANDLER: AuthUser = { id: 'h1', name: 'Hannah Handler', username: 'hannah', email: 'h@example.com', role: 'handler' };

interface Posted {
  on: boolean;
  why?: string;
  headers: Record<string, string>;
}

let server: ManagerModeView;
let posts: Posted[];

function view(over: Partial<ManagerModeView> = {}): ManagerModeView {
  return { allowed: true, on: false, idleMinutes: 60, defaultReason: 'Manager override', ...over };
}

function Probe() {
  const mm = useManagerMode();
  return (
    <div>
      <span data-testid="state">{mm.on ? 'on' : 'off'}</span>
      <span data-testid="allowed">{mm.allowed ? 'allowed' : 'not allowed'}</span>
      <button type="button" onClick={() => void mm.turnOn()}>
        turn on
      </button>
    </div>
  );
}

function renderProvider(user: AuthUser, initial: ManagerModeView) {
  server = { ...initial };
  return renderWithProviders(
    <ManagerModeProvider>
      <Probe />
    </ManagerModeProvider>,
    { queryData: [[['auth', 'me'], user], [['auth', 'manager-mode'], initial]] }
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-05T09:00:00Z'));
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = String(init.method ?? 'GET');
      if (url.startsWith('/api/auth/manager-mode') && method === 'POST') {
        const body = JSON.parse(String(init.body)) as { on: boolean; why?: string };
        posts.push({ ...body, headers: { ...(init.headers as Record<string, string>) } });
        server = { ...server, on: body.on };
      }
      if (url.startsWith('/api/auth/manager-mode')) return new Response(JSON.stringify(server), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: url } }), { status: 404, headers: { 'content-type': 'application/json' } });
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.classList.remove('manager-mode');
});

describe('ManagerModeProvider', () => {
  it('sets the body class and the X-Manager-Override reason while on, and clears both when off', async () => {
    const r = renderProvider(ADMIN, view({ on: true }));
    expect(screen.getByTestId('state').textContent).toBe('on');
    expect(document.body.classList.contains('manager-mode')).toBe(true);
    expect(getManagerOverrideReason()).toBe('Manager override');
    await act(async () => {
      r.queryClient.setQueryData(['auth', 'manager-mode'], view({ on: false }));
      // React Query batches observer notifications on a setTimeout(0), which the fake timers hold back.
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.classList.contains('manager-mode')).toBe(false);
    expect(getManagerOverrideReason()).toBeNull();
    r.unmount();
  });

  it('turns on with one click (POST {on:true}) for an admin; a handler is not allowed', async () => {
    const r = renderProvider(ADMIN, view());
    expect(screen.getByTestId('allowed').textContent).toBe('allowed');
    await act(async () => {
      screen.getByText('turn on').click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posts.map((p) => p.on)).toEqual([true]);
    expect(screen.getByTestId('state').textContent).toBe('on');
    expect(document.body.classList.contains('manager-mode')).toBe(true);
    r.unmount();
    const h = renderProvider(HANDLER, view({ allowed: false }));
    expect(screen.getByTestId('allowed').textContent).toBe('not allowed');
    h.unmount();
  });

  it('switches itself off after N idle minutes, with a toast', async () => {
    const r = renderProvider(ADMIN, view({ on: true, idleMinutes: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS); // 30 s: still on
    });
    expect(posts).toEqual([]);
    expect(screen.getByTestId('state').textContent).toBe('on');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS); // 60 s without activity
    });
    expect(posts.map((p) => [p.on, p.why])).toEqual([[false, 'idle']]);
    expect(screen.getByTestId('state').textContent).toBe('off');
    expect(document.body.classList.contains('manager-mode')).toBe(false);
    expect(getManagerOverrideReason()).toBeNull();
    expect(screen.getByText('Manager mode switched off after 1 minute without activity')).toBeTruthy();
    r.unmount();
  });

  it('says so when the server reports it off before the idle check runs (refetch wins the race)', async () => {
    const r = renderProvider(ADMIN, view({ on: true, idleMinutes: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
      r.queryClient.setQueryData(['auth', 'manager-mode'], view({ on: false, idleMinutes: 1 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('state').textContent).toBe('off');
    expect(document.body.classList.contains('manager-mode')).toBe(false);
    expect(screen.getByText('Manager mode switched off after 1 minute without activity')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS * 2);
    });
    expect(posts).toEqual([]); // the idle tick did not run again on an off state
    r.unmount();
  });

  it('a switch-off made here toasts once (idle), not twice', async () => {
    const r = renderProvider(ADMIN, view({ on: true, idleMinutes: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_MS * 2);
    });
    expect(screen.getAllByText('Manager mode switched off after 1 minute without activity')).toHaveLength(1);
    // a refetch that was already in flight briefly says "on", then the server's "off": still one toast
    await act(async () => {
      r.queryClient.setQueryData(['auth', 'manager-mode'], view({ on: true, idleMinutes: 1 }));
      await vi.advanceTimersByTimeAsync(0);
      r.queryClient.setQueryData(['auth', 'manager-mode'], view({ on: false, idleMinutes: 1 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('Manager mode was switched off')).toBeNull();
    expect(screen.getAllByText('Manager mode switched off after 1 minute without activity')).toHaveLength(1);
    r.unmount();
  });

  it('sign-out leaves the page without the manager-mode bar or header, and without a toast', async () => {
    const r = renderProvider(ADMIN, view({ on: true }));
    expect(document.body.classList.contains('manager-mode')).toBe(true);
    await act(async () => {
      clearSignedInState(r.queryClient);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.body.classList.contains('manager-mode')).toBe(false);
    expect(getManagerOverrideReason()).toBeNull();
    expect(screen.getByTestId('state').textContent).toBe('off');
    expect(screen.queryByText(/switched off/)).toBeNull();
    // and it stays off: nothing re-adds the class on the next render
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(document.body.classList.contains('manager-mode')).toBe(false);
    r.unmount();
  });

  it('activity keeps it on', async () => {
    const r = renderProvider(ADMIN, view({ on: true, idleMinutes: 1 }));
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
        window.dispatchEvent(new Event('pointerdown'));
      });
    }
    expect(posts.some((p) => !p.on)).toBe(false);
    expect(screen.getByTestId('state').textContent).toBe('on');
    r.unmount();
  });

  it('activity sends a heartbeat (POST {on:true}) at most every 5 minutes', async () => {
    const r = renderProvider(ADMIN, view({ on: true, idleMinutes: 60 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posts).toEqual([]); // under 5 minutes since it came on
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MAX_MS - 4 * 60_000);
      window.dispatchEvent(new Event('wheel'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posts.map((p) => p.on)).toEqual([true]);
    expect(posts[0]!.headers['X-Manager-Override']).toBe('Manager%20override');
    await act(async () => {
      window.dispatchEvent(new Event('touchstart'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
      await vi.advanceTimersByTimeAsync(60_000);
      window.dispatchEvent(new Event('pointerdown'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posts).toHaveLength(1); // throttled
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MAX_MS);
      window.dispatchEvent(new Event('pointerdown'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posts).toHaveLength(2);
    r.unmount();
  });

  it('a short idle period heartbeats often enough to keep the server from expiring first', async () => {
    const r = renderProvider(ADMIN, view({ on: true, idleMinutes: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      window.dispatchEvent(new Event('pointerdown'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posts.map((p) => p.on)).toEqual([true]);
    r.unmount();
  });
});
