/**
 * HTML → PDF with playwright-core and a locally installed Chromium.
 *
 *   const { pdf, sha256, pages } = await renderPdf(html, { reference: 'CCG-2026-00012' });
 *
 * Chromium is resolved once per process by `resolveChromium()` (CHROMIUM_PATH → PLAYWRIGHT_BROWSERS_PATH scan →
 * PATH). One browser instance is shared (lazy singleton); each render gets its own context and page. Call
 * `closeBrowser()` on shutdown (and in test teardown).
 */
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { brand } from './brand.js';
import { footerTemplate, headerTemplate, readDocumentMeta } from './layout.js';
import { htmlSha256, sha256Hex } from './hash.js';

export { htmlSha256, sha256Hex };

export interface RenderPdfOptions {
  /** Our reference, printed in the running header with "Page X of Y". */
  reference: string;
  /** Footer line 1. Default brand.company.statusLine. */
  statusLine?: string;
  /** Footer line 2. Default brand.tradingDisclosure(registeredOffice). */
  tradingDisclosure?: string;
  /** Used to build the default trading disclosure; falls back to the <meta name="ccguk:registered-office"> the layout embeds. */
  registeredOffice?: string;
  landscape?: boolean;
  /** Navigation / print timeout in ms. Default 30 000. */
  timeoutMs?: number;
}

export interface RenderPdfResult {
  pdf: Buffer;
  /** SHA-256 hex of the PDF bytes. */
  sha256: string;
  pages: number;
}

// ---------------------------------------------------------------------------
// Chromium discovery
// ---------------------------------------------------------------------------

const RELATIVE_BINARIES = [
  join('chrome-linux', 'chrome'),
  join('chrome-linux64', 'chrome'),
  join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('chrome-win', 'chrome.exe'),
  join('chrome-win64', 'chrome.exe')
];

const HEADLESS_SHELL_BINARIES = [join('chrome-linux', 'headless_shell'), join('chrome-linux64', 'headless_shell'), join('chrome-win', 'headless_shell.exe')];

const PATH_CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'chrome.exe'];

function isExecutable(p: string): boolean {
  try {
    accessSync(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function revisionOf(dirName: string): number {
  const mm = /-(\d+)$/.exec(dirName);
  return mm ? Number(mm[1]) : 0;
}

/** Scan a Playwright browsers directory for the newest chromium build. */
export function scanPlaywrightBrowsers(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const pick = (prefix: string, binaries: string[]): string | undefined => {
    const dirs = entries.filter((e) => e.startsWith(prefix)).sort((a, b) => revisionOf(b) - revisionOf(a));
    for (const d of dirs) {
      for (const rel of binaries) {
        const full = join(dir, d, rel);
        if (isExecutable(full)) return full;
      }
    }
    return undefined;
  };
  return pick('chromium-', RELATIVE_BINARIES) ?? pick('chromium_headless_shell-', HEADLESS_SHELL_BINARIES);
}

function findOnPath(names: string[]): string | undefined {
  const pathVar = process.env['PATH'] ?? '';
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  return undefined;
}

let resolvedChromium: string | undefined | null = null; // null = not yet resolved

/**
 * Executable path for Chromium, or undefined to let playwright-core use its own default.
 * Order: CHROMIUM_PATH → PLAYWRIGHT_BROWSERS_PATH (default ~/.cache/ms-playwright) → chromium/google-chrome on PATH.
 */
export function resolveChromium(): string | undefined {
  if (resolvedChromium !== null) return resolvedChromium;
  const explicit = process.env['CHROMIUM_PATH']?.trim();
  if (explicit) {
    resolvedChromium = explicit;
    return explicit;
  }
  const browsersDir = process.env['PLAYWRIGHT_BROWSERS_PATH']?.trim() || join(homedir(), '.cache', 'ms-playwright');
  resolvedChromium = scanPlaywrightBrowsers(browsersDir) ?? findOnPath(PATH_CANDIDATES);
  return resolvedChromium;
}

/** Forget the cached discovery result (tests). */
export function resetChromiumResolution(): void {
  resolvedChromium = null;
}

function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Launch args: sandbox off when running as root (containers) or when CHROMIUM_NO_SANDBOX=1. */
export function launchArgs(): string[] {
  const noSandbox = runningAsRoot() || process.env['CHROMIUM_NO_SANDBOX'] === '1';
  return noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
}

export function launchOptions(): LaunchOptions {
  const opts: LaunchOptions = { headless: true, args: launchArgs() };
  const exe = resolveChromium();
  if (exe) opts.executablePath = exe;
  return opts;
}

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

let browserPromise: Promise<Browser> | undefined;

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const opts = launchOptions();
    browserPromise = chromium.launch(opts).then(
      (b) => {
        b.on('disconnected', () => {
          browserPromise = undefined;
        });
        return b;
      },
      (err: unknown) => {
        browserPromise = undefined;
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not launch Chromium (${opts.executablePath ?? 'playwright default'}). Set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH. ${detail}`
        );
      }
    );
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = undefined;
  if (!p) return;
  try {
    const b = await p;
    await b.close();
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const mm = (n: number): string => `${n}mm`;

export async function renderPdf(html: string, opts: RenderPdfOptions): Promise<RenderPdfResult> {
  const meta = readDocumentMeta(html);
  const statusLine = opts.statusLine ?? brand.company.statusLine;
  const tradingDisclosure = opts.tradingDisclosure ?? brand.tradingDisclosure(opts.registeredOffice ?? meta.registeredOffice ?? '');
  const timeout = opts.timeoutMs ?? 30_000;

  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    await page.setContent(html, { waitUntil: 'load', timeout });
    // Wait for fonts so measurement (and therefore pagination) is stable. String form: no DOM lib in this package.
    await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
    const pdf = await page.pdf({
      format: brand.page.size,
      landscape: opts.landscape ?? false,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(opts.reference),
      footerTemplate: footerTemplate(statusLine, tradingDisclosure),
      margin: {
        top: mm(brand.page.marginMm.top),
        right: mm(brand.page.marginMm.right),
        bottom: mm(brand.page.marginMm.bottom),
        left: mm(brand.page.marginMm.left)
      },
      preferCSSPageSize: false
    });
    const buffer = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    return { pdf: buffer, sha256: sha256Hex(buffer), pages: await pdfPageCount(buffer) };
  } finally {
    await context.close();
  }
}

export async function pdfPageCount(pdf: Buffer | Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  return doc.getPageCount();
}

/** Concatenate PDFs in order (packs and bundles). */
export async function mergePdfs(buffers: ReadonlyArray<Buffer | Uint8Array>): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf, { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  out.setProducer(brand.company.registeredName);
  out.setCreator('ClaimDesk');
  return Buffer.from(await out.save({ useObjectStreams: false }));
}
