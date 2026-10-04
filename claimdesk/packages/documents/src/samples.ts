/**
 * `pnpm --filter @ccguk/documents samples`
 *
 * Renders every production template's `sample()` to `out/<templateId>.html` and `out/<templateId>.pdf`, then prints a
 * table: template id, version, pages, SHA-256 of the PDF bytes, bytes. Every template is attempted before the process
 * exits, so one failure cannot hide another.
 *
 * Exit status is non-zero when
 *   - a template throws (requiredData missing from its own sample, a render error, or a PDF error), or
 *   - a rendered HTML contains a legacy string or a banned phrase (guards.ts: brand.legacy.*).
 *
 * Only templates imported by ./templates/index.ts are rendered — the same set the API lists. The pattern file
 * templates/_example.ts is exercised by the tests and is not written to out/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProhibitedContent } from './guards.js';
import { readDocumentMeta } from './layout.js';
import { listTemplates, renderSample, type TemplateMeta } from './registry.js';
import { closeBrowser, renderPdf } from './render.js';
import './templates/index.js';

interface SampleRow {
  id: string;
  version: string;
  pages: number;
  sha256: string;
  bytes: number;
}

interface SampleFailure {
  id: string;
  stage: 'render' | 'guard' | 'pdf';
  message: string;
}

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../out');
mkdirSync(outDir, { recursive: true });

const rows: SampleRow[] = [];
const failures: SampleFailure[] = [];

async function renderOne(meta: TemplateMeta): Promise<void> {
  let html: string;
  try {
    html = renderSample(meta.id).html;
  } catch (e) {
    failures.push({ id: meta.id, stage: 'render', message: errorMessage(e) });
    return;
  }
  writeFileSync(join(outDir, `${meta.id}.html`), html, 'utf8');

  const hits = findProhibitedContent(html);
  for (const h of hits) failures.push({ id: meta.id, stage: 'guard', message: `[${h.kind}] "${h.needle}" — ${h.excerpt}` });

  try {
    const reference = readDocumentMeta(html).reference || meta.id.toUpperCase();
    const { pdf, pages, sha256 } = await renderPdf(html, { reference });
    writeFileSync(join(outDir, `${meta.id}.pdf`), pdf);
    rows.push({ id: meta.id, version: meta.version, pages, sha256, bytes: pdf.length });
  } catch (e) {
    failures.push({ id: meta.id, stage: 'pdf', message: errorMessage(e) });
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function formatTable(list: SampleRow[]): string {
  const idWidth = Math.max('Template'.length, ...list.map((r) => r.id.length));
  const header = `${'Template'.padEnd(idWidth)}  ${'Version'.padEnd(7)}  ${'Pages'.padStart(5)}  ${'SHA-256 (PDF)'.padEnd(64)}  ${'Bytes'.padStart(8)}`;
  const rule = '-'.repeat(header.length);
  const lines = list.map(
    (r) => `${r.id.padEnd(idWidth)}  ${r.version.padEnd(7)}  ${String(r.pages).padStart(5)}  ${r.sha256}  ${String(r.bytes).padStart(8)}`
  );
  return [header, rule, ...lines].join('\n');
}

const templates = listTemplates();
try {
  for (const meta of templates) {
    await renderOne(meta);
  }
} finally {
  await closeBrowser();
}

rows.sort((a, b) => a.id.localeCompare(b.id));
console.log(formatTable(rows));
const totalPages = rows.reduce((n, r) => n + r.pages, 0);
console.log(`\n${rows.length} of ${templates.length} template(s) rendered to ${outDir} (${totalPages} pages in total)`);

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f.id}  [${f.stage}]  ${f.message}`);
  process.exit(1);
}
