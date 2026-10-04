import { describe, it, expect } from 'vitest';
import { mapGtaGroup } from './groups.js';

const v = (make: string, model: string, extra: Partial<Parameters<typeof mapGtaGroup>[0]> = {}) => ({ make, model, ...extra });

describe('mapGtaGroup (heuristic)', () => {
  it('uses a group recorded on the vehicle verbatim, not as a heuristic', () => {
    const m = mapGtaGroup(v('Volkswagen', 'Golf', { gtaGroup: 'm1' }));
    expect(m).toMatchObject({ group: 'M1', confidence: 'high', heuristic: false, rateAvailable: true });
  });
  it('maps small cars to S1', () => {
    expect(mapGtaGroup(v('Ford', 'Fiesta', { engineCapacityCc: 1084, bodyType: 'Hatchback' }))).toMatchObject({ group: 'S1', confidence: 'high', heuristic: true, rateAvailable: true });
    expect(mapGtaGroup(v('Vauxhall', 'Corsa', { engineCapacityCc: 1398 }))).toMatchObject({ group: 'S1', confidence: 'medium' });
    expect(mapGtaGroup(v('Renault', 'Zoe', { fuelType: 'electric' }))).toMatchObject({ group: 'S1', confidence: 'high' });
  });
  it('maps medium cars by engine size: Golf 1498cc → M, 1968cc → M1', () => {
    expect(mapGtaGroup(v('Volkswagen', 'Golf', { engineCapacityCc: 1498, bodyType: 'Hatchback' }))).toMatchObject({ group: 'M', confidence: 'medium', rateAvailable: true });
    expect(mapGtaGroup(v('Volkswagen', 'Golf', { engineCapacityCc: 1968, bodyType: 'Hatchback' }))).toMatchObject({ group: 'M1', confidence: 'medium' });
    expect(mapGtaGroup(v('Ford', 'Mondeo', { engineCapacityCc: 2500, bodyType: 'Estate' }))).toMatchObject({ group: 'L', confidence: 'low', rateAvailable: false });
  });
  it('maps vans to CP1/CP2 before any car rule', () => {
    expect(mapGtaGroup(v('Ford', 'Transit Custom', { engineCapacityCc: 1995, bodyType: 'Panel Van' }))).toMatchObject({ group: 'CP1', confidence: 'medium' });
    expect(mapGtaGroup(v('Mercedes-Benz', 'Sprinter', { engineCapacityCc: 2143, bodyType: 'Panel Van' }))).toMatchObject({ group: 'CP2', confidence: 'medium' });
    expect(mapGtaGroup(v('Citroen', 'Berlingo', { engineCapacityCc: 1499 }))).toMatchObject({ group: 'CP1' });
  });
  it('flags prestige, MPV and SUV mappings as low confidence', () => {
    expect(mapGtaGroup(v('BMW', '320d', { engineCapacityCc: 1995, bodyType: 'Saloon' }))).toMatchObject({ group: 'P1', confidence: 'low', rateAvailable: false });
    expect(mapGtaGroup(v('Ford', 'Galaxy', { engineCapacityCc: 1997, bodyType: 'MPV' }))).toMatchObject({ group: 'MPV1', confidence: 'low' });
    expect(mapGtaGroup(v('Nissan', 'Qashqai', { engineCapacityCc: 1332, bodyType: 'SUV' }))).toMatchObject({ group: 'M', confidence: 'low' });
    expect(mapGtaGroup(v('Mitsubishi', 'Outlander', { engineCapacityCc: 2360, bodyType: 'SUV' }))).toMatchObject({ group: 'M1', confidence: 'low' });
  });
  it('defaults to M with low confidence when nothing is known', () => {
    const m = mapGtaGroup(v('Unknown', 'Thing'));
    expect(m).toMatchObject({ group: 'M', confidence: 'low', heuristic: true });
    expect(m.reason).toMatch(/heuristic/);
  });
  it('marks rateAvailable from the injected rate table', () => {
    expect(mapGtaGroup(v('Ford', 'Fiesta', { engineCapacityCc: 998 }), []).rateAvailable).toBe(false);
  });
});
