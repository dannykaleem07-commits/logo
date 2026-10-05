/**
 * Plain-English lines for an API error's `details` (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.5.3). Pure; unit-tested.
 * Used by ApiErrorNotice and the manager-mode OverridePrompt. Unknown shapes give [] (never "[object Object]").
 *
 * Shapes: `reasons: string[]` (ALLOCATION_REFUSED), `flags: Array<{code,message}>` (HARD_STOP, DOCUMENT_BLOCKED),
 * `missing: string[]` (CHECKLIST_INCOMPLETE, FNOL), `errors|incomplete: Array<{field,message}>` (FNOL),
 * `issues: Array<{code?,message}>` (Word templates, mappings), zod `Array<{path,message}>` (VALIDATION),
 * `overlaps: Array<{agreementNumber,startAt,endAt?,claimReference?}>` (HIRE_OVERLAP), `rules: string[]`.
 */
import { formatDateTime } from './dates';

const MAX_LINES = 30;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** "some_field.name" → "some field name" (a path or field key made readable, kept short). */
function humanKey(key: string): string {
  return key.replace(/[_]+/g, ' ').trim();
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (isObj(x) ? str(x.message) ?? str(x.label) ?? str(x.code) : str(x))).filter((x): x is string => Boolean(x));
}

function codeMessageList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (isObj(x)) {
      const message = str(x.message);
      const code = str(x.code);
      if (message) out.push(message);
      else if (code) out.push(code);
    } else {
      const s = str(x);
      if (s) out.push(s);
    }
  }
  return out;
}

function fieldMessageList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (isObj(x)) {
      const message = str(x.message);
      const field = str(x.field) ?? str(x.key);
      if (message && field) out.push(`${humanKey(field)}: ${message}`);
      else if (message) out.push(message);
      else if (field) out.push(humanKey(field));
    } else {
      const s = str(x);
      if (s) out.push(s);
    }
  }
  return out;
}

function zodPath(path: unknown): string | undefined {
  if (Array.isArray(path)) {
    const parts = path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).filter(Boolean);
    return parts.join('.').replace(/\.\[/g, '[') || undefined;
  }
  return str(path);
}

function zodIssues(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (!isObj(x)) continue;
    const message = str(x.message);
    if (!message) continue;
    const path = zodPath(x.path);
    out.push(path ? `${path}: ${message}` : message);
  }
  return out;
}

function when(iso: unknown): string | undefined {
  const s = str(iso);
  if (!s) return undefined;
  try {
    const text = formatDateTime(s);
    return text && text !== '—' ? text : s;
  } catch {
    return s;
  }
}

function overlapLines(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (!isObj(x)) continue;
    const number = str(x.agreementNumber) ?? str(x.hireId) ?? str(x.id) ?? 'Another hire';
    const start = when(x.startAt);
    const end = when(x.endAt);
    const ref = str(x.claimReference);
    const period = start ? ` from ${start}${end ? ` to ${end}` : ' (still on hire)'}` : '';
    out.push(`${number}${ref ? ` on ${ref}` : ''}${period}`);
  }
  return out;
}

/** Turn every known detail shape into plain lines. */
export function describeErrorDetails(code: string, details: unknown): string[] {
  void code;
  if (details === undefined || details === null) return [];
  // zod / validation issues sent as a bare array
  if (Array.isArray(details)) {
    const zod = zodIssues(details);
    return (zod.length ? zod : codeMessageList(details)).slice(0, MAX_LINES);
  }
  if (!isObj(details)) return [];
  const lines: string[] = [];
  const push = (xs: string[]) => {
    for (const x of xs) if (!lines.includes(x)) lines.push(x);
  };
  push(stringList(details.reasons));
  push(codeMessageList(details.flags));
  const missing = stringList(details.missing);
  if (missing.length) push(missing.map((m) => (/^missing\b/i.test(m) ? m : `Missing: ${m}`)));
  push(fieldMessageList(details.errors));
  push(fieldMessageList(details.incomplete));
  push(codeMessageList(details.issues));
  push(overlapLines(details.overlaps));
  const rules = stringList(details.rules);
  if (rules.length) push(rules.map((r) => `Relaxed: ${r}`));
  return lines.slice(0, MAX_LINES);
}
