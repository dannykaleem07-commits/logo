// owned by ap-paperwork
import { describe, expect, it } from 'vitest';
import { byteCapacity, dataCodewords, dataModuleOrder, encodeQr, formatBits, maskApplies, MAX_VERSION, qrSvgPath, reedSolomon, versionBits, type QrCode } from './qr';

/** ISO/IEC 18004 Table C.1 — format information for level M, masks 0–7 (after the 101010000010010 XOR). */
const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];

/** ISO/IEC 18004 Table D.1 — version information for versions 7–10. */
const VERSION_INFO: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

/** Byte-mode capacity at level M (ISO/IEC 18004 Table 7). */
const BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

// ---------------------------------------------------------------------------
// A small reader used to check symbols end to end (format → unmask → codewords → RS check → payload).
// ---------------------------------------------------------------------------

const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS: number[][] = [[16], [28], [44], [32, 32], [43, 43], [27, 27, 27, 27], [31, 31, 31, 31], [38, 38, 39, 39], [36, 36, 36, 37, 37], [43, 43, 43, 43, 44]];

function isFunctionModule(version: number, size: number, x: number, y: number): boolean {
  const inFinder = (cx: number, cy: number) => Math.abs(x - cx) <= 4 && Math.abs(y - cy) <= 4;
  if (inFinder(3, 3) || inFinder(size - 4, 3) || inFinder(3, size - 4)) return true;
  if (x === 6 || y === 6) return true;
  if ((x === 8 && (y <= 8 || y >= size - 8)) || (y === 8 && (x <= 8 || x >= size - 8))) return true;
  if (version >= 7 && ((x >= size - 11 && x <= size - 9 && y <= 5) || (y >= size - 11 && y <= size - 9 && x <= 5))) return true;
  const pos = ([[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]] as number[][])[version - 1]!;
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i += 1)
    for (let j = 0; j < pos.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      if (Math.abs(x - pos[i]!) <= 2 && Math.abs(y - pos[j]!) <= 2) return true;
    }
  return false;
}

function read(qr: QrCode): { text: string; mask: number } {
  const { modules: m, size, version } = qr;
  expect(size).toBe(17 + 4 * version);
  // Format info, first copy (bits 0..14 as placed by the encoder)
  const coords: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i += 1) coords.push([8, i]);
  coords.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i += 1) coords.push([14 - i, 8]);
  let fmt = 0;
  coords.forEach(([x, y], i) => {
    if (m[y]![x]) fmt |= 1 << i;
  });
  const mask = FORMAT_M.findIndex((s) => parseInt(s, 2) === fmt);
  expect(mask, 'format information decodes to level M').toBeGreaterThanOrEqual(0);
  // Second copy agrees
  let fmt2 = 0;
  for (let i = 0; i < 8; i += 1) if (m[8]![size - 1 - i]) fmt2 |= 1 << i;
  for (let i = 8; i < 15; i += 1) if (m[size - 15 + i]![8]) fmt2 |= 1 << i;
  expect(fmt2).toBe(fmt);
  expect(m[size - 8]![8]).toBe(true); // dark module
  // Version info
  if (version >= 7) {
    let v = 0;
    for (let i = 0; i < 18; i += 1) if (m[Math.floor(i / 3)]![size - 11 + (i % 3)]) v |= 1 << i;
    expect(v).toBe(VERSION_INFO[version]);
  }
  // Codewords
  const order = dataModuleOrder(size, (x, y) => isFunctionModule(version, size, x, y));
  const total = BLOCKS[version - 1]!.reduce((t, n) => t + n + EC_PER_BLOCK[version - 1]!, 0);
  const cws: number[] = [];
  for (let i = 0; i < total * 8; i += 1) {
    const [x, y] = order[i]!;
    const bit = (m[y]![x] ? 1 : 0) ^ (maskApplies(mask, x, y) ? 1 : 0);
    if ((i & 7) === 0) cws.push(0);
    cws[cws.length - 1] = (cws[cws.length - 1]! << 1) | bit;
  }
  // De-interleave and check every block's EC codewords
  const sizes = BLOCKS[version - 1]!;
  const ec = EC_PER_BLOCK[version - 1]!;
  const blocks = sizes.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...sizes); i += 1) sizes.forEach((s, b) => i < s && blocks[b]!.push(cws[k++]!));
  const ecs = sizes.map(() => [] as number[]);
  for (let i = 0; i < ec; i += 1) sizes.forEach((_s, b) => ecs[b]!.push(cws[k++]!));
  blocks.forEach((block, b) => expect(reedSolomon(block, ec)).toEqual(ecs[b]));
  // Parse byte mode
  const data = blocks.flat();
  const bits = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (byte >>> s) & 1));
  let p = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | bits[p++]!;
    return v;
  };
  expect(take(4)).toBe(0b0100);
  const len = take(version < 10 ? 8 : 16);
  const bytes = Array.from({ length: len }, () => take(8));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), mask };
}

