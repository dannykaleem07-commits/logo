/**
 * Strict JSON Schemas (docs/SUPREME-DESIGN.md §B.5) — owned by `gateway`.
 *
 *  - `toStrictSchema(z.toJSONSchema(schema))` strips the keywords strict tools / structured outputs do not support
 *    (`minimum`, `maximum`, `exclusive*`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`,
 *    `$schema`, plus `propertyNames` and `default`, which zod emits for records and defaults) and then asserts the result
 *    is strict: every object `additionalProperties: false` and every property in `required`.
 *  - `toolInputSchema(zodV4)` = the two steps above for a tool input written with `zod/v4`.
 *  - `zodFromJsonSchema(json)` builds the server-side "zod twin" of a hand-written strict result schema
 *    (`RESULT_SCHEMAS` in @ccguk/domain). The twin re-adds the range constraints the strict schema cannot carry:
 *    every `confidence`-like number is 0..1 and every `*Pence` value is a non-negative-or-negative safe integer.
 *
 * The model's output is untrusted: the twin (results) and the tool's own zod input (tools) are the real validation.
 */
import { z } from 'zod/v4';
import { compactSchemaBytes, MAX_RESULT_SCHEMA_BYTES, strictSchemaProblems, type JsonSchema } from '@ccguk/domain';

/** Keywords removed by `toStrictSchema` (the design's list plus zod's record/default output). */
export const STRIPPED_KEYWORDS: readonly string[] = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  '$schema',
  'propertyNames',
  'default',
];

export class StrictSchemaError extends Error {
  readonly code = 'STRICT_SCHEMA';
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
  }
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (STRIPPED_KEYWORDS.includes(k)) continue;
    // `properties` / `$defs` hold user-named keys: strip inside the values, never the keys themselves.
    if ((k === 'properties' || k === '$defs' || k === 'definitions') && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, strip(pv)]));
      continue;
    }
    out[k] = strip(v);
  }
  return out;
}

/** Remove the unsupported keywords and assert the schema is strict (throws StrictSchemaError otherwise). */
export function toStrictSchema(jsonSchema: JsonSchema): JsonSchema {
  const out = strip(jsonSchema) as JsonSchema;
  assertStrict(out);
  return out;
}

/** Throw unless `schema` is strict (§B.5). `label` names the schema in the error. */
export function assertStrict(schema: JsonSchema, label = 'schema'): void {
  const problems = strictSchemaProblems(schema);
  if (problems.length) throw new StrictSchemaError(`${label} is not a strict schema: ${problems.slice(0, 5).join('; ')}`, problems);
}

/** Assert a result schema is strict and small enough for the CLI command line (< 16 KB compact). */
export function assertResultSchema(schema: JsonSchema, label = 'result schema'): void {
  assertStrict(schema, label);
  const bytes = compactSchemaBytes(schema);
  if (bytes >= MAX_RESULT_SCHEMA_BYTES) throw new StrictSchemaError(`${label} is ${bytes} bytes compact (limit ${MAX_RESULT_SCHEMA_BYTES})`, [`size ${bytes}`]);
}

/** The strict JSON Schema of a `zod/v4` tool input. */
export function toolInputSchema(schema: z.ZodType): JsonSchema {
  return toStrictSchema(z.toJSONSchema(schema) as JsonSchema);
}

// ---------------------------------------------------------------------------
// Zod twins of hand-written strict JSON Schemas
// ---------------------------------------------------------------------------

const isConfidenceKey = (key: string | undefined): boolean => key !== undefined && /(^confidence$|Confidence$)/.test(key);
const isPenceKey = (key: string | undefined): boolean => key !== undefined && /Pence$/.test(key);

function typesOf(s: Record<string, unknown>): string[] {
  if (Array.isArray(s.type)) return s.type as string[];
  if (typeof s.type === 'string') return [s.type];
  return [];
}

function single(type: string, s: Record<string, unknown>, key: string | undefined): z.ZodType {
  switch (type) {
    case 'string':
      return Array.isArray(s.enum) && s.enum.length ? z.enum(s.enum as [string, ...string[]]) : z.string();
    case 'number':
      return isConfidenceKey(key) ? z.number().min(0).max(1) : isPenceKey(key) ? z.number().int() : z.number();
    case 'integer':
      return z.number().int().refine(Number.isSafeInteger, { message: 'not a safe integer' });
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = s.items as JsonSchema | undefined;
      return z.array(items ? zodFromJsonSchema(items, key) : z.unknown());
    }
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const shape: Record<string, z.ZodType> = {};
      for (const [k, v] of Object.entries(props)) shape[k] = zodFromJsonSchema(v, k);
      return s.additionalProperties === false ? z.strictObject(shape) : z.object(shape);
    }
    default:
      return z.unknown();
  }
}

/**
 * A zod (v4) validator equivalent to a strict JSON Schema (`type`, `enum`, `anyOf`/`oneOf`, `items`, `properties`),
 * with the range constraints the strict schema cannot express added back (confidence 0..1, pence integers).
 */
export function zodFromJsonSchema(schema: JsonSchema, key?: string): z.ZodType {
  const s = schema as Record<string, unknown>;
  const alternatives = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(alternatives) && alternatives.length) {
    const members = alternatives.map((a) => zodFromJsonSchema(a, key));
    return members.length === 1 ? members[0]! : z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  const types = typesOf(s);
  if (!types.length) {
    if (s.properties) return single('object', s, key);
    if (Array.isArray(s.enum)) return z.enum(s.enum as [string, ...string[]]);
    return z.unknown();
  }
  const members = types.map((t) => single(t, s, key));
  return members.length === 1 ? members[0]! : z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

/** Validate `value` against a zod twin; issues as `path: message` strings. */
export function validateWithTwin(twin: z.ZodType, value: unknown): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const r = twin.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 20).map((i) => `${i.path.length ? i.path.join('.') : '$'}: ${i.message}`) };
}
