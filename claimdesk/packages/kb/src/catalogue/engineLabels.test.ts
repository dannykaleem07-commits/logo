/**
 * Every engine string of the shipped vehicle catalogue (packages/kb/data/vehicle-catalogue/makes/*.json) must parse
 * with parseEngineLabel (§D.2 grammar, as widened in normalise.ts). Set CATALOGUE_DRAFTS_DIR to a folder of draft
 * make files to check work in progress the same way; that part is skipped when the variable is not set or the folder
 * holds no .json files.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEngineLabel } from './normalise.js';

const SHIPPED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'vehicle-catalogue', 'makes');
const DRAFTS = process.env.CATALOGUE_DRAFTS_DIR?.trim();
const draftsPresent = Boolean(DRAFTS && existsSync(DRAFTS) && readdirSync(DRAFTS).some((f) => f.endsWith('.json')));

type RawMake = { models?: Array<{ generations?: Array<{ engines?: unknown[] }> }> };

function checkEngines(dir: string, tolerateUnreadable: boolean): { count: number; failures: string[] } {
  const failures: string[] = [];
  let count = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let raw: RawMake;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as RawMake;
    } catch (err) {
      if (tolerateUnreadable) continue; // a draft being written right now
      throw err;
    }
    for (const m of raw.models ?? []) {
      for (const g of m.generations ?? []) {
        for (const e of g.engines ?? []) {
          if (typeof e !== 'string') continue;
          count += 1;
          try {
            parseEngineLabel(e);
          } catch {
            failures.push(`${f}: ${e}`);
          }
        }
      }
    }
  }
  return { count, failures };
}

describe('catalogue engine labels', () => {
  it('every engine string in the shipped make files parses', () => {
    const { count, failures } = checkEngines(SHIPPED, false);
    expect(count).toBeGreaterThan(1000);
    expect(failures).toEqual([]);
  });

  it.skipIf(!draftsPresent)('every engine string in CATALOGUE_DRAFTS_DIR parses', () => {
    const { count, failures } = checkEngines(DRAFTS!, true);
    expect(count).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
