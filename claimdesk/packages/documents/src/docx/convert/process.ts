/**
 * Spawn with timeout + kill helper shared by the Word and LibreOffice converters (§A.11).
 * `spawn` is injectable so tests can assert arguments and simulate hangs without running anything.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

export interface ChildLike {
  pid?: number | undefined;
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildLike;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export interface RunOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  /** Called once when the timeout fires, before the process tree is killed (e.g. to kill WINWORD.EXE). */
  onTimeout?: (child: ChildLike) => Promise<void> | void;
  /** Tree killer (tests inject a fake). */
  killTree?: (child: ChildLike, platform: NodeJS.Platform) => Promise<void>;
}

export const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options) as unknown as ChildLike;

/** Kill a process and its children: taskkill /T /F on Windows, the process group on POSIX. */
export async function killProcessTree(child: ChildLike, platform: NodeJS.Platform = process.platform, spawn: SpawnFn = defaultSpawn): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on('exit', () => resolve());
        k.on('error', () => resolve());
      } catch {
        resolve();
      }
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

export function runProcess(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const platform = opts.platform ?? process.platform;
  const started = Date.now();
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildLike;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void (async () => {
        try {
          await opts.onTimeout?.(child);
        } finally {
          await (opts.killTree ?? ((c, p) => killProcessTree(c, p, spawn)))(child, platform);
        }
      })();
    }, opts.timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    });
  });
}
