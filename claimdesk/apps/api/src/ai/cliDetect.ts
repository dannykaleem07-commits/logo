/**
 * Claude Code CLI detection and sign-in check (docs/SUPREME-DESIGN.md §A.2, §A.7, §M.3) — owned by `gateway`.
 *
 * Order: `CLAIMDESK_CLAUDE_PATH` → `%USERPROFILE%\.local\bin\claude.exe` (native installer) → `where.exe claude` (first
 * `.exe` hit only) → `%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe`. A `.cmd`/`.bat` shim is never spawned (Node
 * refuses it without a shell, and a shell would re-open injection). Verified with `claude --version` matching
 * `^(\d+\.\d+\.\d+) \(Claude Code\)`; older than MIN_CLAUDE_CODE_VERSION → a health problem.
 *
 * No model is ever called here: only `--version` and `auth status`. When the process forbids real AI
 * (CLAIMDESK_FORBID_REAL_AI=1) only an injected command or a Node script (`.mjs`/`.js`, the test fake) is executed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const MIN_CLAUDE_CODE_VERSION = '2.1.292';
export const CLAUDE_VERSION_RE = /^(\d+\.\d+\.\d+) \(Claude Code\)/;

/** Environment variables a Claude Code child may inherit (§A.2: an allow-list, never a copy). */
export const CLI_ENV_ALLOWLIST: readonly string[] = [
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

/**
 * The child environment: the allow-list (matched case-insensitively, as Windows does) plus the subscription token,
 * `CLAUDE_CONFIG_DIR=<appHome>/claude-home`, `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
 * `MAX_MCP_OUTPUT_TOKENS=20000`. `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` are never passed (an API key in the environment
 * would silently bill the API instead of the subscription).
 */
export function buildCliEnv(base: NodeJS.ProcessEnv, token: string | undefined, appHome: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const wanted = new Map(CLI_ENV_ALLOWLIST.map((k) => [k.toUpperCase(), k]));
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (wanted.has(k.toUpperCase())) out[k] = v;
  }
  if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token;
  out.CLAUDE_CONFIG_DIR = path.join(appHome, 'claude-home');
  out.DISABLE_AUTOUPDATER = '1';
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  out.MAX_MCP_OUTPUT_TOKENS = '20000';
  for (const k of Object.keys(out)) if (/^ANTHROPIC_/i.test(k) || /^CLAUDE_CODE_USE_/i.test(k)) delete out[k];
  return out;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (command: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string }) => Promise<RunResult>;

/** Default runner: no shell, hidden window, bounded time, output capped at 1 MB. */
export const defaultRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(command, [...args], { shell: false, windowsHide: true, env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      done({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ code: -1, stdout, stderr: `${stderr}\n(timed out)` });
    }, opts.timeoutMs ?? 15_000);
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout = (stdout + d).slice(0, 1_000_000)));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(0, 1_000_000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr });
    });
  });

export interface CliDeps {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  run?: CommandRunner;
  /** Tests / CI: the command standing in for claude.exe, e.g. `[process.execPath, fakeScript]`. */
  claudeCommand?: readonly string[];
  /** Real AI forbidden in this process (default: CLAIMDESK_FORBID_REAL_AI=1 in `env`). */
  forbidRealAi?: boolean;
}

export interface CliDetection {
  /** The executable that was found (for an injected/Node-script command, the script path). */
  path?: string;
  version?: string;
  problems: string[];
  minVersionOk: boolean;
  /** argv prefix to spawn Claude Code (the exe, or `[node, script]`). */
  command?: string[];
}

const isShim = (p: string): boolean => /\.(cmd|bat|ps1)$/i.test(p);
const isNodeScript = (p: string): boolean => /\.(mjs|cjs|js)$/i.test(p);

/** Compare dotted versions numerically (-1, 0, 1). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Parse `claude --version` output. */
export function parseClaudeVersion(stdout: string): string | undefined {
  return CLAUDE_VERSION_RE.exec(stdout.trim())?.[1];
}

/** argv prefix for a found path: Node scripts run under this Node (the test fake); anything else directly. */
export function commandFor(p: string): string[] {
  return isNodeScript(p) ? [process.execPath, p] : [p];
}

/** Candidate paths in the documented order (the `where.exe` hits are resolved by `detectClaudeCli`). */
export function candidatePaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Array<{ source: string; path: string }> {
  const out: Array<{ source: string; path: string }> = [];
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (env.CLAIMDESK_CLAUDE_PATH) out.push({ source: 'CLAIMDESK_CLAUDE_PATH', path: env.CLAIMDESK_CLAUDE_PATH });
  if (platform === 'win32') {
    if (env.USERPROFILE) out.push({ source: 'native installer', path: join(env.USERPROFILE, '.local', 'bin', 'claude.exe') });
  } else if (env.HOME) {
    out.push({ source: 'native installer', path: join(env.HOME, '.local', 'bin', 'claude') });
  }
  return out;
}