describe('known vectors', () => {
  it('Reed–Solomon: the classic 1-M "HELLO WORLD" data codewords give the published EC codewords', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('format information for level M matches the standard table for every mask', () => {
    FORMAT_M.forEach((s, mask) => expect(formatBits(mask).toString(2).padStart(15, '0'), `mask ${mask}`).toBe(s));
  });

  it('version information matches the standard table for versions 7–10', () => {
    for (const [v, bits] of Object.entries(VERSION_INFO)) expect(versionBits(Number(v))).toBe(bits);
  });

  it('byte-mode capacities at level M match the standard table', () => {
    expect(MAX_VERSION).toBe(10);
    expect(Array.from({ length: 10 }, (_, i) => byteCapacity(i + 1))).toEqual(BYTE_CAPACITY_M);
    expect(dataCodewords(1)).toBe(16);
    expect(dataCodewords(10)).toBe(216);
  });
});

describe('encodeQr', () => {
  it('encodes and reads back a kiosk URL', () => {
    const url = 'http://192.168.1.20:5181/sign/kiosk/2f6c0b9e4a1d7c3e8b5f0a2d4c6e8f1a3b5d7c9e1f3a5b7c9d1e3f5a7b9c1d3e';
    const qr = encodeQr(url);
    expect(qr.version).toBeLessThanOrEqual(10);
    expect(read(qr).text).toBe(url);
  });

  it('picks the smallest version that fits, and reads back at every version 1–10', () => {
    for (let v = 1; v <= 10; v += 1) {
      const text = 'k'.repeat(Math.min(byteCapacity(v), 200));
      const qr = encodeQr(text);
      if (byteCapacity(v) <= 200) expect(qr.version).toBe(v);
      expect(read(qr).text).toBe(text);
    }
  });

  it('reads back with every forced mask, and the chosen mask is recorded in the format bits', () => {
    for (let mask = 0; mask < 8; mask += 1) expect(read(encodeQr('HELLO WORLD', { mask })).mask).toBe(mask);
    const best = encodeQr('https://example.test/sign');
    expect(read(best).mask).toBe(best.mask);
  });

  it('encodes UTF-8 and refuses text over 200 characters', () => {
    expect(read(encodeQr('Café — £5')).text).toBe('Café — £5');
    expect(() => encodeQr('x'.repeat(201))).toThrow(/too long/);
  });

  it('draws the finder patterns and timing pattern', () => {
    const qr = encodeQr('hello');
    const m = qr.modules;
    for (const [cx, cy] of [[3, 3], [qr.size - 4, 3], [3, qr.size - 4]] as const) {
      expect(m[cy]![cx]).toBe(true);
      expect(m[cy - 2]![cx]).toBe(false);
      expect(m[cy - 3]![cx]).toBe(true);
    }
    for (let i = 8; i < qr.size - 8; i += 1) expect(m[6]![i]).toBe(i % 2 === 0);
  });

  it('is deterministic and produces SVG path data', () => {
    expect(encodeQr('same')).toEqual(encodeQr('same'));
    const path = qrSvgPath(encodeQr('svg'), 4);
    expect(path.startsWith('M')).toBe(true);
    expect(path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  });
});
