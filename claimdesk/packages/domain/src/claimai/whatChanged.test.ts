// owned by claimai-server
import { describe, expect, it } from 'vitest';
import { parseOwnerUpdate } from './parse.js';
import { clockChanges, clockSentence, whatChangedLines, type ClockView } from './whatChanged.js';

const NOW = '2026-10-12T09:00:00.000Z';
const ncafRunning: ClockView = { kind: 'gta_4_1_ncaf_1wd', label: 'NCAF (GTA 4.1)', status: 'breached', startsAt: '2026-10-01T13:00:00.000Z', dueAt: '2026-10-02T13:00:00.000Z' };
const ncafMet: ClockView = { ...ncafRunning, status: 'met', metAt: '2026-10-02T11:00:00.000Z' };
const href: ClockView = { kind: 'gta_4_2_handling_ref_5wd', label: 'Handling reference (GTA 4.2)', status: 'met', startsAt: '2026-10-02T11:00:00.000Z', dueAt: '2026-10-09T11:00:00.000Z', metAt: '2026-10-06T11:00:00.000Z' };

describe('whatChanged (§3.9)', () => {
  it('clock lines for every clock whose status, start or due changed', () => {
    expect(clockSentence(href)).toBe('Handling reference (GTA 4.2): started 2 Oct, met 6 Oct');
    expect(clockSentence(ncafRunning)).toBe('NCAF (GTA 4.1): started 1 Oct, due 2 Oct — missed');
    const c = clockChanges([ncafRunning], [ncafMet, href]);
    expect(c).toEqual([
      { label: 'NCAF (GTA 4.1)', before: 'NCAF (GTA 4.1): started 1 Oct, due 2 Oct — missed', after: 'NCAF (GTA 4.1): started 1 Oct, met 2 Oct', status: 'met' },
      { label: 'Handling reference (GTA 4.2)', before: null, after: 'Handling reference (GTA 4.2): started 2 Oct, met 6 Oct', status: 'met' },
    ]);
    expect(clockChanges([href], [href])).toEqual([]);
  });

  it('a missed clock that is now done late reads differently before and after (never "missed → missed")', () => {
    const doneLate: ClockView = { ...ncafRunning, metAt: '2026-10-05T11:00:00.000Z' };
    expect(clockSentence(doneLate)).toBe('NCAF (GTA 4.1): started 1 Oct, due 2 Oct — missed (done late, 5 Oct)');
    const [c] = clockChanges([ncafRunning], [doneLate]);
    expect(c!.before).not.toBe(c!.after);
  });

  it('one line per applied / Needs-you / failed action; private notes never shown; Autopilot first steps', () => {
    const r = parseOwnerUpdate('client called, hire ended yesterday. they paid £10 for the hire. the client is lying', { now: NOW, openHires: [{ id: 'h1', agreementNumber: 'HA-0042', startAt: '2026-10-03T09:00:00.000Z' }], insurerName: null, clientFirstName: null, evidence: [], templates: [] });
    const [call, hire, money, priv] = r.actions;
    const w = whatChangedLines(
      [
        { action: call!, refs: { eventId: 'e1' }, state: 'applied' },
        { action: hire!, refs: {}, state: 'failed', message: 'The hire already ended' },
        { action: money!, refs: { needsYouId: 'n1' }, state: 'needs_you' },
        { action: priv!, refs: {}, state: 'applied' },
      ],
      [ncafRunning],
      [ncafMet],
      { stopped: null, firstSteps: [{ id: 'notify.handling_ref', title: 'Get the handling reference', status: 'waiting', sentence: 'Get the handling reference: waiting on the insurer.' }] },
      (l) => (l.refs.eventId ? '/claims/c1/chronology' : null),
    );
    expect(w.lines.map((l) => [l.kind, l.text])).toEqual([
      ['event', 'Chronology: Call — Mon 12 Oct 2026'],
      ['not_done', 'Not done: End hire HA-0042 on Sun 11 Oct 2026 — The hire already ended'],
      ['needs_you', 'Sent to Needs-you: Payment of £10.00 on hire — goes to Needs-you; you record it in the ledger'],
      ['clock', 'NCAF (GTA 4.1): started 1 Oct, met 2 Oct'],
      ['autopilot', 'Get the handling reference: waiting on the insurer.'],
    ]);
    expect(w.lines[0]!.link).toBe('/claims/c1/chronology');
    expect(w.autopilot?.firstSteps).toHaveLength(1);
  });
});
