/**
 * Perimeter and script-guard copy check for the Fleet / Directory / KB / Analytics / Settings / Capture / Watch / Login /
 * Templates / Vehicles / GTA rates / Knowledge screens (README convention 9; extends the guard in claims/new/fnol.test.ts). No screen copy may advise a client
 * to ignore or decline an insurer's offer, imply regulated status, or carry legacy details. The legacy list itself
 * lives in lib/legacy.ts, which is deliberately outside the scanned folders.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BANNED = ['ignore any offer of a courtesy car', 'do not accept a vehicle from the insurer', 'our solicitors', 'we act as your solicitors', 'legal advice from our lawyers', '17360033', '66 paul st', 'ec2a 4px', 'ec2a4px', 'courtesycarsuk.co.uk'];
const ADVICE_PATTERNS = [/(?<!not )regulated by the sra/i, /ignore (the|their|any) offer/i, /(decline|refuse|reject|turn down) (the|their|any|that) (offer|vehicle|courtesy car)/i, /tell (the client|them) to (ignore|decline|refuse)/i, /do not (accept|take) (the|a|their) (vehicle|car|offer)/i];
/** The legacy supplier name may appear only in the exact registered style CARFLEX LTD (the watch-list seed). */
const CARFLEX_PATTERNS = [/car ?flex/i];

const FOLDERS = ['fleet', 'directory', 'kb', 'analytics', 'settings', 'capture', 'watch', 'login', 'templates', 'vehicles', 'gta', 'knowledge'];
const root = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile() && /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p));
}

describe('screen copy carries no legacy detail and never advises on insurer offers', () => {
  const files = FOLDERS.flatMap((f) => sources(join(root, f)));
  it('scans every screen source file', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lower = text.toLowerCase();
      for (const phrase of BANNED) expect(lower.includes(phrase), `${file} contains "${phrase}"`).toBe(false);
      for (const re of ADVICE_PATTERNS) expect(re.test(text), `${file} matches ${re}`).toBe(false);
      for (const line of text.split('\n')) {
        for (const re of CARFLEX_PATTERNS) {
          if (re.test(line) && !/CARFLEX LTD/.test(line)) throw new Error(`${file}: legacy supplier name outside the registered style: ${line.trim()}`);
        }
      }
    }
  });
  it('the FOS is never named as open against the at-fault insurer', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(/complain to the (financial )?ombudsman about the (at-fault|third[- ]party) insurer/i.test(text), file).toBe(false);
    }
  });
});

/**
 * Smart intake (docs/SMART-INTAKE.md §4.11, §11.5, §15): no intake screen describes a client or a document as untrue.
 * Risk signals are plain facts with the innocent explanation, for the owner only. Every source file of the intake
 * folder (case bundles included) and the intake insertions elsewhere is scanned, comments too.
 */
const INTAKE_BANNED = /fraud|fraudulent|fake|forg|dishonest|\blie\b|lying|scam|suspicious|staged/i;

function sourcesDeep(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sourcesDeep(p);
    return /\.(ts|tsx|css|json)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

describe('intake screens never accuse (case bundles, risk signals)', () => {
  const files = [
    ...sourcesDeep(join(root, 'intake')),
    join(root, 'needsYou', 'panels', 'BundleReadyPanel.tsx'),
    join(root, 'settings', 'intake', 'IntakeSettingsPage.tsx'),
    join(root, 'claim', 'components', 'IntakeBriefCard.tsx'),
    join(root, '..', 'api', 'bundlesApi.ts'),
  ];
  it('scans the intake folder and the intake insertions', () => {
    expect(files.length).toBeGreaterThanOrEqual(25);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        expect(INTAKE_BANNED.test(line), `${file}:${i + 1}: ${line.trim()}`).toBe(false);
      });
      const lower = text.toLowerCase();
      for (const phrase of BANNED) expect(lower.includes(phrase), `${file} contains "${phrase}"`).toBe(false);
      for (const re of ADVICE_PATTERNS) expect(re.test(text), `${file} matches ${re}`).toBe(false);
    }
  });
});