/** Detect Claude Code: path, version and problems. Never calls a model. */
export async function detectClaudeCli(env: NodeJS.ProcessEnv = process.env, deps: CliDeps = {}): Promise<CliDetection> {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? defaultRunner;
  const forbid = deps.forbidRealAi ?? env.CLAIMDESK_FORBID_REAL_AI === '1';
  const problems: string[] = [];

  let command: string[] | undefined = deps.claudeCommand ? [...deps.claudeCommand] : undefined;
  let found: string | undefined = command ? command[command.length - 1] : undefined;

  if (!command) {
    const candidates = candidatePaths(env, platform);
    for (const c of candidates) {
      if (isShim(c.path)) {
        problems.push(`${c.source} points at ${path.basename(c.path)}; ClaimDesk never runs .cmd/.bat shims — point it at claude.exe`);
        continue;
      }
      if (exists(c.path)) {
        found = c.path;
        break;
      }
    }
    if (!found && platform === 'win32') {
      const where = await run('where.exe', ['claude'], { timeoutMs: 10_000 });
      const hit = where.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /\.exe$/i.test(l));
      if (hit) found = hit;
      else if (env.LOCALAPPDATA) {
        const winget = path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'claude.exe');
        if (exists(winget)) found = winget;
      }
    }
    if (found) command = commandFor(found);
  }

  if (!command || !found) {
    problems.push('Claude Code is not installed: run `winget install Anthropic.ClaudeCode` (or the native installer), then press Check again');
    return { problems, minVersionOk: false };
  }
  if (forbid && !deps.claudeCommand && !isNodeScript(found)) {
    problems.push('Claude Code checks are disabled in this process (CLAIMDESK_FORBID_REAL_AI=1)');
    return { path: found, problems, minVersionOk: false, command };
  }

  const [cmd, ...pre] = command;
  const res = await run(cmd!, [...pre, '--version'], { timeoutMs: 15_000, env: buildCliEnv(env, undefined, env.CLAIMDESK_HOME ?? path.dirname(found)) });
  const version = parseClaudeVersion(res.stdout);
  if (!version) {
    problems.push(`${found} did not answer --version like Claude Code (exit ${res.code})`);
    return { path: found, problems, minVersionOk: false, command };
  }
  const minVersionOk = compareVersions(version, MIN_CLAUDE_CODE_VERSION) >= 0;
  if (!minVersionOk) problems.push(`Claude Code ${version} is older than the tested minimum ${MIN_CLAUDE_CODE_VERSION}: update Claude Code`);
  return { path: found, version, problems, minVersionOk, command };
}

export interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  problems: string[];
}

/**
 * `claude auth status` with the setup token in the environment (no model call). Expects JSON with
 * `authMethod: "oauth_token"`; anything else is reported as a problem.
 */
export async function claudeAuthStatus(
  command: string | readonly string[],
  token: string | undefined,
  opts: { appHome: string; baseEnv?: NodeJS.ProcessEnv; run?: CommandRunner } = { appHome: process.cwd() },
): Promise<AuthStatus> {
  const argv = typeof command === 'string' ? commandFor(command) : [...command];
  const problems: string[] = [];
  if (!token) problems.push('No Claude sign-in token saved yet: open the sign-in window, then paste the token');
  const run = opts.run ?? defaultRunner;
  const [cmd, ...pre] = argv;
  const res = await run(cmd!, [...pre, 'auth', 'status'], { timeoutMs: 20_000, env: buildCliEnv(opts.baseEnv ?? process.env, token, opts.appHome) });
  const text = res.stdout.trim();
  const start = text.indexOf('{');
  let parsed: Record<string, unknown> | undefined;
  if (start >= 0) {
    try {
      parsed = JSON.parse(text.slice(start)) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed) {
    problems.push(`claude auth status gave no JSON (exit ${res.code})`);
    return { problems };
  }
  const out: AuthStatus = { problems };
  if (typeof parsed.loggedIn === 'boolean') out.loggedIn = parsed.loggedIn;
  if (typeof parsed.authMethod === 'string') out.authMethod = parsed.authMethod;
  if (out.loggedIn === false) problems.push('Claude Code is not signed in with the saved token');
  if (out.authMethod !== 'oauth_token') problems.push(`Claude Code reports sign-in method "${out.authMethod ?? 'unknown'}" — expected the setup token (oauth_token)`);
  return out;
}
