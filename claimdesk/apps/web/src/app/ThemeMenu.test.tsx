// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qk } from '../api/hooks';
import { __resetThemeForTests, themeKeyFor } from '../lib/theme';
import { AppearanceCard } from '../screens/settings/AppearanceCard';
import { ThemeMenu } from './ThemeMenu';

const USER = { id: 'u-theme', name: 'Theme Tester', username: 'tt', email: 'tt@example.test', role: 'handler' as const };

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  qc.setQueryData(qk.me, USER);
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })));
  __resetThemeForTests();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('top-bar appearance menu', () => {
  it('opens Light / Dark / System, focuses the current choice and applies a new one for the signed-in user', () => {
    render(wrap(<ThemeMenu />));
    const button = screen.getByTestId('theme-menu');
    expect(button.getAttribute('aria-label')).toMatch(/Appearance: System/);
    fireEvent.click(button);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent?.replace('✓', '').trim())).toEqual(['Light', 'Dark', 'System']);
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.click(items[1]!);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(themeKeyFor(USER.id))).toBe('dark');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('Escape closes the menu and returns focus to the button', () => {
    render(wrap(<ThemeMenu />));
    const button = screen.getByTestId('theme-menu');
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('Settings → Appearance and the top-bar menu show the same choice', () => {
    render(wrap(
      <>
        <ThemeMenu />
        <AppearanceCard />
      </>
    ));
    act(() => {
      fireEvent.click(screen.getByLabelText(/^Light/));
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByTestId('theme-menu').getAttribute('aria-label')).toBe('Appearance: Light');
    expect((screen.getByLabelText(/^Light/) as HTMLInputElement).checked).toBe(true);
  });
});
