// owned by ap-paperwork
/**
 * QR code encoder for the LAN kiosk link (docs/SUPREME-AUTOPILOT.md §E.3, §K): a small pure module, no dependency.
 *
 * Byte mode (UTF-8), error correction level M, versions 1–10 (up to 213 bytes; the kiosk URL is ≤ 200 characters),
 * the eight standard masks scored with the ISO/IEC 18004 penalty rules (N1 = 3, N2 = 3, N3 = 40, N4 = 10), format
 * information (BCH 15,5 with mask 101010000010010) and version information for version 7 and above (BCH 18,6).
 * The short URL is always shown in large type beside the code as well.
 */

export interface QrCode {
  version: number;
  /** Modules per side (17 + 4 × version). */
  size: number;
  /** The chosen mask pattern (0–7). */
  mask: number;
  /** modules[y][x] — true = dark. */
  modules: boolean[][];
}

export const QR_MAX_CHARS = 200;

/** Error correction level M: (ec codewords per block, [blocks, data codewords per block][]) for versions 1–10. */
const EC_M: ReadonlyArray<{ ec: number; groups: ReadonlyArray<readonly [number, number]> }> = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];

const ALIGNMENT: ReadonlyArray<readonly number[]> = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** Format bits for level M: the 2-bit level indicator is 00. */
const EC_LEVEL_M_BITS = 0b00;

export const MAX_VERSION = EC_M.length;

/** Data codewords of a version at level M. */
export function dataCodewords(version: number): number {
  return EC_M[version - 1]!.groups.reduce((t, [n, k]) => t + n * k, 0);
}

/** Bytes that fit in byte mode at level M (character count is 8 bits up to version 9, 16 bits from version 10). */
export function byteCapacity(version: number): number {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

// ---------------------------------------------------------------------------
// Reed–Solomon over GF(256), primitive polynomial 0x11D
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
})();

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial coefficients (highest degree first, leading 1 omitted) for `degree` EC codewords. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly.slice(1);
}

/** The `degree` error-correction codewords of `data` (polynomial division remainder). */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const gen = generator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < degree; i += 1) rem[i] = rem[i]! ^ gfMul(gen[i]!, factor);
  }
  return rem;
}

// ---------------------------------------------------------------------------
// BCH codes for format and version information
// ---------------------------------------------------------------------------

/** 15-bit format information for level M and a mask (already XORed with 101010000010010). */
export function formatBits(mask: number): number {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information (versions 7 and above). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ---------------------------------------------------------------------------
// Data encoding
// ---------------------------------------------------------------------------

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** The final interleaved codeword sequence (data then EC) for `bytes` in byte mode at `version`. */
export function encodeCodewords(bytes: readonly number[], version: number): number[] {
  const capacity = dataCodewords(version);
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  if (bits.length > capacity * 8) throw new Error('Data does not fit');
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, bit) => (v << 1) | bit, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const spec = EC_M[version - 1]!;
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i += 1) {
      const block = data.slice(offset, offset + size);
      offset += size;
      blocks.push(block);
      ecBlocks.push(reedSolomon(block, spec.ec));
    }
  }
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < spec.ec; i += 1) for (const b of ecBlocks) out.push(b[i]!);
  return out;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

interface Grid {
  size: number;
  dark: boolean[][];
  fn: boolean[][];
}

function newGrid(size: number): Grid {
  return { size, dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)), fn: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)) };
}

function setFn(g: Grid, x: number, y: number, dark: boolean): void {
  g.dark[y]![x] = dark;
  g.fn[y]![x] = true;
}

function drawFinder(g: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy += 1)
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(g, x, y, d !== 2 && d !== 4);
    }
}

function drawAlignment(g: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) setFn(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
}

function drawFormat(g: Grid, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) setFn(g, 8, i, bit(i));
  setFn(g, 8, 7, bit(6));
  setFn(g, 8, 8, bit(7));
  setFn(g, 7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) setFn(g, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) setFn(g, g.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) setFn(g, 8, g.size - 15 + i, bit(i));
  setFn(g, 8, g.size - 8, true); // the dark module
}

