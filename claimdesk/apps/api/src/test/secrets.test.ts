/**
 * Secret store (docs/SUPREME-DESIGN.md §K.2): AES-256-GCM round trip off Windows, DPAPI through PowerShell with the
 * payload on stdin (a fake runner stands in for powershell.exe), values never on the command line or in plain files.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretStore, dpapiScript, POWERSHELL_ARGS, secretPresence, type ProcessRunner } from '../services/secrets.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-secrets-'));
  dirs.push(d);
  return d;
}

const SECRET = 'sk-ant-oat01-SECRET-VALUE-do-not-leak';

describe('AES-256-GCM store (dev/CI)', () => {
  it('round-trips, keeps no plaintext on disk, survives a restart, deletes', async () => {
    const h = home();
    const store = createSecretStore({ appHome: h, backend: 'aes' });
    expect(store.has('claude_oauth_token')).toBe(false);
    expect(await store.get('claude_oauth_token')).toBeUndefined();
    await store.set('claude_oauth_token', SECRET);
    expect(store.has('claude_oauth_token')).toBe(true);
    expect(await store.get('claude_oauth_token')).toBe(SECRET);

    const file = path.join(h, 'secrets', 'claude_oauth_token.enc');
    expect(existsSync(file)).toBe(true);
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).not.toContain(Buffer.from(SECRET).toString('base64'));
    const keyFile = path.join(h, 'secret.key');
    expect(readFileSync(keyFile, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') {
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    // A new process (no cache) decrypts with the same key file.
    const again = createSecretStore({ appHome: h, backend: 'aes' });
    expect(await again.get('claude_oauth_token')).toBe(SECRET);
    expect(secretPresence(again)).toMatchObject({ claude_oauth_token: true, imap_password: false });

    // Tampering is detected (GCM tag).
    const parsed = JSON.parse(onDisk) as { data: string };
    const bytes = Buffer.from(parsed.data, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = createSecretStore({ appHome: h, backend: 'aes' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify({ ...parsed, data: bytes.toString('base64') }));
    await expect(tampered.get('claude_oauth_token')).rejects.toThrow();

    await again.delete('claude_oauth_token');
    expect(again.has('claude_oauth_token')).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('uses an existing launcher secret.key and refuses unknown names and empty values', async () => {
    const h = home();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(h, 'secret.key'), 'a'.repeat(64));
    const store = createSecretStore({ appHome: h, backend: 'aes' });
    await store.set('imap_password', 'pw');
    expect(readFileSync(path.join(h, 'secret.key'), 'utf8')).toBe('a'.repeat(64));
    // @ts-expect-error unknown secret name
    expect(() => store.has('database_password')).toThrow(/Unknown secret/);
    await expect(store.set('smtp_password', '')).rejects.toThrow(/required/);
  });
});

describe('DPAPI store (Windows) with a fake PowerShell', () => {
  /** Fake DPAPI: "protect" prefixes the bytes with a marker; "unprotect" strips it. Records every call. */
  function fakePowerShell() {
    const calls: Array<{ command: string; args: readonly string[]; stdin: string }> = [];
    const runner: ProcessRunner = async (command, args, stdin) => {
      calls.push({ command, args, stdin });
      const op = /ProtectedData\]::(Protect|Unprotect)\(/.exec(stdin)?.[1];
      const b64 = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(stdin)?.[1] ?? '';
      const data = Buffer.from(b64, 'base64');
      const marker = Buffer.from('DPAPI:');
      if (op === 'Protect') return { code: 0, stdout: Buffer.concat([marker, data]).toString('base64'), stderr: '' };
      if (op === 'Unprotect' && data.subarray(0, marker.length).equals(marker)) return { code: 0, stdout: data.subarray(marker.length).toString('base64'), stderr: '' };
      return { code: 1, stdout: '', stderr: 'bad' };
    };
    return { calls, runner };
  }

  it('protects through powershell.exe -Command - with the payload on stdin, never in argv', async () => {
    const h = home();
    const ps = fakePowerShell();
    const store = createSecretStore({ appHome: h, backend: 'dpapi', runner: ps.runner });
    await store.set('anthropic_api_key', SECRET);
    const file = path.join(h, 'secrets', 'anthropic_api_key.dpapi');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET);

    // Cached: no second PowerShell call for the same process.
    expect(await store.get('anthropic_api_key')).toBe(SECRET);
    expect(ps.calls).toHaveLength(1);
    // A fresh store unprotects through PowerShell.
    const fresh = createSecretStore({ appHome: h, backend: 'dpapi', runner: ps.runner });
    expect(await fresh.get('anthropic_api_key')).toBe(SECRET);
    expect(ps.calls).toHaveLength(2);

    const b64 = Buffer.from(SECRET).toString('base64');
    for (const c of ps.calls) {
      expect(c.command).toBe('powershell.exe');
      expect(c.args).toEqual(POWERSHELL_ARGS);
      expect(c.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-']);
      const argv = JSON.stringify([c.command, ...c.args]);
      expect(argv).not.toContain(SECRET);
      expect(argv).not.toContain(b64);
      expect(c.stdin).toContain("ClaimDesk/v1/anthropic_api_key");
      expect(c.stdin).toContain('DataProtectionScope]::CurrentUser');
      expect(c.stdin).not.toContain(SECRET);
    }
    expect(ps.calls[0]!.stdin).toContain(b64);
    // No .enc / plaintext files next to the DPAPI blob, and no secret.key needed.
    expect(readdirSync(path.join(h, 'secrets'))).toEqual(['anthropic_api_key.dpapi']);
    expect(existsSync(path.join(h, 'secret.key'))).toBe(false);
  });

  it('a PowerShell failure is an error, not a silent empty secret', async () => {
    const h = home();
    const runner: ProcessRunner = async () => ({ code: 1, stdout: '', stderr: 'DPAPI unavailable' });
    const store = createSecretStore({ appHome: h, backend: 'dpapi', runner });
    await expect(store.set('imap_password', 'pw')).rejects.toThrow(/DPAPI protect failed/);
    expect(store.has('imap_password')).toBe(false);
  });

  it('the script refuses a non-base64 payload (nothing can break out of the quoted string)', () => {
    expect(() => dpapiScript('protect', 'imap_password', "abc'); Remove-Item C:\\ -Recurse; ('")).toThrow(/base64/);
    expect(dpapiScript('unprotect', 'imap_password', 'QUJD')).toContain("FromBase64String('QUJD')");
  });
});
