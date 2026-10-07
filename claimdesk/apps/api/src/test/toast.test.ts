/**
 * Windows toasts (docs/SUPREME-DESIGN.md §J.1): the XML carries a reference and a kind only (no personal data), the
 * PowerShell runner receives the script on stdin with the AUMID, and off Windows the toast is a logged no-op.
 * Nothing is spawned: every test injects the runner.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { buildToastScript, buildToastXml, POWERSHELL_ARGS, scrubToastText, showToast, TOAST_AUMID, type ToastRunner } from '../notify/toast.js';
import { dispatch, inQuietHours, notificationForNeedsYou, notifyHeldSend, notifyOwner } from '../notify/index.js';
import { createNeedsYou } from '../agent/core.js';
import { startWorker } from '../agent/worker.js';
import { systemJobHandlers } from '../agent/handlers/system.js';

interface Call {
  command: string;
  args: readonly string[];
  stdin: string;
}
function recordingRunner(code = 0): { runner: ToastRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: async (command, args, stdin) => {
      calls.push({ command, args, stdin });
      return { code, stderr: code ? 'Access denied' : '' };
    },
  };
}

const PERSONAL = ['Amina', 'Yusuf', 'amina@example.com', '07700 900123', 'RG1 1AA', 'High Street'];

describe('toast XML and script', () => {
  it('builds protocol-activated XML with Open/Undo actions and escapes text', () => {
    const xml = buildToastXml({ title: 'Email held <before> sending', body: 'CCG-2026-00012: sends at 10:15 & can be undone', launch: '/outbox/ob-1', actions: [{ label: 'Open', url: '/outbox/ob-1' }, { label: 'Undo', url: 'outbox/ob-1?undo=1' }] });
    expect(xml).toContain('activationType="protocol"');
    expect(xml).toContain('launch="claimdesk://outbox/ob-1"');
    expect(xml).toContain('arguments="claimdesk://outbox/ob-1?undo=1"');
    expect(xml).toContain('&lt;before&gt;');
    expect(xml).toContain('&amp; can be undone');
    expect(xml).not.toMatch(/[\r\n]/);
  });

  it('scrubs anything that looks like personal data', () => {
    const s = scrubToastText('Call Amina on 07700 900123 or amina@example.com at RG1 1AA, account 12345678');
    expect(s).not.toContain('07700');
    expect(s).not.toContain('amina@example.com');
    expect(s).not.toContain('RG1 1AA');
    expect(s).not.toContain('12345678');
  });

  it('the script loads the WinRT toast types and uses the CCGUK.ClaimDesk AUMID', () => {
    const script = buildToastScript(buildToastXml({ title: 't', body: 'b', launch: 'needs-you/x' }));
    expect(script).toContain('[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]');
    expect(script).toContain(`CreateToastNotifier('${TOAST_AUMID}')`);
    expect(TOAST_AUMID).toBe('CCGUK.ClaimDesk');
  });

  it('on Windows the runner gets powershell.exe -NoProfile -NonInteractive -Command - and the script on stdin', async () => {
    const { runner, calls } = recordingRunner();
    const res = await showToast({ title: 'ClaimDesk needs you', body: 'Offer received on CCG-2026-00012', launch: '/needs-you/n1', actions: [{ label: 'Open', url: '/needs-you/n1' }] }, { platform: 'win32', runner });
    expect(res).toEqual({ shown: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('powershell.exe');
    expect(calls[0]!.args).toEqual(POWERSHELL_ARGS);
    expect([...POWERSHELL_ARGS]).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-']);
    expect(calls[0]!.stdin).toContain('claimdesk://needs-you/n1');
    expect(calls[0]!.stdin).toContain('Offer received on CCG-2026-00012');
  });

  it('off Windows it is a logged no-op; a PowerShell failure is reported, not thrown', async () => {
    const { runner, calls } = recordingRunner();
    const logged: string[] = [];
    const logger = { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) };
    expect(await showToast({ title: 't', body: 'b', launch: 'x' }, { platform: 'linux', runner, logger })).toEqual({ shown: false, reason: 'not_windows' });
    expect(calls).toHaveLength(0);
    expect(logged[0]).toMatch(/not Windows/);
    const failing = recordingRunner(1);
    expect(await showToast({ title: 't', body: 'b', launch: 'x' }, { platform: 'win32', runner: failing.runner })).toMatchObject({ shown: false, reason: 'powershell_failed' });
  });

  it('quiet hours wrap midnight', () => {
    const q = { start: '20:00', end: '07:30' };
    expect(inQuietHours(q, '21:00')).toBe(true);
    expect(inQuietHours(q, '06:00')).toBe(true);
    expect(inQuietHours(q, '07:30')).toBe(false);
    expect(inQuietHours(q, '12:00')).toBe(false);
    expect(inQuietHours(null, '23:00')).toBe(false);
  });
});

describe('notification dispatch', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp('2026-10-05T09:00:00.000Z'); // 10:00 London, outside quiet hours
  });
  afterEach(async () => {
    await t.close();
  });

  it('a Needs-you toast says kind + reference only, never the personal data in the item', async () => {
    const res = await t.api<{ claim: { id: string; reference: string } }>('POST', '/claims', FNOL);
    const item = createNeedsYou(t.ctx, {
      kind: 'offer_decision',
      claimId: res.body.claim.id,
      title: 'Offer from Example Insurance for Amina Yusuf (amina@example.com, 07700 900123)',
      summary: 'Amina Yusuf of 12 High Street, Reading RG1 1AA — offer £1,200',
      payload: {},
      priority: 'high',
      createdBy: 'agent:case_manager',
    });
    const { runner, calls } = recordingRunner();
    (t.ctx.services as { notify?: unknown }).notify = { platform: 'win32', runner };
    // The notify.dispatch job queued by createNeedsYou runs through the queue.
    const w = startWorker(t.ctx, { owner: 'w', handlers: systemJobHandlers });
    await w.tick(t.ctx.now());
    expect(calls).toHaveLength(1);
    for (const p of PERSONAL) expect(calls[0]!.stdin).not.toContain(p);
    expect(calls[0]!.stdin).toContain(`Offer received on ${res.body.claim.reference}`);
    expect(calls[0]!.stdin).toContain(`claimdesk://needs-you/${item.id}`);
    const n = notificationForNeedsYou(t.ctx, item.id)!;
    expect(n.deliveries.map((d) => [d.channel, d.ok])).toEqual([
      ['in_app', true],
      ['toast', true],
    ]);
    // The in-app row keeps the full detail; the public list hides internal channel metadata.
    const list = await t.api<{ items: Array<{ title: string; channels: string[] }> }>('GET', '/notifications');
    expect(list.body.items[0]!.title).toContain('Amina Yusuf');
    expect(list.body.items[0]!.channels).toEqual(['in_app', 'toast']);
  });

  it('low priority stays in-app; quiet hours suppress non-urgent toasts; held sends get Undo', async () => {
    const { runner, calls } = recordingRunner();
    const opts = { platform: 'win32' as const, runner };
    const low = notifyOwner(t.ctx, { level: 'low', title: 'FYI', body: 'x' });
    expect(low.channels.filter((c) => !c.includes(':'))).toEqual(['in_app']);
    const held = notifyHeldSend(t.ctx, { outboxId: 'ob-9', reference: 'CCG-2026-00012', holdUntil: '2026-10-05T09:10:00.000Z', title: 'Held: acknowledgement to Example Insurance', body: 'to handler@insurer.example' });
    await dispatch(t.ctx, held.id, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.stdin).toContain('claimdesk://outbox/ob-9?undo=1');
    expect(calls[0]!.stdin).toContain('CCG-2026-00012: sends at 10:10 unless you undo it.');
    expect(calls[0]!.stdin).not.toContain('handler@insurer.example');
    // 21:30 London: quiet hours.
    const late = notifyOwner(t.ctx, { level: 'high', title: 'Late', body: 'x', link: '/needs-you/x' });
    const r = await dispatch(t.ctx, late.id, { ...opts, now: '2026-10-05T20:30:00.000Z' });
    expect(r.deliveries.find((d) => d.channel === 'toast')).toMatchObject({ ok: true, status: 'quiet_hours' });
    expect(calls).toHaveLength(1);
    const urgent = notifyOwner(t.ctx, { level: 'urgent', title: 'Urgent', body: 'x', link: '/needs-you/y' });
    await dispatch(t.ctx, urgent.id, { ...opts, now: '2026-10-05T20:30:00.000Z' });
    expect(calls).toHaveLength(2);
  });

  it('POST /notifications/test reports the platform result (no-op off Windows)', async () => {
    const res = await t.api<{ result: { deliveries: Array<{ channel: string; status: string }> }; platform: string }>('POST', '/notifications/test');
    expect(res.status).toBe(200);
    const toast = res.body.result.deliveries.find((d) => d.channel === 'toast');
    if (process.platform !== 'win32') expect(toast?.status).toBe('not_windows');
  });
});
