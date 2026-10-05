import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  /** Less-used tabs behind a "More ▾" menu button (0.3 §E1). When the current tab is one of them the button shows its name. */
  more?: TabItem[];
  /** Badge on the More button (e.g. the open-flag count of a tab inside it). */
  moreBadge?: ReactNode;
  moreLabel?: string;
  /** On phones (≤ 640 px) keep only this many tabs in the strip and list the rest first in More, so none sits
   * off-screen in a strip that scrolls with no hint. Their badges then show on the More button. */
  narrowPrimary?: number;
}

const NARROW_QUERY = '(max-width: 640px)';

function useNarrow(enabled: boolean): boolean {
  const get = () => enabled && typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [enabled]);
  return narrow;
}

/** Controlled tab strip. Route-driven tabs pass the current segment as `value` and navigate in `onChange`. */
export function Tabs({ items: allItems, value, onChange, ariaLabel, more: moreItems, moreBadge: extraBadge, moreLabel = 'More', narrowPrimary }: TabsProps) {
  const narrow = useNarrow(narrowPrimary !== undefined);
  const fold = narrow && narrowPrimary !== undefined && allItems.length > narrowPrimary;
  const items = fold ? allItems.slice(0, narrowPrimary) : allItems;
  const moved = fold ? allItems.slice(narrowPrimary) : [];
  const more = fold ? [...moved, ...(moreItems ?? [])] : moreItems;
  const movedBadges = moved.filter((t) => t.badge).map((t) => <span key={t.id}>{t.badge}</span>);
  const moreBadge = movedBadges.length ? (
    <>
      {movedBadges}
      {extraBadge}
    </>
  ) : (
    extraBadge
  );
  const strip = (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          className="tab"
          aria-selected={t.id === value}
          aria-controls={`tabpanel-${t.id}`}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
  if (!more?.length) return strip;
  return (
    <div className="tabs-bar">
      {strip}
      <MoreMenu items={more} value={value} onChange={onChange} badge={moreBadge} label={moreLabel} />
    </div>
  );
}

/** "More ▾" menu button: Enter/Space/↓ opens, ↑/↓/Home/End move, Enter picks, Escape or Tab closes, click outside closes. */
function MoreMenu({ items, value, onChange, badge, label }: { items: TabItem[]; value: string; onChange: (id: string) => void; badge?: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const current = items.find((t) => t.id === value);
  const enabled = items.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);

  const focusItem = (i: number) => itemRefs.current[i]?.focus();
  const openMenu = (focus: 'first' | 'last' | 'current' = 'current') => {
    setOpen(true);
    requestAnimationFrame(() => {
      const cur = items.findIndex((t) => t.id === value);
      const target = focus === 'first' ? enabled[0] : focus === 'last' ? enabled[enabled.length - 1] : cur >= 0 && !items[cur]?.disabled ? cur : enabled[0];
      if (target !== undefined) focusItem(target);
    });
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu('last');
    }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = itemRefs.current.findIndex((el) => el === document.activeElement);
    const pos = enabled.indexOf(at);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(enabled[(pos + 1) % enabled.length]!);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(enabled[(pos - 1 + enabled.length) % enabled.length]!);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(enabled[0]!);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(enabled[enabled.length - 1]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="tabs-more" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={current ? 'tab tab-more tab-more-current' : 'tab tab-more'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onButtonKey}
      >
        {current ? current.label : label}
        {current?.badge ?? badge}
        <span aria-hidden="true" className="tab-more-caret">
          ▾
        </span>
        {current && <span className="sr-only"> (in {label})</span>}
      </button>
      {open && (
        <div className="tabs-menu" role="menu" id={menuId} aria-label={label} onKeyDown={onMenuKey}>
          {items.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === value}
              className="tabs-menu-item"
              disabled={t.disabled}
              tabIndex={-1}
              onClick={() => {
                close(true);
                onChange(t.id);
              }}
            >
              <span>{t.label}</span>
              {t.badge}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
