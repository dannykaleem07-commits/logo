/**
 * Plain-English lines for an API error's `details` (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.5.3). Pure; unit-tested.
 * Used by ApiErrorNotice and the manager-mode OverridePrompt. Unknown shapes give [] (never "[object Object]").
 *
 * Shapes: `reasons: string[]` (ALLOCATION_REFUSED), `flags: Array<{code,message}>` (HARD_STOP, DOCUMENT_BLOCKED),
 * `missing: string[]` (CHECKLIST_INCOMPLETE, FNOL), `errors|incomplete: Array<{field,message}>` (FNOL),
 * `issues: Array<{code?,message}>` (Word templates, mappings), zod `Array<{path,message}>` (VALIDATION),
 * `overlaps: Array<{agreementNumber,startAt,endAt?,claimReference?}>` (HIRE_OVERLAP), `rules: string[]`.
 * Upload codes (SUPREME-DESIGN §0.3 point 6): FILE_TOO_LARGE `{limitBytes, useChunked?, useImportFolder?}`,
 * OFFSET_MISMATCH `{receivedBytes}`, INSUFFICIENT_STORAGE `{needBytes, freeBytes}`, UPLOAD_ABORTED, UPLOAD_INCOMPLETE.
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

/** "31 MB", "1.6 GB" (binary units, as Windows shows them). */
function sizeWords(bytes: unknown): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, '') : Math.round(gb)} GB`;
}

/** Plain-English lines for the upload refusals (the code alone says nothing to the owner). */
export function uploadErrorLines(code: string, details: unknown): string[] {
  const d = isObj(details) ? details : {};
  switch (code) {
    case 'FILE_TOO_LARGE': {
      const limit = sizeWords(d.limitBytes);
      const lines = [limit ? `The file is too large: ${d.chunk === true ? `one part can be at most ${limit}` : `the most one upload can take is ${limit}`}.` : 'The file is too large for one upload.'];
      if (d.useImportFolder === true) lines.push('Put the file in the ClaimDesk import folder instead (Settings → Import folder) — any size works there.');
      else if (d.useChunked === true) lines.push('Try again from the Evidence tab: ClaimDesk sends big files in parts. For very large files, use the import folder (Settings → Import folder).');
      return lines;
    }
    case 'OFFSET_MISMATCH': {
      const got = sizeWords(d.receivedBytes);
      return [`The upload got out of step with ClaimDesk${got ? ` (it has ${got} so far)` : ''}. Try again — it carries on from where it stopped.`];
    }
    case 'INSUFFICIENT_STORAGE': {
      const need = sizeWords(d.needBytes);
      const free = sizeWords(d.freeBytes);
      return [`This computer does not have enough free disk space for the file${need && free ? ` (${need} needed, ${free} free)` : ''}. Free some space and try again.`];
    }
    case 'UPLOAD_ABORTED':
      return ['The connection dropped before the whole file arrived. Nothing was stored — try again.'];
    case 'UPLOAD_INCOMPLETE':
      return ['Not all of the file has arrived yet. Try again — it carries on from where it stopped.'];
    default:
      return [];
  }
}

/** Turn every known detail shape into plain lines. */
export function describeErrorDetails(code: string, details: unknown): string[] {
  const upload = uploadErrorLines(code, details);
  if (upload.length) return upload;
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
