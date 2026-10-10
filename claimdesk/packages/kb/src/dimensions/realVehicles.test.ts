/**
 * The real data directory (packages/kb/data/vehicle-dimensions) for the vehicles the 3D model is checked against.
 * The directory is written by a separate data job: a make file that is missing or caught mid-write is skipped (and must
 * then show up in dimensionsLoadIssues), never a crash.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { dimensionsDataDir, dimensionsLoadIssues, findVehicleDimensions, makeSlug, resetDimensionsCache, setDimensionsDataDir } from './index.js';

const CASES = [
  { make: 'Ford', model: 'Fiesta', generation: 'Mk8', body: 'hatchback', doors: 5, profile: 'hatch', lengthMm: [3900, 4150] },
  { make: 'Ford', model: 'Fiesta', generation: 'Mk8', body: 'hatchback', doors: 3, profile: 'hatch', lengthMm: [3900, 4150] },
  { make: 'Volkswagen', model: 'Golf', generation: 'Mk8', body: 'hatchback', doors: 5, profile: 'hatch', lengthMm: [4150, 4400] },
  { make: 'Vauxhall', model: 'Corsa', generation: 'F', body: 'hatchback', doors: 5, profile: 'hatch', lengthMm: [3950, 4150] },
  { make: 'BMW', model: '3 Series', generation: 'G20', body: 'saloon', doors: 4, profile: 'saloon', lengthMm: [4600, 4800] },
  { make: 'Nissan', model: 'Qashqai', generation: 'J11', body: 'crossover', doors: 5, profile: 'suv', lengthMm: [4300, 4500] },
  { make: 'Land Rover', model: 'Range Rover Evoque', generation: 'L551', body: 'suv', doors: 5, profile: 'suv-coupe', lengthMm: [4300, 4450] },
  { make: 'Ford', model: 'Transit Custom', generation: 'Gen1', body: 'panel van', doors: 4, profile: 'van', lengthMm: [4900, 5400] },
  { make: 'Toyota', model: 'Hilux', generation: 'Mk8', body: 'pickup', doors: 4, profile: 'pickup', lengthMm: [5200, 5400] }
] as const;

describe('real vehicle dimensions used by the 3D model', () => {
  beforeAll(() => setDimensionsDataDir(undefined));
  afterAll(() => resetDimensionsCache());

  for (const c of CASES) {
    it(`${c.make} ${c.model} ${c.generation} ${c.doors}-door ${c.body}`, () => {
      const file = `${makeSlug(c.make)}.json`;
      // the data job has not written this make yet: nothing to check
      if (!existsSync(path.join(dimensionsDataDir(), file))) return;
      const hit = findVehicleDimensions(c);
      // a file caught mid-write is reported as an error issue, never thrown
      if (!hit && dimensionsLoadIssues().some((i) => i.file === file && i.level === 'error')) return;
      expect(hit, `${c.make} ${c.model} not found in ${file}`).toBeDefined();
      if (!hit) return;
      expect(hit.match).toBe('exact');
      expect(hit.dims.profile).toBe(c.profile);
      expect(hit.dims.lengthMm).toBeGreaterThanOrEqual(c.lengthMm[0]);
      expect(hit.dims.lengthMm).toBeLessThanOrEqual(c.lengthMm[1]);
      expect(hit.dims.doors).toBe(c.doors);
      // overhangs + wheelbase = length (the generator relies on it)
      const sum = hit.dims.frontOverhangRatio + hit.dims.rearOverhangRatio + hit.dims.wheelbaseMm / hit.dims.lengthMm;
      expect(sum).toBeCloseTo(1, 2);
      expect(hit.dims.wheelDiameterIn).toBeGreaterThanOrEqual(14);
      expect(hit.dims.wheelDiameterIn).toBeLessThanOrEqual(22);
    });
  }
});
