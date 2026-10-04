/**
 * `pnpm --filter @ccguk/documents docx:scan <file.docx> [--json]` — prints the outline, blocks and a slot table
 * (id, kind, label, qualifier, preview, signature, blank pattern, options) for a .docx.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scanDocx } from './scan.js';
import type { DocxScan } from './types.js';

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function formatScan(scan: DocxScan, file = ''): string {
  const out: string[] = [];
  out.push(`# ${file}`);
  out.push(`sha256 ${scan.sha256}  scanner v${scan.scannerVersion}  ${scan.slots.length} slots  ${scan.stats.paragraphs} paragraphs  ${scan.stats.tables} tables  ${scan.stats.parts} parts  ${scan.stats.ms} ms`);
  out.push('');
  out.push('## Outline');
  for (const h of scan.outline) out.push(`${h.level === 1 ? '' : '    '}${h.slug}    (${clip(h.title, 70)})`);
  out.push('');
  out.push('## Blocks');
  for (const b of scan.blocks) out.push(`${b.id}  [${b.startIndex}, ${b.endIndex})  ${clip(b.title, 60)}`);
  if (scan.warnings.length) {
    out.push('');
    out.push('## Warnings');
    for (const w of scan.warnings) out.push(`${w.code}  ${w.message}${w.part ? `  (${w.part})` : ''}`);
  }
  out.push('');
  out.push('## Slots');
  out.push(['id', 'kind', 'label', 'qualifier', 'preview', 'sig', 'blank', 'options'].join('\t'));
  for (const s of scan.slots) {
    const extra: string[] = [];
    if (s.parts) extra.push(`parts=${s.parts.join(',')}`);
    if (s.rowCount !== undefined) extra.push(`rows=${s.rowCount}`);
    if (s.columns) extra.push(`columns=${s.columns.map((c) => c.slug).join(',')}`);
    if (s.fixedLead) extra.push(`lead=${clip(s.fixedLead, 30)}`);
    if (s.hint) extra.push('hint');
    if (s.blockId) extra.push(`block=${s.blockId}`);
    out.push(
      [
        s.id,
        s.kind,
        clip(s.label, 40),
        s.qualifier ?? '',
        JSON.stringify(clip(s.preview, 40)),
        s.signature ? 'SIG' : '',
        s.blank ? `${s.blank.pattern}${s.blank.unit ? `+${s.blank.unit}` : ''}${s.blank.prefix ? ` ${s.blank.prefix}` : ''}` : '',
        s.options ? s.options.map((o) => `${o.checked ? '☒' : '☐'}${o.slug}${o.blank ? `[${o.blank.pattern}]` : ''}`).join(' ') : '',
        extra.join(' ')
      ].join('\t')
    );
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const json = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    process.stderr.write('usage: docx:scan <file.docx> [--json]\n');
    process.exitCode = 2;
    return;
  }
  for (const file of files) {
    const scan = scanDocx(new Uint8Array(readFileSync(file)));
    process.stdout.write(json ? `${JSON.stringify(scan, null, 2)}\n` : `${formatScan(scan, file)}\n\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
