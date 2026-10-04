/**
 * Adversarial verification for the "agreements-forms-packs" group (agreements-forms.ts, packs-bundles.ts, notices.ts,
 * certificate.ts) as a whole:
 *
 *  1. requiredData completeness — removing any single required key from the sample must throw DocumentDataError
 *     naming that key (not a TypeError from deep inside the render);
 *  2. the domain position-consistency engine's text checks (legacy details, banned phrases, regulated-status wording,
 *     GTA cited as law for a non-subscriber, forum not open) return no flags for any render;
 *  3. no render leaks "undefined", "NaN", "[object Object]" or "Invalid Date", and only the agreement carries the
 *     {{SHA256}} placeholder the API replaces;
 *  4. every template renders through Playwright to an A4 PDF with a sensible page count (the header/footer
 *     templates with the reference and "Page X of Y" are applied by renderPdf for every document).
 */
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { bannedPhraseCheck, forumChecks, gtaChecks, legacyCheck, type DraftContext } from '@ccguk/domain';
import { brand } from '../brand.js';
import { findProhibitedContent, htmlToText } from '../guards.js';
import { readDocumentMeta } from '../layout.js';
import { DocumentDataError, getTemplate, listTemplates, renderTemplate } from '../registry.js';
import { closeBrowser, renderPdf } from '../render.js';
import './index.js';

const GROUP = [
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
  'certificate.signature'
] as const;

/** Upper bound on pages for each sample: a fixture that paginates past this has a layout problem. */
const MAX_PAGES: Record<(typeof GROUP)[number], number> = {
  'agreement.credit_hire': 8,
  'form.cancellation_sch3': 1,
  'form.express_request_to_start': 2,
  'form.mitigation_questionnaire': 4,
  'form.statement_of_means': 4,
  'form.statement_of_need': 3,
  'statement.witness': 3,
  'pack.gta_payment': 6,
  'bundle.litigation_index': 3,
  'notice.pcn_liability_transfer': 3,
  'notice.s172_response': 2,
  'certificate.signature': 2
};

/** Deep clone of `data` with the dot-path `path` removed (the parent object is left in place). */
function without<T>(data: T, path: string): T {
  const clone = structuredClone(data) as unknown;
  const keys = path.split('.');
  let cur: unknown = clone;
  for (const k of keys.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return clone as T;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (cur !== null && typeof cur === 'object') delete (cur as Record<string, unknown>)[keys[keys.length - 1]!];
  return clone as T;
}

function fakeContext(templateId: string): DraftContext {
  const role = listTemplates().find((m) => m.id === templateId)?.recipientRole;
  // Only the fields the text checks read: a non-subscriber claim and the template's recipient role.
  return { bundle: { claim: { gtaSubscriber: false } }, templateId, recipientRole: role, draftCreatedAt: '2026-10-04T00:00:00Z', priorOutgoing: [] } as unknown as DraftContext;
}

describe('agreements-forms-packs group: requiredData completeness', () => {
  for (const id of GROUP) {
    it(`${id}: every required key, removed on its own, throws DocumentDataError naming it`, () => {
      const template = getTemplate(id);
      expect(template.requiredData.length).toBeGreaterThan(0);
      for (const key of template.requiredData) {
        const broken = without(template.sample(), key);
        let err: unknown;
        try {
          renderTemplate(id, broken);
        } catch (e) {
          err = e;
        }
        expect(err, `${id} without ${key}`).toBeInstanceOf(DocumentDataError);
        expect((err as DocumentDataError).missing, `${id} without ${key}`).toContain(key);
        expect((err as DocumentDataError).templateId).toBe(id);
      }
    });
  }

  it('an empty string counts as missing, false and an empty array do not', () => {
    const data = getTemplate<Record<string, unknown>>('notice.s172_response').sample();
    expect(() => renderTemplate('notice.s172_response', { ...data, ourReference: '   ' })).toThrow(DocumentDataError);
    const pack = getTemplate<Record<string, unknown>>('pack.gta_payment').sample();
    expect(() => renderTemplate('pack.gta_payment', { ...pack, present: [] })).not.toThrow();
  });
});

describe('agreements-forms-packs group: the domain consistency engine finds nothing to flag', () => {
  for (const id of GROUP) {
    it(`${id}: no legacy detail, banned phrase, regulated-status wording, GTA-as-law or closed forum`, () => {
      const html = renderTemplate(id, getTemplate(id).sample()).html;
      const text = htmlToText(html);
      const ctx = fakeContext(id);
      const flags = [...legacyCheck(text), ...bannedPhraseCheck(text), ...gtaChecks(text, ctx), ...forumChecks(text, ctx)];
      expect(flags.map((f) => `${f.code}: ${f.excerpt ?? f.message}`)).toEqual([]);
      expect(findProhibitedContent(html)).toEqual([]);
      for (const needle of ['undefined', 'NaN', '[object Object]', 'Invalid Date', 'null']) {
        expect(text, `${id} leaks "${needle}"`).not.toMatch(new RegExp(`(^|[\\s(])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s).,;]|$)`));
      }
      expect(text).toContain(brand.company.statusLine);
      if (/\bGTA\b/.test(text)) expect(text).toContain('industry benchmark');
    });
  }

  it('only the agreement carries the {{SHA256}} placeholder for the API to replace', () => {
    for (const id of GROUP) {
      const html = renderTemplate(id, getTemplate(id).sample()).html;
      expect(html.includes('{{SHA256}}'), id).toBe(id === 'agreement.credit_hire');
    }
  });

  it('never tells the claimant to ignore or refuse an insurer’s offer, and never claims regulated status', () => {
    for (const id of GROUP) {
      const text = htmlToText(renderTemplate(id, getTemplate(id).sample()).html).toLowerCase();
      expect(text, id).not.toMatch(/\bignore\b/);
      expect(text, id).not.toMatch(/\b(?:refuse|decline|reject)\s+(?:any|the|their|an)\s+offer/);
      expect(text, id).not.toMatch(/\bwe\s+act\s+(?:for|as)\b/);
      expect(text, id).not.toMatch(/\bour\s+(?:solicitors?|lawyers?|legal\s+team|client)\b/);
      expect(text, id).not.toMatch(/\bfinancial\s+ombudsman\b|\bfos\b/);
    }
  });
});

describe('agreements-forms-packs group: PDF rendering', () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it(
    'every template renders to an A4 PDF with the reference in the running header and a sensible page count',
    async () => {
      for (const id of GROUP) {
        const rendered = renderTemplate(id, getTemplate(id).sample());
        const reference = readDocumentMeta(rendered.html).reference;
        expect(reference, `${id} embeds its reference for the running header`).toBeTruthy();
        const { pdf, pages, sha256 } = await renderPdf(rendered.html, { reference: reference! });
        expect(pdf.length, id).toBeGreaterThan(10_000);
        expect(sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(pages, `${id} pages`).toBeGreaterThanOrEqual(1);
        expect(pages, `${id} paginates past ${MAX_PAGES[id]} pages`).toBeLessThanOrEqual(MAX_PAGES[id]);
        const doc = await PDFDocument.load(pdf, { updateMetadata: false });
        const { width, height } = doc.getPage(0).getSize();
        expect(Math.round(width), `${id} A4 width`).toBeGreaterThanOrEqual(594);
        expect(Math.round(width), `${id} A4 width`).toBeLessThanOrEqual(596);
        expect(Math.round(height), `${id} A4 height`).toBeGreaterThanOrEqual(841);
        expect(Math.round(height), `${id} A4 height`).toBeLessThanOrEqual(843);
      }
    },
    120_000
  );
});
