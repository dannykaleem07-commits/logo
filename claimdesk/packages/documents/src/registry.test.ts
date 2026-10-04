import { afterAll, describe, expect, it } from 'vitest';
import { findProhibitedContent } from './guards.js';
import {
  DocumentDataError,
  TemplateNotFoundError,
  getPath,
  getTemplate,
  hasTemplate,
  listTemplates,
  missingRequiredData,
  registerTemplate,
  renderSample,
  renderTemplate,
  unregisterTemplate
} from './registry.js';
import { exampleLetterTemplate, registerExampleTemplate } from './templates/_example.js';
import './templates/index.js';

// Registered at import time so the per-template describe block below (built at collection) sees it.
registerExampleTemplate();

afterAll(() => {
  unregisterTemplate(exampleLetterTemplate.id);
});

describe('registry', () => {
  it('registers, lists and fetches', () => {
    expect(hasTemplate('letter.example')).toBe(true);
    expect(getTemplate('letter.example')).toBe(exampleLetterTemplate);
    const meta = listTemplates().find((t) => t.id === 'letter.example');
    expect(meta).toMatchObject({ id: 'letter.example', version: '1.0.0', kind: 'letter', recipientRole: 'at_fault_insurer' });
    expect(meta?.requiredData).toContain('claim.ourReference');
    expect(() => getTemplate('letter.does_not_exist')).toThrow(TemplateNotFoundError);
  });

  it('is idempotent for the same template and refuses a conflicting one', () => {
    expect(registerExampleTemplate()).toBe(exampleLetterTemplate);
    expect(() => registerTemplate({ ...exampleLetterTemplate, version: '2.0.0' })).toThrow(/already registered/);
    expect(() => registerTemplate({ ...exampleLetterTemplate, id: 'Bad Id' })).toThrow(/must look like/);
    expect(() => registerTemplate({ ...exampleLetterTemplate, id: 'invoice.example' })).toThrow(/kind/);
    expect(() => registerTemplate({ ...exampleLetterTemplate, id: 'letter.other', version: '1' })).toThrow(/semver/);
  });

  it('validates requiredData with dot paths and reports every missing key', () => {
    const data = exampleLetterTemplate.sample();
    expect(missingRequiredData(exampleLetterTemplate, data)).toEqual([]);
    const broken = { ...data, claim: { ...data.claim, ourReference: '' }, responseDeadline: undefined as unknown as string, hire: undefined as never };
    let err: unknown;
    try {
      renderTemplate('letter.example', broken);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentDataError);
    const dde = err as DocumentDataError;
    expect(dde.templateId).toBe('letter.example');
    expect(dde.missing).toEqual([
      'claim.ourReference',
      'hire.startAt',
      'hire.endAt',
      'hire.days',
      'hire.dailyRatePence',
      'hire.totalPence',
      'responseDeadline'
    ]);
    expect(getPath({ a: { b: [1, 2] } }, 'a.b.1')).toBe(2);
    expect(getPath(null, 'a')).toBeUndefined();
  });

  it('renders with version, title and html hash', () => {
    const out = renderTemplate('letter.example', exampleLetterTemplate.sample());
    expect(out.templateVersion).toBe('1.0.0');
    expect(out.title).toBe('Example letter (pattern)');
    expect(out.kind).toBe('letter');
    expect(out.htmlSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.html).toContain('10 August 2026 to 2 September 2026 (24 days)');
    expect(out.html).toContain('£1,195.20');
    expect(out.html).toContain('5pm on Sunday 18 October 2026');
    expect(renderSample('letter.example').html).toBe(out.html); // pure: same data, same html
  });
});

describe('every registered template renders its sample cleanly', () => {
  const metas = listTemplates();
  it('has at least the example registered', () => {
    expect(metas.length).toBeGreaterThan(0);
  });
  for (const meta of metas) {
    it(`${meta.id} v${meta.version}: sample satisfies requiredData, renders, and contains no legacy or banned content`, () => {
      const template = getTemplate(meta.id);
      const data = template.sample();
      expect(missingRequiredData(template, data)).toEqual([]);
      const { html } = renderTemplate(meta.id, data);
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('class="logo-lockup"');
      expect(html).toContain('name="ccguk:reference"'); // rendered through baseLayout
      expect(html).not.toContain('Invalid Date');
      expect(html).not.toContain('NaN');
      expect(html).not.toContain('undefined');
      expect(findProhibitedContent(html)).toEqual([]);
    });
  }
});
