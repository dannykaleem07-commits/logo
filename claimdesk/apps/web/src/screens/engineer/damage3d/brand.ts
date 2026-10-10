/**
 * Brand faces: the front and rear "design signature" of a make (and some models), used when the vehicle's dimensions
 * record only carries the generic styles ("wide" grille, "slim" lamps, which is most of the data). The silhouette comes
 * from the dimensions; the face is what makes a Ford read as a Ford and a BMW as a BMW at a glance.
 *
 * These are design families, not copies of any manufacturer's artwork: a trapezoid grille, twin kidneys, a V-shaped
 * chrome surround, a full-width black visor. Specific styles in the data (kidney, round, hexagonal …) always win.
 */
import type { GrilleStyle, LampStyle } from './spec';

export type RearLampStyle = 'wrap' | 'split' | 'tall' | 'bar' | 'round';

export interface BrandFace {
  grille?: GrilleStyle;
  lamp?: LampStyle;
  rear?: RearLampStyle;
  /** Chrome accents (grille surround / bars) rather than gloss black. */
  chrome?: boolean;
}

const slug = (s: unknown) =>
  (typeof s === 'string' ? s : '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const MAKE_ALIAS: Record<string, string> = {
  vw: 'volkswagen',
  'volkswagen-commercial-vehicles': 'volkswagen',
  mercedes: 'mercedes-benz',
  merc: 'mercedes-benz',
  'mercedes-amg': 'mercedes-benz',
  'range-rover': 'land-rover',
  landrover: 'land-rover',
  opel: 'vauxhall',
  alfa: 'alfa-romeo',
  'ds-automobiles': 'ds'
};

// prettier-ignore
const MAKES: Record<string, BrandFace> = {
  ford:            { grille: 'trapezoid', lamp: 'swept', rear: 'wrap' },
  volkswagen:      { grille: 'slim', lamp: 'slim', rear: 'split' },
  vauxhall:        { grille: 'wide', lamp: 'swept', rear: 'wrap', chrome: true },
  bmw:             { grille: 'kidney', lamp: 'split', rear: 'split', chrome: true },
  mini:            { grille: 'hexagonal', lamp: 'round', rear: 'round', chrome: true },
  audi:            { grille: 'hexagonal', lamp: 'swept', rear: 'wrap' },
  'mercedes-benz': { grille: 'large', lamp: 'swept', rear: 'wrap', chrome: true },
  nissan:          { grille: 'vmotion', lamp: 'boomerang', rear: 'wrap', chrome: true },
  toyota:          { grille: 'trapezoid', lamp: 'swept', rear: 'wrap' },
  lexus:           { grille: 'hexagonal', lamp: 'swept', rear: 'bar', chrome: true },
  'land-rover':    { grille: 'wide', lamp: 'slim', rear: 'bar' },
  jaguar:          { grille: 'large', lamp: 'slim', rear: 'wrap', chrome: true },
  kia:             { grille: 'split', lamp: 'swept', rear: 'wrap' },
  hyundai:         { grille: 'large', lamp: 'slim', rear: 'bar' },
  peugeot:         { grille: 'wide', lamp: 'swept', rear: 'wrap', chrome: true },
  citroen:         { grille: 'split', lamp: 'split', rear: 'wrap', chrome: true },
  ds:              { grille: 'large', lamp: 'swept', rear: 'wrap', chrome: true },
  renault:         { grille: 'wide', lamp: 'swept', rear: 'wrap', chrome: true },
  dacia:           { grille: 'wide', lamp: 'square', rear: 'wrap' },
  skoda:           { grille: 'large', lamp: 'swept', rear: 'wrap', chrome: true },
  seat:            { grille: 'trapezoid', lamp: 'swept', rear: 'bar' },
  cupra:           { grille: 'hexagonal', lamp: 'swept', rear: 'bar' },
  volvo:           { grille: 'large', lamp: 'slim', rear: 'tall', chrome: true },
  honda:           { grille: 'wide', lamp: 'swept', rear: 'wrap' },
  mazda:           { grille: 'hexagonal', lamp: 'slim', rear: 'wrap', chrome: true },
  suzuki:          { grille: 'wide', lamp: 'swept', rear: 'wrap', chrome: true },
  mitsubishi:      { grille: 'split', lamp: 'slim', rear: 'tall', chrome: true },
  fiat:            { grille: 'slim', lamp: 'swept', rear: 'wrap' },
  'alfa-romeo':    { grille: 'shield', lamp: 'slim', rear: 'wrap', chrome: true },
  mg:              { grille: 'large', lamp: 'swept', rear: 'wrap', chrome: true },
  tesla:           { grille: 'closed', lamp: 'swept', rear: 'wrap' },
  polestar:        { grille: 'closed', lamp: 'slim', rear: 'bar' },
  porsche:         { grille: 'closed', lamp: 'round', rear: 'bar' },
  jeep:            { grille: 'large', lamp: 'round', rear: 'tall', chrome: true },
  subaru:          { grille: 'hexagonal', lamp: 'swept', rear: 'wrap', chrome: true },
  byd:             { grille: 'closed', lamp: 'slim', rear: 'bar' },
  smart:           { grille: 'closed', lamp: 'slim', rear: 'bar' },
  genesis:         { grille: 'shield', lamp: 'split', rear: 'split', chrome: true },
  'aston-martin':  { grille: 'large', lamp: 'swept', rear: 'bar' },
  bentley:         { grille: 'large', lamp: 'round', rear: 'wrap', chrome: true },
  'rolls-royce':   { grille: 'large', lamp: 'slim', rear: 'tall', chrome: true },
  maserati:        { grille: 'large', lamp: 'swept', rear: 'wrap', chrome: true },
  ssangyong:       { grille: 'wide', lamp: 'swept', rear: 'wrap', chrome: true },
  isuzu:           { grille: 'large', lamp: 'swept', rear: 'tall', chrome: true },
  iveco:           { grille: 'bars', lamp: 'tall', rear: 'tall' },
  ldv:             { grille: 'bars', lamp: 'swept', rear: 'tall', chrome: true }
};

