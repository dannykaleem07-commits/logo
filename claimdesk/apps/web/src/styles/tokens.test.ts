/**
 * Theme tokens guard: every colour token has a dark value, the two dark copies (explicit Dark, and System when the OS is
 * dark) are identical, and the text / control pairs the app actually uses meet WCAG 2.2 AA in BOTH themes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations inside the first block that follows `selector {`. */
function block(selector: string, from = 0): Record<string, string> {
  const at = css.indexOf(selector, from);
  if (at < 0) throw new Error(`no block for ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const decl of css.slice(open + 1, close).split(';')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const light = block(':root {');
const darkExplicit = block(":root[data-theme='dark'] {");
const darkSystem = block(":root:not([data-theme='light']) {", css.indexOf('@media (prefers-color-scheme: dark)'));
const dark = { ...light, ...darkExplicit };

/** Colour tokens that are the same in both themes on purpose (paper, number plate, camera, text on a solid fill). */
const SAME_IN_BOTH = new Set(['--doc-navy', '--doc-accent', '--doc-gold', '--doc-silver', '--doc-tint', '--doc-ink', '--doc-rule', '--doc-paper', '--plate-bg', '--plate-ink', '--media-bg', '--media-fg', '--on-solid']);

const isColour = (v: string) => /^#[0-9a-f]{3,8}$|^rgba?\(|^transparent$/i.test(v.trim()) || /rgba?\(/.test(v);

function rgb(value: string, tokens: Record<string, string>): [number, number, number] {
  let v = value.trim();
  for (let i = 0; i < 5 && v.startsWith('var('); i++) v = tokens[/var\((--[a-z0-9-]+)/.exec(v)![1]!]!.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`not an opaque hex colour: ${value} → ${v}`);
}
function luminance([r, g, b]: [number, number, number]): number {
  const c = (x: number) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}
export function contrast(fg: string, bg: string, tokens: Record<string, string>): number {
  const a = luminance(rgb(tokens[fg] ?? fg, tokens));
  const b = luminance(rgb(tokens[bg] ?? bg, tokens));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** [foreground, background] text pairs used across the app (4.5:1). */
const TEXT_PAIRS: Array<[string, string]> = [
  ['--ink', '--bg'],
  ['--ink', '--surface'],
  ['--ink', '--surface-2'],
  ['--ink-2', '--surface'],
  ['--ink-2', '--surface-2'],
  ['--muted', '--surface'],
  ['--muted', '--bg'],
  ['--muted', '--surface-2'],
  ['--muted', '--neutral-bg'],
  ['--navy', '--surface'],
  ['--navy', '--bg'],
  ['--navy', '--blue-50'],
  ['--navy', '--blue-100'],
  ['--blue', '--surface'],
  ['--blue', '--bg'],
  ['--blue', '--blue-50'],
  ['--on-accent', '--accent'],
  ['--on-accent', '--accent-hover'],
  ['--green', '--green-bg'],
  ['--amber', '--amber-bg'],
  ['--red', '--red-bg'],
  ['--info', '--info-bg'],
  ['--neutral', '--neutral-bg'],
  ['--green', '--surface'],
  ['--amber', '--surface'],
  ['--red', '--surface'],
  ['--green-ink', '--green-bg'],
  ['--amber-ink', '--amber-bg'],
  ['--red-ink', '--red-bg'],
  ['--info-ink', '--info-bg'],
  ['--on-solid', '--green-solid'],
  ['--on-solid', '--amber-solid'],
  ['--on-solid', '--red-solid'],
  ['--plate-ink', '--plate-bg'],
  ['--doc-ink', '--doc-paper']
];
/** Icons, placeholders and status dots (3:1, WCAG 1.4.11). */
const UI_PAIRS: Array<[string, string]> = [
  ['--muted-2', '--surface'],
  ['--green', '--surface'],
  ['--red', '--surface'],
  ['--accent', '--surface']
];

describe('theme tokens', () => {
  it('every colour token has a dark value (or is listed as the same in both themes)', () => {
    const colourTokens = Object.entries(light).filter(([, v]) => isColour(v)).map(([k]) => k);
    expect(colourTokens.length).toBeGreaterThan(50);
    const missing = colourTokens.filter((k) => !SAME_IN_BOTH.has(k) && !(k in darkExplicit));
    expect(missing).toEqual([]);
  });

  it('the explicit Dark palette and the System (OS dark) palette are the same', () => {
    expect(darkSystem).toEqual(darkExplicit);
    expect(css).toMatch(/:root\[data-theme='dark'\][^{]*\{[^}]*color-scheme:\s*dark/);
  });

  for (const [name, tokens] of [
    ['light', light],
    ['dark', dark]
  ] as const) {
    it(`${name}: text pairs meet WCAG AA (4.5:1)`, () => {
      const failing = TEXT_PAIRS.map(([fg, bg]) => [fg, bg, contrast(fg, bg, tokens)] as const).filter(([, , r]) => r < 4.5);
      expect(failing.map(([fg, bg, r]) => `${fg} on ${bg}: ${r.toFixed(2)}`)).toEqual([]);
    });
    it(`${name}: icons, placeholders and fills meet 3:1`, () => {
      const failing = UI_PAIRS.map(([fg, bg]) => [fg, bg, contrast(fg, bg, tokens)] as const).filter(([, , r]) => r < 3);
      expect(failing.map(([fg, bg, r]) => `${fg} on ${bg}: ${r.toFixed(2)}`)).toEqual([]);
    });
  }

  it('documents stay on light paper in dark mode', () => {
    for (const k of SAME_IN_BOTH) expect(k in darkExplicit, k).toBe(false);
  });
});
