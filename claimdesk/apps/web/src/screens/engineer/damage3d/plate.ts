/**
 * UK number plates for the 3D model: white front, yellow rear, black characters (charcoal on reflective stock), drawn
 * on a canvas and used as a texture. Formatting follows the current scheme ("AB12 CDE"); older and personalised marks
 * are shown as given (upper-cased, spacing kept).
 */
export type PlateKind = 'front' | 'rear';

export const PLATE_COLOURS: Record<PlateKind, string> = { front: '#f7f7f2', rear: '#f5c518' };

/** Normalise a registration for display: upper case, current-style marks spaced "AB12 CDE". */
export function formatRegistration(reg: string | null | undefined): string {
  const raw = (reg ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const flat = raw.replace(/ /g, '');
  if (/^[A-Z]{2}\d{2}[A-Z]{3}$/.test(flat)) return `${flat.slice(0, 4)} ${flat.slice(4)}`; // 2001– current
  if (/^[A-Z]\d{1,3}[A-Z]{3}$/.test(flat)) return `${flat.slice(0, flat.length - 3)} ${flat.slice(-3)}`; // prefix 1983–2001
  if (/^[A-Z]{3}\d{1,3}[A-Z]$/.test(flat)) return `${flat.slice(0, 3)} ${flat.slice(3)}`; // suffix 1963–1983
  return raw.slice(0, 10);
}

/** The minimal 2D context the drawer needs (lets tests pass a recorder). */
export interface PlateCtx {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  beginPath(): void;
  roundRect?(x: number, y: number, w: number, h: number, r: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
}

/**
 * Draw a plate filling w × h (aspect ≈ 520:111). Returns the text drawn ('' for a blank plate when there is no
 * registration — the plate then shows only its border).
 */
export function drawPlate(ctx: PlateCtx, reg: string | null | undefined, kind: PlateKind, w: number, h: number): string {
  const text = formatRegistration(reg);
  ctx.fillStyle = PLATE_COLOURS[kind];
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, w, h, h * 0.08);
  else ctx.rect(0, 0, w, h);
  ctx.fill();
  ctx.strokeStyle = '#1b1b1b';
  ctx.lineWidth = Math.max(1, h * 0.035);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(h * 0.04, h * 0.04, w - h * 0.08, h - h * 0.08, h * 0.06);
  else ctx.rect(h * 0.04, h * 0.04, w - h * 0.08, h - h * 0.08);
  ctx.stroke();
  if (!text) return '';
  ctx.fillStyle = '#121212';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Charles Wright is not bundled; a bold condensed sans is a close stand-in
  ctx.font = `700 ${Math.round(h * 0.74)}px "Arial Narrow", "Roboto Condensed", "DejaVu Sans Condensed", "Liberation Sans Narrow", Arial, sans-serif`;
  ctx.fillText(text, w / 2, h * 0.54, w * 0.9);
  return text;
}
