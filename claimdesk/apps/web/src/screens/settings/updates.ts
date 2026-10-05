/**
 * Settings → Updates and the side-bar "Update available" link (docs/V03-MANAGER-MODE-HIRE-PRICING.md §F.3). Pure
 * wording and formatting; times are shown in Europe/London.
 */
import type { UpdateCheck } from '../../api/updatesApi';
import { versionLabel } from './settings';

const LONDON = 'Europe/London';

/** "Installed: ClaimDesk 0.3.12". */
export function installedText(current: string | undefined): string {
  return `Installed: ${versionLabel(current)}`;
}

/** "10:42" (Europe/London). */
export function checkedTime(iso: string | undefined): string {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/** "12 Oct" (Europe/London). */
export function publishedDay(iso: string | undefined): string {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, day: 'numeric', month: 'short' }).format(d);
}

/** 44 040 192 → "42 MB"; under a megabyte → "820 KB". */
export function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "Download ClaimDesk-Setup-0.3.15.exe (42 MB)". */
export function downloadLabel(download: { name: string; size?: number }): string {
  const size = formatSize(download.size);
  return `Download ${download.name}${size ? ` (${size})` : ''}`;
}

/** Release notes as plain text: Markdown emphasis, headings, links and list markers removed. */
const HTML_TAG = /<\/?(?:br|p|div|span|details|summary|a|img|b|i|em|strong|code|pre|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|hr|sub|sup)\b[^>]*>/gi;
const BLOCK_START = /^[ \t]*(?:$|#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|\||>|```)/;

/** Markdown table rows → "cell — cell"; the |---| separator row goes. */
function tableRow(line: string): string | undefined {
  const t = line.trim();
  if (!t.startsWith('|')) return undefined;
  if (/^\|?[\s:|-]+\|?$/.test(t)) return '';
  return t
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean)
    .join(' — ');
}

/**
 * Release notes (Markdown from the GitHub release body) as plain text: real HTML tags removed (a "<version>"
 * placeholder is kept), hard-wrapped paragraph lines joined, tables flattened, list markers as bullets.
 */
export function notesPlainText(notes: string | undefined): string {
  if (!notes) return '';
  const lines = notes.replace(/\r\n?/g, '\n').replace(HTML_TAG, '').split('\n');
  const out: string[] = [];
  let joinable = false;
  for (const raw of lines) {
    const row = tableRow(raw);
    if (row !== undefined) {
      if (row) out.push(row);
      joinable = false;
      continue;
    }
    if (joinable && !BLOCK_START.test(raw)) {
      out[out.length - 1] = `${out[out.length - 1]!.replace(/[ \t]+$/, '')} ${raw.trim()}`;
      continue;
    }
    out.push(raw);
    // a paragraph or list line can continue on the next line; headings, blank lines and fences cannot
    joinable = raw.trim() !== '' && !/^[ \t]*(?:#{1,6}[ \t]|```)/.test(raw);
  }
  return out
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const OFFLINE_TEXT = 'Could not check for updates (no internet?). You can always download the latest version from the ClaimDesk releases page.';
export const DISABLED_TEXT = 'Update checks are switched off on this computer. You can always download the latest version from the ClaimDesk releases page.';
export const RUN_IT_TEXT = 'Run it once downloaded. Your data is kept.';

export type UpdateView =
  | { kind: 'available'; headline: string; published: string; notes: string; download?: { href: string; label: string }; releaseUrl?: string }
  | { kind: 'up_to_date'; line: string }
  | { kind: 'offline'; line: string; detail?: string }
  | { kind: 'disabled'; line: string };

/** What the Updates card says for a check result. */
export function updateView(check: UpdateCheck): UpdateView {
  if (check.status === 'disabled') return { kind: 'disabled', line: DISABLED_TEXT };
  if (check.status === 'offline' || check.status === 'error') return { kind: 'offline', line: OFFLINE_TEXT, ...(check.message ? { detail: check.message } : {}) };
  if (check.updateAvailable && check.latest) {
    const published = publishedDay(check.release?.publishedAt);
    return {
      kind: 'available',
      headline: `ClaimDesk ${check.latest} is available`,
      published: published ? `published ${published}` : '',
      notes: notesPlainText(check.release?.notes),
      ...(check.download ? { download: { href: check.download.url, label: downloadLabel(check.download) } } : {}),
      ...(check.release?.htmlUrl ? { releaseUrl: check.release.htmlUrl } : {}),
    };
  }
  const time = checkedTime(check.checkedAt);
  return { kind: 'up_to_date', line: time ? `Up to date (checked ${time})` : 'Up to date' };
}

/** Side-bar link text, or undefined when there is nothing to say (no update, a failed or disabled check). */
export function updateNoticeText(check: UpdateCheck | undefined): string | undefined {
  if (!check || check.status !== 'ok' || !check.updateAvailable || !check.latest) return undefined;
  return `Update available: ${check.latest}`;
}
