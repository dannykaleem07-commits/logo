/**
 * `pnpm --filter @ccguk/documents docx:mappings` — for each built-in Word template:
 *   prints every slot with its mapping status (mapped / ignored / UNMAPPED), policy and the value the sample claim
 *   (sampleMergeSource(), CCG-2026-00012) would print, plus mapping issues and plan issues;
 *   writes out/docx/<id>.mapped.docx and, when Chromium is available, out/docx/<id>.browser.pdf.
 * Env: CHROMIUM_PATH (browser PDF), DOCX_MAPPINGS (comma-separated id filter), DOCX_MAPPINGS_NO_PDF=1.
 * Exit code 1 when any built-in has a mapping issue or an unmapped slot.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeBrowser, resolveChromium } from '../../render.js';
import { convertDocxToPdf, createBrowserConverter } from '../convert/index.js';
import { fillDocx } from '../fill.js';
import { scanDocx } from '../scan.js';
import { BUILTIN_DOCX_TEMPLATES, builtinAssetBytes, builtinMapping } from './builtin/index.js';
import { resolveSelectors } from './mapping.js';
import { buildFillPlan } from './plan.js';
import { sampleMergeSource } from './source.js';

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

async function chromiumAvailable(): Promise<boolean> {
  if (process.env['DOCX_MAPPINGS_NO_PDF'] === '1') return false;
  try {
    const p = await Promise.resolve(resolveChromium());
    return !!p;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const out = fileURLToPath(new URL('../../../out/docx/', import.meta.url));
  const work = join(out, '.work');
  mkdirSync(work, { recursive: true });
  const filter = (process.env['DOCX_MAPPINGS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pdf = await chromiumAvailable();
  const now = new Date('2026-10-04T08:30:00Z');
  let failures = 0;
  const summary: string[] = [];
  for (const t of BUILTIN_DOCX_TEMPLATES) {
    if (filter.length && !filter.some((f) => t.id.includes(f))) continue;
    const bytes = builtinAssetBytes(t.id);
    const scan = scanDocx(bytes);
    const mapping = builtinMapping(t.id);
    const { bySlot, ignored, issues } = resolveSelectors(mapping, scan);
    const source = sampleMergeSource();
    const plan = buildFillPlan(scan, mapping, source, { confirm: [] });
    const rowsById = new Map(plan.rows.map((r) => [r.slotId, r]));
    const lines: string[] = [];
    lines.push(`# ${t.id}  (${t.file})`);
    lines.push(`sha256 ${scan.sha256}${mapping.sourceSha256 === scan.sha256 ? '' : `  ≠ mapping ${mapping.sourceSha256}`}  slots ${scan.slots.length}  mapped ${bySlot.size}  ignored ${ignored.size}  variant ${plan.variant ?? '-'}`);
    let unmapped = 0;
    for (const slot of scan.slots) {
      const row = rowsById.get(slot.id);
      const entry = bySlot.get(slot.id);
      const status = entry ? 'mapped ' : ignored.has(slot.id) ? 'ignored' : 'UNMAPPED';
      if (status === 'UNMAPPED') unmapped++;
      const value = row ? (row.display ? clip(row.display, 60) : row.needsConfirmation && row.value !== null ? `(suggest: ${clip(JSON.stringify(row.value), 50)})` : '') : '(block removed)';
      lines.push(`  ${status}  ${(row?.policy ?? entry?.policy ?? '').padEnd(13)} ${slot.id.padEnd(84)} ${(entry?.key ?? '').padEnd(36)} ${value}`);
      for (const sub of plan.rows.filter((r) => r.slotId.startsWith(`${slot.id}|`))) lines.push(`           ${sub.policy.padEnd(13)} ${`  ↳ ${sub.slotId.slice(slot.id.length + 1)}`.padEnd(84)} ${(sub.key ?? '').padEnd(36)} ${clip(sub.display, 60)}`);
    }
    for (const i of issues) lines.push(`  MAPPING ISSUE ${i.code} entry ${i.entry}: ${i.detail}`);
    for (const i of plan.issues) lines.push(`  plan ${i.severity} ${i.code}: ${i.message}`);
    if (issues.length || unmapped || mapping.sourceSha256 !== scan.sha256) failures++;
    const filled = fillDocx(bytes, plan.instructions, {
      removeBlocks: plan.removeBlocks,
      coreProps: { title: `${t.title} — ${source.claim.reference}`, subject: t.title, keywords: [source.claim.reference, t.id], created: now, modified: now },
      now,
      ...(mapping.style?.valueRun ? { valueRunStyle: mapping.style.valueRun } : {})
    });
    writeFileSync(join(out, `${t.id}.mapped.docx`), filled.docx);
    lines.push(`  fill: ${filled.report.filled.length} filled, ${filled.report.removed.length} removed, ${filled.report.skipped.length} skipped${filled.report.skipped.length ? ` (${filled.report.skipped.map((s) => `${s.slotId}:${s.reason}`).join(', ')})` : ''}`);
    let pdfNote = 'pdf skipped';
    if (pdf) {
      try {
        const r = await convertDocxToPdf(filled.docx, { workDir: work, preference: 'browser', converters: [createBrowserConverter()], metadata: { title: `${t.title} — ${source.claim.reference}`, subject: t.title, keywords: [source.claim.reference] } });
        writeFileSync(join(out, `${t.id}.browser.pdf`), r.pdf);
        pdfNote = `pdf ${r.pages} pages`;
      } catch (err) {
        pdfNote = `pdf ERR ${clip(err instanceof Error ? err.message : String(err), 80)}`;
      }
    }
    lines.push(`  ${pdfNote}`);
    process.stdout.write(`${lines.join('\n')}\n\n`);
    summary.push(`${t.id.padEnd(50)} slots ${String(scan.slots.length).padStart(4)}  mapping issues ${issues.length}  unmapped ${unmapped}  filled ${filled.report.filled.length}  ${pdfNote}`);
  }
  process.stdout.write(`${summary.join('\n')}\n`);
  writeFileSync(join(out, 'mappings-summary.txt'), `${summary.join('\n')}\n`);
  await closeBrowser();
  if (failures) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(async (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    await closeBrowser();
    process.exitCode = 1;
  });
}
