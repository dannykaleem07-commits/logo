/**
 * Whole-registry checks. HTML only — no Chromium — so this file runs in well under a second and is the first thing to
 * fail when a template drifts.
 *
 *   1. Coverage: every template id in ARCHITECTURE.md ("Documents" → "Template set (minimum)") is registered, and every
 *      registered id is either in that list or in KNOWN_EXTRA_TEMPLATE_IDS. Adding a template means adding its id to
 *      ARCHITECTURE.md or to that list — the test is how the document and the code stay in step.
 *   2. Content: every template renders its sample without legacy strings, banned phrases, "our solicitors", wording that
 *      implies regulated status, GTA-as-entitlement wording, or — for the at-fault insurer — any Financial Ombudsman
 *      mention (a third-party claimant is not an eligible complainant: DISP 2.7).
 *   3. Shape: semver versions, id ↔ kind agreement, the mandatory layout elements, and no clock / randomness / I/O in any
 *      template source (templates are pure functions of their data).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { brand } from './brand.js';
import type { TemplateKind } from './common.js';
import { findBannedPhrases, findBlockedStrings, htmlToText } from './guards.js';
import { getTemplate, listTemplates, missingRequiredData, renderTemplate } from './registry.js';
import './templates/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** ARCHITECTURE.md → Documents → "Template set (minimum)". Baked in so the test is self-contained; the live file is parsed too. */
const ARCHITECTURE_TEMPLATE_IDS: readonly string[] = [
  'letter.ncaf',
  'letter.handling_ref_request',
  'letter.intervention_reply',
  'letter.collect_or_pay',
  'letter.delay_notice_gta_4_10',
  'letter.chaser_7',
  'letter.chaser_14',
  'letter.chaser_21',
  'letter.complaint_disp',
  'letter.dsar',
  'letter.cctv_preservation',
  'letter.letter_before_claim',
  'letter.part36_offer',
  'letter.vendor_verification_pack',
  'letter.pav_challenge',
  'letter.particularisation_demand',
  'invoice.hire',
  'invoice.storage',
  'invoice.recovery',
  'invoice.engineer_fee',
  'report.engineer',
  'report.pav',
  'agreement.credit_hire',
  'form.cancellation_sch3',
  'form.express_request_to_start',
  'form.mitigation_questionnaire',
  'form.statement_of_means',
  'form.statement_of_need',
  'statement.witness',
  'pack.gta_payment',
  'bundle.litigation_index',
  'notice.pcn_liability_transfer',
  'notice.s172_response',
  'schedule.loss',
  'certificate.signature'
];

/** Registered templates that go beyond the ARCHITECTURE minimum. Fine to have; list them so the coverage test is explicit. */
const KNOWN_EXTRA_TEMPLATE_IDS: readonly string[] = [
  'letter.client_update', // progress letter to the claimant
  'letter.supplier_instruction_engineer' // instruction to the independent engineer
];

