/**
 * Manager mode in the web app (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.5.2).
 *
 * - Reads `GET /auth/manager-mode` under the query key ['auth', 'manager-mode'] (the server decides; 401 → off).
 * - While on: every mutation carries `X-Manager-Override: <reason>` (api/client.ts), `<body>` has class `manager-mode`,
 *   activity sends a heartbeat at most every 5 minutes, and N minutes without activity switch it off.
 * - Registers the client hooks: the "Overridden: …" toast, the "This is blocked — override as manager?" prompt and the
 *   silent re-activation when the server let it expire.
 * Mounted in main.tsx inside QueryClientProvider and ToastProvider, around the router.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isManagerRole } from '@ccguk/domain';
import { getManagerOverrideReason, onManagerOverrides, setManagerModeReactivator, setManagerOverrideReason, setOverridePromptHandler, type ApiError, type OverrideDecision } from '../api/client';
import { useMe } from '../api/hooks';
import { getManagerMode, managerQk, OFF_VIEW, setManagerMode, type ManagerModeView } from '../api/managerApi';
import { OverridePrompt } from '../components/OverridePrompt';
import { useToast } from '../components/Toast';

export interface ManagerModeApi {
  /** Signed-in role is admin or approver. */
  allowed: boolean;
  on: boolean;
  until?: string;
  idleMinutes: number;
  /** Banner reason box, default 'Manager override'. */
  reason: string;
  setReason(reason: string): void;
  turnOn(): Promise<void>;
  turnOff(why?: 'user' | 'idle'): Promise<void>;
  pending: boolean;
}

export const DEFAULT_MANAGER_REASON = 'Manager override';
/** How often the idle check runs. */
export const IDLE_CHECK_MS = 30_000;
/** Activity while on refreshes the server's sliding expiry at most this often (and at least twice per idle period). */
export const HEARTBEAT_MAX_MS = 5 * 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
/** After a switch-off made here, a server answer saying "off" is not news for this long. */
const LOCAL_OFF_QUIET_MS = 10_000;

const STUB: ManagerModeApi = {
  allowed: false,
  on: false,
  idleMinutes: 60,
  reason: DEFAULT_MANAGER_REASON,
  setReason: () => undefined,
  turnOn: async () => undefined,
  turnOff: async () => undefined,
  pending: false,
};

const ManagerModeContext = createContext<ManagerModeApi>(STUB);

/** Manager mode for this screen. Outside the provider: off, not allowed, no-op actions. */
export function useManagerMode(): ManagerModeApi {
  return useContext(ManagerModeContext);
}

export function minutesText(n: number): string {
  return `${n} minute${n === 1 ? '' : 's'}`;
}

/** Labels of one response's overrides → "Overridden: A; B — reason". */
export function overriddenToastText(applied: ReadonlyArray<{ label: string; reason: string }>): string {
  const labels = applied.map((a) => a.label).join('; ');
  const reason = applied.find((a) => a.reason)?.reason ?? DEFAULT_MANAGER_REASON;
  return `Overridden: ${labels} — ${reason}`;
}

/** The banner reason survives a page reload in this tab (a per-viewer convenience; storage may be unavailable). */
const REASON_STORAGE_KEY = 'claimdesk.managerReason';
function readStoredReason(): string {
  try {
    const v = window.sessionStorage.getItem(REASON_STORAGE_KEY);
    return v && v.trim() ? v.slice(0, 500) : DEFAULT_MANAGER_REASON;
  } catch {
    return DEFAULT_MANAGER_REASON;
  }
}
function storeReason(reason: string | null): void {
  try {
    if (reason === null || reason === DEFAULT_MANAGER_REASON) window.sessionStorage.removeItem(REASON_STORAGE_KEY);
    else window.sessionStorage.setItem(REASON_STORAGE_KEY, reason);
  } catch {
    // private window or blocked storage: the reason simply resets on reload
  }
}

interface PromptState {
  error: ApiError;
  resolve: (d: OverrideDecision) => void;
}

