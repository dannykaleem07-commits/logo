/**
 * Perimeter, script-guard and append-only check for the claim-file screens (README convention 9). Extends
 * screens/copyGuard.test.ts (which covers the other screen folders, one level deep) and claims/new/fnol.test.ts:
 * this one walks screens/claim recursively (tabs/, tabs/engineering/, components/, lib/).
 *
 * No screen copy may advise a client to ignore or decline an insurer's offer, imply regulated status, or carry legacy
 * details. The legacy list itself lives in lib/legacy.ts, outside this folder.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BANNED = ['ignore any offer of a courtesy car', 'do not accept a vehicle from the insurer', 'our solicitors', 'we act as your solicitors', 'legal advice from our lawyers', '17360033', '66 paul st', 'ec2a 4px', 'ec2a4px', 'courtesycarsuk.co.uk'];
const ADVICE_PATTERNS = [/(?<!not )regulated by the sra/i, /ignore (the|their|any) offer/i, /(decline|refuse|reject|turn down) (the|their|any|that) (offer|vehicle|courtesy car)/i, /tell (the client|them) to (ignore|decline|refuse)/i, /do not (accept|take) (the|a|their) (vehicle|car|offer)/i];
/** The legacy supplier name may appear only in the exact registered style CARFLEX LTD (the watch-list seed). */
const CARFLEX_PATTERNS = [/car ?flex/i];

const root = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

describe('claim-file copy carries no legacy detail and never advises on insurer offers', () => {
  const files = walk(root);
  it('scans every claim-file source file, including nested folders', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(files.some((f) => f.includes(join('tabs', 'engineering')))).toBe(true);
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
  it('GTA figures are always labelled as a benchmark where the GTA is cited in the hire and clocks screens', () => {
    const hire = readFileSync(join(root, 'lib', 'hire.ts'), 'utf8');
    const basis = readFileSync(join(root, 'components', 'BasisText.tsx'), 'utf8');
    expect(/benchmark/i.test(hire)).toBe(true);
    expect(/not a GTA subscriber/i.test(basis)).toBe(true);
  });
});

describe('append-only screens render no edit or delete control (README convention 5)', () => {
  const APPEND_ONLY = ['tabs/LedgerTab.tsx', 'tabs/ChronologyTab.tsx', 'tabs/EvidenceTab.tsx'];
  it.each(APPEND_ONLY)('%s has no edit / delete button and no DELETE, PATCH or PUT call', (rel) => {
    const text = readFileSync(join(root, rel), 'utf8');
    expect(/(Delete|Remove|Edit)\s+(entry|event|evidence|file|row)\b/.test(text), `${rel}: edit/delete label`).toBe(false);
    expect(/>\s*(Delete|Remove|Edit)\s*</.test(text), `${rel}: bare edit/delete button`).toBe(false);
    expect(/method:\s*'(DELETE|PATCH|PUT)'/.test(text), `${rel}: mutating verb`).toBe(false);
    expect(/use(Delete|Update)(Ledger|Event|Evidence)/.test(text), `${rel}: edit/delete hook`).toBe(false);
  });
  it('the ledger says corrections are new entries', () => {
    const text = readFileSync(join(root, 'tabs', 'LedgerTab.tsx'), 'utf8');
    expect(/corrections are new entries/i.test(text)).toBe(true);
  });
  it('the evidence tab says files are never edited or deleted', () => {
    const text = readFileSync(join(root, 'tabs', 'EvidenceTab.tsx'), 'utf8');
    expect(/never edited or deleted/i.test(text)).toBe(true);
  });
});

describe('no internal ids or design references in screen copy (0.3 §E8, §E12)', () => {
  const screens = join(root, '..');
  const read = (rel: string) => readFileSync(join(screens, rel), 'utf8');
  it.each([
    ['analytics/AnalyticsPage.tsx', /— lesson [a-z]/],
    ['kb/KbPage.tsx', /\(UNVERIFIED_CITATION\)|flags UNVERIFIED_CITATION/],
    ['kb/kb.ts', /\(lesson [a-z]\)/],
    ['claim/tabs/ClocksTab.tsx', /className="xs muted mono">\{c\.kind\}/],
    ['claim/tabs/engineering/EngineerReportForm.tsx', /Generate report\.engineer|the report\.engineer document/],
    ['claim/tabs/LedgerTab.tsx', /corrects \$\{r\.entry\.supersedesId\}/],
    ['claims/new/NewClaimPage.tsx', /flags\.map\(\(f\) => f\.code\)/]
  ])('%s', (rel, re) => {
    expect(re.test(read(rel)), `${rel} matches ${re}`).toBe(false);
  });
  it('server text that can carry ids or references is passed through plainText where it is shown', () => {
    expect(read('watch/WatchPage.tsx')).toMatch(/plainText\(r\)/);
    expect(read('claim/components/GatesRow.tsx')).toMatch(/plainText\(m\)/);
  });
});
