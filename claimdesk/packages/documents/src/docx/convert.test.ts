import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../hash.js';
import { closeBrowser, resolveChromium } from '../render.js';
import {
  browserPrintCss,
  convertDocxToPdf,
  converterOrder,
  createBrowserConverter,
  createLibreOfficeConverter,
  createWordConverter,
  cssString,
  detectDocxConverters,
  libreOfficeArgs,
  libreOfficeCandidates,
  runProcess,
  selectWordPidsToKill,
  WORD_CONVERT_SCRIPT,
  type ChildLike,
  type SpawnFn
} from './convert/index.js';
import { fillDocx } from './fill.js';
import { stampPdfMetadata } from './pdfmeta.js';
import type { ConverterStatus, DocxPdfConverter, DocxPdfConverterId } from './types.js';
import { docx, pt } from './__fixtures__/build.js';

afterAll(async () => {
  await closeBrowser();
});

const work = mkdtempSync(join(tmpdir(), 'ccguk-convert-test-'));
const metadata = { title: 'Payment Authorisation — CCG-2026-00012', subject: 'Payment Authorisation', keywords: ['CCG-2026-00012', 'form.ccguk_05_payment_direction'] };

async function tinyPdf(pages = 1): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([200, 200]);
  return d.save();
}

interface FakeLog {
  active: number;
  maxActive: number;
  calls: string[];
}

function fake(id: DocxPdfConverterId, behaviour: { detect?: ConverterStatus; fail?: string; pages?: number; delayMs?: number }, log: FakeLog): DocxPdfConverter {
  return {
    id,
    async detect() {
      return behaviour.detect ?? { ok: true, detail: `fake ${id}` };
    },
    async convert({ outDir, timeoutMs }) {
      log.calls.push(`${id}:${timeoutMs}`);
      log.active++;
      log.maxActive = Math.max(log.maxActive, log.active);
      try {
        await new Promise((r) => setTimeout(r, behaviour.delayMs ?? 5));
        if (behaviour.fail) throw new Error(behaviour.fail);
        const out = join(outDir, 'x.pdf');
        const { mkdirSync } = await import('node:fs');
        mkdirSync(outDir, { recursive: true });
        writeFileSync(out, await tinyPdf(behaviour.pages ?? 1));
        return out;
      } finally {
        log.active--;
      }
    }
  };
}

const input = docx(pt('Hello'));

