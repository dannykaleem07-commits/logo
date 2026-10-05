/**
 * Insurer / authority directory presentation (pure; unit-tested). BLUEPRINT §8 maintenance workflow:
 *  - each record carries source URL, "last verified" date and verifier;
 *  - records older than 90 days turn amber, older than 180 days red;
 *  - a number that fails on a live call is reported and the record goes red;
 *  - copycat claims-management domains and numbers are listed as warnings.
 * Verification is data (ARCHITECTURE convention 6): nothing here changes a status — only PATCH /directory/:id/verify
 * with a source URL does, and that is a person's act.
 */
import type { InsurerDirectoryEntry, ISODate } from '@ccguk/domain';
import { daysBetween } from '../../lib/dates';
import type { Tone } from '../../lib/status';

export const DIRECTORY_AMBER_DAYS = 90;
export const DIRECTORY_RED_DAYS = 180;

export const UNVERIFIED_WARNING = "UNVERIFIED — confirm on the insurer's site before use";

export interface DirectoryStatus {
  tone: Tone;
  label: string;
  /** Plain-English line for the card; undefined when nothing needs saying. */
  warning?: string;
  ageDays?: number;
}

/** Green / amber / red by verification status and age (90 / 180 days). */
export function directoryStatus(entry: Pick<InsurerDirectoryEntry, 'verification' | 'lastFailed' | 'lastUsedOk'>, today: ISODate): DirectoryStatus {
  const v = entry.verification;
  if (v.status === 'failed') return { tone: 'red', label: 'Failed', warning: `A number on this record failed on a live call${entry.lastFailed ? ` (${entry.lastFailed})` : ''} — confirm on the insurer's site before use.` };
  if (v.status === 'unverified' || !v.verifiedAt) return { tone: 'amber', label: 'Unverified', warning: UNVERIFIED_WARNING };
  const ageDays = daysBetween(v.verifiedAt, today);
  if (v.status === 'stale' || ageDays > DIRECTORY_RED_DAYS) return { tone: 'red', label: 'Stale', warning: `Last verified ${ageDays} days ago (over ${DIRECTORY_RED_DAYS}) — re-verify before use.`, ageDays };
  if (ageDays > DIRECTORY_AMBER_DAYS) return { tone: 'amber', label: `Verified ${ageDays}d ago`, warning: `Verified over ${DIRECTORY_AMBER_DAYS} days ago — worth a re-check.`, ageDays };
  return { tone: 'green', label: `Verified ${ageDays}d ago`, ageDays };
}

/** "Press 2, then 3" style line from the stored IVR path ("Option 2 → Option 3 (third party)"). */
export function ivrPressLine(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const steps = path
    .split(/→|->|,|then/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/(\d+)/);
      const note = s.replace(/option\s*\d+|press\s*\d+|\d+/gi, '').replace(/[()]/g, '').trim();
      return m ? `press ${m[1]}${note ? ` (${note})` : ''}` : s;
    });
  return steps.length ? steps.join(', then ') : path;
}

/** Text for the "copy for call" button: name, third-party number, IVR path and hours — nothing else. */
export function copyForCallText(entry: InsurerDirectoryEntry): string {
  const lines = [entry.name];
  if (entry.thirdPartyClaimsPhone) lines.push(`Third-party claims: ${entry.thirdPartyClaimsPhone}`);
  else if (entry.policyholderClaimsPhone) lines.push(`Claims (policyholder line, no separate third-party line published): ${entry.policyholderClaimsPhone}`);
  const ivr = ivrPressLine(entry.thirdPartyIvrPath);
  if (ivr) lines.push(`IVR: ${ivr}`);
  if (entry.openingHours) lines.push(`Hours: ${entry.openingHours}`);
  if (entry.verification.status !== 'verified') lines.push(UNVERIFIED_WARNING);
  return lines.join('\n');
}

export function hasCopycats(entry: Pick<InsurerDirectoryEntry, 'copycatDomains' | 'copycatNumbers'>): boolean {
  return (entry.copycatDomains?.length ?? 0) > 0 || (entry.copycatNumbers?.length ?? 0) > 0;
}

/** Client-side filter mirroring the API search (name, brands, group, phones) so typing feels instant. */
export function filterDirectory(entries: InsurerDirectoryEntry[], q: string): InsurerDirectoryEntry[] {
  const term = q.trim().toLowerCase();
  if (!term) return entries;
  const digits = term.replace(/\D/g, '');
  return entries.filter((e) => {
    const hay = [e.name, e.group ?? '', ...(e.brands ?? [])].join(' ').toLowerCase();
    if (hay.includes(term)) return true;
    if (digits.length >= 4) {
      for (const p of [e.thirdPartyClaimsPhone, e.policyholderClaimsPhone]) if (p && p.replace(/\D/g, '').includes(digits)) return true;
    }
    return false;
  });
}

export const DIRECTORY_FIELDS: Array<{ value: keyof InsurerDirectoryEntry; label: string }> = [
  { value: 'thirdPartyClaimsPhone', label: 'Third-party claims phone' },
  { value: 'thirdPartyIvrPath', label: 'IVR path' },
  { value: 'policyholderClaimsPhone', label: 'Policyholder claims phone' },
  { value: 'claimsEmail', label: 'Claims email' },
  { value: 'thirdPartyEmail', label: 'Third-party email' },
  { value: 'complaintsEmail', label: 'Complaints email' },
  { value: 'portalUrl', label: 'Portal' },
  { value: 'postalAddress', label: 'Postal address' },
  { value: 'openingHours', label: 'Opening hours' }
];

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Cards with a published third-party claims number first (that is the number a handler dials), then by name. */
export function sortDirectory<T extends Pick<InsurerDirectoryEntry, 'name' | 'thirdPartyClaimsPhone'>>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => Number(Boolean(b.thirdPartyClaimsPhone)) - Number(Boolean(a.thirdPartyClaimsPhone)) || a.name.localeCompare(b.name, 'en-GB'));
}

/**
 * The status banner shown on a compact card: only for a failed or stale record (red — do not dial without checking).
 * Unverified and ageing records rely on the badge (and its tooltip) alone, so the warning is not said twice.
 */
export function cardBanner(status: DirectoryStatus): string | undefined {
  return status.tone === 'red' ? status.warning : undefined;
}

/** Whether the closed "More about this insurer" section has anything in it beyond the verification line. */
export function hasMoreDetails(entry: InsurerDirectoryEntry): boolean {
  return Boolean(
    entry.brands?.length || entry.policyholderClaimsPhone || entry.thirdPartyEmail || entry.claimsEmail || entry.complaintsEmail || entry.postalAddress || entry.group || entry.verification.sourceNote || entry.notes
  );
}
