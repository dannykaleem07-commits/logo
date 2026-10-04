/**
 * Every engine string of the catalogue scratch drafts must parse with parseEngineLabel (§D.2 grammar). The drafts live
 * outside the repository (written by the data slice while it works); the test is skipped when they are not present.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEngineLabel } from './normalise.js';

const DRAFTS = '/tmp/claude-0/-home-user-logo/811a135a-35cb-5723-858d-e84fbd9027fa/scratchpad/catalogue/makes';
const present = existsSync(DRAFTS) && readdirSync(DRAFTS).some((f) => f.endsWith('.json'));

describe.skipIf(!present)('catalogue scratch drafts', () => {
  it('every engine string parses', () => {
    const failures: string[] = [];
    let count = 0;
    for (const f of readdirSync(DRAFTS).filter((x) => x.endsWith('.json'))) {
      let raw: { models?: Array<{ generations?: Array<{ engines?: unknown[] }> }> };
      try {
        raw = JSON.parse(readFileSync(path.join(DRAFTS, f), 'utf8'));
      } catch {
        continue; // a draft being written right now
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
    expect(count).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