const TEMPLATE_KINDS: readonly TemplateKind[] = [
  'letter',
  'invoice',
  'report',
  'notice',
  'agreement',
  'form',
  'statement',
  'pack',
  'bundle',
  'schedule',
  'certificate'
];

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Wording that implies regulated status (perimeter.md). The status line itself is removed before these run. */
const REGULATED_STATUS_PATTERNS: readonly RegExp[] = [
  /\bour solicitors?\b/i,
  /\bour lawyers?\b/i,
  /\bwe act as (?:your |the claimant['’]s )?(?:solicitors?|lawyers?)\b/i,
  /\bwe act for\b/i,
  /\blegal advice\b/i,
  /\bour clients?['’]?s?\b/i, // the claimant is the litigant in person, never "our client"
  /\bregulated by the (?:SRA|FCA)\b/i // only the negated status line may say this, and it has been removed
];

/** GTA framed as an entitlement or an obligation rather than an industry benchmark (perimeter.md). */
const GTA_ENTITLEMENT_PATTERNS: readonly RegExp[] = [
  /\bunder the GTA\b/i,
  /\bGTA\b[^.]{0,80}\bentitle/i,
  /\bentitle[a-z]*\b[^.]{0,80}\bGTA\b/i,
  /\byou must\b[^.]{0,60}\bGTA\b/i,
  /\bGTA\b[^.]{0,60}\byou must\b/i
];

/** A third-party claimant cannot take the at-fault insurer to the Financial Ombudsman (DISP 2.7). */
const FOS_PATTERNS: readonly RegExp[] = [/\bombudsman\b/i, /\bFOS\b/];

/** Rendering artefacts that mean a formatter or a data path was missed. */
const RENDER_ARTEFACTS: readonly string[] = ['Invalid Date', 'NaN', 'undefined', '[object Object]'];

function readArchitectureTemplateIds(): string[] | undefined {
  const path = resolve(here, '../../../docs/ARCHITECTURE.md');
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => l.includes('Template set (minimum)'));
  if (!line) return undefined;
  return [...line.matchAll(/`([a-z][a-z0-9_]*\.[a-z0-9_]+)`/g)].map((m) => m[1] as string);
}

/** Visible text with the mandatory status line removed, so its "not a firm of solicitors … not regulated by the SRA" does not trip the perimeter checks. */
function bodyText(html: string): string {
  return htmlToText(html).split(brand.company.statusLine).join(' ');
}

const metas = listTemplates();

describe('template coverage against ARCHITECTURE.md', () => {
  const registered = new Set(metas.map((m) => m.id));

  it('registers every id in the ARCHITECTURE template set', () => {
    const missing = ARCHITECTURE_TEMPLATE_IDS.filter((id) => !registered.has(id));
    expect(missing).toEqual([]);
    expect(metas.length).toBeGreaterThanOrEqual(ARCHITECTURE_TEMPLATE_IDS.length);
  });

  it('lists every registered id either in ARCHITECTURE.md or as a known extra', () => {
    const allowed = new Set([...ARCHITECTURE_TEMPLATE_IDS, ...KNOWN_EXTRA_TEMPLATE_IDS]);
    const unlisted = metas.map((m) => m.id).filter((id) => !allowed.has(id));
    expect(unlisted, 'add the id to ARCHITECTURE.md (Documents → Template set) or to KNOWN_EXTRA_TEMPLATE_IDS').toEqual([]);
    for (const id of KNOWN_EXTRA_TEMPLATE_IDS) expect(registered.has(id), `known extra ${id} is not registered`).toBe(true);
  });

  it('agrees with the live docs/ARCHITECTURE.md when it is present', () => {
    const live = readArchitectureTemplateIds();
    if (!live) return; // package checked out on its own
    expect(live.length).toBeGreaterThan(0);
    expect([...live].sort()).toEqual([...ARCHITECTURE_TEMPLATE_IDS].sort());
    expect(live.filter((id) => !registered.has(id))).toEqual([]);
  });

  it('has no duplicate ids and lists them sorted', () => {
    const ids = metas.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});

describe('template metadata', () => {
  for (const meta of metas) {
    it(`${meta.id}: semver version, kind matches id, title and requiredData present`, () => {
      expect(meta.version).toMatch(SEMVER_RE);
      expect(TEMPLATE_KINDS).toContain(meta.kind);
      expect(meta.id.startsWith(`${meta.kind}.`)).toBe(true);
      expect(meta.title.trim().length).toBeGreaterThan(0);
      expect(meta.requiredData.length).toBeGreaterThan(0);
      expect(meta.requiredData).toContain('date'); // the document date comes from the API, never the clock
      expect(meta.requiredData).toContain('settings.registeredOffice'); // Part 6 disclosure
      expect(new Set(meta.requiredData).size).toBe(meta.requiredData.length);
    });
  }
});

describe('every template renders its sample within the perimeter', () => {
  for (const meta of metas) {
    const template = getTemplate(meta.id);
    const data = template.sample();
    const { html, templateVersion, title } = renderTemplate(meta.id, data);
    const text = bodyText(html);

    describe(`${meta.id} v${meta.version}`, () => {
      it('satisfies its own requiredData and renders deterministically', () => {
        expect(missingRequiredData(template, data)).toEqual([]);
        expect(templateVersion).toBe(meta.version);
        expect(title.trim().length).toBeGreaterThan(0);
        expect(renderTemplate(meta.id, template.sample()).html).toBe(html); // pure: same data → same HTML
      });

      it('carries the mandatory layout elements', () => {
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain('class="logo-lockup"');
        expect(html).toContain('<meta name="ccguk:reference"');
        expect(html).toContain(`<meta name="ccguk:kind" content="${meta.kind}">`);
        expect(html).toContain(brand.typography.fontStack.split(',')[0] as string);
        expect(htmlToText(html)).toContain(brand.company.statusLine);
        expect(htmlToText(html)).toContain('Registered in England and Wales, company number 17430389');
        for (const artefact of RENDER_ARTEFACTS) expect(html, `rendered "${artefact}"`).not.toContain(artefact);
      });

      it('prints the real company details, never a placeholder office (design doc §H)', () => {
        expect(html).not.toMatch(/\[registered office\]/);
        expect(htmlToText(html)).toContain('44 Syon Lane, Isleworth, London TW7 5NQ');
        expect(htmlToText(html)).toContain('claims@courtesycars.net');
      });

      if (meta.kind === 'letter') {
        it('marks the letter parts the letterhead composer reads (data-letter-part)', () => {
          expect(html).toContain('data-letter-part="body"');
          expect(html).toContain('data-letter-part="ref-our"');
          expect(html).toContain('data-letter-part="ref-date"');
          if (data && typeof data === 'object' && (data as { recipient?: unknown }).recipient) expect(html).toContain('data-letter-part="recipient"');
        });
      }

      it('contains no legacy strings or banned phrases', () => {
        expect(findBlockedStrings(html)).toEqual([]);
        expect(findBannedPhrases(html)).toEqual([]);
        expect(text).not.toMatch(/\bour solicitors\b/i);
      });

      it('never implies regulated status', () => {
        for (const re of REGULATED_STATUS_PATTERNS) {
          const m = re.exec(text);
          expect(m, m ? `"${m[0]}" at …${text.slice(Math.max(0, m.index - 60), m.index + 80)}…` : '').toBeNull();
        }
      });

      it('frames the GTA as an industry benchmark, never an entitlement', () => {
        for (const re of GTA_ENTITLEMENT_PATTERNS) {
          const m = re.exec(text);
          expect(m, m ? `"${m[0]}" at …${text.slice(Math.max(0, m.index - 60), m.index + 80)}…` : '').toBeNull();
        }
      });

      if (meta.recipientRole === 'at_fault_insurer') {
        it('does not mention the Financial Ombudsman to the at-fault insurer (DISP 2.7)', () => {
          for (const re of FOS_PATTERNS) {
            const m = re.exec(text);
            expect(m, m ? `"${m[0]}" at …${text.slice(Math.max(0, m.index - 60), m.index + 80)}…` : '').toBeNull();
          }
        });
      }
    });
  }
});

describe('template sources are pure', () => {
  const dir = join(here, 'templates');
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts');

  it('finds the template modules', () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of sources) {
    it(`${file} does not read the clock, randomness, the environment or the filesystem`, () => {
      const code = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/^\s*\/\/.*$/gm, ''); // full-line comments
      expect(code).not.toMatch(/\bDate\.now\s*\(/);
      expect(code).not.toMatch(/\bnew Date\s*\(\s*\)/);
      expect(code).not.toMatch(/\bMath\.random\s*\(/);
      expect(code).not.toMatch(/\bprocess\.env\b/);
      expect(code).not.toMatch(/\breadFileSync\b|\breadFile\b|\bfetch\s*\(/);
      expect(code).not.toMatch(/from '\.\.\/index\.js'/); // would be a cycle
    });
  }
});
