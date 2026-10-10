/**
 * SubscriptionCliDriver (docs/SUPREME-DESIGN.md §A.2) — owned by `gateway`. Runs Claude Code headless on the owner's
 * subscription (`claude -p`, signed in with the long-lived setup token), with ClaimDesk's tools served over MCP at
 * `/api/mcp` and a per-run bearer token.
 *
 * Exact spawn (never `--bare`, which ignores OAuth): see `buildCliArgs`. The prompt goes to stdin (no 32,767-character
 * Windows command-line limit); cwd is the empty run dir; the environment is an allow-list (`buildCliEnv`) so an
 * `ANTHROPIC_API_KEY` in the parent can never bill the API. `mcp.json` (mode 0600) is deleted at the end of the run.
 * Timeout / cancel kill the whole tree by PID (Windows `taskkill /PID <pid> /T /F`; POSIX the process group).
 *
 * Real AI guard: the constructor throws REAL_AI_FORBIDDEN when `ctx.config.forbidRealAi`; and while the process
 * environment says CLAIMDESK_FORBID_REAL_AI=1 only an injected command or a Node-script fake is ever spawned.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import type { AiDriver, AiRunOutcome, AiRunRequest, DriverHealth, RateLimitSnapshot, ToolExecutor } from './types.js';
import { buildCliEnv, claudeAuthStatus, detectClaudeCli, type CliDeps, type CommandRunner } from './cliDetect.js';
import { MCP_SERVER_NAME, StreamJsonParser } from './streamJson.js';

export { buildCliEnv, CLI_ENV_ALLOWLIST } from './cliDetect.js';

export class RealAiForbiddenError extends Error {
  readonly code = 'REAL_AI_FORBIDDEN';
  constructor(what: string) {
    super(`${what} cannot run here: real AI is forbidden in this process (CLAIMDESK_FORBID_REAL_AI=1)`);
  }
}

/** A ToolExecutor that also carries the run's bearer token (built by runAgent; the CLI writes it into mcp.json). */
export interface TokenCarrier {
  readonly runToken?: string;
}

/** `mcp__claimdesk__<tool>` — how a ClaimDesk tool appears to the CLI. */
export const mcpToolName = (tool: string): string => `mcp__${MCP_SERVER_NAME}__${tool}`;

/** `WebFetch(domain:<d>)` permission rules for plain host names (KB §7.8); anything that is not a host name is dropped. */
export function webFetchRules(domains: readonly string[]): string[] {
  const ok = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;
  return [...new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => ok.test(d)))].map((d) => `WebFetch(domain:${d})`);
}

/** The exact argument list (§A.2), after the executable. `files.mcpConfig` is omitted when the run has no tools. */
export function buildCliArgs(req: AiRunRequest, files: { mcpConfig?: string; systemPrompt: string }): string[] {
  const args = ['-p', '--restricted', '--strict-mcp-config'];
  if (files.mcpConfig && req.tools.length) args.push('--mcp-config', files.mcpConfig);
  if (req.web) {
    // Knowledge Builder web research (KB §7.8): WebFetch only, restricted to the allow-list; never WebSearch, Read,
    // Write or Bash. Deny and copycat domains are also listed in --disallowedTools.
    args.push('--tools', 'WebFetch');
    const allowed = [...req.tools.map(mcpToolName), ...webFetchRules(req.web.fetchDomains)];
    if (allowed.length) args.push('--allowedTools', ...allowed);
    const denied = webFetchRules(req.web.denyDomains);
    if (denied.length) args.push('--disallowedTools', ...denied);
  } else {
    args.push('--tools', req.allowRead ? 'Read' : '');
    const allowed = [...req.tools.map(mcpToolName), ...(req.allowRead ? ['Read'] : [])];
    if (allowed.length) args.push('--allowedTools', ...allowed);
  }
  args.push(
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--max-turns',
    String(req.maxTurns),
    '--model',
    req.model,
    '--effort',
    req.effort,
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(req.resultSchema),
    '--system-prompt-file',
    files.systemPrompt,
  );
  return args;
}

