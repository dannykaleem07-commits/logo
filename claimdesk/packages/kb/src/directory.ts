/**
 * Insurer directory helpers (BLUEPRINT §8 maintenance workflow).
 *
 *  - Records older than 90 days turn amber, older than 180 days red.
 *  - A record nobody has verified on the insurer's own site is never green: 'unverified' is at least amber,
 *    and a record with no verifiedAt at all is red (ARCHITECTURE convention 6; the web screen uses the same light).
 *  - A number that failed on a live call turns the record red until it is used successfully again.
 *  - Copycat claims-management domains and numbers are blacklisted per insurer; `isCopycat` checks a phone
 *    number or domain against every blacklist (digit wildcards 'x' / '*' are allowed in number patterns, e.g.
 *    "0333 006 44xx").
 */
import type { InsurerDirectoryEntry, ISODate } from '@ccguk/domain';
import { loadDirectory } from './load.js';
import type { CopycatMatch, DirectoryAgeing, DirectoryStatus } from './types.js';

export const DIRECTORY_AMBER_DAYS = 90;
export const DIRECTORY_RED_DAYS = 180;

function dateToDays(iso: ISODate): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: ISODate, to: ISODate): number {
  return dateToDays(to) - dateToDays(from);
}

/**
 * Traffic light for a directory record on `today`:
 *  red   — verification.status 'failed', or lastFailed newer than lastUsedOk, or no verifiedAt, or > 180 days old
 *  amber — > 90 days since verifiedAt, or verification.status 'stale' or 'unverified'
 *  green — a 'verified' record checked within the last 90 days
 * An 'unverified' number is also shown with its own warning badge (ARCHITECTURE convention 6); the light never
 * reads green for a number no human has confirmed on the insurer's own site.
 */
export function directoryAgeing(entry: InsurerDirectoryEntry, today: ISODate): DirectoryAgeing {
  const reasons: string[] = [];
  let status: DirectoryStatus = 'green';
  const escalate = (to: DirectoryStatus, reason: string): void => {
    reasons.push(reason);
    if (to === 'red' || (to === 'amber' && status === 'green')) status = to;
  };

  const v = entry.verification;
  const ageDays = v.verifiedAt ? daysBetween(v.verifiedAt, today) : null;

  if (v.status === 'failed') escalate('red', "verification status is 'failed'");
  if (entry.lastFailed && (!entry.lastUsedOk || entry.lastFailed > entry.lastUsedOk)) {
    escalate('red', `last live call failed on ${entry.lastFailed}${entry.lastUsedOk ? ` (last success ${entry.lastUsedOk})` : ''}`);
  }
  if (ageDays === null) escalate('red', 'never verified (no verifiedAt)');
  else if (ageDays > DIRECTORY_RED_DAYS) escalate('red', `verified ${ageDays} days ago (> ${DIRECTORY_RED_DAYS})`);
  else if (ageDays > DIRECTORY_AMBER_DAYS) escalate('amber', `verified ${ageDays} days ago (> ${DIRECTORY_AMBER_DAYS})`);
  if (v.status === 'stale') escalate('amber', "verification status is 'stale'");
  if (v.status === 'unverified') escalate('amber', "not yet verified on the insurer's own site (status 'unverified')");

  return { status, ageDays, reasons, today };
}

