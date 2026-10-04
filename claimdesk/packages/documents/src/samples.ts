/**
 * `pnpm --filter @ccguk/documents samples` — renders every registered template's sample() to out/<id>.html and
 * out/<id>.pdf, plus the example pattern letter, and prints a table. Fails (exit 1) if any output contains legacy
 * strings or banned phrases.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProhibitedContent } from './guards.js';
import { readDocumentMeta } from './layout.js';
import { listTemplates, renderSample } from './registry.js';
import { closeBrowser, renderPdf } from './render.js';
import { registerExampleTemplate } from './templates/_example.js';
import './templates/index.js';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../out');
mkdirSync(outDir, { recursive: true });

registerExampleTemplate();

let failures = 0;
const rows: string[] = [];
for (const meta of listTemplates()) {
  const rendered = renderSample(meta.id);
  const hits = findProhibitedContent(rendered.html);
  if (hits.length > 0) {
    failures += 1;
    for (const h of hits) rows.push(`${meta.id}  PROHIBITED [${h.kind}] "${h.needle}": ${h.excerpt}`);
  }
  const base = join(outDir, meta.id);
  writeFileSync(`${base}.html`, rendered.html, 'utf8');
  const reference = readDocumentMeta(rendered.html).reference || meta.id.toUpperCase();
  const { pdf, pages, sha256 } = await renderPdf(rendered.html, { reference });
  writeFileSync(`${base}.pdf`, pdf);
  rows.push(`${meta.id.padEnd(36)} v${meta.version.padEnd(8)} ${String(pages).padStart(2)} page(s)  ${sha256.slice(0, 12)}…  ${pdf.length} bytes`);
}
await closeBrowser();

console.log(rows.join('\n'));
console.log(`\n${listTemplates().length} template(s) rendered to ${outDir}`);
if (failures > 0) {
  console.error(`\n${failures} template(s) contain prohibited content`);
  process.exit(1);
}
