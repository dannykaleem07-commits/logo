// owned by mail
import { describe, expect, it } from 'vitest';
import { formatCountdown, holdSecondsLeft, isEmailAddress, parseAddresses, OUTBOX_STATUS_LABEL } from '../../api/mailApi';
import { deepLink } from './OutboxPage';

describe('held countdown', () => {
  it('counts down against the server clock (local clock skew does not matter)', () => {
    const server = '2026-10-07T09:00:00.000Z';
    const hold = '2026-10-07T09:10:00.000Z';
    // the PC clock is 5 minutes fast: the response arrived at local 09:05 while the server said 09:00
    const received = Date.parse('2026-10-07T09:05:00.000Z');
    expect(holdSecondsLeft(hold, server, received, received)).toBe(600);
    expect(holdSecondsLeft(hold, server, received, received + 61_000)).toBe(539);
    expect(holdSecondsLeft(hold, server, received, received + 700_000)).toBe(0);
    expect(holdSecondsLeft(null, server, received, received)).toBe(0);
  });
  it('formats m:ss', () => {
    expect(formatCountdown(600)).toBe('10:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});

describe('deep links (toasts open claimdesk://outbox/<id>?undo=1)', () => {
  it('finds the item and whether to offer Undo', () => {
    expect(deepLink({ id: 'o1' }, new URLSearchParams('undo=1'))).toEqual({ focusId: 'o1', undo: true });
    expect(deepLink({}, new URLSearchParams('focus=o2&undo=1'))).toEqual({ focusId: 'o2', undo: true });
    expect(deepLink({}, new URLSearchParams('undo=o3'))).toEqual({ focusId: 'o3', undo: true });
    expect(deepLink({}, new URLSearchParams('focus=o4'))).toEqual({ focusId: 'o4', undo: false });
    expect(deepLink({}, new URLSearchParams(''))).toEqual({ undo: false });
  });
});

describe('addresses and labels', () => {
  it('parses address lists', () => {
    expect(parseAddresses('a@x.test, b@y.test; a@x.test  c@z.test')).toEqual(['a@x.test', 'b@y.test', 'c@z.test']);
    expect(isEmailAddress('handler@insurer.example')).toBe(true);
    expect(isEmailAddress('not an address')).toBe(false);
  });
  it('labels every status in plain words', () => {
    expect(OUTBOX_STATUS_LABEL.held).toMatch(/Undo/);
    expect(Object.keys(OUTBOX_STATUS_LABEL)).toHaveLength(9);
  });
});
