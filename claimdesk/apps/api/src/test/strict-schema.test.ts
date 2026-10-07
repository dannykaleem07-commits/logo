/**
 * Strict schemas (docs/SUPREME-DESIGN.md §B.5): every registered tool input and every result schema is strict
 * (additionalProperties:false everywhere, every property required, no unsupported keywords) and < 16 KB compact; the
 * zod twins put the stripped range constraints back.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { compactSchemaBytes, MAX_RESULT_SCHEMA_BYTES, RESULT_SCHEMA_IDS, RESULT_SCHEMAS, strictSchemaProblems } from '@ccguk/domain';
import { allTools } from '../agent/tools/index.js';
import { coreTools } from '../agent/tools/core.js';
import { assertResultSchema, assertStrict, StrictSchemaError, toolInputSchema, toStrictSchema, validateWithTwin, zodFromJsonSchema } from '../ai/strictSchema.js';
import { resultTwin } from '../agent/runAgent.js';

describe('toStrictSchema', () => {
  it('strips the unsupported keywords and keeps property names', () => {
    const s = z.strictObject({ minimum: z.string().min(2).max(9).regex(/^a/), n: z.int().min(1).max(5).nullable(), list: z.array(z.string()).min(1).max(3) });
    const out = toStrictSchema(z.toJSONSchema(s) as Record<string, unknown>);
    const text = JSON.stringify(out);
    for (const k of ['"minLength"', '"maxLength"', '"pattern"', '"maximum"', '"minItems"', '"maxItems"', '"$schema"']) expect(text).not.toContain(k);
    expect(Object.keys((out as { properties: object }).properties)).toEqual(['minimum', 'n', 'list']);
    expect(strictSchemaProblems(out)).toEqual([]);
  });

  it('refuses a non-strict object (optional property / open object)', () => {
    expect(() => toolInputSchema(z.object({ a: z.string().optional() }))).toThrow(StrictSchemaError);
    expect(() => assertStrict({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toThrow(/additionalProperties/);
  });

  it('refuses a result schema of 16 KB or more', () => {
    const props = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`field_number_${i}`, { type: 'string' }]));
    expect(() => assertResultSchema({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false })).toThrow(/bytes compact/);
  });
});

describe('every registered tool', () => {
  it('has a strict input schema under 16 KB that matches its zod/v4 input', () => {
    const tools = allTools();
    expect(tools.length).toBeGreaterThanOrEqual(coreTools.length);
    for (const t of tools) {
      expect(strictSchemaProblems(t.strictSchema), t.name).toEqual([]);
      expect(compactSchemaBytes(t.strictSchema), t.name).toBeLessThan(MAX_RESULT_SCHEMA_BYTES);
      expect(t.strictSchema.type, t.name).toBe('object');
      expect(/^[a-z][a-z0-9_]*$/.test(t.name), t.name).toBe(true);
      expect(t.maxOutputChars, t.name).toBeGreaterThan(0);
    }
  });

  it('names every gateway tool of the catalogue exactly once', () => {
    const names = coreTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['claims_search', 'claim_get', 'claim_next_actions', 'claim_clocks', 'claim_gates', 'claim_acceptance', 'events_list', 'ledger_get', 'offers_list', 'hire_get', 'storage_get', 'recovery_get', 'hire_pricing_guide', 'party_get', 'party_search', 'vehicle_get', 'vehicle_on_file', 'evidence_list', 'evidence_read', 'documents_list', 'document_get', 'templates_list', 'docx_template_values', 'kb_search', 'kb_entry', 'kb_advise', 'directory_search', 'directory_get', 'total_loss_assess', 'document_draft', 'docx_document_draft', 'event_append', 'offer_record', 'directory_report_failed', 'directory_used_ok', 'vehicle_lookup']) {
      expect(names, n).toContain(n);
    }
  });

  it('declares the route of every HTTP tool for the perimeter allow-list', () => {
    for (const t of coreTools) if (t.http) expect(t.httpRoute, t.name).toBeDefined();
  });
});

describe('result schemas', () => {
  it.each(RESULT_SCHEMA_IDS)('%s is strict and under 16 KB', (id) => {
    expect(() => assertResultSchema(RESULT_SCHEMAS[id], id)).not.toThrow();
    expect(compactSchemaBytes(RESULT_SCHEMAS[id])).toBeLessThan(MAX_RESULT_SCHEMA_BYTES);
  });

  it('zod twins accept a valid result and re-add the range constraints', () => {
    const twin = resultTwin('research_answer');
    expect(validateWithTwin(twin, { answer: 'x', citations: [{ kind: 'kb', id: 'gta-4-7', verified: false }], confidence: 0.5 }).ok).toBe(true);
    const bad = validateWithTwin(twin, { answer: 'x', citations: [], confidence: 1.5 });
    expect(bad.ok).toBe(false);
    expect(validateWithTwin(twin, { answer: 'x', citations: [], confidence: 0.5, extra: 1 }).ok).toBe(false);
    const offer = resultTwin('offer_analysis');
    expect(validateWithTwin(offer, { recommendation: 'hold', counterPence: 12.5, reasoning: 'r', basis: [], confidence: 0.5, figures: [] }).ok).toBe(false);
    expect(validateWithTwin(offer, { recommendation: 'hold', counterPence: null, reasoning: 'r', basis: [], confidence: 0.5, figures: [] }).ok).toBe(true);
  });

  it('builds a twin for nullable enums and unions (handoffs)', () => {
    const twin = zodFromJsonSchema(RESULT_SCHEMAS.case_review);
    const ok = validateWithTwin(twin, {
      situation: 's',
      nextBestAction: { code: 'CHASER_7', title: 't', why: 'w', basis: [], confidence: 0.9, dueAt: null },
      actions: [],
      handoffs: [{ to: 'drafter', templateId: null, emailKind: null, purpose: 'p', recipientPartyId: null, replyToMessageId: null, actionCode: null, dueAt: null }, { to: 'researcher', question: 'q' }],
      tasks: [],
      questionsForOwner: [],
      risks: [],
      confidence: 0.8,
    });
    expect(ok.ok).toBe(true);
    expect(validateWithTwin(twin, { situation: 's' }).ok).toBe(false);
  });
});
