import { describe, expect, it } from 'vitest';
import { DEFAULT_PAINT, paintFor } from './paint';
import { drawPlate, formatRegistration, PLATE_COLOURS, type PlateCtx } from './plate';
import { resolveDims, resolveProfile, resolveSpec } from './spec';

describe('paint', () => {
  it('maps UK manufacturer colour names', () => {
    expect(paintFor('Magnetic Grey')).toMatchObject({ hex: '#4a4e53', finish: 'metallic' });
    expect(paintFor('RACE RED')).toMatchObject({ name: 'Race Red', finish: 'solid' });
    expect(paintFor('Polar White').finish).toBe('solid');
    expect(paintFor('Portimao Blue metallic').finish).toBe('metallic');
    expect(paintFor('Crystal Black Pearl').finish).toBe('pearl');
  });
  it('falls back to DVLA basic colours and shades', () => {
    expect(paintFor('BLUE').hex).toBe('#234a8a');
    expect(paintFor('dark blue').hex).not.toBe(paintFor('blue').hex);
    expect(paintFor('GREY').finish).toBe('metallic');
    expect(paintFor('#336699').hex).toBe('#336699');
    expect(paintFor('')).toBe(DEFAULT_PAINT);
    expect(paintFor('Unobtainium').fallback).toBe(true);
  });
});

function recorder(): PlateCtx & { texts: string[]; fills: string[] } {
  const r = {
    texts: [] as string[],
    fills: [] as string[],
    fillStyle: '' as PlateCtx['fillStyle'],
    strokeStyle: '' as PlateCtx['strokeStyle'],
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect() {},
    strokeRect() {},
    fillText(t: string) {
      r.texts.push(t);
    },
    beginPath() {},
    rect() {},
    fill() {
      r.fills.push(String(r.fillStyle));
    },
    stroke() {}
  };
  return r;
}

describe('number plates', () => {
  it('formats current, prefix and suffix marks', () => {
    expect(formatRegistration('ab12cde')).toBe('AB12 CDE');
    expect(formatRegistration(' AB12 CDE ')).toBe('AB12 CDE');
    expect(formatRegistration('M123ABC')).toBe('M123 ABC');
    expect(formatRegistration('ABC123D')).toBe('ABC 123D');
    expect(formatRegistration('1 ABC')).toBe('1 ABC');
    expect(formatRegistration(undefined)).toBe('');
  });
  it('draws the registration on a white front and yellow rear plate', () => {
    const f = recorder();
    expect(drawPlate(f, 'rx19fkd', 'front', 1040, 222)).toBe('RX19 FKD');
    expect(f.texts).toEqual(['RX19 FKD']);
    expect(f.fills[0]).toBe(PLATE_COLOURS.front);
    const r = recorder();
    drawPlate(r, 'RX19FKD', 'rear', 1040, 222);
    expect(r.fills[0]).toBe(PLATE_COLOURS.rear);
    const blank = recorder();
    expect(drawPlate(blank, '', 'rear', 1040, 222)).toBe('');
    expect(blank.texts).toEqual([]);
  });
});

describe('spec from the dimensions record', () => {
  it('reads the data vocabulary and door lists', () => {
    expect(resolveProfile('saloon', { profile: 'notchback' })).toBe('saloon');
    expect(resolveProfile('suv', { profile: 'suv-boxy' })).toBe('suv-boxy');
    expect(resolveProfile('panel-van', { profile: 'van-low' }, { body: 'PANEL VAN HIGH ROOF' })).toBe('van-high-roof');
    expect(resolveProfile('pickup', { profile: 'hatch' })).toBe('pickup');
    expect(resolveDims('hatch', { doors: [3, 5] }, { doors: 3 }).doors).toBe(3);
    expect(resolveDims('hatch', { doors: [3, 5] }).doors).toBe(5);
    expect(resolveDims('hatch', { doors: [5] }, { doors: 3 }).doors).toBe(5);
    expect(resolveDims('hatch', { lampStyle: 'wide-slim', grilleStyle: 'large-upright' })).toMatchObject({ lampStyle: 'slim', grilleStyle: 'large' });
  });
  it('tolerates a missing or broken record', () => {
    const s = resolveSpec('estate', { lengthMm: -5, widthMm: Number.NaN, wheelbaseMm: 9999 });
    expect(s.L).toBeCloseTo(4.7);
    expect(s.wheelbase).toBeLessThan(s.L);
    expect(resolveSpec('estate').key).toBe(resolveSpec('estate', null).key);
  });
  it('keys differ per vehicle so caches do not mix models', () => {
    expect(resolveSpec('hatchback', { lengthMm: 4040 }).key).not.toBe(resolveSpec('hatchback', { lengthMm: 4284 }).key);
  });
});