/** Model families that differ from their make's face (matched on the model slug prefix). */
// prettier-ignore
const MODELS: Array<[make: string, model: RegExp, face: BrandFace]> = [
  ['ford', /^(transit|tourneo|ranger)/, { grille: 'bars', lamp: 'swept', rear: 'tall', chrome: true }],
  ['ford', /^(ka|ka-plus|ka\+)/, { grille: 'trapezoid', lamp: 'swept', rear: 'wrap' }],
  ['volkswagen', /^(transporter|caddy|crafter|amarok|multivan|caravelle|california)/, { grille: 'bars', lamp: 'slim', rear: 'tall', chrome: true }],
  ['volkswagen', /^(id|id-3|id-4|id-5|id-7|id-buzz)/, { grille: 'closed', lamp: 'slim', rear: 'bar' }],
  ['vauxhall', /^(corsa|astra|mokka|grandland|frontera)/, { grille: 'vizor', lamp: 'slim', rear: 'wrap' }],
  ['vauxhall', /^(vivaro|movano|combo)/, { grille: 'bars', lamp: 'swept', rear: 'tall', chrome: true }],
  ['mercedes-benz', /^(sprinter|vito|citan|v-class|x-class)/, { grille: 'bars', lamp: 'swept', rear: 'tall', chrome: true }],
  ['toyota', /^(hilux|land-cruiser|proace)/, { grille: 'large', lamp: 'swept', rear: 'tall', chrome: true }],
  ['toyota', /^(aygo|yaris|corolla|c-hr|prius)/, { grille: 'trapezoid', lamp: 'swept', rear: 'wrap' }],
  ['nissan', /^(navara|nv|primastar|interstar|townstar)/, { grille: 'vmotion', lamp: 'swept', rear: 'tall', chrome: true }],
  ['nissan', /^(leaf|ariya)/, { grille: 'closed', lamp: 'slim', rear: 'wrap' }],
  ['land-rover', /^(defender)/, { grille: 'wide', lamp: 'round', rear: 'tall' }],
  ['land-rover', /^(discovery)/, { grille: 'wide', lamp: 'slim', rear: 'tall' }],
  ['fiat', /^(500|600)/, { grille: 'closed', lamp: 'round', rear: 'round' }],
  ['fiat', /^(ducato|doblo|scudo|fiorino)/, { grille: 'bars', lamp: 'swept', rear: 'tall' }],
  ['peugeot', /^(partner|expert|boxer|rifter|traveller)/, { grille: 'bars', lamp: 'swept', rear: 'tall', chrome: true }],
  ['citroen', /^(berlingo|dispatch|relay|spacetourer)/, { grille: 'split', lamp: 'split', rear: 'tall', chrome: true }],
  ['renault', /^(trafic|master|kangoo)/, { grille: 'bars', lamp: 'swept', rear: 'tall', chrome: true }],
  ['hyundai', /^(ioniq)/, { grille: 'closed', lamp: 'square', rear: 'bar' }],
  ['kia', /^(ev)/, { grille: 'closed', lamp: 'slim', rear: 'bar' }],
  ['bmw', /^(i3|ix|i4|i5|i7)/, { grille: 'kidney', lamp: 'slim', rear: 'split', chrome: true }],
  ['mini', /^(countryman|clubman|paceman)/, { grille: 'hexagonal', lamp: 'round', rear: 'tall', chrome: true }]
];

/** The design signature for a make / model; empty when the make is unknown. */
export function brandFace(make?: string | null, model?: string | null): BrandFace {
  const m0 = slug(make);
  const mk = MAKE_ALIAS[m0] ?? m0;
  if (!mk) return {};
  let md = slug(model);
  if (md.startsWith(`${mk}-`)) md = md.slice(mk.length + 1);
  for (const [make2, re, face] of MODELS) if (make2 === mk && re.test(md)) return { ...face };
  const face = MAKES[mk];
  return face ? { ...face } : {};
}