function drawVersion(g: Grid, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFn(g, a, b, dark);
    setFn(g, b, a, dark);
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  for (let i = 0; i < g.size; i += 1) {
    setFn(g, 6, i, i % 2 === 0);
    setFn(g, i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, g.size - 4, 3);
  drawFinder(g, 3, g.size - 4);
  const pos = ALIGNMENT[version - 1]!;
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i += 1)
    for (let j = 0; j < pos.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      drawAlignment(g, pos[i]!, pos[j]!);
    }
  drawFormat(g, 0); // reserves the format areas; redrawn with the chosen mask
  drawVersion(g, version);
}

/** Visit the data modules in placement order (two-column zig-zag from the bottom right, skipping column 6). */
export function dataModuleOrder(size: number, isFunction: (x: number, y: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction(x, y)) out.push([x, y]);
      }
    }
  }
  return out;
}

export function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error(`Unknown mask ${mask}`);
  }
}

/** ISO/IEC 18004 §7.8.3 penalty score of a finished symbol. */
export function penaltyScore(m: readonly boolean[][]): number {
  const size = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y += 1) lines.push([...m[y]!]);
  for (let x = 0; x < size; x += 1) lines.push(m.map((row) => row[x]!));
  for (const line of lines) {
    // N1: runs of five or more same-colour modules
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // N3: 1:1:3:1:1 finder-like pattern with four light modules on either side
    for (let i = 0; i + 7 <= size; i += 1) {
      const core = line[i] && !line[i + 1] && line[i + 2] && line[i + 3] && line[i + 4] && !line[i + 5] && line[i + 6];
      if (!core) continue;
      const lightBefore = i >= 4 && !line[i - 1] && !line[i - 2] && !line[i - 3] && !line[i - 4];
      const lightAfter = i + 11 <= size && !line[i + 7] && !line[i + 8] && !line[i + 9] && !line[i + 10];
      const edgeBefore = i - 4 < 0 && line.slice(0, i).every((v) => !v);
      const edgeAfter = i + 11 > size && line.slice(i + 7).every((v) => !v);
      if (lightBefore || lightAfter || edgeBefore || edgeAfter) score += 40;
    }
  }
  // N2: 2×2 blocks of the same colour
  for (let y = 0; y + 1 < size; y += 1)
    for (let x = 0; x + 1 < size; x += 1) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
    }
  // N4: dark proportion away from 50 %, 10 points per 5 % step
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark += 1;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

function smallestVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v += 1) if (byteLength <= byteCapacity(v)) return v;
  throw new Error(`Text too long for a QR code here (${byteLength} bytes; at most ${byteCapacity(MAX_VERSION)})`);
}

/** Encode `text` (≤ 200 characters) as a QR code, byte mode, level M, the smallest version that fits, best mask. */
export function encodeQr(text: string, opts: { mask?: number; minVersion?: number } = {}): QrCode {
  if (text.length > QR_MAX_CHARS) throw new Error(`Text too long for the kiosk QR code (${text.length} > ${QR_MAX_CHARS} characters)`);
  const bytes = utf8(text);
  const version = Math.max(smallestVersion(bytes.length), opts.minVersion ?? 1);
  const size = 17 + 4 * version;
  const codewords = encodeCodewords(bytes, version);
  const base = newGrid(size);
  drawFunctionPatterns(base, version);
  const order = dataModuleOrder(size, (x, y) => base.fn[y]![x]!);
  order.forEach(([x, y], i) => {
    const cw = i >> 3;
    base.dark[y]![x] = cw < codewords.length ? ((codewords[cw]! >>> (7 - (i & 7))) & 1) === 1 : false; // remainder bits are light
  });
  const build = (mask: number): boolean[][] => {
    const g: Grid = { size, dark: base.dark.map((r) => [...r]), fn: base.fn };
    for (const [x, y] of order) if (maskApplies(mask, x, y)) g.dark[y]![x] = !g.dark[y]![x];
    drawFormat(g, mask);
    return g.dark;
  };
  if (opts.mask !== undefined) return { version, size, mask: opts.mask, modules: build(opts.mask) };
  let best: QrCode | undefined;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = build(mask);
    const score = penaltyScore(modules);
    if (score < bestScore) {
      bestScore = score;
      best = { version, size, mask, modules };
    }
  }
  return best!;
}

/** SVG path data ("M x y h1 v1 h-1 z" per dark module) with a quiet zone of `border` modules. */
export function qrSvgPath(qr: QrCode, border = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y += 1) for (let x = 0; x < qr.size; x += 1) if (qr.modules[y]![x]) parts.push(`M${x + border} ${y + border}h1v1h-1z`);
  return parts.join('');
}
