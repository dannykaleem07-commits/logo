/**
 * The logo lockup, inlined as SVG so every HTML document is self-contained (no file or network fetch at
 * print time). The asset is read from disk once per process and lightly minified:
 *   - XML declaration and the fixed width/height are removed so the SVG scales to its container;
 *   - inter-tag whitespace is collapsed;
 *   - path coordinates are rounded to 0.1 viewBox units (0.1 of 2000 units at 55 mm wide is under 3 µm —
 *     far below print resolution). Colours, gradients and all other attributes are untouched: the logo is
 *     never recoloured (brand.ts).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from './format.js';

const LOGO_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/logo.svg');

let cached: string | undefined;

export function minifySvg(svg: string): string {
  let out = svg.replace(/<\?xml[^>]*\?>\s*/i, '');
  out = out.replace(/<svg([^>]*)>/i, (_m, attrs: string) => {
    const cleaned = attrs.replace(/\s+(width|height)="[^"]*"/gi, '');
    return `<svg${cleaned}>`;
  });
  out = out.replace(/\s*\n\s*/g, ' ').replace(/>\s+</g, '><');
  out = out.replace(/ d="([^"]*)"/g, (_m, d: string) => {
    const rounded = d.replace(/-?\d+\.\d+/g, (n) => String(Math.round(parseFloat(n) * 10) / 10));
    return ` d="${rounded}"`;
  });
  return out.trim();
}

/** The inline SVG markup (cached after the first read). */
export function logoSvg(): string {
  if (cached === undefined) {
    cached = minifySvg(readFileSync(LOGO_PATH, 'utf8'));
  }
  return cached;
}

/** Read the asset now rather than on first render (e.g. at API start-up). */
export function preloadLogo(): void {
  logoSvg();
}

/**
 * The lockup as it appears top-left on every document. Width defaults to 55 mm (BLUEPRINT §9 "compact lockup").
 */
export function logoLockup(widthMm = 55, altText = 'Courtesy Cars UK'): string {
  return `<div class="logo-lockup" role="img" aria-label="${escapeHtml(altText)}" style="width:${widthMm}mm">${logoSvg()}</div>`;
}
