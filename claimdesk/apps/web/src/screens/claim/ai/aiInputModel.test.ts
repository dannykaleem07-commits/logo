// owned by claimai-web
/** AI input screen model (docs/CLAIM-AI-INPUT.md §14): tiers, grouping, ticks, Do it, labels, what changed, drafts, layout. */
import { describe, expect, it } from 'vitest';
import type { AiAction, CatchUpFile } from '../../../api/claimAiApi';
import {
  buildApplyChoices,
  columnsFor,
  compareKeys,
  countsHeadline,
  dateSourceLabel,
  defaultTicks,
  DIRECTION_LABEL,
  doItCount,
  doItLabel,
  draftKey,
  editErrors,
  groupActions,
  groupWhatChanged,
  withoutLabel,
  headlineOf,
  insertExample,
  isPhoneWidth,
  isStillOpen,
  loadDraft,
  londonDate,
  orderCatchUpFiles,
  saveDraft,
  segmentText,
  TIER_LABEL,
  TIER_ORDER,
  toggleScope,
  updateProblem,
  validateEdit,
  waitingText,
  whenText,
} from './aiInputModel';
import { catchUpDetail, updateApplied, updatePreview } from './__fixtures__/fixtures';

const byKey = (xs: AiAction[], k: string) => xs.find((a) => a.key === k)!;

describe('tiers and grouping', () => {
  it('labels every tier the way the contract does', () => {
    expect(TIER_ORDER.map((t) => TIER_LABEL[t])).toEqual(['Will do', 'Needs your tick', 'Goes to Needs-you', 'Open the screen', 'Private note', "Won't do"]);
  });
  it('groups lines by tier in display order, each group in key order (a2 before a10)', () => {
    const groups = groupActions(updatePreview().actions);
    expect(groups.map((g) => g.tier)).toEqual(['apply', 'confirm', 'needs_you', 'private', 'refused']);
    expect(groups[0]!.actions.map((a) => a.key)).toEqual(['a1', 'a2', 'a3', 'a6', 'a7']);
    expect(compareKeys('a2', 'a10')).toBeLessThan(0);
    expect(compareKeys('f1', 'r1')).toBeLessThan(0);
  });
});

