/**
 * LibreOffice (§A.11.3): `soffice --headless --convert-to pdf:writer_pdf_Export` with a private profile under the
 * work dir. Detection proves Writer exists by converting a one-paragraph probe .docx once (a system soffice without
 * the Writer component reports "Writer component missing").
 */
import { existsSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, delimiter, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import type { ConverterStatus, DocxPdfConverter } from '../types.js';
import { defaultSpawn, runProcess, type SpawnFn } from './process.js';

export function libreOfficeCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  const explicit = env['SOFFICE_PATH']?.trim();
  if (explicit) out.push(explicit);
  if (platform === 'win32') {
    for (const root of [env['ProgramFiles'] ?? env['PROGRAMFILES'], env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']) {
      if (root) out.push(`${root}\\LibreOffice\\program\\soffice.exe`);
    }
    return [...new Set(out)];
  }
  if (platform === 'darwin') out.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const name of ['soffice', 'libreoffice']) out.push(join(dir, name));
  }
  return [...new Set(out)];
}

export function findSoffice(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string | undefined {
  return libreOfficeCandidates(env, platform).find((p) => exists(p));
}

/** `-env:UserInstallation=file:///<workDir>/lo-profile`. */
export function libreOfficeProfileUrl(workDir: string): string {
  return pathToFileURL(join(workDir, 'lo-profile')).href;
}

export function libreOfficeArgs(docxPath: string, outDir: string, workDir: string): string[] {
  return ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${libreOfficeProfileUrl(workDir)}`, '--convert-to', 'pdf:writer_pdf_Export', '--outdir', outDir, docxPath];
}

/** A valid one-paragraph .docx (the Writer probe). */
export function probeDocx(text = 'ClaimDesk LibreOffice probe'): Uint8Array {
  const ct =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
  return zipSync({ '[Content_Types].xml': strToU8(ct), '_rels/.rels': strToU8(rels), 'word/document.xml': strToU8(doc) }, { level: 6, mtime: new Date(2026, 0, 1) });
}

export interface LibreOfficeConverterOptions {
  workDir: string;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  /** Probe timeout (first start of a fresh profile is slow). Default 120 s. */
  probeTimeoutMs?: number;
}

export function createLibreOfficeConverter(opts: LibreOfficeConverterOptions): DocxPdfConverter {
  const spawn = opts.spawn ?? defaultSpawn;
  const platform = opts.platform ?? process.platform;
  const soffice = (): string | undefined => findSoffice(opts.env ?? process.env, platform, opts.exists ?? existsSync);

  const runConvert = async (exe: string, docxPath: string, outDir: string, timeoutMs: number): Promise<string> => {
    await mkdir(outDir, { recursive: true });
    await mkdir(opts.workDir, { recursive: true });
    const r = await runProcess(exe, libreOfficeArgs(docxPath, outDir, opts.workDir), { timeoutMs, spawn, platform, cwd: opts.workDir });
    if (r.timedOut) throw new Error(`LibreOffice did not finish within ${Math.round(timeoutMs / 1000)} s`);
    const pdfPath = join(outDir, `${basename(docxPath, extname(docxPath))}.pdf`);
    try {
      await access(pdfPath);
    } catch {
      const detail = `${r.stderr}\n${r.stdout}`.trim().slice(0, 400);
      throw new Error(`LibreOffice wrote no PDF (exit ${r.code})${detail ? `: ${detail}` : ''}`);
    }
    return pdfPath;
  };

  return {
    id: 'libreoffice',
    async detect(): Promise<ConverterStatus> {
      const exe = soffice();
      if (!exe) return { ok: false, detail: 'LibreOffice not found' };
      const probeDir = join(opts.workDir, 'lo-probe');
      try {
        await mkdir(probeDir, { recursive: true });
        const probe = join(probeDir, 'probe.docx');
        await writeFile(probe, probeDocx());
        await runConvert(exe, probe, probeDir, opts.probeTimeoutMs ?? 120_000);
        return { ok: true, detail: 'LibreOffice Writer', path: exe };
      } catch (err) {
        return { ok: false, detail: `Writer component missing (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`, path: exe };
      }
    },
    async convert({ docxPath, outDir, timeoutMs }): Promise<string> {
      const exe = soffice();
      if (!exe) throw new Error('LibreOffice not found');
      return runConvert(exe, docxPath, outDir, timeoutMs);
    }
  };
}