export function ManagerModeProvider({ children }: { children: ReactNode }): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const user = me.data ?? null;
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: managerQk.mode,
    queryFn: ({ signal }) => getManagerMode(signal),
    enabled: Boolean(userId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => ((q.state.data as ManagerModeView | undefined)?.on ? 60_000 : false),
    retry: 0,
  });
  const view: ManagerModeView = userId ? (query.data ?? OFF_VIEW) : OFF_VIEW;
  const on = Boolean(userId) && view.on;
  const allowed = Boolean(userId) && (query.data ? view.allowed : isManagerRole(user?.role));
  const idleMinutes = view.idleMinutes;

  const [reason, setReasonState] = useState(() => (typeof window === 'undefined' ? DEFAULT_MANAGER_REASON : readStoredReason()));
  const [pending, setPending] = useState(false);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);

  // Latest values for the long-lived listeners registered once below.
  const reasonRef = useRef(reason);
  reasonRef.current = reason;
  const onRef = useRef(on);
  onRef.current = on;
  const idleRef = useRef(idleMinutes);
  idleRef.current = idleMinutes;
  const lastActivity = useRef(Date.now());
  const lastHeartbeat = useRef(Date.now());
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const effectiveReason = (r: string) => r.trim() || DEFAULT_MANAGER_REASON;

  // The client sends the header while on; the body class follows.
  useEffect(() => {
    setManagerOverrideReason(on ? effectiveReason(reason) : null);
  }, [on, reason]);
  useEffect(() => {
    document.body.classList.toggle('manager-mode', on);
    if (on) {
      lastActivity.current = Date.now();
      lastHeartbeat.current = Date.now();
    }
  }, [on]);
  useEffect(
    () => () => {
      setManagerOverrideReason(null);
      document.body.classList.remove('manager-mode');
    },
    []
  );

  // A different user (or nobody) signed in: forget the previous session's manager mode.
  const prevUser = useRef<string | null | undefined>(undefined);
  const meKnown = me.data !== undefined; // undefined while GET /auth/me is still loading
  useEffect(() => {
    if (!meKnown || prevUser.current === userId) return;
    const first = prevUser.current === undefined;
    prevUser.current = userId;
    if (first && userId) return; // first sign-in seen by this page: keep the reason restored for this tab
    setManagerOverrideReason(null);
    setReasonState(DEFAULT_MANAGER_REASON);
    storeReason(null);
    if (!userId) qc.removeQueries({ queryKey: managerQk.mode, exact: true });
    else void qc.invalidateQueries({ queryKey: managerQk.mode, exact: true });
  }, [meKnown, userId, qc]);

  const store = useCallback((v: ManagerModeView) => qc.setQueryData(managerQk.mode, v), [qc]);

  // Switched off by the server (its idle expiry won the race, or another tab turned it off): say so. A switch-off
  // made here (turnOff) toasts for itself; a sign-out (no user) needs no toast.
  const localOffAt = useRef(0);
  const prevOn = useRef(on);
  useEffect(() => {
    const was = prevOn.current;
    prevOn.current = on;
    // turnOff ran in the last few seconds: it says so itself (its own toast, or none for a user click)
    if (on || !was || !userId || Date.now() - localOffAt.current < LOCAL_OFF_QUIET_MS) return;
    const minutes = idleRef.current;
    const idle = Date.now() - lastActivity.current >= minutes * 60_000 - IDLE_CHECK_MS;
    toastRef.current.push(idle ? `Manager mode switched off after ${minutesText(minutes)} without activity` : 'Manager mode was switched off', 'info', 10_000);
  }, [on, userId]);

  const turnOn = useCallback(async () => {
    setPending(true);
    try {
      const v = await setManagerMode(true, 'user');
      store(v);
      if (v.on) {
        setManagerOverrideReason(effectiveReason(reasonRef.current));
        lastActivity.current = Date.now();
        lastHeartbeat.current = Date.now();
      }
    } finally {
      setPending(false);
    }
  }, [store]);

  const turnOff = useCallback(
    async (why: 'user' | 'idle' = 'user') => {
      // Stop sending the header at once, whatever the server says.
      localOffAt.current = Date.now();
      setManagerOverrideReason(null);
      // a refetch still in flight would put the old "on" back for a moment (and look like a second switch-off)
      void qc.cancelQueries({ queryKey: managerQk.mode, exact: true });
      const { until: _until, ...was } = (qc.getQueryData(managerQk.mode) as ManagerModeView | undefined) ?? OFF_VIEW;
      void _until;
      store({ ...was, on: false });
      setPending(true);
      try {
        store(await setManagerMode(false, why));
      } catch (e) {
        void qc.invalidateQueries({ queryKey: managerQk.mode, exact: true });
        throw e;
      } finally {
        setPending(false);
      }
    },
    [qc, store]
  );
  const turnOffRef = useRef(turnOff);
  turnOffRef.current = turnOff;

  // Activity: idle turn-off and the heartbeat.
  useEffect(() => {
    if (!on) return;
    const heartbeatEvery = () => Math.min(HEARTBEAT_MAX_MS, Math.max(30_000, (idleRef.current * 60_000) / 2));
    const onActivity = () => {
      const now = Date.now();
      lastActivity.current = now;
      if (onRef.current && now - lastHeartbeat.current >= heartbeatEvery()) {
        lastHeartbeat.current = now;
        setManagerMode(true, 'user')
          .then((v) => store(v))
          .catch(() => undefined);
      }
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true });
    const timer = window.setInterval(() => {
      if (!onRef.current) return;
      const minutes = idleRef.current;
      if (Date.now() - lastActivity.current >= minutes * 60_000) {
        turnOffRef
          .current('idle')
          .catch(() => undefined)
          .finally(() => toastRef.current.push(`Manager mode switched off after ${minutesText(minutes)} without activity`, 'info', 10_000));
      }
    }, IDLE_CHECK_MS);
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity);
      window.clearInterval(timer);
    };
  }, [on, store]);

  // Client hooks: override toasts, the prompt, and re-activation after a server-side expiry.
  const promptQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const offToasts = onManagerOverrides((applied) => {
      toastRef.current.push(overriddenToastText(applied), 'warn', 7000);
      void qc.invalidateQueries({ queryKey: ['auth', 'manager-mode', 'log'] });
    });
    const ask = (error: ApiError) =>
      new Promise<OverrideDecision>((resolve) => {
        // A queued prompt whose rule was already overridden by an earlier answer: just carry on.
        if (getManagerOverrideReason() !== null) {
          resolve({ action: 'override', reason: effectiveReason(reasonRef.current) });
          return;
        }
        setPrompt({ error, resolve });
      });
    const handler = (error: ApiError): Promise<OverrideDecision> => {
      const next = promptQueue.current.then(() => ask(error));
      promptQueue.current = next.catch(() => undefined);
      return next;
    };
    const offPrompt = setOverridePromptHandler(handler);
    const reactivate = async (): Promise<boolean> => {
      try {
        const v = await setManagerMode(true, 'user');
        qc.setQueryData(managerQk.mode, v);
        if (!v.on) return false;
        setManagerOverrideReason(effectiveReason(reasonRef.current));
        lastActivity.current = Date.now();
        lastHeartbeat.current = Date.now();
        toastRef.current.push('Manager mode was switched back on', 'info');
        return true;
      } catch {
        return false;
      }
    };
    const offReactivator = setManagerModeReactivator(reactivate);
    return () => {
      offToasts();
      offPrompt();
      offReactivator();
    };
  }, [qc]);

  const answerPrompt = async (decision: 'cancel' | 'override', chosen?: string) => {
    const current = prompt;
    if (!current) return;
    if (decision === 'cancel') {
      setPrompt(null);
      current.resolve({ action: 'cancel' });
      return;
    }
    const r = effectiveReason(chosen ?? reasonRef.current);
    setReasonState(r);
    storeReason(r);
    reasonRef.current = r;
    setPromptBusy(true);
    try {
      await turnOn();
      setPrompt(null);
      current.resolve({ action: 'override', reason: r });
    } catch (e) {
      setPrompt(null);
      toast.error(`Could not turn manager mode on: ${(e as Error)?.message ?? String(e)}`);
      current.resolve({ action: 'cancel' });
    } finally {
      setPromptBusy(false);
    }
  };

  const setReason = useCallback((r: string) => {
    const next = r.slice(0, 500);
    setReasonState(next);
    storeReason(next.trim() ? next : null);
  }, []);

  const api = useMemo<ManagerModeApi>(() => {
    const value: ManagerModeApi = { allowed, on, idleMinutes, reason, setReason, turnOn, turnOff, pending };
    if (on && view.until) value.until = view.until;
    return value;
  }, [allowed, on, idleMinutes, reason, setReason, turnOn, turnOff, pending, view.until]);

  return (
    <ManagerModeContext.Provider value={api}>
      {children}
      <OverridePrompt error={prompt?.error ?? null} defaultReason={reason} busy={promptBusy} onCancel={() => void answerPrompt('cancel')} onOverride={(r) => void answerPrompt('override', r)} />
    </ManagerModeContext.Provider>
  );
}
