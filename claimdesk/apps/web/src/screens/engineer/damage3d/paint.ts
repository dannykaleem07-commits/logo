/**
 * Vehicle colour → paint for the 3D model. Knows the common UK manufacturer paint names (Ford Magnetic, Vauxhall
 * Quartz Grey, VW Pure White, BMW Mineral Grey …) and falls back to the DVLA basic colours ("GREY", "BLUE") and
 * keywords ("dark blue metallic"). Hex values are close visual matches, not manufacturer colour codes.
 */
export type Finish = 'solid' | 'metallic' | 'pearl' | 'matte';

export interface Paint {
  /** The name we matched (or the input when only a keyword matched). */
  name: string;
  hex: string;
  finish: Finish;
  /** True when nothing recognisable was given and the neutral default is used. */
  fallback?: boolean;
}

// [name, hex, finish] — names are matched case-insensitively, longest first
// prettier-ignore
const NAMED: Array<[string, string, Finish]> = [
  // Ford
  ['magnetic grey', '#4a4e53', 'metallic'], ['magnetic', '#4a4e53', 'metallic'], ['race red', '#c3111d', 'solid'], ['frozen white', '#f2f3f1', 'solid'],
  ['agate black', '#141517', 'metallic'], ['shadow black', '#121314', 'metallic'], ['moondust silver', '#b9bdc0', 'metallic'], ['blue metallic', '#264d86', 'metallic'],
  ['desert island blue', '#2d6d9b', 'metallic'], ['chrome blue', '#2a5ea8', 'metallic'], ['solar silver', '#c3c6c8', 'metallic'], ['diffused silver', '#b4b7b9', 'metallic'],
  ['ruby red', '#8e1020', 'metallic'], ['lucid red', '#9c1622', 'pearl'], ['blazer blue', '#1f3054', 'solid'], ['carbonised grey', '#55585b', 'metallic'],
  ['grabber blue', '#1d6fc4', 'solid'], ['bohai bay mint', '#9fc8b8', 'solid'], ['star white', '#ecebe4', 'pearl'], ['metropolis white', '#ecece8', 'pearl'],
  ['oxford white', '#f1f1ee', 'solid'], ['sea grey', '#6c757c', 'metallic'], ['smoke grey', '#62676c', 'metallic'],
  // Vauxhall
  ['summit white', '#f3f3f0', 'solid'], ['quartz grey', '#6e7175', 'metallic'], ['mineral black', '#141516', 'metallic'], ['sovereign silver', '#c1c4c6', 'metallic'],
  ['power red', '#c11b20', 'solid'], ['hot red', '#c31d22', 'solid'], ['arden blue', '#203e74', 'metallic'], ['voltaic blue', '#1f63b8', 'metallic'],
  ['satin steel grey', '#787c80', 'metallic'], ['diamond black', '#141517', 'metallic'], ['jade white', '#eef0ec', 'pearl'], ['cobalt blue', '#1f4ea0', 'metallic'],
  // VW / Audi / Skoda / SEAT / Cupra
  ['pure white', '#f4f4f2', 'solid'], ['candy white', '#f3f3ee', 'solid'], ['deep black pearl', '#0e0f11', 'pearl'], ['deep black', '#121315', 'pearl'],
  ['reflex silver', '#b9bcbe', 'metallic'], ['tungsten silver', '#9fa3a6', 'metallic'], ['urano grey', '#585c5e', 'solid'], ['moonstone grey', '#7d8184', 'solid'],
  ['atlantic blue', '#1f3c6b', 'metallic'], ['lapiz blue', '#1f4fa1', 'metallic'], ['kings red', '#a5161e', 'metallic'], ['tornado red', '#c41820', 'solid'],
  ['dolphin grey', '#5b6064', 'metallic'], ['indium grey', '#6f7477', 'metallic'], ['limestone grey', '#8d8f8e', 'metallic'], ['pomelo yellow', '#e3c62a', 'metallic'],
  ['kurkuma yellow', '#d8a91b', 'metallic'], ['mythos black', '#0f1012', 'metallic'], ['glacier white', '#f2f2ef', 'metallic'], ['daytona grey', '#5a5d60', 'pearl'],
  ['navarra blue', '#1d4a8c', 'metallic'], ['florett silver', '#b7babc', 'metallic'], ['manhattan grey', '#5f6266', 'metallic'], ['tango red', '#9b1a1f', 'metallic'],
  ['moon white', '#efefea', 'metallic'], ['magic black', '#111214', 'pearl'], ['race blue', '#22508f', 'metallic'], ['energy blue', '#2563b5', 'metallic'],
  ['quartz grey', '#6e7175', 'metallic'], ['velvet red', '#7d1420', 'metallic'], ['graphite grey', '#4b4e51', 'metallic'], ['magnetic tech', '#5d6164', 'metallic'],
  // BMW / MINI
  ['alpine white', '#f2f2ee', 'solid'], ['mineral white', '#e9e9e4', 'metallic'], ['black sapphire', '#121316', 'metallic'], ['jet black', '#0d0e0f', 'solid'],
  ['mineral grey', '#5a5e61', 'metallic'], ['portimao blue', '#24539f', 'metallic'], ['estoril blue', '#1b3f86', 'metallic'], ['sophisto grey', '#4a4e52', 'pearl'],
  ['glacier silver', '#c3c6c9', 'metallic'], ['melbourne red', '#8a1621', 'metallic'], ['skyscraper grey', '#8a8e91', 'metallic'], ['brooklyn grey', '#7b8083', 'metallic'],
  ['tanzanite blue', '#1c2944', 'metallic'], ['phytonic blue', '#25446f', 'metallic'], ['chili red', '#b4181f', 'solid'], ['british racing green', '#1d3a2b', 'metallic'],
  ['midnight black', '#121315', 'metallic'], ['moonwalk grey', '#8d9193', 'metallic'], ['pepper white', '#f0efe9', 'solid'], ['island blue', '#2e6aa4', 'metallic'],
  // Mercedes
  ['polar white', '#f3f3ef', 'solid'], ['obsidian black', '#111214', 'metallic'], ['iridium silver', '#a8acaf', 'metallic'], ['selenite grey', '#5a5e61', 'metallic'],
  ['mountain grey', '#6f7376', 'metallic'], ['cavansite blue', '#1f3a6a', 'metallic'], ['designo diamond white', '#efefea', 'pearl'], ['graphite grey', '#4b4e51', 'metallic'],
  ['hyacinth red', '#7d1420', 'metallic'], ['night black', '#101113', 'solid'], ['arctic white', '#f2f2ef', 'solid'],
  // Toyota / Lexus / Honda / Nissan / Mazda / Kia / Hyundai
  ['pure white', '#f4f4f2', 'solid'], ['white pearl', '#f0efea', 'pearl'], ['decuma grey', '#7b7f82', 'metallic'], ['eclipse black', '#131416', 'metallic'],
  ['attitude black', '#121315', 'metallic'], ['silver metallic', '#b8bbbe', 'metallic'], ['tokyo red', '#b8141d', 'pearl'], ['scarlet flare', '#b51b22', 'metallic'],
  ['platinum white pearl', '#f1f0ea', 'pearl'], ['crystal black pearl', '#111214', 'pearl'], ['lunar silver', '#b5b8bb', 'metallic'], ['meteoroid grey', '#5c6063', 'metallic'],
  ['solid white', '#f1f1ee', 'solid'], ['pearl black', '#121315', 'pearl'], ['magnetic blue', '#25428a', 'metallic'], ['ceramic grey', '#8e9294', 'metallic'],
  ['gun metallic', '#51565a', 'metallic'], ['storm white', '#f0efea', 'pearl'], ['fuji red', '#a5161e', 'metallic'], ['vivid blue', '#1e56a8', 'metallic'],
  ['soul red crystal', '#a1121d', 'metallic'], ['soul red', '#a1121d', 'metallic'], ['machine grey', '#5b5f62', 'metallic'], ['polymetal grey', '#7e8689', 'metallic'],
  ['jet black', '#0d0e0f', 'solid'], ['snow white pearl', '#f1f1ec', 'pearl'], ['clear white', '#f2f2ef', 'solid'], ['infra red', '#b51820', 'solid'],
  ['aurora black', '#121315', 'pearl'], ['platinum graphite', '#585c5f', 'metallic'], ['phantom black', '#101113', 'pearl'], ['polar white', '#f3f3ef', 'solid'],
  ['shadow grey', '#4d5154', 'metallic'], ['dark knight', '#1a1c20', 'pearl'], ['gravity gold', '#7e6a4c', 'metallic'],
  // Land Rover / Jaguar / Volvo / Renault / Peugeot / Citroen / Fiat
  ['fuji white', '#f2f2ee', 'solid'], ['santorini black', '#111214', 'metallic'], ['carpathian grey', '#3d4043', 'pearl'], ['eiger grey', '#55595c', 'metallic'],
  ['seoul pearl silver', '#a9adb0', 'pearl'], ['firenze red', '#8c1520', 'metallic'], ['byron blue', '#2b4d7a', 'metallic'], ['corris grey', '#5f6366', 'metallic'],
  ['lantau bronze', '#6b5848', 'metallic'], ['narvik black', '#101113', 'solid'], ['yulong white', '#f0efe9', 'metallic'], ['indus silver', '#b1b4b7', 'metallic'],
  ['crystal white', '#f0f0ec', 'pearl'], ['onyx black', '#111214', 'metallic'], ['thunder grey', '#5b5f63', 'metallic'], ['denim blue', '#3a5677', 'metallic'],
  ['glacier white', '#f2f2ef', 'solid'], ['diamond black', '#121315', 'metallic'], ['flame red', '#b31a1f', 'solid'], ['iron blue', '#2b4566', 'metallic'],
  ['nera perla', '#121315', 'pearl'], ['perla nera', '#121315', 'pearl'], ['nera onice', '#141517', 'metallic'], ['passione red', '#a3161e', 'solid'],
  ['bianco gelato', '#f2f2ee', 'solid'], ['nacre white', '#efeeea', 'pearl'], ['artense grey', '#5c6064', 'metallic'], ['vertigo blue', '#1f4b8b', 'metallic'],
  ['elixir red', '#9c1520', 'metallic'], ['pearl white', '#f0efea', 'pearl'], ['perla black', '#111214', 'pearl'], ['ultimate red', '#a2141e', 'metallic'],
  ['platinum grey', '#7a7e81', 'metallic'], ['cumulus grey', '#8e9193', 'metallic'], ['polar white', '#f3f3ef', 'solid']
];

