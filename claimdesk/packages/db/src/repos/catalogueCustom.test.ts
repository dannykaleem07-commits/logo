import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { createTestDatabase } from '../testing.js';
import { createCustomCatalogueEntry, getCustomCatalogueEntry, listCustomCatalogueEntries, softDeleteCustomCatalogueEntry } from './catalogueCustom.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const actor = { userId: 'u1' };

describe('custom catalogue entries', () => {
  it('creates make, model and trim entries and lists them by make/model', () => {
    const make = createCustomCatalogueEntry(h.db, { level: 'make', make: 'Lynk & Co', makeSlug: 'lynk-and-co', name: 'Lynk & Co' }, actor);
    expect(make).toMatchObject({ level: 'make', makeSlug: 'lynk-and-co', overridesBuiltin: false, data: {}, createdBy: 'u1' });
    const model = createCustomCatalogueEntry(h.db, { level: 'model', make: 'Lynk & Co', makeSlug: 'lynk-and-co', model: '01', modelSlug: '01', name: '01', segment: 'suv-medium', gtaGroup: 'm2', data: { vehicleType: 'car' } }, actor);
    expect(model).toMatchObject({ gtaGroup: 'M2', segment: 'suv-medium', data: { vehicleType: 'car' } });
    createCustomCatalogueEntry(h.db, { level: 'trim', make: 'Ford', makeSlug: 'ford', model: 'Fiesta', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk8-2017-2023', name: 'Active X' }, actor);
    expect(listCustomCatalogueEntries(h.db)).toHaveLength(3);
    expect(listCustomCatalogueEntries(h.db, { makeSlug: 'lynk-and-co' })).toHaveLength(2);
    expect(listCustomCatalogueEntries(h.db, { makeSlug: 'ford', modelSlug: 'fiesta' }).map((e) => e.name)).toEqual(['Active X']);
  });

  it('records overrides of shipped entries', () => {
    const o = createCustomCatalogueEntry(h.db, { level: 'model', make: 'Ford', makeSlug: 'ford', model: 'Fiesta', modelSlug: 'fiesta', name: 'Fiesta', gtaGroup: 'S2', overridesBuiltin: true }, actor);
    expect(o.overridesBuiltin).toBe(true);
    expect(() => createCustomCatalogueEntry(h.db, { level: 'model', make: 'Ford', makeSlug: 'ford', modelSlug: 'fiesta', name: 'Fiesta', overridesBuiltin: true }, actor)).toThrow(/segment or GTA group/);
  });

  it('validates the entry', () => {
    expect(() => createCustomCatalogueEntry(h.db, { level: 'model', make: 'Ford', makeSlug: 'Ford', modelSlug: 'x', name: 'X' }, actor)).toThrow(ValidationError);
    expect(() => createCustomCatalogueEntry(h.db, { level: 'model', make: 'Ford', makeSlug: 'ford', name: 'X' }, actor)).toThrow(/model it belongs to/);
    expect(() => createCustomCatalogueEntry(h.db, { level: 'engine', make: 'Ford', makeSlug: 'ford', modelSlug: 'fiesta', name: '1.0 100PS petrol' }, actor)).toThrow(/generation/);
    expect(() => createCustomCatalogueEntry(h.db, { level: 'make', make: 'X', makeSlug: 'x', name: 'X', gtaGroup: 'group 1' }, actor)).toThrow(/GTA group/);
  });

  it('soft-deletes and hides deleted entries by default', () => {
    const e = createCustomCatalogueEntry(h.db, { level: 'make', make: 'Test', makeSlug: 'test', name: 'Test' }, actor);
    const d = softDeleteCustomCatalogueEntry(h.db, e.id, { userId: 'u2' });
    expect(d).toMatchObject({ deletedBy: 'u2' });
    expect(d.deletedAt).toBeTruthy();
    expect(softDeleteCustomCatalogueEntry(h.db, e.id, actor).deletedBy).toBe('u2');
    expect(listCustomCatalogueEntries(h.db)).toEqual([]);
    expect(listCustomCatalogueEntries(h.db, { includeDeleted: true })).toHaveLength(1);
    expect(getCustomCatalogueEntry(h.db, e.id)?.deletedAt).toBeTruthy();
    expect(() => softDeleteCustomCatalogueEntry(h.db, 'nope', actor)).toThrow(NotFoundError);
  });
});
