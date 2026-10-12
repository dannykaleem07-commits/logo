// owned by claimai-web
/**
 * AI input copy guard (docs/CLAIM-AI-INPUT.md §15, §16.6): no screen text in screens/claim/ai/** (sources, styles and the
 * synthetic fixtures) describes anyone or any document as untrue, none advises on an insurer's offer, and the folder
 * uses theme tokens only (no colour literals), so light and dark both work.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(fileURLToPath(import.meta.url));
/**
 * The words of @ccguk/domain BANNED_INTAKE_WORDS (web does not depend on new domain exports), as whole words: this folder
 * says "applying" and "apply" everywhere, and "applying" contains "lying".
 */
const BANNED = /\b(fraud\w*|fake\w*|forge[ds]?|forger(y|ies)|forging|dishonest\w*|lie|lies|lying|liar|scam\w*|suspicious\w*|suspicion|staged)\b/i;
const ADVICE = [
  /ignore (the|their|any) offer/i,
  /(decline|refuse|reject|turn down) (the|their|any|that) (offer|vehicle|courtesy car)/i,
  /(you should|we recommend|best to) (accept|take|refuse|reject) (the|their|this) offer/i,
  /tell (the client|them) to (ignore|decline|refuse)/i,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx|css|json)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

describe('AI input screens: plain, neutral copy', () => {
  const files = [...walk(root), join(root, '..', '..', '..', 'api', 'claimAiApi.ts')];
  it('scans every source, style and fixture file of the AI input folder', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of ['AiInputTab.tsx', 'UpdateBox.tsx', 'PreviewCard.tsx', 'CatchUpCard.tsx', 'aiInput.css']) expect(files.some((p) => p.endsWith(f)), f).toBe(true);
  });
  it('never accuses anyone and never advises on an offer', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        expect(BANNED.test(line), `${file}:${i + 1}: ${line.trim()}`).toBe(false);
        for (const re of ADVICE) expect(re.test(line), `${file}:${i + 1} matches ${re}`).toBe(false);
      });
    }
  });
  it('colours only through the theme tokens (no hex or rgb literals in the styles)', () => {
    const css = readFileSync(join(root, 'aiInput.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/#[0-9a-f]{3,8}\b/i.test(css), 'hex colour in aiInput.css').toBe(false);
    expect(/\brgba?\(/i.test(css), 'rgb colour in aiInput.css').toBe(false);
    for (const file of files.filter((f) => f.endsWith('.tsx'))) {
      const text = readFileSync(file, 'utf8');
      expect(/(color|background)\s*:\s*['"]?#[0-9a-f]{3,8}/i.test(text), `${file}: inline hex colour`).toBe(false);
    }
  });
  it('money, offers, legal steps and closing are described as going to Needs-you, never as done', () => {
    const model = readFileSync(join(root, 'aiInputModel.ts'), 'utf8');
    expect(model).toMatch(/needs_you: 'A card goes to Needs-you; you decide there\. Nothing else changes\.'/);
    const box = readFileSync(join(root, 'UpdateBox.tsx'), 'utf8');
    expect(box).toMatch(/money, offers, legal steps and closing go to Needs-you/);
  });
});
