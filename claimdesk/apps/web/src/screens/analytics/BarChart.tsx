import { niceMax, type BarItem } from './analytics';

/**
 * Horizontal bar chart in plain SVG (no chart library). One series, one hue (brand blue; amber for `warn`),
 * direct value labels, a <title> tooltip per bar, recessive grid. The table beside it is the accessible view.
 */
export function BarChart({ items, unit = '', maxValue, ariaLabel }: { items: BarItem[]; unit?: string; maxValue?: number; ariaLabel: string }) {
  if (items.length === 0) return null;
  const W = 640;
  const labelW = 170;
  const valueW = 80;
  const rowH = 26;
  const padTop = 8;
  const H = padTop + items.length * rowH + 8;
  const plotX = labelW;
  const plotW = W - labelW - valueW;
  const max = maxValue ?? niceMax(Math.max(...items.map((i) => i.value)));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg className="bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} preserveAspectRatio="xMinYMin meet">
      {ticks.map((t) => (
        <line key={t} className="grid" x1={plotX + plotW * t} x2={plotX + plotW * t} y1={padTop} y2={H - 8} />
      ))}
      <line className="axis" x1={plotX} x2={plotX} y1={padTop} y2={H - 8} />
      {items.map((it, i) => {
        const y = padTop + i * rowH;
        const w = Math.max(0, Math.min(plotW, (it.value / max) * plotW));
        const display = it.display ?? `${Math.round(it.value * 10) / 10}${unit}`;
        return (
          <g key={it.key}>
            <title>{it.title ?? `${it.label}: ${display}`}</title>
            <text className="bar-label" x={plotX - 8} y={y + rowH / 2 + 4} textAnchor="end">
              {truncate(it.label, 26)}
            </text>
            <rect className={`bar ${it.warn ? 'warn' : ''}`} x={plotX} y={y + 5} width={w} height={rowH - 10} rx={3} />
            <text className="bar-value" x={plotX + w + 6} y={y + rowH / 2 + 4}>
              {display}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