describe('ticks and Do it', () => {
  it('confirm lines are never pre-ticked; untickable lines are never ticked', () => {
    const t = defaultTicks(updatePreview().actions);
    expect(t.a4).toBe(false);
    expect(t.a5).toBe(false);
    expect(t.a1).toBe(true);
    expect(t.a8).toBe(true);
    expect(t.a9).toBe(false);
    expect(t.a10).toBe(false);
  });
  it('counts the ticked pending lines and labels the button', () => {
    const actions = updatePreview().actions;
    const t = defaultTicks(actions);
    expect(doItCount(actions, t)).toBe(6);
    expect(doItLabel(6)).toBe('Do it (6)');
    expect(doItLabel(0)).toBe('Do it');
    expect(doItCount(actions, { ...t, a5: true, a1: false })).toBe(6);
    // a line that cannot be ticked never counts, whatever the ticks say
    expect(doItCount(actions, { ...t, a9: true })).toBe(6);
  });
  it('posts every pending tickable line with its tick, edits only on ticked lines', () => {
    const actions = updatePreview().actions;
    const body = buildApplyChoices(actions, { ...defaultTicks(actions), a5: true, a2: false }, { a3: { at: '2026-10-10T12:00:00.000Z' }, a2: { at: '2026-10-09' }, a7: { text: '  ', until: null } });
    expect(body.map((c) => c.key)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
    expect(byKey(body as unknown as AiAction[], 'a2')).toEqual({ key: 'a2', ticked: false });
    expect(body.find((c) => c.key === 'a3')).toEqual({ key: 'a3', ticked: true, edits: { at: '2026-10-10T12:00:00.000Z' } });
    expect(body.find((c) => c.key === 'a5')).toEqual({ key: 'a5', ticked: true });
    expect(body.find((c) => c.key === 'a7')).toEqual({ key: 'a7', ticked: true, edits: { until: null } });
  });
  it('validates inline edits before posting', () => {
    const now = new Date('2026-10-12T10:00:00Z');
    expect(validateEdit('at', '2026-10-20T10:00:00Z', now)).toMatch(/future/);
    expect(validateEdit('at', '2026-10-11', now)).toBeNull();
    expect(validateEdit('until', '2026-10-11', now)).toMatch(/after today/);
    expect(validateEdit('until', null, now)).toBeNull();
    expect(validateEdit('text', '  ', now)).toMatch(/empty/);
    expect(validateEdit('appliesTo', [], now)).toMatch(/at least one/);
    const actions = updatePreview().actions;
    expect(editErrors(actions, defaultTicks(actions), { a2: { at: '2027-01-01' } }, now)).toEqual({ a2: expect.stringMatching(/future/) });
    // an unticked line's edits are not checked
    expect(editErrors(actions, { ...defaultTicks(actions), a2: false }, { a2: { at: '2027-01-01' } }, now)).toEqual({});
  });
  it('after a partial apply only never-applied tickable lines stay open', () => {
    const d = updateApplied();
    expect(d.actions.filter(isStillOpen).map((a) => a.key)).toEqual(['a4', 'a5']);
  });
});

describe('headlines and labels', () => {
  it('uses the server headline, else builds one from the counts', () => {
    const d = updatePreview();
    expect(headlineOf(d)).toBe(d.headline);
    expect(countsHeadline({ actions: 7, applied: 3, waitingTick: 2, needsYou: 1, undone: 0, failed: 1, questions: 0 })).toBe('3 done · 1 for Needs-you · 2 need your tick · 1 failed');
    expect(headlineOf({ headline: '', counts: { actions: 1, applied: 0, waitingTick: 0, needsYou: 0, undone: 0, failed: 0, questions: 0 } })).toBe('1 line');
  });
  it('says why the AI is waiting', () => {
    expect(waitingText({ reason: 'agents_off' })).toBe('agents are switched off');
    expect(waitingText({ reason: 'usage', until: '2026-10-12T13:30:00.000Z' })).toBe('the AI usage limit is reached (resets at 14:30)');
    expect(waitingText(null)).toBeNull();
  });
  it('dates in London time', () => {
    expect(whenText('2026-10-11T11:00:00.000Z')).toBe('Sun 11 Oct 2026');
    expect(whenText('2026-10-11T13:00:00.000Z', 'datetime')).toBe('Sun 11 Oct 2026, 14:00');
    expect(whenText('2026-10-02')).toBe('Fri 2 Oct 2026');
    expect(londonDate('2026-10-18T23:00:00.000Z')).toBe('2026-10-19');
    expect(londonDate('2026-10-05')).toBe('2026-10-05');
  });
});

describe('catch-up files', () => {
  it('direction and date-source labels', () => {
    expect(DIRECTION_LABEL).toEqual({ out: 'Sent by us', in: 'Received', none: 'For the file', unknown: 'Who sent it?' });
    expect(dateSourceLabel('document')).toBe('from the letter');
    expect(dateSourceLabel('email_header')).toBe('email date');
    expect(dateSourceLabel('owner')).toBe('set by you');
    expect(dateSourceLabel(null)).toBe('no date found');
    expect(segmentText({ fromPage: 2, toPage: 3 })).toBe('pages 2–3');
    expect(segmentText({ fromPage: 4, toPage: 4 })).toBe('page 4');
  });
  it('puts files that need the owner first, then by real date, other claims last', () => {
    const files = catchUpDetail().catchUp!.files as CatchUpFile[];
    const order = orderCatchUpFiles(files).map((f) => f.fileId);
    expect(order[0]).toBe('f4');
    expect(order[order.length - 1]).toBe('f5');
    expect(order.indexOf('f1')).toBeLessThan(order.indexOf('f2'));
  });
});

describe('what changed', () => {
  it('groups the lines in reading order', () => {
    const g = groupWhatChanged(updateApplied().whatChanged);
    expect(g.map((x) => x.kind)).toEqual(['event', 'hire', 'instruction', 'needs_you', 'not_done']);
    expect(g[1]!.label).toBe('Hire');
    expect(groupWhatChanged(null)).toEqual([]);
  });

  it('clock and Autopilot lines are not repeated when their own sections are shown (the server sends both)', () => {
    const w = {
      lines: [
        { kind: 'filed' as const, text: "Filed 'a.pdf'", link: null },
        { kind: 'clock' as const, text: 'NCAF (1 WD): started 29 Sep, due 30 Sep — missed', link: null },
        { kind: 'autopilot' as const, text: 'Acknowledge the client: due.', link: null },
      ],
      clocks: [{ label: 'NCAF (1 WD)', before: null, after: 'NCAF (1 WD): started 29 Sep, due 30 Sep — missed', status: 'breached' }],
      autopilot: { stopped: null, firstSteps: [{ id: 'intake.acknowledge', title: 'Acknowledge the client', status: 'ready', sentence: 'Acknowledge the client: due.' }] },
    };
    expect(groupWhatChanged(w).map((g) => g.kind)).toEqual(['filed']);
    expect(groupWhatChanged({ ...w, clocks: [], autopilot: null }).map((g) => g.kind)).toEqual(['filed', 'clock', 'autopilot']);
    expect(withoutLabel('NCAF (1 WD): started 29 Sep', 'NCAF (1 WD)')).toBe('started 29 Sep');
    expect(withoutLabel('Something else', 'NCAF (1 WD)')).toBe('Something else');
    expect(withoutLabel(null, 'x')).toBeNull();
  });
});

describe('instructions and the update box', () => {
  it('scope chips: All agents is exclusive and the last chip falls back to all', () => {
    expect(toggleScope(['all'], 'mail')).toEqual(['mail']);
    expect(toggleScope(['mail'], 'drafter')).toEqual(['mail', 'drafter']);
    expect(toggleScope(['mail'], 'mail')).toEqual(['all']);
    expect(toggleScope(['mail', 'drafter'], 'all')).toEqual(['all']);
  });
  it('examples append to the text', () => {
    expect(insertExample('', 'Client called today: ')).toBe('Client called today: ');
    expect(insertExample('Car repaired.  ', 'Hire ended.')).toBe('Car repaired. Hire ended.');
  });
  it('Read it needs some text and stays under the limits', () => {
    expect(updateProblem({ text: ' ', extra: '' })).toMatch(/Type what happened/);
    expect(updateProblem({ text: '', extra: 'call note' })).toBeNull();
    expect(updateProblem({ text: 'x'.repeat(8001), extra: '' })).toMatch(/8000/);
  });
  it('keeps the draft per claim, and survives a broken store', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    saveDraft('c1', { text: 'Client called', extra: '', channel: 'call_note' }, store);
    expect(mem.has(draftKey('c1'))).toBe(true);
    expect(draftKey('c1')).toBe('claimdesk.aiInput.draft.c1');
    expect(loadDraft('c1', store).text).toBe('Client called');
    expect(loadDraft('c2', store).text).toBe('');
    saveDraft('c1', { text: '', extra: '', channel: 'call_note' }, store);
    expect(mem.has(draftKey('c1'))).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDraft('c1', broken)).toEqual({ text: '', extra: '', channel: 'call_note' });
    expect(() => saveDraft('c1', { text: 'x', extra: '', channel: 'call_note' }, broken)).not.toThrow();
  });
});

describe('layout (§14.2)', () => {
  it('two columns from 960 px, one below; phone details at 600 px and below', () => {
    expect(columnsFor(1280)).toBe(2);
    expect(columnsFor(960)).toBe(2);
    expect(columnsFor(959)).toBe(1);
    expect(columnsFor(390)).toBe(1);
    expect(isPhoneWidth(390)).toBe(true);
    expect(isPhoneWidth(768)).toBe(false);
  });
});
