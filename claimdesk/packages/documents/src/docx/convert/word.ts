/**
 * Microsoft Word via PowerShell COM (§A.11.2) — preferred when installed (exact pagination, fonts, PAGE x OF y).
 *
 * Conversions run one at a time. Macros are force-disabled (AutomationSecurity 3) whatever the file says. On timeout
 * the PowerShell process tree is killed and then the Word this conversion started (its PID is recorded by the script);
 * if no PID was recorded yet, only WINWORD.EXE processes that appeared during this run and were started for automation
 * (`/Automation` or `-Embedding`) are killed — never a Word the user has open.
 */
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ConverterStatus, DocxPdfConverter } from '../types.js';
import { defaultSpawn, runProcess, type RunResult, type SpawnFn } from './process.js';

export const WORD_CONVERT_SCRIPT = `param([string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
$before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
# the Word started for this conversion (so a timeout kills that one only, never another conversion's or the user's)
$mine = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
if ($mine.Count -eq 1) { Set-Content -LiteralPath ($Out + '.wordpid') -Value $mine[0] -Encoding ascii }
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0                      # wdAlertsNone
  $word.AutomationSecurity = 3                 # msoAutomationSecurityForceDisable: no macros, whatever the file says
  $word.Options.UpdateLinksAtOpen = $false
  $m = [Type]::Missing
  # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, …, Visible, OpenAndRepair, DocumentDirection, NoEncodingDialog
  $doc = $word.Documents.Open($In, $false, $true, $false, $m, $m, $m, $m, $m, $m, $m, $false, $false, $m, $true)
  $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 0, 0, 0, $true, $true, 0, $true, $true, $false)  # wdExportFormatPDF; DocStructureTags; BitmapMissingFonts
  $doc.Close(0)
} finally {
  $word.Quit(0)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
`;

export const WORD_DETECT_COMMAND = "[type]::GetTypeFromProgID('Word.Application') -ne $null";

const LIST_WINWORD =
  "Get-CimInstance Win32_Process -Filter \"Name='WINWORD.EXE'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";

export interface WordProcess {
  pid: number;
  commandLine: string;
}

/** PIDs to kill after a timeout: started during this run AND started for automation. */
export function selectWordPidsToKill(before: ReadonlySet<number>, after: readonly WordProcess[]): number[] {
  return after.filter((p) => !before.has(p.pid) && /(\/Automation|-Embedding)\b/i.test(p.commandLine)).map((p) => p.pid);
}

export function wordDetectArgs(): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', WORD_DETECT_COMMAND];
}

export function wordConvertArgs(scriptPath: string, docxPath: string, pdfPath: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-In', docxPath, '-Out', pdfPath];
}

export function parseWordProcessList(json: string): WordProcess[] {
  const t = json.trim();
  if (!t) return [];
  try {
    const v = JSON.parse(t) as unknown;
    const arr = Array.isArray(v) ? v : [v];
    return arr
      .map((x) => x as { ProcessId?: number; CommandLine?: string | null })
      .filter((x) => typeof x.ProcessId === 'number')
      .map((x) => ({ pid: x.ProcessId as number, commandLine: x.CommandLine ?? '' }));
  } catch {
    return [];
  }
}

export interface WordConverterOptions {
  workDir: string;
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  powershell?: string;
  /** Running WINWORD.EXE processes (tests inject a fake). */
  listWordProcesses?: () => Promise<WordProcess[]>;
  /** Kill one PID (tests inject a fake). */
  killPid?: (pid: number) => Promise<void>;
  /** Tree killer for the PowerShell process (tests inject a fake). */
  killTree?: Parameters<typeof runProcess>[2]['killTree'];
}

export function createWordConverter(opts: WordConverterOptions): DocxPdfConverter {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? defaultSpawn;
  const ps = opts.powershell ?? 'powershell.exe';
  const run = (args: string[], timeoutMs: number, extra?: Partial<Parameters<typeof runProcess>[2]>): Promise<RunResult> =>
    runProcess(ps, args, { timeoutMs, spawn, platform, ...(opts.killTree ? { killTree: opts.killTree } : {}), ...extra });

  const listWordProcesses =
    opts.listWordProcesses ??
    (async (): Promise<WordProcess[]> => {
      try {
        const r = await run(['-NoProfile', '-NonInteractive', '-Command', LIST_WINWORD], 20_000);
        return parseWordProcessList(r.stdout);
      } catch {
        return [];
      }
    });
  const killPid =
    opts.killPid ??
    (async (pid: number): Promise<void> => {
      await runProcess('taskkill', ['/PID', String(pid), '/F'], { timeoutMs: 10_000, spawn, platform }).catch(() => undefined);
    });

  let queue: Promise<unknown> = Promise.resolve();

  return {
    id: 'word',
    async detect(): Promise<ConverterStatus> {
      if (platform !== 'win32') return { ok: false, detail: 'Microsoft Word is only used on Windows' };
      try {
        const r = await run(wordDetectArgs(), 30_000);
        if (r.stdout.trim() === 'True') return { ok: true, detail: 'Microsoft Word (COM automation)', path: ps };
        return { ok: false, detail: 'Microsoft Word is not installed' };
      } catch (err) {
        return { ok: false, detail: `PowerShell unavailable: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    // One Word conversion at a time: Word automation is not built for parallel instances, and a timeout must only
    // ever stop the Word this conversion started.
    async convert(input): Promise<string> {
      const next = queue.then(() => convertOne(input));
      queue = next.catch(() => undefined);
      return next;
    }
  };

  async function convertOne({ docxPath, outDir, timeoutMs }: { docxPath: string; outDir: string; timeoutMs: number }): Promise<string> {
    {
      await mkdir(opts.workDir, { recursive: true });
      await mkdir(outDir, { recursive: true });
      const scriptPath = join(opts.workDir, 'convert.ps1');
      await writeFile(scriptPath, WORD_CONVERT_SCRIPT, 'utf8');
      const pdfPath = join(outDir, `${basename(docxPath, extname(docxPath))}.pdf`);
      const before = new Set((await listWordProcesses()).map((p) => p.pid));
      const pidFile = `${pdfPath}.wordpid`;
      const r = await run(wordConvertArgs(scriptPath, docxPath, pdfPath), timeoutMs, {
        onTimeout: async () => {
          // the PID the script recorded for its own Word; else (not recorded yet) the automation Words started since
          const own = await readFile(pidFile, 'utf8').then((t) => Number(t.trim())).catch(() => NaN);
          if (Number.isInteger(own) && own > 0) await killPid(own);
          else for (const pid of selectWordPidsToKill(before, await listWordProcesses())) await killPid(pid);
        }
      });
      await rm(pidFile, { force: true }).catch(() => undefined);
      if (r.timedOut) throw new Error(`Microsoft Word did not finish within ${Math.round(timeoutMs / 1000)} s`);
      if (r.code !== 0) throw new Error(`Microsoft Word conversion failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
      try {
        await access(pdfPath);
      } catch {
        throw new Error('Microsoft Word reported success but wrote no PDF');
      }
      return pdfPath;
    }
  }
}