/** The per-run MCP client config: one HTTP server, the run token as a bearer header. */
export function mcpConfigJson(mcpUrl: string, runToken: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${runToken}` } } } });
}

/** Kill a process tree by PID (never by name). */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    try {
      spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // the child leads its own process group (spawned detached on POSIX)
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export interface SubscriptionCliDriverOptions {
  /** argv prefix standing in for claude.exe (tests: `[process.execPath, fakeScript]`). Default: detected. */
  claudeCommand?: readonly string[];
  /** MCP endpoint URL (default `http://127.0.0.1:<config.port>/api/mcp`). */
  mcpUrl?: string | (() => string);
  /** Parent environment the allow-list is taken from (default process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Detection/auth-check runner (tests). */
  run?: CommandRunner;
  /** Rate-limit snapshots as they arrive (besides ai_usage_state). */
  onRateLimit?: (s: RateLimitSnapshot) => void;
}

/** Store a rate-limit snapshot in ai_usage_state as it arrives (§A.2 "push it to the supervisor immediately"). */
export function recordRateLimit(ctx: AppContext, driver: string, snap: RateLimitSnapshot): void {
  try {
    const t = snap.type ?? 'five_hour';
    const now = ctx.now();
    if (t === 'five_hour') ctx.repos.setAiUsageSnapshot(ctx.db, { driver, fiveHour: snap, now });
    else if (t.startsWith('seven_day')) ctx.repos.setAiUsageSnapshot(ctx.db, { driver, sevenDay: snap, now });
    else ctx.repos.setAiUsageSnapshot(ctx.db, { driver, now });
  } catch (err) {
    ctx.logger.warn('could not store a rate-limit snapshot', { error: String(err) });
  }
}

