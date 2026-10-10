/**
 * Secret store (docs/SUPREME-DESIGN.md §K.2). Secrets live under `<appHome>/secrets/` — outside DATA_DIR, so data
 * backups never contain them — and the API only ever returns presence flags.
 *
 *  - Windows: DPAPI `CurrentUser` scope through `powershell.exe -NoProfile -NonInteractive -Command -`. The script and
 *    the base64 payload travel on stdin, never on the command line; entropy `ClaimDesk/v1/<name>`; files
 *    `<appHome>/secrets/<name>.dpapi` (base64 of the protected bytes).
 *  - Elsewhere (dev/CI): AES-256-GCM, key derived from `<appHome>/secret.key` (the launcher's 64-hex secret; created
 *    with mode 0600 when missing); files `<appHome>/secrets/<name>.enc`.
 *
 * Decrypted values are cached in memory for the life of the process. The process runner is injectable for tests.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** `fca_handbook_api_key`: the owner's FCA Handbook API key (Knowledge Builder §7.2; optional, DPAPI-encrypted like the rest). */
export type SecretName = 'claude_oauth_token' | 'anthropic_api_key' | 'imap_password' | 'smtp_password' | 'twilio_auth_token' | 'fca_handbook_api_key';
export const SECRET_NAMES: readonly SecretName[] = ['claude_oauth_token', 'anthropic_api_key', 'imap_password', 'smtp_password', 'twilio_auth_token', 'fca_handbook_api_key'];

export interface SecretStore {
  has(n: SecretName): boolean;
  get(n: SecretName): Promise<string | undefined>;
  set(n: SecretName, v: string): Promise<void>;
  delete(n: SecretName): Promise<void>;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `command args…` with `stdin` written to the child's standard input. Never receives a secret in `args`. */
export type ProcessRunner = (command: string, args: readonly string[], stdin: string) => Promise<ProcessResult>;

export const POWERSHELL_ARGS: readonly string[] = ['-NoProfile', '-NonInteractive', '-Command', '-'];

export interface SecretStoreOptions {
  appHome: string;
  /** 'dpapi' on Windows, 'aes' elsewhere (default by platform). */
  backend?: 'dpapi' | 'aes';
  runner?: ProcessRunner;
  powershell?: string;
}

export class SecretStoreError extends Error {
  readonly code = 'SECRET_STORE';
}

function assertName(n: string): asserts n is SecretName {
  if (!(SECRET_NAMES as readonly string[]).includes(n)) throw new SecretStoreError(`Unknown secret name ${n}`);
}

/** Default runner: spawn without a shell, hidden window, stdin piped. */
export const spawnRunner: ProcessRunner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin);
  });

/** PowerShell script for DPAPI Protect/Unprotect. `name` is from the closed SECRET_NAMES set; `b64` is base64 only. */
export function dpapiScript(op: 'protect' | 'unprotect', name: SecretName, b64: string): string {
  if (!/^[A-Za-z0-9+/=]*$/.test(b64)) throw new SecretStoreError('payload is not base64');
  const fn = op === 'protect' ? 'Protect' : 'Unprotect';
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    `$entropy = [System.Text.Encoding]::UTF8.GetBytes('ClaimDesk/v1/${name}')`,
    `$data = [Convert]::FromBase64String('${b64}')`,
    `$out = [System.Security.Cryptography.ProtectedData]::${fn}($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
    'exit 0',
    '',
  ].join('\r\n');
}

function writePrivate(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: ACLs, not modes */
  }
}

/** The AES key: sha256 of the launcher secret (created with 0600 when missing). */
export function loadOrCreateSecretKey(appHome: string): Buffer {
  const file = path.join(appHome, 'secret.key');
  let secret = '';
  try {
    secret = readFileSync(file, 'utf8').trim();
  } catch {
    /* missing */
  }
  if (secret.length < 32) {
    secret = randomBytes(32).toString('hex');
    mkdirSync(appHome, { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
  }
  return createHash('sha256').update(`ClaimDesk/secrets/v1:${secret}`).digest();
}

interface AesFile {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

export function createSecretStore(options: SecretStoreOptions): SecretStore {
  const backend = options.backend ?? (process.platform === 'win32' ? 'dpapi' : 'aes');
  const dir = path.join(options.appHome, 'secrets');
  const ext = backend === 'dpapi' ? '.dpapi' : '.enc';
  const fileOf = (n: SecretName): string => path.join(dir, `${n}${ext}`);
  const runner = options.runner ?? spawnRunner;
  const ps = options.powershell ?? 'powershell.exe';
  const cache = new Map<SecretName, string>();
  let key: Buffer | undefined;
  const aesKey = (): Buffer => (key ??= loadOrCreateSecretKey(options.appHome));

  async function dpapi(op: 'protect' | 'unprotect', n: SecretName, b64: string): Promise<string> {
    const r = await runner(ps, POWERSHELL_ARGS, dpapiScript(op, n, b64));
    const out = r.stdout.trim();
    if (r.code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(out)) throw new SecretStoreError(`DPAPI ${op} failed for ${n} (exit ${r.code})`);
    return out;
  }

  return {
    has(n) {
      assertName(n);
      return cache.has(n) || existsSync(fileOf(n));
    },
    async get(n) {
      assertName(n);
      const hit = cache.get(n);
      if (hit !== undefined) return hit;
      const file = fileOf(n);
      if (!existsSync(file)) return undefined;
      let value: string;
      if (backend === 'dpapi') {
        const plainB64 = await dpapi('unprotect', n, readFileSync(file, 'utf8').trim());
        value = Buffer.from(plainB64, 'base64').toString('utf8');
      } else {
        const f = JSON.parse(readFileSync(file, 'utf8')) as AesFile;
        const decipher = createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(f.iv, 'base64'));
        decipher.setAAD(Buffer.from(`ClaimDesk/v1/${n}`, 'utf8'));
        decipher.setAuthTag(Buffer.from(f.tag, 'base64'));
        value = Buffer.concat([decipher.update(Buffer.from(f.data, 'base64')), decipher.final()]).toString('utf8');
      }
      cache.set(n, value);
      return value;
    },
    async set(n, v) {
      assertName(n);
      if (typeof v !== 'string' || !v.length) throw new SecretStoreError('A secret value is required');
      if (backend === 'dpapi') {
        const protectedB64 = await dpapi('protect', n, Buffer.from(v, 'utf8').toString('base64'));
        writePrivate(fileOf(n), protectedB64);
      } else {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
        cipher.setAAD(Buffer.from(`ClaimDesk/v1/${n}`, 'utf8'));
        const data = Buffer.concat([cipher.update(v, 'utf8'), cipher.final()]);
        const f: AesFile = { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
        writePrivate(fileOf(n), JSON.stringify(f));
      }
      cache.set(n, v);
    },
    async delete(n) {
      assertName(n);
      cache.delete(n);
      rmSync(fileOf(n), { force: true });
    },
  };
}

/** Presence flags only — the API never returns a secret value. */
export function secretPresence(store: SecretStore): Record<SecretName, boolean> {
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, store.has(n)])) as Record<SecretName, boolean>;
}
