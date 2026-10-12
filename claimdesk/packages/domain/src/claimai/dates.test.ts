// owned by claimai-server
import { describe, expect, it } from 'vitest';
import { eventAtFor, findDatePhrase, fmtDay, fmtDayLong, fmtDayWeek, nineAm, resolveDate, startOfLondonDay } from './dates.js';

// Monday 12 October 2026, 10:00 London (BST, UTC+1)
const NOW = '2026-10-12T09:00:00.000Z';
const day = (iso: string) => fmtDay(iso);

describe('resolveDate (§3.2)', () => {
  it('today / this morning / afternoon / tonight / yesterday / tomorrow / day before yesterday', () => {
    expect(resolveDate('today', NOW, 'past')).toEqual({ at: '2026-10-11T23:00:00.000Z', precision: 'date', text: 'today' });
    expect(resolveDate('this morning', NOW, 'past')).toMatchObject({ at: '2026-10-12T08:00:00.000Z', precision: 'datetime' });
    expect(resolveDate('this afternoon', NOW, 'past')).toMatchObject({ at: '2026-10-12T13:00:00.000Z' });
    expect(resolveDate('tonight', NOW, 'future')).toMatchObject({ at: '2026-10-12T18:00:00.000Z' });
    expect(day(resolveDate('yesterday', NOW, 'past')!.at)).toBe('Sun 11 Oct 2026');
    expect(day(resolveDate('tomorrow', NOW, 'future')!.at)).toBe('Tue 13 Oct 2026');
    expect(day(resolveDate('day before yesterday', NOW, 'past')!.at)).toBe('Sat 10 Oct 2026');
  });

  it('a bare weekday follows the sense; next / last are strict; on / this read like bare', () => {
    expect(day(resolveDate('Monday', NOW, 'past')!.at)).toBe('Mon 5 Oct 2026');
    expect(day(resolveDate('Monday', NOW, 'future')!.at)).toBe('Mon 19 Oct 2026');
    expect(day(resolveDate('on Friday', NOW, 'past')!.at)).toBe('Fri 9 Oct 2026');
    expect(day(resolveDate('friday', NOW, 'future')!.at)).toBe('Fri 16 Oct 2026');
    expect(day(resolveDate('next Wednesday', NOW, 'past')!.at)).toBe('Wed 14 Oct 2026');
    expect(day(resolveDate('last Thursday', NOW, 'future')!.at)).toBe('Thu 8 Oct 2026');
    expect(day(resolveDate('Tues', NOW, 'future')!.at)).toBe('Tue 13 Oct 2026');
  });

  it('numeric and written dates; a date without a year takes the nearest year in the sense', () => {
    expect(day(resolveDate('2/10/2026', NOW, 'past')!.at)).toBe('Fri 2 Oct 2026');
    expect(day(resolveDate('02.10.26', NOW, 'past')!.at)).toBe('Fri 2 Oct 2026');
    expect(day(resolveDate('2 October 2026', NOW, 'past')!.at)).toBe('Fri 2 Oct 2026');
    expect(day(resolveDate('October 2nd', NOW, 'past')!.at)).toBe('Fri 2 Oct 2026');
    expect(day(resolveDate('the 3rd', NOW, 'past')!.at)).toBe('Sat 3 Oct 2026');
    expect(day(resolveDate('the 3rd', NOW, 'future')!.at)).toBe('Tue 3 Nov 2026');
    // year rollover: 28 Dec said in January is last year; 5 Jan said in December is next year
    expect(day(resolveDate('28 Dec', '2027-01-04T10:00:00.000Z', 'past')!.at)).toBe('Mon 28 Dec 2026');
    expect(day(resolveDate('5 Jan', '2026-12-20T10:00:00.000Z', 'future')!.at)).toBe('Tue 5 Jan 2027');
    expect(day(resolveDate('20/12', NOW, 'past')!.at)).toBe('Sat 20 Dec 2025');
  });

  it('relative spans, end of week, next week, and an optional time', () => {
    expect(day(resolveDate('in 3 days', NOW, 'future')!.at)).toBe('Thu 15 Oct 2026');
    expect(day(resolveDate('2 weeks ago', NOW, 'past')!.at)).toBe('Mon 28 Sep 2026');
    expect(day(resolveDate('end of the week', NOW, 'future')!.at)).toBe('Fri 16 Oct 2026');
    expect(day(resolveDate('next week', NOW, 'future')!.at)).toBe('Mon 19 Oct 2026');
    expect(resolveDate('tomorrow at 3pm', NOW, 'future')).toMatchObject({ at: '2026-10-13T14:00:00.000Z', precision: 'datetime' });
    expect(resolveDate('yesterday 14:30', NOW, 'past')).toMatchObject({ at: '2026-10-11T13:30:00.000Z', precision: 'datetime' });
  });

  it('DST: dates either side of the October change keep London midnight', () => {
    // BST ends Sunday 25 October 2026
    expect(resolveDate('Monday', '2026-10-27T10:00:00.000Z', 'past')!.at).toBe('2026-10-26T00:00:00.000Z');
    expect(resolveDate('Friday', '2026-10-27T10:00:00.000Z', 'past')!.at).toBe('2026-10-22T23:00:00.000Z');
  });

  it('more than two years away → null; nonsense → null', () => {
    expect(resolveDate('2/10/2031', NOW, 'future')).toBeNull();
    expect(resolveDate('31/02/2026', NOW, 'past')).toBeNull();
    expect(resolveDate('banana', NOW, 'past')).toBeNull();
  });
});

describe('findDatePhrase and helpers', () => {
  it('finds the first date in a clause with its position', () => {
    const f = findDatePhrase("don't chase the client until Monday", NOW, 'future')!;
    expect(f.text).toBe('Monday');
    expect(f.index).toBe(29);
    expect(findDatePhrase('the month was long', NOW, 'past')).toBeNull();
  });
  it('"until <date>" is the start of that day; events dated by day are written at noon, never after now', () => {
    expect(startOfLondonDay(resolveDate('Monday', NOW, 'future')!.at)).toBe('2026-10-18T23:00:00.000Z');
    expect(eventAtFor(resolveDate('yesterday', NOW, 'past')!.at, 'date', NOW)).toBe('2026-10-11T11:00:00.000Z');
    expect(eventAtFor(resolveDate('today', NOW, 'past')!.at, 'date', NOW)).toBe(NOW);
    expect(nineAm(resolveDate('tomorrow', NOW, 'future')!.at)).toBe('2026-10-13T08:00:00.000Z');
    expect(fmtDayWeek('2026-10-18T23:00:00.000Z')).toBe('Mon 19 Oct');
    expect(fmtDayLong('2026-10-18T23:00:00.000Z')).toBe('Monday 19 October 2026');
  });
});
