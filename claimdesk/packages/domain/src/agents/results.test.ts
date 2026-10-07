import { describe, expect, it } from 'vitest';
import { compactSchemaBytes, MAX_RESULT_SCHEMA_BYTES, RESULT_SCHEMA_IDS, RESULT_SCHEMAS, strictSchemaProblems, type CaseReviewResult, type JsonSchema, type MailTriageResult } from './results.js';
import { AI_JOB_DEFAULTS, aiJobModel, DEFAULT_AI_SETTINGS, mergeDefaults } from './settings.js';
import { FIELD_TARGETS, isFieldTarget, isJobType, JOB_TYPE_INFO, JOB_TYPES, SENSITIVE_FIELD_TARGETS } from './types.js';

/** Minimal structural validator for the strict subset we use (type, enum, properties, required, items, anyOf). */
function validate(schema: JsonSchema, value: unknown, path = '$'): string[] {
  if (schema.anyOf) {
    const branches = schema.anyOf as JsonSchema[];
    return branches.some((b) => validate(b, value, path).length === 0) ? [] : [`${path}: no anyOf branch matched`];
  }
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const t = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const ok = types.includes(t) || (t === 'integer' && types.includes('number'));
  if (!ok) return [`${path}: expected ${types.join('|')}, got ${t}`];
  if (schema.enum && value !== null && !(schema.enum as unknown[]).includes(value)) return [`${path}: ${String(value)} not in enum`];
  const out: string[] = [];
  if (t === 'object') {
    const props = schema.properties as Record<string, JsonSchema>;
    for (const k of schema.required as string[]) if (!(k in (value as object))) out.push(`${path}.${k}: missing`);
    for (const k of Object.keys(value as object)) {
      if (!props[k]) out.push(`${path}.${k}: not allowed`);
      else out.push(...validate(props[k], (value as Record<string, unknown>)[k], `${path}.${k}`));
    }
  }
  if (t === 'array') (value as unknown[]).forEach((v, i) => out.push(...validate(schema.items as JsonSchema, v, `${path}[${i}]`)));
  return out;
}

