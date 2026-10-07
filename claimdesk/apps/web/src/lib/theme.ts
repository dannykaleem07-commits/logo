/**
 * Light / Dark / System appearance.
 *
 * - The choice is kept in localStorage per signed-in user (`claimdesk.theme.u.<userId>`), plus the last choice applied on
 *   this computer (`claimdesk.theme`), which /theme-init.js reads before the first paint (the sign-in screen and the first
 *   frame after a reload therefore never flash the wrong colours). The API's CSP allows no inline scripts, so the
 *   pre-paint step is that tiny same-origin file; keep it in step with `resolveTheme` / `applyTheme` below.
 * - <html data-theme> always holds the RESOLVED theme ('light' | 'dark'); <html data-theme-setting> holds the choice.
 *   tokens.css also follows prefers-color-scheme when no data-theme is set, so a blocked script still gets System.
 * - Documents and PDFs stay on light paper in both themes (tokens --doc-*).
 */
import { useEffect, useSyncExternalStore } from 'react';

export type ThemeSetting = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_SETTINGS: ReadonlyArray<{ value: ThemeSetting; label: string; hint: string }> = [
  { value: 'light', label: 'Light', hint: 'Dark text on a light background' },
  { value: 'dark', label: 'Dark', hint: 'Light text on a dark background, easier in a dim room' },
  { value: 'system', label: 'System', hint: "Follow this computer's light or dark setting" }
];

export const DEFAULT_THEME: ThemeSetting = 'system';
/** Last choice applied on this computer: read before first paint by /theme-init.js. */
export const THEME_LAST_KEY = 'claimdesk.theme';
const USER_PREFIX = 'claimdesk.theme.u.';
const DARK_QUERY = '(prefers-color-scheme: dark)';
/** Browser / PWA title-bar colour per resolved theme (matches index.html for light). */
export const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#072647', dark: '#0e1319' };

export function isThemeSetting(v: unknown): v is ThemeSetting {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function themeKeyFor(userId: string | null | undefined): string {
  return userId ? `${USER_PREFIX}${userId}` : THEME_LAST_KEY;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The user's saved choice; falls back to this computer's last choice, then System. */
export function readThemeSetting(userId?: string | null): ThemeSetting {
  const s = storage();
  try {
    const own = userId ? s?.getItem(themeKeyFor(userId)) : null;
    if (isThemeSetting(own)) return own;
    const last = s?.getItem(THEME_LAST_KEY);
    if (isThemeSetting(last)) return last;
  } catch {
    // blocked storage: System
  }
  return DEFAULT_THEME;
}

/** Saves the choice for the user (when known) and as this computer's last choice. */
export function writeThemeSetting(setting: ThemeSetting, userId?: string | null): void {
  const s = storage();
  try {
    if (userId) s?.setItem(themeKeyFor(userId), setting);
    s?.setItem(THEME_LAST_KEY, setting);
  } catch {
    // private window / blocked storage: the choice still applies for this visit
  }
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  return setting === 'system' ? (prefersDark ? 'dark' : 'light') : setting;
}

/** Puts the theme on <html> (data-theme, data-theme-setting) and the title-bar colour. Returns the resolved theme. */
export function applyTheme(setting: ThemeSetting, doc: Document | undefined = typeof document !== 'undefined' ? document : undefined, prefersDark = systemPrefersDark()): ResolvedTheme {
  const resolved = resolveTheme(setting, prefersDark);
  if (!doc) return resolved;
  const root = doc.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-setting', setting);
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
  return resolved;
}

/* ---- tiny shared store, so the top-bar menu and Settings → Appearance always agree ---- */

interface ThemeState {
  userId: string | null;
  setting: ThemeSetting;
  resolved: ResolvedTheme;
}
let state: ThemeState = { userId: null, setting: DEFAULT_THEME, resolved: 'light' };
let initialised = false;
const listeners = new Set<() => void>();

function emit(next: ThemeState) {
  state = next;
  listeners.forEach((l) => l());
}

function ensureInit() {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;
  const setting = readThemeSetting(null);
  emit({ userId: null, setting, resolved: applyTheme(setting) });
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      if (state.setting === 'system') emit({ ...state, resolved: applyTheme('system') });
    };
    mq.addEventListener?.('change', onChange);
  }
  // Another ClaimDesk window on this computer changed the theme.
  window.addEventListener('storage', (e) => {
    if (e.key !== themeKeyFor(state.userId) && !(state.userId === null && e.key === THEME_LAST_KEY)) return;
    const setting = readThemeSetting(state.userId);
    if (setting !== state.setting) emit({ ...state, setting, resolved: applyTheme(setting) });
  });
}

function subscribe(listener: () => void) {
  ensureInit();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => state;

/** Switches to the signed-in user's saved theme (or this computer's last one). */
export function setThemeUser(userId: string | null): void {
  ensureInit();
  if (userId === state.userId) return;
  const setting = readThemeSetting(userId);
  if (userId) writeThemeSetting(setting, userId);
  emit({ userId, setting, resolved: applyTheme(setting) });
}

/** Chooses Light, Dark or System for the current user and applies it at once. */
export function setThemeSetting(setting: ThemeSetting): void {
  ensureInit();
  writeThemeSetting(setting, state.userId);
  emit({ ...state, setting, resolved: applyTheme(setting) });
}

/** Current choice and resolved theme; pass the signed-in user's id to load their own choice. */
export function useTheme(userId?: string | null): { setting: ThemeSetting; resolved: ResolvedTheme; setSetting: (s: ThemeSetting) => void } {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (userId !== undefined) setThemeUser(userId);
  }, [userId]);
  return { setting: current.setting, resolved: current.resolved, setSetting: setThemeSetting };
}

/** Test hook: forget the module state. */
export function __resetThemeForTests(): void {
  state = { userId: null, setting: DEFAULT_THEME, resolved: 'light' };
  initialised = false;
  listeners.clear();
}
