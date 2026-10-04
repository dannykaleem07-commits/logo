import { describe, expect, it } from 'vitest';
import { isLoginPath, loginPath, pathOf, sanitizeNextPath, unauthorizedRedirectTarget } from './auth';

describe('sanitizeNextPath (no open redirects from /login?next=)', () => {
  it('keeps same-origin root-relative paths with their query and hash', () => {
    expect(sanitizeNextPath('/')).toBe('/');
    expect(sanitizeNextPath('/claims')).toBe('/claims');
    expect(sanitizeNextPath('/claims?q=AB12CDE&status=fnol')).toBe('/claims?q=AB12CDE&status=fnol');
    expect(sanitizeNextPath('/claims/c1/ledger#entry-3')).toBe('/claims/c1/ledger#entry-3');
    expect(sanitizeNextPath('/settings')).toBe('/settings');
  });

  it('falls back to the dashboard when there is nothing usable', () => {
    expect(sanitizeNextPath(null)).toBe('/');
    expect(sanitizeNextPath(undefined)).toBe('/');
    expect(sanitizeNextPath('')).toBe('/');
    expect(sanitizeNextPath(`/${'a'.repeat(5000)}`)).toBe('/');
  });

  it('refuses full URLs and other schemes', () => {
    for (const bad of ['https://evil.example/', 'http://evil.example/claims', 'HTTPS://evil.example', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'mailto:x@evil.example', 'evil.example', 'claims', './claims', '../claims']) {
      expect(sanitizeNextPath(bad), bad).toBe('/');
    }
  });

  it('refuses protocol-relative and backslash tricks that browsers treat as another host', () => {
    for (const bad of ['//evil.example', '//evil.example/claims', '///evil.example', '/\\evil.example', '\\\\evil.example', '/\\/evil.example', '/claims\\..\\..\\evil', '\\/evil.example']) {
      expect(sanitizeNextPath(bad), bad).toBe('/');
    }
  });

  it('refuses leading whitespace and control characters (URL parsers strip them)', () => {
    for (const bad of [' /claims', ' //evil.example', '/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', '/claims\u0000', '\u0001/claims']) {
      expect(sanitizeNextPath(bad), JSON.stringify(bad)).toBe('/');
    }
  });

  it('normalises dot segments without ever leaving the origin', () => {
    expect(sanitizeNextPath('/claims/../settings')).toBe('/settings');
    expect(sanitizeNextPath('/./claims')).toBe('/claims');
    expect(sanitizeNextPath('/../../etc/passwd')).toBe('/etc/passwd'); // still an in-app path (renders "Page not found")
    expect(sanitizeNextPath('/%2F%2Fevil.example')).toBe('/%2F%2Fevil.example'); // encoded slashes stay a path, not a host
  });

  it('never sends the user back to /login (no loop)', () => {
    expect(sanitizeNextPath('/login')).toBe('/');
    expect(sanitizeNextPath('/login?next=/claims')).toBe('/');
    expect(sanitizeNextPath('/LOGIN/')).toBe('/');
    expect(sanitizeNextPath('/login-help')).toBe('/login-help');
  });
});

describe('loginPath / unauthorizedRedirectTarget', () => {
  it('carries the current page as an encoded next parameter', () => {
    expect(loginPath('/claims?q=AB12 CDE')).toBe('/login?next=%2Fclaims%3Fq%3DAB12%2520CDE');
    expect(new URLSearchParams(loginPath('/claims/c1/ledger#x').split('?')[1]).get('next')).toBe('/claims/c1/ledger#x');
    expect(loginPath('/settings')).toBe('/login?next=%2Fsettings');
  });
  it('gives a bare /login for the dashboard or an unsafe path', () => {
    expect(loginPath('/')).toBe('/login');
    expect(loginPath(undefined)).toBe('/login');
    expect(loginPath('//evil.example')).toBe('/login');
  });
  it('round-trips: what loginPath puts in next, sanitizeNextPath gives back', () => {
    for (const p of ['/claims', '/claims?status=fnol&q=AB12CDE', '/fleet/penalties', '/claims/c%201/overview']) {
      const next = new URLSearchParams(loginPath(p).split('?')[1]).get('next');
      expect(sanitizeNextPath(next)).toBe(p);
    }
  });
  it('does not redirect while already on the sign-in screen', () => {
    expect(unauthorizedRedirectTarget('/login')).toBeNull();
    expect(unauthorizedRedirectTarget('/login?next=%2Fclaims')).toBeNull();
    expect(unauthorizedRedirectTarget('/claims/c1')).toBe('/login?next=%2Fclaims%2Fc1');
    expect(unauthorizedRedirectTarget('/')).toBe('/login');
  });
  it('isLoginPath and pathOf', () => {
    expect(isLoginPath('/login')).toBe(true);
    expect(isLoginPath('/login#x')).toBe(true);
    expect(isLoginPath('/logins')).toBe(false);
    expect(isLoginPath('/claims')).toBe(false);
    expect(pathOf({ pathname: '/claims', search: '?q=1', hash: '#a' })).toBe('/claims?q=1#a');
    expect(pathOf({ pathname: '/kb' })).toBe('/kb');
  });
});
