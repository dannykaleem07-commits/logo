// owned by knowledge-core
/**
 * Learned rules are restrictive by construction (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.3, KR-5, KR-6).
 *
 * A rule's `when` is a closed JSONLogic subset over RULE_FACT_IDS; its `then` is a list of effects from a closed
 * vocabulary that can only add restrictions (require a document, ask the owner, add a reviewer check, avoid a phrase)
 * or give advice (prefer a step, suggest a follow-up). There is no effect that sends, approves, skips a review, changes
 * a threshold, touches money or decides an offer. `evalRule` is pure and total and never uses eval().
 * `activeLearnedRules(ctx)` lives in the API store (apps/api/src/knowledge/store.ts) — the Phase 3 entry point.
 */
import type { JsonLogic, RuleData, RuleEffect } from './types.js';

/** Facts a learned rule may test — computable both live (from the Case Brief) and in replay (from history, §12.1). */
export const RULE_FACT_IDS = ['insurer.slug', 'claim.types', 'claim.liability', 'claim.gtaSubscriber', 'claim.track', 'stage.current', 'days.sincePackSent', 'days.sinceLastInbound', 'count.chasersSent', 'last.inboundIntent', 'docs.onFile', 'docs.requestedOpen', 'heads.open', 'money.outstandingPence'] as const;
export type RuleFactId = (typeof RULE_FACT_IDS)[number];

export const RULE_OPS = ['==', '!=', '<', '<=', '>', '>=', 'and', 'or', '!', 'in', 'var', 'missing'] as const;
type RuleOp = (typeof RULE_OPS)[number];

export const RESTRICTIVE_EFFECTS: ReadonlySet<RuleEffect['kind']> = new Set<RuleEffect['kind']>(['require_document', 'ask_owner', 'add_check', 'avoid_phrase']);
export const ADVISORY_EFFECTS: ReadonlySet<RuleEffect['kind']> = new Set<RuleEffect['kind']>(['prefer_step', 'suggest_followup']);

export const MAX_RULE_DEPTH = 6;
export const MAX_RULE_NODES = 20;
export const MAX_RULE_EFFECTS = 10;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFactId = (v: unknown): v is RuleFactId => typeof v === 'string' && (RULE_FACT_IDS as readonly string[]).includes(v);
const isScalar = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const nonEmpty = (v: unknown, max = 500): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Problems with a `when` expression: closed ops, closed fact ids, depth ≤ 6, ≤ 20 nodes. */
export function validateLogic(when: unknown): string[] {
  const problems: string[] = [];
  let nodes = 0;
  const walk = (node: unknown, depth: number, path: string): void => {
    nodes += 1;
    if (depth > MAX_RULE_DEPTH) {
      problems.push(`${path}: deeper than ${MAX_RULE_DEPTH}`);
      return;
    }
    if (isScalar(node)) return;
    if (Array.isArray(node)) {
      // A literal list (only valid as the right side of `in`); every member must be a scalar.
      if (!node.every(isScalar)) problems.push(`${path}: lists may hold only plain values`);
      return;
    }
    if (!isPlainObject(node)) {
      problems.push(`${path}: not a JSONLogic node`);
      return;
    }
    const keys = Object.keys(node);
    if (keys.length !== 1) {
      problems.push(`${path}: a node must have exactly one operator`);
      return;
    }
    const op = keys[0] as string;
    if (!(RULE_OPS as readonly string[]).includes(op)) {
      problems.push(`${path}: operator "${op}" is not allowed`);
      return;
    }
    const arg = node[op];
    switch (op as RuleOp) {
      case 'var': {
        const name = Array.isArray(arg) ? arg[0] : arg;
        if (!isFactId(name)) problems.push(`${path}: fact "${String(name)}" is not one of RULE_FACT_IDS`);
        return;
      }
      case 'missing': {
        const names = Array.isArray(arg) ? arg : [arg];
        for (const n of names) if (!isFactId(n)) problems.push(`${path}: fact "${String(n)}" is not one of RULE_FACT_IDS`);
        return;
      }
      case '!': {
        const inner = Array.isArray(arg) ? arg : [arg];
        if (inner.length !== 1) problems.push(`${path}: "!" takes one argument`);
        inner.forEach((a, i) => walk(a, depth + 1, `${path}.!${i}`));
        return;
      }
      case 'and':
      case 'or': {
        if (!Array.isArray(arg) || arg.length < 1) {
          problems.push(`${path}: "${op}" takes a list`);
          return;
        }
        arg.forEach((a, i) => walk(a, depth + 1, `${path}.${op}${i}`));
        return;
      }
      case 'in': {
        if (!Array.isArray(arg) || arg.length !== 2) {
          problems.push(`${path}: "in" takes two arguments`);
          return;
        }
        walk(arg[0], depth + 1, `${path}.in0`);
        walk(arg[1], depth + 1, `${path}.in1`);
        return;
      }
      default: {
        // comparisons
        if (!Array.isArray(arg) || arg.length !== 2) {
          problems.push(`${path}: "${op}" takes two arguments`);
          return;
        }
        arg.forEach((a, i) => {
          if (Array.isArray(a)) problems.push(`${path}.${op}${i}: a comparison cannot take a list`);
          else walk(a, depth + 1, `${path}.${op}${i}`);
        });
      }
    }
  };
  walk(when, 1, 'when');
  if (nodes > MAX_RULE_NODES) problems.push(`when: ${nodes} nodes (at most ${MAX_RULE_NODES})`);
  return problems;
}

