import { describe, expect, it } from 'vitest';
import { normaliseUpdateCheck, type UpdateCheck } from '../../api/updatesApi';
import { checkedTime, DISABLED_TEXT, downloadLabel, formatSize, installedText, notesPlainText, OFFLINE_TEXT, publishedDay, updateNoticeText, updateView } from './updates';

const base: UpdateCheck = { status: 'ok', current: '0.3.12', updateAvailable: false, checkedAt: '2026-10-05T09:42:00.000Z' };
const available: UpdateCheck = {
  ...base,
  latest: '0.3.15',
  updateAvailable: true,
  release: { tag: 'claimdesk-v0.3.15', name: 'ClaimDesk 0.3.15', publishedAt: '2026-10-12T10:00:00Z', htmlUrl: 'https://github.com/x/releases/tag/claimdesk-v0.3.15', notes: "## What's new\n- **Manager mode** — one click\n- [Docs](https://x) and `code`" },
  download: { name: 'ClaimDesk-Setup-0.3.15.exe', url: 'https://github.com/x/ClaimDesk-Setup-0.3.15.exe', size: 44_040_192, sha256: 'ab'.repeat(32) }
};

describe('Updates card wording (§F.3)', () => {
  it('shows the installed version', () => {
    expect(installedText('0.3.12')).toBe('Installed: ClaimDesk 0.3.12');
    expect(installedText(undefined)).toBe('Installed: ClaimDesk');
  });
  it('formats times in Europe/London, sizes in MB', () => {
    expect(checkedTime('2026-10-05T09:42:00.000Z')).toBe('10:42'); // BST
    expect(checkedTime('2026-12-05T09:42:00.000Z')).toBe('09:42'); // GMT
    expect(checkedTime('nonsense')).toBe('');
    expect(publishedDay('2026-10-12T10:00:00Z')).toBe('12 Oct');
    expect(formatSize(44_040_192)).toBe('42 MB');
    expect(formatSize(500_000)).toBe('488 KB');
    expect(formatSize(undefined)).toBe('');
    expect(downloadLabel({ name: 'ClaimDesk-Setup-0.3.15.exe', size: 44_040_192 })).toBe('Download ClaimDesk-Setup-0.3.15.exe (42 MB)');
    expect(downloadLabel({ name: 'ClaimDesk-Setup-0.3.15.exe' })).toBe('Download ClaimDesk-Setup-0.3.15.exe');
  });
  it('up to date → "Up to date (checked 10:42)"', () => {
    expect(updateView(base)).toEqual({ kind: 'up_to_date', line: 'Up to date (checked 10:42)' });
  });
  it('a newer version → headline, published date, plain-text notes and the download link', () => {
    const v = updateView(available);
    expect(v).toMatchObject({ kind: 'available', headline: 'ClaimDesk 0.3.15 is available', published: 'published 12 Oct', download: { href: 'https://github.com/x/ClaimDesk-Setup-0.3.15.exe', label: 'Download ClaimDesk-Setup-0.3.15.exe (42 MB)' } });
    if (v.kind !== 'available') throw new Error('expected available');
    expect(v.notes).toBe("What's new\n• Manager mode — one click\n• Docs and code");
    const noAsset = updateView({ ...available, download: undefined });
    expect(noAsset).toMatchObject({ kind: 'available', releaseUrl: available.release!.htmlUrl });
    expect('download' in noAsset).toBe(false);
  });
  it('offline and error read the same quiet line; disabled says checks are off', () => {
    expect(updateView({ ...base, status: 'offline' })).toMatchObject({ kind: 'offline', line: OFFLINE_TEXT });
    expect(updateView({ ...base, status: 'error', message: 'The update server answered 403.' })).toEqual({ kind: 'offline', line: OFFLINE_TEXT, detail: 'The update server answered 403.' });
    expect(OFFLINE_TEXT).toBe('Could not check for updates (no internet?). You can always download the latest version from the ClaimDesk releases page.');
    expect(updateView({ ...base, status: 'disabled' })).toEqual({ kind: 'disabled', line: DISABLED_TEXT });
  });
  it('the side-bar notice shows only a real update', () => {
    expect(updateNoticeText(available)).toBe('Update available: 0.3.15');
    expect(updateNoticeText(base)).toBeUndefined();
    expect(updateNoticeText({ ...available, status: 'offline' })).toBeUndefined();
    expect(updateNoticeText(undefined)).toBeUndefined();
  });
  it('notes are plain text', () => {
    expect(notesPlainText('**Bold** and *italic* <b>html</b>\n\n\n\n# Head')).toBe('Bold and italic html\n\nHead');
    expect(notesPlainText(undefined)).toBe('');
  });
  it('keeps <placeholders>, joins hard-wrapped lines and flattens tables', () => {
    expect(notesPlainText('A backup is saved as claimdesk-before-<version>-<date>-<time>.sqlite.')).toBe('A backup is saved as claimdesk-before-<version>-<date>-<time>.sqlite.');
    expect(notesPlainText('It updates\nClaimDesk in place\nand keeps your data.\n\n- one\n  more\n- two')).toBe('It updates ClaimDesk in place and keeps your data.\n\n• one more\n• two');
    expect(notesPlainText('| Folder or file | What it holds |\n|---|---|\n| data | the database |')).toBe('Folder or file — What it holds\ndata — the database');
    expect(notesPlainText('# Title\nFirst line')).toBe('Title\nFirst line');
  });
});

describe('normaliseUpdateCheck', () => {
  it('keeps a valid answer and turns junk into an error without an update', () => {
    expect(normaliseUpdateCheck(available)).toEqual(available);
    expect(normaliseUpdateCheck(null)).toMatchObject({ status: 'error', updateAvailable: false });
    expect(normaliseUpdateCheck({ status: 'weird', updateAvailable: true })).toMatchObject({ status: 'error', updateAvailable: false });
    // only http(s) download links are kept
    expect(normaliseUpdateCheck({ ...available, download: { name: 'x.exe', url: 'javascript:alert(1)' } }).download).toBeUndefined();
  });
});
