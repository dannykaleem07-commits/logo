/**
 * `pnpm --filter @ccguk/documents docx:samples` — for each built-in Word file in assets/docx:
 *   out/docx/<file>.scan.txt      outline + slot table
 *   out/docx/<file>.labels.docx   every non-signature text-like slot filled with its own label in [brackets]
 *   out/docx/<file>.browser.pdf   the labels fill converted by the built-in browser converter
 *   out/docx/<file>.lo.pdf        the same through LibreOffice (only when SOFFICE_PATH is set)
 *   out/docx/<file>.*-1.png / -2  pages 1–2 via pdftoppm when available
 * Env: CHROMIUM_PATH (browser), SOFFICE_PATH (LibreOffice with Writer), DOCX_SAMPLES (comma-separated name filter).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeBrowser } from '../render.js';
import { formatScan } from './cli.js';
import { convertDocxToPdf, createBrowserConverter, createLibreOfficeConverter } from './convert/index.js';
import { fillDocx } from './fill.js';
import { scanDocx } from './scan.js';
import type { DocxScan, FillInstruction } from './types.js';

const TEXT_KINDS = new Set(['cell', 'line', 'block', 'inline', 'blank', 'bracket', 'token', 'control', 'mergefield']);

/** The 'labels' fill: every non-signature text-like slot gets `[its label]`. */
export function labelsInstructions(scan: DocxScan): FillInstruction[] {
  return scan.slots.filter((s) => !s.signature && TEXT_KINDS.has(s.kind)).map((s) => ({ slotId: s.id, value: { type: 'text', text: `[${s.label}]` } }));
}

function hasTool(name: string): boolean {
  return spawnSync(name, ['-v'], { stdio: 'ignore' }).error === undefined;
}

function pngs(pdf: string, prefix: string): void {
  const dir = dirname(prefix);
  const base = basename(prefix);
  for (const f of readdirSync(dir)) if (f.startsWith(`${base}-`) && f.endsWith('.png')) rmSync(join(dir, f));
  spawnSync('pdftoppm', ['-png', '-r', '70', '-f', '1', '-l', '2', pdf, prefix], { stdio: 'ignore' });
}

async function main(): Promise<void> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const assets = join(here, '..', '..', 'assets', 'docx');
  const out = join(here, '..', '..', 'out', 'docx');
  const work = join(out, '.work');
  mkdirSync(work, { recursive: true });
  const filter = (process.env['DOCX_SAMPLES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const files = readdirSync(assets).filter((f) => f.endsWith('.docx') && (filter.length === 0 || filter.some((x) => f.includes(x)))).sort();
  const soffice = process.env['SOFFICE_PATH']?.trim();
  const withPng = hasTool('pdftoppm');
  const now = new Date('2026-10-04T09:30:00Z');
  const rows: string[] = [];
  for (const file of files) {
    const name = file.replace(/\.docx$/, '');
    const bytes = new Uint8Array(readFileSync(join(assets, file)));
    const scan = scanDocx(bytes);
    writeFileSync(join(out, `${name}.scan.txt`), `${formatScan(scan, file)}\n`);
    const instructions = labelsInstructions(scan);
    const filled = fillDocx(bytes, instructions, { coreProps: { title: `${name} — labels sample`, subject: name, keywords: ['sample', name], created: now, modified: now }, now });
    writeFileSync(join(out, `${name}.labels.docx`), filled.docx);
    const metadata = { title: `${name} — labels sample`, subject: name, keywords: ['sample'] };
    let browserPages = '-';
    try {
      const r = await convertDocxToPdf(filled.docx, { workDir: work, metadata, preference: 'browser', converters: [createBrowserConverter()] });
      const p = join(out, `${name}.browser.pdf`);
      writeFileSync(p, r.pdf);
      browserPages = String(r.pages);
      if (withPng) pngs(p, join(out, `${name}.browser`));
    } catch (err) {
      browserPages = `ERR ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`;
    }
    let loPages = '-';
    if (soffice) {
      try {
        const r = await convertDocxToPdf(filled.docx, { workDir: work, metadata, preference: 'libreoffice', converters: [createLibreOfficeConverter({ workDir: work })] });
        const p = join(out, `${name}.lo.pdf`);
        writeFileSync(p, r.pdf);
        loPages = String(r.pages);
        if (withPng) pngs(p, join(out, `${name}.lo`));
      } catch (err) {
        loPages = `ERR ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`;
      }
    }
    rows.push(
      `${name.padEnd(62)} slots ${String(scan.slots.length).padStart(4)}  filled ${String(filled.report.filled.length).padStart(4)}  skipped ${String(filled.report.skipped.length).padStart(3)}  scan ${String(scan.stats.ms).padStart(4)} ms  browser ${browserPages}  lo ${loPages}`
    );
    process.stdout.write(`${rows[rows.length - 1]}\n`);
  }
  writeFileSync(join(out, 'summary.txt'), `${rows.join('\n')}\n`);
  await closeBrowser();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(async (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    await closeBrowser();
    process.exitCode = 1;
  });
}