/** Problems with one effect: closed vocabulary, required fields. */
export function validateEffect(e: unknown, i: number): string[] {
  const at = `then[${i}]`;
  if (!isPlainObject(e)) return [`${at}: not an effect`];
  const kind = e.kind;
  switch (kind) {
    case 'require_document':
      return [...(nonEmpty(e.doc, 200) ? [] : [`${at}: doc is required`]), ...(nonEmpty(e.beforeStep, 64) ? [] : [`${at}: beforeStep is required`])];
    case 'ask_owner':
      return nonEmpty(e.reason) ? [] : [`${at}: reason is required`];
    case 'add_check':
      return [
        ...(typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(e.code) ? [] : [`${at}: code must be UPPER_SNAKE`]),
        ...(nonEmpty(e.message) ? [] : [`${at}: message is required`]),
        ...(e.severity === 'warn' || e.severity === 'block' ? [] : [`${at}: severity must be warn or block`]),
      ];
    case 'avoid_phrase':
      return nonEmpty(e.phrase, 200) ? [] : [`${at}: phrase is required`];
    case 'prefer_step':
      return [...(nonEmpty(e.actionCode, 64) ? [] : [`${at}: actionCode is required`]), ...(typeof e.note === 'string' ? [] : [`${at}: note is required`])];
    case 'suggest_followup':
      return [
        ...(typeof e.afterWorkingDays === 'number' && Number.isInteger(e.afterWorkingDays) && e.afterWorkingDays >= 1 && e.afterWorkingDays <= 60 ? [] : [`${at}: afterWorkingDays must be 1..60`]),
        ...(typeof e.note === 'string' ? [] : [`${at}: note is required`]),
      ];
    default:
      return [`${at}: effect "${String(kind)}" is not allowed (learned rules may only add restrictions or give advice)`];
  }
}

/** closed ops, closed fact ids, closed effects, depth ≤ 6, ≤ 20 nodes. Empty = valid. */
export function validateRule(data: unknown): string[] {
  if (!isPlainObject(data)) return ['rule data must be an object'];
  const d = data as Partial<RuleData> & Record<string, unknown>;
  const problems: string[] = [];
  problems.push(...validateLogic(d.when));
  if (!Array.isArray(d.then) || d.then.length === 0) problems.push('then: at least one effect is required');
  else if (d.then.length > MAX_RULE_EFFECTS) problems.push(`then: at most ${MAX_RULE_EFFECTS} effects`);
  else d.then.forEach((e, i) => problems.push(...validateEffect(e, i)));
  if (typeof d.why !== 'string' || !d.why.trim()) problems.push('why is required');
  if (d.severity !== 'info' && d.severity !== 'warn' && d.severity !== 'block') problems.push('severity must be info, warn or block');
  return problems;
}

/** True when every effect of a valid rule is restrictive or advisory (KN-03 uses this). */
export function effectsAllowed(effects: readonly { kind: string }[]): boolean {
  return effects.every((e) => RESTRICTIVE_EFFECTS.has(e.kind as RuleEffect['kind']) || ADVISORY_EFFECTS.has(e.kind as RuleEffect['kind']));
}

// ---------------------------------------------------------------------------
// Evaluation (pure, total)
// ---------------------------------------------------------------------------

const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : Boolean(v));

const compare = (op: string, a: unknown, b: unknown): boolean => {
  if (op === '==') return a === b || (a !== null && b !== null && a !== undefined && b !== undefined && typeof a !== typeof b && String(a) === String(b));
  if (op === '!=') return !compare('==', a, b);
  if (typeof a === 'number' && typeof b === 'number') {
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
  }
  return false; // mismatched or missing values never satisfy an ordering
};

function value(node: unknown, facts: Readonly<Record<string, unknown>>, depth: number): unknown {
  if (depth > MAX_RULE_DEPTH + 1) return undefined;
  if (isScalar(node)) return node;
  if (Array.isArray(node)) return node;
  if (!isPlainObject(node)) return undefined;
  const keys = Object.keys(node);
  if (keys.length !== 1) return undefined;
  const op = keys[0] as string;
  const arg = node[op];
  switch (op) {
    case 'var': {
      const name = Array.isArray(arg) ? arg[0] : arg;
      if (!isFactId(name)) return undefined;
      const v = facts[name];
      return v === undefined && Array.isArray(arg) && arg.length > 1 ? arg[1] : v;
    }
    case 'missing': {
      const names = Array.isArray(arg) ? arg : [arg];
      return names.filter((n) => isFactId(n) && (facts[n] === undefined || facts[n] === null || facts[n] === ''));
    }
    case '!':
      return !truthy(value(Array.isArray(arg) ? arg[0] : arg, facts, depth + 1));
    case 'and':
      return Array.isArray(arg) && arg.length > 0 && arg.every((a) => truthy(value(a, facts, depth + 1)));
    case 'or':
      return Array.isArray(arg) && arg.some((a) => truthy(value(a, facts, depth + 1)));
    case 'in': {
      if (!Array.isArray(arg) || arg.length !== 2) return false;
      const needle = value(arg[0], facts, depth + 1);
      const hay = value(arg[1], facts, depth + 1);
      if (Array.isArray(hay)) return hay.some((h) => compare('==', h, needle));
      if (typeof hay === 'string' && typeof needle === 'string') return hay.includes(needle);
      return false;
    }
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (!Array.isArray(arg) || arg.length !== 2) return false;
      return compare(op, value(arg[0], facts, depth + 1), value(arg[1], facts, depth + 1));
    }
    default:
      return undefined;
  }
}

/** Evaluate a rule's `when` against facts. Pure and total: an invalid expression is false, never an exception. */
export function evalRule(when: JsonLogic, facts: Readonly<Record<string, unknown>>): boolean {
  if (validateLogic(when).length) return false;
  try {
    return truthy(value(when, facts, 1));
  } catch {
    return false;
  }
}