export class SubscriptionCliDriver implements AiDriver {
  readonly kind = 'subscription_cli' as const;
  /** PID of the most recent child (tests check it was killed). */
  lastPid: number | undefined;
  /** The last ≤ 200 stream lines of the most recent run (for the run record; may contain claim text). */
  lastLines: string[] = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: SubscriptionCliDriverOptions = {},
  ) {
    if (ctx.config.forbidRealAi) throw new RealAiForbiddenError('The subscription (Claude Code) driver');
  }

  private get baseEnv(): NodeJS.ProcessEnv {
    return this.opts.baseEnv ?? process.env;
  }

  private cliDeps(): CliDeps {
    const forbidRealAi = process.env.CLAIMDESK_FORBID_REAL_AI === '1' || this.baseEnv.CLAIMDESK_FORBID_REAL_AI === '1';
    return { forbidRealAi, ...(this.opts.platform ? { platform: this.opts.platform } : {}), ...(this.opts.run ? { run: this.opts.run } : {}), ...(this.opts.claudeCommand ? { claudeCommand: this.opts.claudeCommand } : {}) };
  }

  private mcpUrl(): string {
    const u = this.opts.mcpUrl;
    if (typeof u === 'function') return u();
    return u ?? `http://127.0.0.1:${this.ctx.config.port}/api/mcp`;
  }

  async health(): Promise<DriverHealth> {
    const det = await detectClaudeCli(this.baseEnv, this.cliDeps());
    const problems = [...det.problems];
    const token = await this.ctx.secrets.get('claude_oauth_token');
    const cli: NonNullable<DriverHealth['cli']> = { minVersionOk: det.minVersionOk };
    if (det.path) cli.path = det.path;
    if (det.version) cli.version = det.version;
    if (det.command && det.version) {
      const auth = await claudeAuthStatus(det.command, token, { appHome: this.ctx.config.appHome, baseEnv: this.baseEnv, ...(this.opts.run ? { run: this.opts.run } : {}) });
      if (auth.authMethod) cli.authMethod = auth.authMethod;
      if (auth.loggedIn !== undefined) cli.loggedIn = auth.loggedIn;
      problems.push(...auth.problems.filter((p) => !problems.includes(p)));
    } else if (!token) {
      problems.push('No Claude sign-in token saved yet: open the sign-in window, then paste the token');
    }
    const ready = Boolean(det.path && det.version && det.minVersionOk && token && cli.authMethod === 'oauth_token' && cli.loggedIn !== false);
    return { kind: this.kind, ready, problems, cli };
  }

  async run(req: AiRunRequest, tools: ToolExecutor, signal: AbortSignal): Promise<AiRunOutcome> {
    const started = Date.now();
    const platform = this.opts.platform ?? process.platform;
    let command = this.opts.claudeCommand ? [...this.opts.claudeCommand] : undefined;
    if (!command) {
      const det = await detectClaudeCli(this.baseEnv, this.cliDeps());
      if (!det.command || !det.version) return { kind: 'error', retryable: false, code: 'CLI_NOT_FOUND', message: det.problems.join('; ') || 'Claude Code was not found' };
      if (!det.minVersionOk) return { kind: 'error', retryable: false, code: 'claude_code_version_too_old', message: det.problems.join('; ') };
      command = det.command;
    }
    const injected = Boolean(this.opts.claudeCommand);
    const scriptOnly = command.length > 1 && /\.(mjs|cjs|js)$/i.test(command[command.length - 1]!);
    if ((process.env.CLAIMDESK_FORBID_REAL_AI === '1' || this.baseEnv.CLAIMDESK_FORBID_REAL_AI === '1') && !injected && !scriptOnly) {
      return { kind: 'error', retryable: false, code: 'REAL_AI_FORBIDDEN', message: new RealAiForbiddenError('Claude Code').message };
    }
    const runToken = (tools as ToolExecutor & TokenCarrier).runToken;
    if (req.tools.length && !runToken) return { kind: 'error', retryable: false, code: 'NO_RUN_TOKEN', message: 'The run has tools but no run token for the MCP endpoint' };

    mkdirSync(req.runDir, { recursive: true });
    const systemPrompt = path.join(req.runDir, 'system.md');
    writeFileSync(systemPrompt, req.system.map((b) => b.text.trim()).join('\n\n') + '\n', 'utf8');
    let mcpConfig: string | undefined;
    if (req.tools.length && runToken) {
      mcpConfig = path.join(req.runDir, 'mcp.json');
      writeFileSync(mcpConfig, mcpConfigJson(this.mcpUrl(), runToken), { encoding: 'utf8', mode: 0o600 });
      try {
        chmodSync(mcpConfig, 0o600);
      } catch {
        /* Windows: ACLs, not modes */
      }
    }
    const token = await this.ctx.secrets.get('claude_oauth_token');
    const env = buildCliEnv(this.baseEnv, token, this.ctx.config.appHome);
    const args = buildCliArgs(req, { ...(mcpConfig ? { mcpConfig } : {}), systemPrompt });
    const [cmd, ...pre] = command;

    try {
      return await new Promise<AiRunOutcome>((resolve) => {
        let timedOut = false;
        let stderr = '';
        const parser = new StreamJsonParser({
          requireMcp: req.tools.length > 0,
          onRateLimit: (s) => {
            recordRateLimit(this.ctx, this.kind, s);
            this.opts.onRateLimit?.(s);
          },
          onFatal: () => killTree(child, platform),
        });
        const child = spawn(cmd!, [...pre, ...args], { cwd: req.runDir, env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        this.lastPid = child.pid;
        const stop = () => {
          timedOut = true;
          killTree(child, platform);
        };
        const timer = setTimeout(stop, Math.max(1, req.timeoutMs));
        const onAbort = () => stop();
        if (signal.aborted) stop();
        else signal.addEventListener('abort', onAbort, { once: true });
        child.stdout.setEncoding('utf8').on('data', (d: string) => parser.push(d));
        child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-20_000)));
        child.stdin.on('error', () => {
          /* the child exited before reading the prompt: reported by its exit */
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve({ kind: 'error', retryable: false, code: 'SPAWN_FAILED', message: `Could not start Claude Code: ${String(err)}` });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          parser.end();
          this.lastLines = [...parser.lines];
          resolve(parser.outcome({ model: req.model, durationMs: Date.now() - started, exitCode: code, stderr, timedOut }));
        });
        child.stdin.end(req.user, 'utf8');
      });
    } finally {
      if (mcpConfig) rmSync(mcpConfig, { force: true });
    }
  }
}
