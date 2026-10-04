/**
 * DOCX → PDF on the user's PC (§A.11): Microsoft Word → LibreOffice → docx-preview in the shared browser.
 *
 * `auto` tries word, libreoffice, browser in that order; a named preference is tried first and still falls back (the
 * attempt log records why). Conversions are serialised (Word automation is single-threaded, LibreOffice locks its
 * profile). Detection results are cached for the process lifetime. Every PDF is stamped with the ClaimDesk metadata
 * BEFORE its sha256 is computed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../../hash.js';
import { stampPdfMetadata } from '../pdfmeta.js';
import { extractHeaderFooter } from '../preview.js';
import { DocxError, type ConverterStatus, type ConvertDocxOptions, type ConvertDocxResult, type DocxPdfConverter, type DocxPdfConverterId, type DocxPdfPreference } from '../types.js';
import { createBrowserConverter } from './browser.js';
import { createLibreOfficeConverter } from './libreoffice.js';
import { createWordConverter } from './word.js';

export { createBrowserConverter, browserPrintCss, browserScriptPaths, cssString, marginBoxesSupported, resetMarginBoxProbe, FONT_FACE_CSS } from './browser.js';
export { createLibreOfficeConverter, findSoffice, libreOfficeArgs, libreOfficeCandidates, libreOfficeProfileUrl, probeDocx } from './libreoffice.js';
export { createWordConverter, parseWordProcessList, selectWordPidsToKill, wordConvertArgs, wordDetectArgs, WORD_CONVERT_SCRIPT, WORD_DETECT_COMMAND, type WordProcess } from './word.js';
export { killProcessTree, runProcess, type ChildLike, type RunResult, type SpawnFn } from './process.js';

export const CONVERTER_ORDER: readonly DocxPdfConverterId[] = ['word', 'libreoffice', 'browser'];
export const DEFAULT_TIMEOUTS: Readonly<Record<DocxPdfConverterId, number>> = { word: 90_000, libreoffice: 90_000, browser: 60_000 };

export class DocxConversionError extends DocxError {
  readonly attempts: ConvertDocxResult['attempts'];
  constructor(message: string, attempts: ConvertDocxResult['attempts']) {
    super('PDF_CONVERSION_FAILED', message);
    this.attempts = attempts;
  }
}

export function parsePreference(v: string | undefined): DocxPdfPreference | undefined {
  const t = v?.trim().toLowerCase();
  return t === 'auto' || t === 'word' || t === 'libreoffice' || t === 'browser' ? t : undefined;
}

/** Converter ids in the order they are tried for a preference. */
export function converterOrder(preference: DocxPdfPreference): DocxPdfConverterId[] {
  if (preference === 'auto') return [...CONVERTER_ORDER];
  return [preference, ...CONVERTER_ORDER.filter((id) => id !== preference)];
}

// ---------------------------------------------------------------------------
// Serial queue and detection cache
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every previously queued conversion has finished. */
export function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const detectionCache = new WeakMap<DocxPdfConverter, Promise<ConverterStatus>>();

function detectCached(c: DocxPdfConverter, refresh = false): Promise<ConverterStatus> {
  if (!refresh) {
    const hit = detectionCache.get(c);
    if (hit) return hit;
  }
  const p = c.detect().catch((err: unknown) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }));
  detectionCache.set(c, p);
  return p;
}

function defaultWorkDir(): string {
  return process.env['DOCX_CONVERT_WORKDIR']?.trim() || join(tmpdir(), 'claimdesk-convert');
}

let defaults: { workDir: string; list: DocxPdfConverter[] } | undefined;

/** The process-wide converter instances (so their detection is cached once). */
export function defaultConverters(workDir: string = defaultWorkDir()): DocxPdfConverter[] {
  if (!defaults || defaults.workDir !== workDir) {
    defaults = { workDir, list: [createWordConverter({ workDir }), createLibreOfficeConverter({ workDir }), createBrowserConverter()] };
  }
  return defaults.list;
}

export async function detectDocxConverters(opts?: { refresh?: boolean; converters?: DocxPdfConverter[] }): Promise<Record<DocxPdfConverterId, ConverterStatus>> {
  const list = opts?.converters ?? defaultConverters(defaults?.workDir ?? defaultWorkDir());
  const out: Record<DocxPdfConverterId, ConverterStatus> = {
    word: { ok: false, detail: 'not configured' },
    libreoffice: { ok: false, detail: 'not configured' },
    browser: { ok: false, detail: 'not configured' }
  };
  for (const c of list) out[c.id] = await detectCached(c, opts?.refresh);
  return out;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 500);
}

export function convertDocxToPdf(docx: Uint8Array, opts: ConvertDocxOptions): Promise<ConvertDocxResult> {
  const preference = opts.preference ?? parsePreference(process.env['DOCX_PDF_CONVERTER']) ?? 'auto';
  const converters = opts.converters ?? defaultConverters(opts.workDir);
  const ordered = converterOrder(preference)
    .map((id) => converters.find((c) => c.id === id))
    .filter((c): c is DocxPdfConverter => !!c);
  return serialise(async () => {
    await mkdir(opts.workDir, { recursive: true });
    const jobDir = await mkdtemp(join(opts.workDir, 'job-'));
    const attempts: ConvertDocxResult['attempts'] = [];
    try {
      const docxPath = join(jobDir, 'document.docx');
      await writeFile(docxPath, docx);
      const header = extractHeaderFooter(docx);
      for (const c of ordered) {
        const t0 = Date.now();
        const status = await detectCached(c);
        if (!status.ok) {
          attempts.push({ id: c.id, ok: false, ms: Date.now() - t0, error: `unavailable: ${status.detail ?? 'not found'}` });
          continue;
        }
        try {
          const pdfPath = await c.convert({ docxPath, outDir: join(jobDir, `out-${c.id}`), header, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUTS[c.id] });
          const raw = new Uint8Array(await readFile(pdfPath));
          if (!(raw[0] === 0x25 && raw[1] === 0x50 && raw[2] === 0x44 && raw[3] === 0x46)) throw new Error('the converter output is not a PDF');
          const stamped = await stampPdfMetadata(raw, opts.metadata);
          attempts.push({ id: c.id, ok: true, ms: Date.now() - t0 });
          return { pdf: stamped.pdf, sha256: sha256Hex(stamped.pdf), pages: stamped.pages, converter: c.id, attempts };
        } catch (err) {
          attempts.push({ id: c.id, ok: false, ms: Date.now() - t0, error: errorText(err) });
        }
      }
      throw new DocxConversionError(`No PDF converter succeeded: ${attempts.map((a) => `${a.id}: ${a.error ?? 'failed'}`).join('; ')}`, attempts);
    } finally {
      await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
