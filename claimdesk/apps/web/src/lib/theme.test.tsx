// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetThemeForTests,
  applyTheme,
  readThemeSetting,
  resolveTheme,
  setThemeSetting,
  setThemeUser,
  THEME_COLOR,
  THEME_LAST_KEY,
  themeKeyFor,
  useTheme,
  writeThemeSetting
} from './theme';

let osDark = false;
const mqListeners = new Set<() => void>();
function setOsDark(v: boolean) {
  osDark = v;
  mqListeners.forEach((l) => l());
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-setting');
  document.head.innerHTML = '<meta name="theme-color" content="#072647" />';
  osDark = false;
  mqListeners.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('dark') && osDark;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => mqListeners.add(l),
      removeEventListener: (_: string, l: () => void) => mqListeners.delete(l)
    }))
  );
  __resetThemeForTests();
});
afterEach(() => vi.unstubAllGlobals());

const html = () => document.documentElement;

describe('theme setting', () => {
  it('resolves System from the operating system and keeps Light / Dark as chosen', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('defaults to System, and ignores junk in storage', () => {
    expect(readThemeSetting('u1')).toBe('system');
    window.localStorage.setItem(themeKeyFor('u1'), 'purple');
    expect(readThemeSetting('u1')).toBe('system');
  });

  it('is saved per user, and as this computer’s last choice for the pre-paint script', () => {
    writeThemeSetting('dark', 'u1');
    writeThemeSetting('light', 'u2');
    expect(readThemeSetting('u1')).toBe('dark');
    expect(readThemeSetting('u2')).toBe('light');
    expect(window.localStorage.getItem(THEME_LAST_KEY)).toBe('light');
    // a user with no saved choice starts from this computer's last one
    expect(readThemeSetting('u3')).toBe('light');
  });

  it('applies the resolved theme to <html data-theme> and the title-bar colour', () => {
    expect(applyTheme('dark')).toBe('dark');
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(html().getAttribute('data-theme-setting')).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(THEME_COLOR.dark);
    osDark = false;
    expect(applyTheme('system')).toBe('light');
    expect(html().getAttribute('data-theme')).toBe('light');
    expect(html().getAttribute('data-theme-setting')).toBe('system');
  });

  it('switches to the signed-in user’s own choice, and saves changes against that user', () => {
    window.localStorage.setItem(themeKeyFor('u1'), 'dark');
    setThemeUser('u1');
    expect(html().getAttribute('data-theme')).toBe('dark');
    setThemeSetting('light');
    expect(window.localStorage.getItem(themeKeyFor('u1'))).toBe('light');
    expect(window.localStorage.getItem(THEME_LAST_KEY)).toBe('light');
    expect(html().getAttribute('data-theme')).toBe('light');
  });

  it('System follows the operating system live', () => {
    setThemeUser('u1');
    setThemeSetting('system');
    expect(html().getAttribute('data-theme')).toBe('light');
    setOsDark(true);
    expect(html().getAttribute('data-theme')).toBe('dark');
    setThemeSetting('light');
    setOsDark(false);
    setOsDark(true);
    expect(html().getAttribute('data-theme')).toBe('light');
  });

  it('useTheme shares one state between every component', () => {
    function Probe({ id }: { id: string }) {
      const t = useTheme();
      return (
        <span data-testid={id}>
          {t.setting}/{t.resolved}
        </span>
      );
    }
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>
    );
    act(() => setThemeSetting('dark'));
    expect(screen.getByTestId('a').textContent).toBe('dark/dark');
    expect(screen.getByTestId('b').textContent).toBe('dark/dark');
  });
});

describe('/theme-init.js (pre-paint, kept in step with theme.ts)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/theme-init.js'), 'utf8');
  const run = () => new Function(src)();

  it('applies the last saved choice before React loads', () => {
    window.localStorage.setItem(THEME_LAST_KEY, 'dark');
    run();
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(html().getAttribute('data-theme-setting')).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(THEME_COLOR.dark);
  });

  it('System (or nothing saved) follows the operating system', () => {
    osDark = true;
    run();
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(html().getAttribute('data-theme-setting')).toBe('system');
    osDark = false;
    window.localStorage.setItem(THEME_LAST_KEY, 'system');
    run();
    expect(html().getAttribute('data-theme')).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(THEME_COLOR.light);
  });

  it('is loaded from index.html as a same-origin file (the CSP allows no inline script)', () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');
    expect(index).toMatch(/<script src="\/theme-init\.js"><\/script>/);
    const head = index.slice(0, index.indexOf('</head>'));
    expect(head.indexOf('theme-init.js')).toBeLessThan(head.indexOf('<title>'));
    expect(/<script>(?!\s*<\/script>)/.test(index)).toBe(false);
  });
});