export function directoryStatus(entry: InsurerDirectoryEntry, today: ISODate): DirectoryStatus {
  return directoryAgeing(entry, today).status;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface DirectorySearchHit {
  entry: InsurerDirectoryEntry;
  score: number;
  /** 'name' | 'brand' | 'id' | 'group' */
  matchedOn: string;
}

/**
 * Search the directory by insurer or brand name (accent-, case- and punctuation-insensitive). Exact brand or
 * name matches rank first, then prefix matches, then word/substring matches. Empty query → everything.
 */
export function searchDirectory(q: string, directory: readonly InsurerDirectoryEntry[] = loadDirectory()): DirectorySearchHit[] {
  const needle = fold(q);
  if (!needle) return directory.map((entry) => ({ entry, score: 0, matchedOn: 'all' }));
  const hits: DirectorySearchHit[] = [];
  for (const entry of directory) {
    let best = 0;
    let matchedOn = '';
    const consider = (value: string, field: string): void => {
      const f = fold(value);
      if (!f) return;
      let s = 0;
      if (f === needle) s = 100;
      else if (f.startsWith(needle)) s = 80;
      else if (f.split(' ').includes(needle)) s = 60;
      else if (f.includes(needle)) s = 40;
      else if (needle.split(' ').every((w) => w && f.includes(w))) s = 30;
      if (s > best) {
        best = s;
        matchedOn = field;
      }
    };
    consider(entry.name, 'name');
    consider(entry.id.replace(/-/g, ' '), 'id');
    for (const b of entry.brands) consider(b, 'brand');
    if (entry.group) consider(entry.group, 'group');
    if (best > 0) hits.push({ entry, score: best, matchedOn });
  }
  return hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}

// ---------------------------------------------------------------------------
// Copycat detection
// ---------------------------------------------------------------------------

/** Digits only; +44 / 0044 / bare 44 → leading 0; strips (0) and punctuation. Returns '' when there are no digits. */
export function normalisePhone(input: string): string {
  let s = input.trim().replace(/\(0\)/g, '').replace(/[^\d+]/g, '');
  if (s.startsWith('+44')) s = `0${s.slice(3)}`;
  else if (s.startsWith('0044')) s = `0${s.slice(4)}`;
  else if (/^44\d{10}$/.test(s)) s = `0${s.slice(2)}`;
  return s.replace(/\D/g, '');
}

/** Lower-case host name without scheme, credentials, port, path or leading "www.". */
export function normaliseDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^[^/@]*@/, '');
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.split(':')[0] ?? '';
  s = s.replace(/^www\./, '');
  return s.replace(/\.$/, '');
}

function looksLikeDomain(input: string): boolean {
  return /[a-z]/i.test(input) && /\./.test(input);
}

/** A blacklist number pattern ("0333 006 44xx", "03330064*") matched digit-by-digit against a normalised number. */
export function phoneMatchesPattern(normalisedPhone: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/[^\dx*]/g, '').replace(/^\+?44/, '0');
  if (!p) return false;
  if (p.includes('*')) {
    const [head, tail = ''] = p.split('*', 2) as [string, string];
    return normalisedPhone.length >= head.length + tail.length && normalisedPhone.startsWith(head) && normalisedPhone.endsWith(tail);
  }
  if (p.length !== normalisedPhone.length) return false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c !== 'x' && c !== normalisedPhone[i]) return false;
  }
  return true;
}

function domainMatches(host: string, blacklisted: string): boolean {
  const b = normaliseDomain(blacklisted);
  return b !== '' && (host === b || host.endsWith(`.${b}`));
}

/**
 * Test a phone number or a domain / URL / email against every insurer's copycat blacklist. Returns the first
 * match (entry, kind, pattern) or undefined. Treat a match as a hard stop: never dial or email it.
 */
export function isCopycat(phoneOrDomain: string, directory: readonly InsurerDirectoryEntry[] = loadDirectory()): CopycatMatch | undefined {
  const raw = phoneOrDomain.trim();
  if (!raw) return undefined;
  if (looksLikeDomain(raw)) {
    const host = normaliseDomain(raw);
    for (const entry of directory) {
      for (const pattern of entry.copycatDomains) {
        if (domainMatches(host, pattern)) return { entryId: entry.id, name: entry.name, kind: 'domain', pattern, input: host };
      }
    }
    return undefined;
  }
  const phone = normalisePhone(raw);
  if (phone.length < 7) return undefined;
  for (const entry of directory) {
    for (const pattern of entry.copycatNumbers) {
      if (phoneMatchesPattern(phone, pattern)) return { entryId: entry.id, name: entry.name, kind: 'number', pattern, input: phone };
    }
  }
  return undefined;
}

/** The directory record whose published numbers include this phone number (so a call can be attributed). */
export function findByPhone(phone: string, directory: readonly InsurerDirectoryEntry[] = loadDirectory()): InsurerDirectoryEntry | undefined {
  const n = normalisePhone(phone);
  if (!n) return undefined;
  return directory.find((e) => [e.thirdPartyClaimsPhone, e.policyholderClaimsPhone].some((p) => p && normalisePhone(p) === n));
}
