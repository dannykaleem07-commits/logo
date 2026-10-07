// owned by runtime
/**
 * Windows toasts without native modules (docs/SUPREME-DESIGN.md §J.1): spawn
 * `powershell.exe -NoProfile -NonInteractive -Command -` and write a script to stdin that loads the WinRT toast types,
 * builds the toast XML and shows it through the AUMID `CCGUK.ClaimDesk` (registered by the installer's Start-menu
 * shortcut). Clicking opens `claimdesk://…`, which the launcher routes to the matching page.
 *
 * Lock-screen rule: toasts carry a reference and a kind only — never names, addresses, phone numbers or emails. The
 * caller passes already-neutral text; `scrubToastText` is a second line of defence.
 */
import { spawn } from 'node:child_process';
import type { Logger } from '../context.js';

export const TOAST_AUMID = 'CCGUK.ClaimDesk';
export const POWERSHELL_ARGS: readonly string[] = ['-NoProfile', '-NonInteractive', '-Command', '-'];

export interface ToastAction {
  label: string;
  /** claimdesk:// URL launched by the button. */
  url: string;
}

export interface ToastInput {
  title: string;
  body: string;
  /** claimdesk:// URL opened when the toast itself is clicked. */
  launch: string;
  actions?: ToastAction[];
}

/** What runs PowerShell: (command, args, stdin) → exit code + stderr. Injectable for tests. */
export type ToastRunner = (command: string, args: readonly string[], stdin: string) => Promise<{ code: number; stderr: string }>;

export interface ShowToastOptions {
  platform?: NodeJS.Platform;
  runner?: ToastRunner;
  logger?: Logger;
  powershellPath?: string;
}

export interface ToastResult {
  shown: boolean;
  reason?: 'not_windows' | 'powershell_failed' | 'disabled' | 'quiet_hours';
  error?: string;
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
export const xmlEscape = (s: string): string => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+?44\s?|\b0)(?:\d[\s-]?){9,10}\b/g;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;
const LONG_DIGITS = /\b\d{6,}\b/g;

/** Remove anything that looks like personal data and keep the line short. */
export function scrubToastText(s: string, max = 90): string {
  const clean = s.replace(EMAIL, '[email]').replace(PHONE, '[phone]').replace(POSTCODE, '[postcode]').replace(LONG_DIGITS, '[number]').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Only claimdesk:// links are ever launched. */
export function claimdeskUrl(path: string): string {
  if (path.startsWith('claimdesk://')) return path;
  return `claimdesk://${path.replace(/^\/+/, '')}`;
}

/** Toast XML (ToastGeneric, protocol activation, Open/Undo-style buttons). */
export function buildToastXml(input: ToastInput): string {
  const launch = xmlEscape(claimdeskUrl(input.launch));
  const actions = (input.actions ?? []).slice(0, 5);
  const actionsXml = actions.length
    ? `<actions>${actions.map((a) => `<action content="${xmlEscape(scrubToastText(a.label, 24))}" activationType="protocol" arguments="${xmlEscape(claimdeskUrl(a.url))}"/>`).join('')}</actions>`
    : '';
  return (
    `<toast activationType="protocol" launch="${launch}">` +
    `<visual><binding template="ToastGeneric"><text>${xmlEscape(scrubToastText(input.title, 60))}</text><text>${xmlEscape(scrubToastText(input.body))}</text></binding></visual>` +
    actionsXml +
    `</toast>`
  );
}

/** The PowerShell script written to stdin (the XML sits in a single-quoted here-string; it never contains a newline). */
export function buildToastScript(xml: string): string {
  if (/[\r\n]/.test(xml)) throw new Error('toast XML must be a single line');
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    "$xml.LoadXml(@'",
    xml,
    "'@)",
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_AUMID}').Show($toast)`,
    '',
  ].join('\r\n');
}

/** Default runner: spawn PowerShell hidden, script on stdin, 20-second limit. */
export const spawnToastRunner: ToastRunner = (command, args, stdin) =>
  new Promise((resolve) => {
    let stderr = '';
    let done = false;
    const finish = (code: number, extra = ''): void => {
      if (done) return;
      done = true;
      resolve({ code, stderr: (stderr + extra).slice(0, 2000) });
    };
    try {
      const child = spawn(command, [...args], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill();
        finish(124, 'timed out');
      }, 20_000);
      timer.unref?.();
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) => finish(127, String(err)));
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code ?? 1);
      });
      child.stdin?.end(stdin, 'utf8');
    } catch (err) {
      finish(127, String(err));
    }
  });

/** Show a toast. Off Windows: a logged no-op (in-app only). */
export async function showToast(input: ToastInput, opts: ShowToastOptions = {}): Promise<ToastResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    opts.logger?.info('toast skipped: not Windows (in-app only)', { launch: claimdeskUrl(input.launch) });
    return { shown: false, reason: 'not_windows' };
  }
  const script = buildToastScript(buildToastXml(input));
  const run = opts.runner ?? spawnToastRunner;
  const res = await run(opts.powershellPath ?? 'powershell.exe', POWERSHELL_ARGS, script);
  if (res.code !== 0) {
    opts.logger?.warn('toast failed (in-app only)', { code: res.code, stderr: res.stderr.slice(0, 300) });
    return { shown: false, reason: 'powershell_failed', error: res.stderr.slice(0, 300) || `exit ${res.code}` };
  }
  return { shown: true };
}