// DVLA basic colours and plain words
// prettier-ignore
const BASIC: Array<[RegExp, string]> = [
  [/\b(white|blanc|bianco|polar|ivory)\b/, '#f1f1ee'],
  [/\b(black|noir|nero|onyx|ebony)\b/, '#131416'],
  [/\b(silver|argent|platinum|aluminium)\b/, '#b6b9bc'],
  [/\b(grey|gray|graphite|gunmetal|charcoal|anthracite|titanium|slate)\b/, '#5f6367'],
  [/\b(red|rosso|rouge|crimson|scarlet|ruby|cherry)\b/, '#b3141e'],
  [/\b(maroon|burgundy|wine|claret)\b/, '#5e1520'],
  [/\b(blue|navy|azure|cobalt|sapphire|indigo)\b/, '#234a8a'],
  [/\b(turquoise|teal|aqua|cyan)\b/, '#1f7f86'],
  [/\b(green|olive|emerald|lime|jade|khaki)\b/, '#2c5a3b'],
  [/\b(yellow|lemon)\b/, '#e0bc1c'],
  [/\b(orange|amber|copper|tangerine)\b/, '#d2621c'],
  [/\b(gold)\b/, '#a8894e'],
  [/\b(bronze)\b/, '#7a5c3e'],
  [/\b(brown|chocolate|mocha|coffee)\b/, '#4b3427'],
  [/\b(beige|cream|sand|champagne)\b/, '#c9b99a'],
  [/\b(purple|violet|plum|lilac|mauve)\b/, '#4a2a5c'],
  [/\b(pink)\b/, '#d58aa5']
];