describe('converter chain', () => {
  it('auto order is word → libreoffice → browser; a preference goes first and still falls back', () => {
    expect(converterOrder('auto')).toEqual(['word', 'libreoffice', 'browser']);
    expect(converterOrder('browser')).toEqual(['browser', 'word', 'libreoffice']);
    expect(converterOrder('libreoffice')).toEqual(['libreoffice', 'word', 'browser']);
  });

  it('falls back with an attempt log, stamps metadata and hashes the stamped bytes', async () => {
    const log: FakeLog = { active: 0, maxActive: 0, calls: [] };
    const converters = [fake('word', { detect: { ok: false, detail: 'Microsoft Word is not installed' } }, log), fake('libreoffice', { fail: 'Writer crashed' }, log), fake('browser', { pages: 2 }, log)];
    const res = await convertDocxToPdf(input, { workDir: work, metadata, converters });
    expect(res.converter).toBe('browser');
    expect(res.pages).toBe(2);
    expect(res.attempts.map((a) => [a.id, a.ok, a.error])).toEqual([
      ['word', false, 'unavailable: Microsoft Word is not installed'],
      ['libreoffice', false, 'Writer crashed'],
      ['browser', true, undefined]
    ]);
    expect(log.calls).toEqual(['libreoffice:90000', 'browser:60000']);
    expect(res.sha256).toBe(sha256Hex(res.pdf));
    const doc = await PDFDocument.load(res.pdf, { updateMetadata: false });
    expect(doc.getAuthor()).toBe('Courtesy Cars Group UK Ltd');
    expect(doc.getCreator()).toBe('ClaimDesk');
    expect(doc.getProducer()).toBe('ClaimDesk — Courtesy Cars Group UK Ltd');
    expect(doc.getTitle()).toBe(metadata.title);
    expect(doc.getSubject()).toBe('Payment Authorisation');
    expect(doc.getKeywords()).toBe('CCG-2026-00012 form.ccguk_05_payment_direction');
  });

  it('honours a preference (and DOCX_PDF_CONVERTER), and fails with the whole attempt log when nothing works', async () => {
    const log: FakeLog = { active: 0, maxActive: 0, calls: [] };
    const converters = [fake('word', {}, log), fake('libreoffice', {}, log), fake('browser', {}, log)];
    expect((await convertDocxToPdf(input, { workDir: work, metadata, converters, preference: 'libreoffice', timeoutMs: 5000 })).converter).toBe('libreoffice');
    process.env['DOCX_PDF_CONVERTER'] = 'browser';
    try {
      expect((await convertDocxToPdf(input, { workDir: work, metadata, converters })).converter).toBe('browser');
    } finally {
      delete process.env['DOCX_PDF_CONVERTER'];
    }
    const broken = [fake('word', { fail: 'a' }, log), fake('browser', { fail: 'b' }, log)];
    await expect(convertDocxToPdf(input, { workDir: work, metadata, converters: broken })).rejects.toMatchObject({ code: 'PDF_CONVERSION_FAILED', attempts: [{ id: 'word', ok: false }, { id: 'browser', ok: false }] });
  });

  it('serialises conversions (one at a time) and caches detection', async () => {
    const log: FakeLog = { active: 0, maxActive: 0, calls: [] };
    let detects = 0;
    const b = fake('browser', { delayMs: 20 }, log);
    const counted: DocxPdfConverter = { ...b, detect: async () => (detects++, { ok: true }) };
    await Promise.all(Array.from({ length: 4 }, () => convertDocxToPdf(input, { workDir: work, metadata, converters: [counted] })));
    expect(log.maxActive).toBe(1);
    expect(log.calls).toHaveLength(4);
    expect(detects).toBe(1);
    const status = await detectDocxConverters({ converters: [counted] });
    expect(status.browser.ok).toBe(true);
    expect(detects).toBe(1);
    await detectDocxConverters({ converters: [counted], refresh: true });
    expect(detects).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Word (PowerShell COM) — never runs here; spawn is injected.
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: Array<string | number | undefined> = [];
  constructor(readonly pid: number) {
    super();
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal);
    return true;
  }
}

describe('Microsoft Word converter', () => {
  it('ships the PowerShell script: read-only open, macros force-disabled, its own Word PID recorded', () => {
    expect(WORD_CONVERT_SCRIPT.startsWith('param([string]$In, [string]$Out)')).toBe(true);
    expect(WORD_CONVERT_SCRIPT).toContain('$word.DisplayAlerts = 0');
    expect(WORD_CONVERT_SCRIPT).toContain('$word.AutomationSecurity = 3');
    expect(WORD_CONVERT_SCRIPT).toContain('$word.Options.UpdateLinksAtOpen = $false');
    // ReadOnly, not added to recent files, OpenAndRepair off, NoEncodingDialog on
    expect(WORD_CONVERT_SCRIPT).toContain('$word.Documents.Open($In, $false, $true, $false, $m, $m, $m, $m, $m, $m, $m, $false, $false, $m, $true)');
    expect(WORD_CONVERT_SCRIPT).toContain("($Out + '.wordpid')");
    expect(WORD_CONVERT_SCRIPT.indexOf('AutomationSecurity')).toBeLessThan(WORD_CONVERT_SCRIPT.indexOf('Documents.Open'));
    expect(WORD_CONVERT_SCRIPT).toContain('$doc.ExportAsFixedFormat($Out, 17,');
    expect(WORD_CONVERT_SCRIPT).toContain('$word.Quit(0)');
  });

  it('detects through PowerShell on Windows only, and spawns the script with the documented arguments', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawn: SpawnFn = (cmd, args) => {
      calls.push({ cmd, args });
      const child = new FakeChild(4242);
      setTimeout(() => {
        if (args.includes('-Command')) child.stdout.emit('data', 'True\r\n');
        if (args.includes('-File')) {
          const out = args[args.indexOf('-Out') + 1]!;
          void tinyPdf().then((b) => {
            writeFileSync(out, b);
            child.emit('exit', 0, null);
          });
          return;
        }
        child.emit('exit', 0, null);
      }, 1);
      return child;
    };
    const wd = mkdtempSync(join(tmpdir(), 'ccguk-word-'));
    const linux = createWordConverter({ workDir: wd, spawn, platform: 'linux' });
    expect(await linux.detect()).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    const conv = createWordConverter({ workDir: wd, spawn, platform: 'win32', listWordProcesses: async () => [] });
    expect(await conv.detect()).toMatchObject({ ok: true });
    expect(calls[0]).toEqual({ cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', "[type]::GetTypeFromProgID('Word.Application') -ne $null"] });
    const docxPath = join(wd, 'in.docx');
    writeFileSync(docxPath, input);
    const pdf = await conv.convert({ docxPath, outDir: join(wd, 'out'), header: { titlePage: false, hasPageFields: false }, timeoutMs: 5000 });
    expect(pdf).toBe(join(wd, 'out', 'in.pdf'));
    expect(calls[1]).toEqual({ cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(wd, 'convert.ps1'), '-In', docxPath, '-Out', pdf] });
    expect(readFileSync(join(wd, 'convert.ps1'), 'utf8')).toBe(WORD_CONVERT_SCRIPT);
  });

  it('on timeout kills the PowerShell tree and only the WINWORD processes this run started for automation', async () => {
    expect(
      selectWordPidsToKill(new Set([100]), [
        { pid: 100, commandLine: '"C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE" /Automation -Embedding' },
        { pid: 200, commandLine: '"C:\\...\\WINWORD.EXE" /Automation -Embedding' },
        { pid: 300, commandLine: '"C:\\...\\WINWORD.EXE" C:\\Users\\me\\letter.docx' }
      ])
    ).toEqual([200]);

    const spawned: FakeChild[] = [];
    const spawn: SpawnFn = () => {
      const c = new FakeChild(5000 + spawned.length);
      spawned.push(c);
      return c; // never exits on its own
    };
    let listCalls = 0;
    const killedPids: number[] = [];
    const trees: number[] = [];
    const wd = mkdtempSync(join(tmpdir(), 'ccguk-word-timeout-'));
    const conv = createWordConverter({
      workDir: wd,
      spawn,
      platform: 'win32',
      listWordProcesses: async () => {
        listCalls++;
        return listCalls === 1
          ? [{ pid: 100, commandLine: 'WINWORD.EXE' }]
          : [
              { pid: 100, commandLine: 'WINWORD.EXE' },
              { pid: 200, commandLine: 'WINWORD.EXE /Automation -Embedding' },
              { pid: 300, commandLine: 'WINWORD.EXE /n' }
            ];
      },
      killPid: async (pid) => {
        killedPids.push(pid);
      },
      killTree: async (child) => {
        trees.push(child.pid ?? -1);
        (child as FakeChild).emit('exit', null, 'SIGKILL');
      }
    });
    const docxPath = join(wd, 'in.docx');
    writeFileSync(docxPath, input);
    await expect(conv.convert({ docxPath, outDir: join(wd, 'out'), header: { titlePage: false, hasPageFields: false }, timeoutMs: 30 })).rejects.toThrow(/did not finish/);
    expect(killedPids).toEqual([200]);
    expect(trees).toEqual([5000]);

    // when the script recorded its own Word, only that PID is stopped (another conversion's Word is left alone)
    killedPids.length = 0;
    listCalls = 0;
    const out2 = join(wd, 'out2');
    mkdirSync(out2, { recursive: true });
    writeFileSync(join(out2, 'in.pdf.wordpid'), '777\r\n');
    await expect(conv.convert({ docxPath, outDir: out2, header: { titlePage: false, hasPageFields: false }, timeoutMs: 30 })).rejects.toThrow(/did not finish/);
    expect(killedPids).toEqual([777]);
  });

  it('runProcess resolves with exit code and output', async () => {
    const spawn: SpawnFn = () => {
      const c = new FakeChild(1);
      setTimeout(() => {
        c.stdout.emit('data', 'out');
        c.stderr.emit('data', 'err');
        c.emit('exit', 3, null);
      }, 1);
      return c;
    };
    expect(await runProcess('x', [], { timeoutMs: 1000, spawn })).toMatchObject({ code: 3, stdout: 'out', stderr: 'err', timedOut: false });
  });
});

// ---------------------------------------------------------------------------
// LibreOffice
// ---------------------------------------------------------------------------

describe('LibreOffice converter', () => {
  it('builds the documented arguments with a private profile under the work dir', () => {
    const args = libreOfficeArgs('/w/job/document.docx', '/w/job/out', '/w');
    expect(args).toEqual(['--headless', '--norestore', '--nolockcheck', '-env:UserInstallation=file:///w/lo-profile', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', '/w/job/out', '/w/job/document.docx']);
  });

  it('looks in SOFFICE_PATH, Program Files and PATH', () => {
    expect(libreOfficeCandidates({ SOFFICE_PATH: '/opt/lo/soffice', PATH: '/usr/bin' }, 'linux')).toEqual(['/opt/lo/soffice', '/usr/bin/soffice', '/usr/bin/libreoffice']);
    const win = libreOfficeCandidates({ ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, 'win32');
    expect(win[0]).toBe('C:\\Program Files\\LibreOffice\\program\\soffice.exe');
    expect(win).toContain('C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe');
    expect(libreOfficeCandidates({ PATH: '' }, 'darwin')).toContain('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  });

  it('reports "Writer component missing" when the probe produces no PDF', async () => {
    const spawn: SpawnFn = () => {
      const c = new FakeChild(9);
      setTimeout(() => c.emit('exit', 0, null), 1);
      return c;
    };
    const lo = createLibreOfficeConverter({ workDir: mkdtempSync(join(tmpdir(), 'ccguk-lo-')), spawn, env: { SOFFICE_PATH: '/fake/soffice' }, exists: () => true });
    const st = await lo.detect();
    expect(st.ok).toBe(false);
    expect(st.detail).toMatch(/^Writer component missing/);
  });

  const soffice = process.env['SOFFICE_PATH'];
  it.skipIf(!soffice)(
    'converts CCGUK-05 with a Writer-enabled LibreOffice (SOFFICE_PATH)',
    async () => {
      const bytes = new Uint8Array(readFileSync(new URL('../../assets/docx/CCGUK-05-Payment-Authorisation-and-Settlement-Direction.docx', import.meta.url)));
      const lo = createLibreOfficeConverter({ workDir: join(work, 'lo') });
      const res = await convertDocxToPdf(bytes, { workDir: join(work, 'lo'), metadata, converters: [lo], preference: 'libreoffice' });
      expect(res.converter).toBe('libreoffice');
      expect(res.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect((await PDFDocument.load(res.pdf, { updateMetadata: false })).getAuthor()).toBe('Courtesy Cars Group UK Ltd');
      expect(res.pages).toBe(3);
    },
    240_000
  );
});

// ---------------------------------------------------------------------------
// Browser (docx-preview in the shared Chromium)
// ---------------------------------------------------------------------------

describe('browser converter', () => {
  it('print CSS: page geometry, margin boxes with page counters, first page without the running header', () => {
    const css = browserPrintCss(
      { widthMm: 210, heightMm: 297, marginMm: { top: 21.2, right: 18, bottom: 20.3, left: 18, header: 8.8, footer: 7.4 } },
      { header: 'COURTESY CARS GROUP UK LTD | PAYMENT AUTHORISATION', footer: 'Line 1\nLine "2"', firstFooter: 'First', titlePage: true, hasPageFields: true },
      { marginBoxes: true, firstFooterHasPageFields: true }
    );
    expect(css).toContain('@page { size: A4; margin: 21.2mm 0 20.3mm 0;');
    expect(css).toContain('@top-left { content: "COURTESY CARS GROUP UK LTD | PAYMENT AUTHORISATION"');
    expect(css).toContain('content: "PAGE " counter(page) " OF " counter(pages)');
    expect(css).toContain('@page :first { margin-top: 8.8mm; @top-left { content: none } @top-right { content: none }');
    expect(css).toContain('section.docx ~ section.docx > header { display: none }');
    expect(css).toContain('local("Carlito")');
    expect(cssString('a "b"\nc\\d')).toBe('"a \\"b\\"\\A c\\\\d"');
    const fallback = browserPrintCss({ widthMm: 210, heightMm: 297, marginMm: { top: 20, right: 18, bottom: 20, left: 18, header: 8, footer: 8 } }, { titlePage: false, hasPageFields: false }, { marginBoxes: false });
    expect(fallback).not.toContain('@top-left');
  });

  const chromium = (() => {
    try {
      const exe = resolveChromium();
      return exe && existsSync(exe) ? exe : undefined;
    } catch {
      return undefined;
    }
  })();

  it.skipIf(!chromium)(
    'renders filled CCGUK-05: %PDF, stamped author, filled values, PAGE n OF N on page 2, first-page contact block, LibreOffice page count',
    async () => {
      const bytes = new Uint8Array(readFileSync(new URL('../../assets/docx/CCGUK-05-Payment-Authorisation-and-Settlement-Direction.docx', import.meta.url)));
      const now = new Date('2026-10-04T09:30:00Z');
      const filled = fillDocx(
        bytes,
        [
          { slotId: 'title/reference', value: { type: 'text', text: 'CCG-2026-00012' } },
          { slotId: '01-claim-and-client-details/client-full-name', value: { type: 'text', text: 'Jane Quartermaine' } },
          { slotId: '01-claim-and-client-details/registration', value: { type: 'text', text: 'AB12 CDE' } },
          { slotId: '06-client-declaration-and-signature/@client/full-name', value: { type: 'text', text: 'Jane Quartermaine' } }
        ],
        { coreProps: { title: metadata.title, created: now, modified: now }, now }
      );
      expect(filled.report.skipped).toEqual([]);
      const res = await convertDocxToPdf(filled.docx, { workDir: join(work, 'browser'), metadata, converters: [createBrowserConverter()], preference: 'browser' });
      expect(res.converter).toBe('browser');
      expect(res.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect((await PDFDocument.load(res.pdf, { updateMetadata: false })).getAuthor()).toBe('Courtesy Cars Group UK Ltd');
      // LibreOffice reference render: 3 pages; acceptance is within +25 %.
      expect(res.pages).toBeGreaterThanOrEqual(3);
      expect(res.pages).toBeLessThanOrEqual(Math.floor(3 * 1.25));
      const pdfPath = join(work, 'browser-05.pdf');
      writeFileSync(pdfPath, res.pdf);
      const text = (first: number, last: number): string | undefined => {
        const r = spawnSync('pdftotext', ['-f', String(first), '-l', String(last), '-layout', pdfPath, '-'], { encoding: 'utf8' });
        return r.error ? undefined : r.stdout;
      };
      const page1 = text(1, 1);
      if (page1 === undefined) return; // pdftotext not installed: structure checks above still ran
      // First page: the inline first-page header (contact block), no running header.
      expect(page1.replace(/\s+/g, ' ')).toMatch(/case handler 07425 475922/i);
      expect(page1).not.toContain('COURTESY CARS GROUP UK LTD | PAYMENT AUTHORISATION');
      expect(page1).toContain('CCG-2026-00012');
      expect(page1).toContain('Jane Quartermaine');
      expect(page1).toContain('AB12 CDE');
      const page2 = text(2, 2)!;
      expect(page2).toMatch(/PAGE 2 OF \d/);
      expect(page2).toContain('COURTESY CARS GROUP UK LTD | PAYMENT AUTHORISATION');
    },
    120_000
  );

  it.skipIf(!chromium)(
    'falls back to Playwright header/footer templates when margin boxes are unavailable',
    async () => {
      const bytes = new Uint8Array(readFileSync(new URL('../../assets/docx/CCGUK-05-Payment-Authorisation-and-Settlement-Direction.docx', import.meta.url)));
      const res = await convertDocxToPdf(bytes, { workDir: join(work, 'browser-fallback'), metadata, converters: [createBrowserConverter({ forceTemplates: true })] });
      expect(res.converter).toBe('browser');
      expect(res.pages).toBeGreaterThanOrEqual(3);
      const pdfPath = join(work, 'browser-fallback-05.pdf');
      writeFileSync(pdfPath, res.pdf);
      const r = spawnSync('pdftotext', ['-f', '2', '-l', '2', '-layout', pdfPath, '-'], { encoding: 'utf8' });
      if (r.error) return;
      expect(r.stdout).toMatch(/PAGE 2 OF \d/);
    },
    120_000
  );

  it('stampPdfMetadata keeps pages and sets Language en-GB', async () => {
    const { pdf, pages } = await stampPdfMetadata(await tinyPdf(3), { title: 'T' });
    expect(pages).toBe(3);
    const raw = Buffer.from(pdf).toString('latin1');
    expect(raw).toMatch(/\/Lang \(en-GB\)|\/Lang <FEFF/);
  });
});
