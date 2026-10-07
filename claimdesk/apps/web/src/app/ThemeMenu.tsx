/**
 * Top-bar appearance menu: one icon button (sun / moon / monitor for the current choice) that opens Light · Dark · System.
 * Also loads the signed-in user's own saved choice (lib/theme.ts). Settings → Appearance shows the same choice.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useMe } from '../api/hooks';
import { THEME_SETTINGS, useTheme, type ThemeSetting } from '../lib/theme';
import { MonitorIcon, MoonIcon, SunIcon } from './Icons';
import '../styles/theme.css';

export function ThemeIcon({ setting }: { setting: ThemeSetting }) {
  return setting === 'light' ? <SunIcon /> : setting === 'dark' ? <MoonIcon /> : <MonitorIcon />;
}

export function ThemeMenu() {
  const userId = useMe().data?.id ?? null;
  const { setting, resolved, setSetting } = useTheme(userId);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Focus the chosen item when the menu opens.
  useEffect(() => {
    if (!open) return;
    const i = Math.max(0, THEME_SETTINGS.findIndex((t) => t.value === setting));
    itemRefs.current[i]?.focus();
  }, [open, setting]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const choose = (value: ThemeSetting) => {
    setSetting(value);
    close();
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const current = THEME_SETTINGS.find((t) => t.value === setting) ?? THEME_SETTINGS[2]!;
  const label = `Appearance: ${current.label}${setting === 'system' ? ` (${resolved})` : ''}`;

  return (
    <div className="theme-menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="theme-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        data-testid="theme-menu"
      >
        <ThemeIcon setting={setting} />
      </button>
      {open && (
        <div className="theme-menu-list" role="menu" id={menuId} aria-label="Appearance" onKeyDown={onMenuKey}>
          {THEME_SETTINGS.map((t, i) => (
            <button
              key={t.value}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={setting === t.value}
              className="theme-menu-item"
              tabIndex={setting === t.value ? 0 : -1}
              onClick={() => choose(t.value)}
            >
              <ThemeIcon setting={t.value} />
              <span>{t.label}</span>
              {setting === t.value && (
                <span className="theme-menu-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