describe('result schemas (§B.5)', () => {
  it('has one schema per result schema id', () => {
    expect(Object.keys(RESULT_SCHEMAS).sort()).toEqual([...RESULT_SCHEMA_IDS].sort());
  });
  it.each(RESULT_SCHEMA_IDS)('%s is strict and under 16 KB compact', (id) => {
    const schema = RESULT_SCHEMAS[id];
    expect(strictSchemaProblems(schema)).toEqual([]);
    expect(compactSchemaBytes(schema)).toBeLessThan(MAX_RESULT_SCHEMA_BYTES);
    expect(schema.type).toBe('object');
  });
  it('strictSchemaProblems catches missing additionalProperties, unrequired properties and forbidden keywords', () => {
    expect(strictSchemaProblems({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toEqual(['$: object without additionalProperties:false']);
    expect(strictSchemaProblems({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'], additionalProperties: false })).toEqual(['$.b: not in required']);
    expect(strictSchemaProblems({ type: 'object', properties: { a: { type: 'string', maxLength: 3 } }, required: ['a'], additionalProperties: false })).toEqual(['$.a: unsupported keyword "maxLength"']);
    expect(strictSchemaProblems({ type: 'array', items: { type: 'object', properties: {}, required: [] }, minItems: 1 })).toHaveLength(2);
    expect(strictSchemaProblems({ anyOf: [{ type: 'object', properties: { x: { type: 'integer', minimum: 0 } }, required: ['x'], additionalProperties: false }, { type: 'null' }] })).toEqual(['$.anyOf[0].x: unsupported keyword "minimum"']);
  });
  it('accepts a well-formed triage result and refuses extra or missing fields', () => {
    const r: MailTriageResult = {
      intent: 'acknowledgement',
      secondaryIntents: [],
      confidence: 0.93,
      summary: 'Insurer acknowledges the claim and gives a handling reference.',
      urgency: 'normal',
      extracted: { amountsPence: [], deadlines: [], theirRef: 'ABC/123', ourRef: 'CCG-2026-00001', vrm: null, docsRequested: [], paymentRef: null, offerTerms: null, bankDetailsChange: false },
      needsReply: true,
      injectionSuspected: false,
      injectionNotes: null,
    };
    expect(validate(RESULT_SCHEMAS.mail_triage, r)).toEqual([]);
    expect(validate(RESULT_SCHEMAS.mail_triage, { ...r, extra: 1 })).toEqual(['$.extra: not allowed']);
    const { injectionNotes: _n, ...missing } = r;
    expect(validate(RESULT_SCHEMAS.mail_triage, missing)).toEqual(['$.injectionNotes: missing']);
    expect(validate(RESULT_SCHEMAS.mail_triage, { ...r, intent: 'bogus' })).toEqual(['$.intent: bogus not in enum']);
  });
  it('accepts a case review with every hand-off variant', () => {
    const r: CaseReviewResult = {
      situation: 'Handling reference received; NCAF sent.',
      nextBestAction: { code: 'CHASE_HANDLING_REF', title: 'Acknowledge', why: 'Reference received', basis: [{ kind: 'message', id: 'm1', label: null }], confidence: 0.9, dueAt: null },
      actions: [],
      handoffs: [
        { to: 'mail_reply', messageId: 'm1', plan: 'Acknowledge', keyPoints: ['thanks'] },
        { to: 'drafter', templateId: 'letter.chaser_7', emailKind: null, purpose: 'chase', recipientPartyId: null, replyToMessageId: null, actionCode: null, dueAt: '2026-10-08T09:00:00.000Z' },
        { to: 'researcher', question: 'What does GTA say about 4.10?' },
        { to: 'offer_analyst', offerId: 'o1' },
      ],
      tasks: [{ kind: 'follow_up', dueAt: '2026-10-10T09:00:00.000Z', note: 'Check payment', actionCode: null }],
      questionsForOwner: [{ title: 'V5C', detail: 'Insurer asks for the V5C', missing: ['V5C'], prepareDraft: true }],
      risks: [{ severity: 'low', text: 'none' }],
      confidence: 0.9,
    };
    expect(validate(RESULT_SCHEMAS.case_review, r)).toEqual([]);
    expect(validate(RESULT_SCHEMAS.case_review, { ...r, handoffs: [{ to: 'drafter', purpose: 'x' }] })).toEqual(['$.handoffs[0]: no anyOf branch matched']);
  });
});

describe('agent vocabulary', () => {
  it('JOB_TYPE_INFO covers every Phase 1 job type, including document.after_review, index.fts and brain.import', () => {
    expect(Object.keys(JOB_TYPE_INFO).sort()).toEqual([...JOB_TYPES].sort());
    for (const t of ['document.after_review', 'index.fts', 'brain.import'] as const) expect(isJobType(t)).toBe(true);
    expect(isJobType('engineer.photo_scan')).toBe(false);
    expect(JOB_TYPE_INFO['offer.analyse']).toMatchObject({ lane: 'ai', defaultPriority: 0 });
    expect(JOB_TYPE_INFO['outbox.release']).toMatchObject({ lane: 'io', defaultPriority: 0 });
  });
  it('field targets are the closed §G.4 set', () => {
    expect(FIELD_TARGETS).toHaveLength(4 + 4 * 6 + 4 * 6);
    expect(isFieldTarget('vehicle:client.vin')).toBe(true);
    expect(isFieldTarget('party:driver.drivingLicenceNumber')).toBe(true);
    expect(isFieldTarget('claim.status')).toBe(false);
    expect(SENSITIVE_FIELD_TARGETS.has('party:claimant.dateOfBirth')).toBe(true);
    expect(SENSITIVE_FIELD_TARGETS.has('vehicle:client.vin')).toBe(false);
  });
  it('AI job defaults follow §A.6 and the quality switches', () => {
    expect(AI_JOB_DEFAULTS['mail.triage']).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 1 });
    expect(aiJobModel(DEFAULT_AI_SETTINGS, 'case.review')).toEqual({ model: 'claude-opus-5-5', effort: 'medium', maxTurns: 16, timeoutMs: 600_000 });
    expect(aiJobModel({ quality: 'economy', perJob: {} }, 'case.review')?.model).toBe('claude-sonnet-5-5');
    expect(aiJobModel({ quality: 'best', perJob: {} }, 'mail.triage')?.model).toBe('claude-opus-5-5');
    expect(aiJobModel({ quality: 'standard', perJob: { 'mail.triage': { effort: 'medium' } } }, 'mail.triage')?.effort).toBe('medium');
    expect(aiJobModel(DEFAULT_AI_SETTINGS, 'mail.sync')).toBeUndefined();
  });
  it('mergeDefaults merges objects, replaces arrays and keeps explicit nulls', () => {
    const def = { a: 1, o: { x: 1, y: 2 }, list: [1, 2], q: { s: '20:00' } as { s: string } | null };
    expect(mergeDefaults(def, { o: { y: 3 }, list: [9], q: null })).toEqual({ a: 1, o: { x: 1, y: 3 }, list: [9], q: null });
    expect(mergeDefaults(def, undefined)).toEqual(def);
    expect(mergeDefaults(def, 'junk')).toEqual(def);
  });
});