export const DEFAULT_PAINT: Paint = { name: 'Not recorded', hex: '#c8ced6', finish: 'metallic', fallback: true };

const BY_NAME = [...NAMED].sort((a, b) => b[0].length - a[0].length);

/** Paint for a colour description ("Magnetic Grey", "BLUE", "dark blue metallic"); a neutral silver when unknown. */
export function paintFor(colour: string | null | undefined): Paint {
  const raw = (colour ?? '').trim();
  const t = raw.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!t) return DEFAULT_PAINT;
  const hex = /#?([0-9a-f]{6})\b/i.exec(t);
  if (hex && /^#?[0-9a-f]{6}$/i.test(t)) return { name: raw, hex: `#${hex[1]!.toLowerCase()}`, finish: 'metallic' };
  const keyFinish: Finish | undefined = /pearl|pearlescent|mica|crystal/.test(t) ? 'pearl' : /metallic|\bmet\b/.test(t) ? 'metallic' : /matt|matte|satin|frozen/.test(t) && !/frozen white/.test(t) ? 'matte' : /solid|flat|non.?metallic/.test(t) ? 'solid' : undefined;
  for (const [name, h, finish] of BY_NAME) {
    if (t.includes(name)) return { name: titleCase(name), hex: h, finish: keyFinish ?? finish };
  }
  for (const [re, h] of BASIC) {
    if (re.test(t)) {
      let c = h;
      if (/\b(dark|deep|midnight|night)\b/.test(t)) c = shade(c, -0.35);
      else if (/\b(light|pale|sky|baby|ice)\b/.test(t)) c = shade(c, 0.35);
      return { name: raw, hex: c, finish: keyFinish ?? (/(white|black)/.test(t) ? 'solid' : 'metallic') };
    }
  }
  return { ...DEFAULT_PAINT, name: raw };
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Lighten (k > 0) or darken (k < 0) a hex colour. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k)));
  return `#${ch.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}
