/**
 * Template registry.
 *
 * A template is a pure function of a typed data object → HTML string. It declares the data keys it needs
 * (`requiredData`, dot paths allowed) and ships a `sample()` fixture so it can be rendered and checked without a
 * database. Templates self-register when their module is imported; `src/templates/index.ts` imports every file.
 *
 * The API renders with `renderTemplate(id, data)`, which validates `requiredData` first and throws
 * `DocumentDataError` listing the missing keys. The returned `templateVersion` is stored on the
 * GeneratedDocument (immutable semver, BLUEPRINT §3.8).
 */
import type { RecipientRole, TemplateKind } from './common.js';
import { htmlSha256 } from './hash.js';

export type { RecipientRole, TemplateKind };

export interface Template<TData> {
  /** Stable id: `<kind>.<name>`, e.g. 'letter.ncaf', 'invoice.hire' (ARCHITECTURE.md lists the set). */
  id: string;
  /** Semver; bump when the wording or structure changes. Stored on every generated document. */
  version: string;
  kind: TemplateKind;
  /** Static document title (also the default H1 / <title>). */
  title: string;
  recipientRole?: RecipientRole;
  /** One line for the template picker. */
  description?: string;
  /** Data keys that must be present (not undefined, null or ''). Dot paths allowed: 'claim.ourReference'. */
  requiredData: string[];
  /** Fixture that renders cleanly; used by tests, `pnpm samples` and the template picker preview. */
  sample: () => TData;
  /** Pure render. Must not read the clock or retype figures: everything comes from `data`. */
  render: (data: TData) => string;
  /** Optional dynamic title, e.g. "Invoice INV-0042". Falls back to `title`. */
  titleFor?: (data: TData) => string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTemplate = Template<any>;

export interface TemplateMeta {
  id: string;
  version: string;
  kind: TemplateKind;
  title: string;
  recipientRole?: RecipientRole;
  description?: string;
  requiredData: string[];
}

export interface RenderedTemplate {
  templateId: string;
  templateVersion: string;
  kind: TemplateKind;
  title: string;
  html: string;
  /** SHA-256 of the HTML (the PDF hash replaces it once rendered). */
  htmlSha256: string;
}

export class DocumentDataError extends Error {
  readonly templateId: string;
  readonly missing: string[];
  constructor(templateId: string, missing: string[]) {
    super(`Template ${templateId} is missing required data: ${missing.join(', ')}`);
    this.name = 'DocumentDataError';
    this.templateId = templateId;
    this.missing = missing;
  }
}

export class TemplateNotFoundError extends Error {
  readonly templateId: string;
  constructor(templateId: string) {
    super(`No template registered with id "${templateId}"`);
    this.name = 'TemplateNotFoundError';
    this.templateId = templateId;
  }
}

const registry = new Map<string, AnyTemplate>();

const ID_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Register a template. Re-registering the identical template object is a no-op (module re-evaluation under test
 * runners); a different template under an existing id throws, so two agents cannot silently collide.
 */
export function registerTemplate<TData>(template: Template<TData>): Template<TData> {
  if (!ID_RE.test(template.id)) {
    throw new Error(`Template id "${template.id}" must look like "<kind>.<name>" in lower snake case`);
  }
  if (!SEMVER_RE.test(template.version)) {
    throw new Error(`Template ${template.id} version "${template.version}" must be semver (e.g. 1.0.0)`);
  }
  if (!template.id.startsWith(`${template.kind}.`)) {
    throw new Error(`Template ${template.id} has kind "${template.kind}" but its id does not start with "${template.kind}."`);
  }
  const existing = registry.get(template.id);
  if (existing && existing !== template) {
    if (existing.version === template.version && existing.title === template.title) {
      registry.set(template.id, template); // same template re-evaluated (hot reload); take the newest closure
      return template;
    }
    throw new Error(`Template id "${template.id}" is already registered (v${existing.version}); refusing to overwrite with v${template.version}`);
  }
  registry.set(template.id, template);
  return template;
}

/** Test helper: remove a template. Not for production use. */
export function unregisterTemplate(id: string): boolean {
  return registry.delete(id);
}

export function hasTemplate(id: string): boolean {
  return registry.has(id);
}

export function getTemplate<TData = unknown>(id: string): Template<TData> {
  const t = registry.get(id);
  if (!t) throw new TemplateNotFoundError(id);
  return t as Template<TData>;
}

/** Metadata for every registered template, sorted by id. */
export function listTemplates(): TemplateMeta[] {
  return [...registry.values()]
    .map((t) => {
      const meta: TemplateMeta = { id: t.id, version: t.version, kind: t.kind, title: t.title, requiredData: [...t.requiredData] };
      if (t.recipientRole) meta.recipientRole = t.recipientRole;
      if (t.description) meta.description = t.description;
      return meta;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Resolve a dot path against a plain object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Keys from `requiredData` that are undefined, null or an empty string in `data`. */
export function missingRequiredData(template: Pick<AnyTemplate, 'requiredData'>, data: unknown): string[] {
  const missing: string[] = [];
  for (const key of template.requiredData) {
    const v = getPath(data, key);
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) missing.push(key);
  }
  return missing;
}

/** Validate then render. Throws TemplateNotFoundError or DocumentDataError. */
export function renderTemplate<TData = unknown>(id: string, data: TData): RenderedTemplate {
  const template = getTemplate<TData>(id);
  const missing = missingRequiredData(template, data);
  if (missing.length > 0) throw new DocumentDataError(id, missing);
  const html = template.render(data);
  const title = template.titleFor ? template.titleFor(data) : template.title;
  return { templateId: template.id, templateVersion: template.version, kind: template.kind, title, html, htmlSha256: htmlSha256(html) };
}

/** Render a template's own sample fixture (template picker preview, tests, `pnpm samples`). */
export function renderSample(id: string): RenderedTemplate {
  const template = getTemplate(id);
  return renderTemplate(id, template.sample());
}
