import { describe, it, expect } from 'vitest';
import { extractAmounts, extractDates, extractDeadlines, extractCitations, toPlainText } from './index.js';
import { addWorkingDaysSimple, addCalendarMonthsSimple, chargeableDays, calendarDaysBetween } from './text.js';

describe('toPlainText', () => {
  it('strips tags, decodes entities and keeps line structure', () => {
    const html = '<p>You have paid &pound;1,287.</p><p>Balance: &#163;175 &amp; costs.<br>Ref A&nbsp;B</p>';
    expect(toPlainText(html)).toBe('You have paid £1,287.\nBalance: £175 & costs.\nRef A B');
    expect(toPlainText('plain text')).toBe('plain text');
  });
});

describe('extractAmounts', () => {
  it('classifies paid / invoice / claimed by the nearest keyword and parses to pence', () => {
    const text = 'You have paid £1,287 against our invoice of £1,112.00 and the balance of £175 remains outstanding.';
    const a = extractAmounts(text);
    expect(a.map((x) => [x.pence, x.context])).toEqual([
      [128_700, 'paid'],
      [111_200, 'invoice'],
      [17_500, 'claimed']
    ]);
    expect(a[0]!.index).toBe(text.indexOf('£1,287'));
    expect(a[0]!.excerpt).toContain('paid £1,287');
  });

  it('treats a negated payment ("not received £X") as a claimed figure, and detects rates and VAT hints', () => {
    const a = extractAmounts('We have not received the £1,287 due. The hire rate is £49.80 per day + VAT, i.e. £59.76 inc VAT. An offer of £20.37/day was made.');
    expect(a[0]).toMatchObject({ pence: 128_700, context: 'claimed' });
    expect(a[1]).toMatchObject({ pence: 4_980, perUnit: 'day', vatHint: 'net' });
    expect(a[2]).toMatchObject({ pence: 5_976, vatHint: 'gross' });
    expect(a[3]).toMatchObject({ pence: 2_037, context: 'offered', perUnit: 'day' });
  });

  it('marks amounts with no nearby keyword as unknown and copes with "£ 90"', () => {
    const a = extractAmounts('Call-out £ 90, per loaded mile £3, admin £25.');
    expect(a.map((x) => x.pence)).toEqual([9_000, 300, 2_500]);
    expect(a[0]!.context).toBe('unknown');
    expect(a[1]!.perUnit).toBeUndefined(); // "per loaded mile" precedes, not follows
  });
});

describe('extractDates', () => {
  it('parses dd/mm/yyyy, d Month yyyy, Month d, yyyy and ISO, skipping invalid dates', () => {
    const text = 'Dates: 04/10/2026, 4 October 2026, 4th Oct 2026, October 4, 2026, 2026-10-04, 31/02/2026, 13.13.2026, 1-9-2026.';
    const d = extractDates(text);
    expect(d.map((x) => x.iso)).toEqual(['2026-10-04', '2026-10-04', '2026-10-04', '2026-10-04', '2026-10-04', '2026-09-01']);
    expect(d[0]!.raw).toBe('04/10/2026');
    expect(d[1]!.index).toBe(text.indexOf('4 October'));
    expect(d[2]!.raw).toBe('4th Oct 2026');
  });

  it('does not double-count overlapping patterns and handles "4 Sept 2026" and "the 21st of September 2026"', () => {
    const d = extractDates('On 4 Sept 2026 and again on the 21st of September 2026.');
    expect(d.map((x) => x.iso)).toEqual(['2026-09-04', '2026-09-21']);
  });
});

describe('extractDeadlines', () => {
  it('finds absolute deadlines with a demand cue and ignores passive "was collected by"', () => {
    const text = 'The vehicle was collected by 1 October 2026. We require payment by 18 October 2026. Please respond no later than 5pm on 20 October 2026. The hire ran until 1 October 2026.';
    const d = extractDeadlines(text);
    expect(d.map((x) => [x.iso, x.kind])).toEqual([
      ['2026-10-18', 'absolute'],
      ['2026-10-20', 'absolute']
    ]);
  });

  it('computes relative deadlines in calendar, working days and months from the base date', () => {
    // 2026-10-04 is a Sunday: 7 working days → Mon 5, Tue 6, Wed 7, Thu 8, Fri 9, Mon 12, Tue 13
    expect(addWorkingDaysSimple('2026-10-04', 7)).toBe('2026-10-13');
    expect(addWorkingDaysSimple('2026-10-02', 1)).toBe('2026-10-05'); // Friday + 1 WD = Monday
    expect(addCalendarMonthsSimple('2026-10-31', 1)).toBe('2026-11-30'); // clamps to month end
    expect(addCalendarMonthsSimple('2026-12-15', 1)).toBe('2027-01-15');
    const d = extractDeadlines('Please pay within 14 days. You must reply within seven working days. Settlement is due within one month.', { baseDate: '2026-10-04' });
    expect(d).toHaveLength(3);
    expect(d[0]).toMatchObject({ iso: '2026-10-18', kind: 'relative', days: 14, workingDays: false });
    expect(d[1]).toMatchObject({ iso: '2026-10-13', kind: 'relative', days: 7, workingDays: true });
    expect(d[2]).toMatchObject({ iso: '2026-11-04', kind: 'relative', months: 1 });
  });

  it('uses an injected working-day function (bank holidays) when provided', () => {
    const d = extractDeadlines('Respond within 1 working day.', { baseDate: '2026-12-24', addWorkingDays: () => '2026-12-29' });
    expect(d[0]!.iso).toBe('2026-12-29');
    // no base date → relative deadlines skipped
    expect(extractDeadlines('Respond within 1 working day.')).toEqual([]);
  });
});

describe('extractCitations', () => {
  it('merges a case name with its neutral citation and finds bare neutral citations', () => {
    const c = extractCitations('See Stevens v Equity Syndicate Management [2015] EWCA Civ 93 and Lagden v O\'Connor [2003] UKHL 64; also [2002] 1 AC 384 and Copley v Lawn.');
    expect(c.map((x) => [x.citation, x.kind])).toEqual([
      ['Stevens v Equity Syndicate Management [2015] EWCA Civ 93', 'full'],
      ["Lagden v O'Connor [2003] UKHL 64", 'full'],
      ['[2002] 1 AC 384', 'neutral'],
      ['Copley v Lawn', 'case_name']
    ]);
    expect(c[0]!.neutral).toBe('[2015] EWCA Civ 93');
    expect(c[0]!.caseName).toBe('Stevens v Equity Syndicate Management');
  });
});

describe('day arithmetic', () => {
  it('counts calendar and chargeable days', () => {
    // 20 Sep 14:00 → 26 Sep 12:00 = 5 days 22 hours → 6 chargeable days; calendar date difference 6
    expect(calendarDaysBetween('2026-09-20T14:00:00Z', '2026-09-26T12:00:00Z')).toBe(6);
    expect(chargeableDays('2026-09-20T14:00:00Z', '2026-09-26T12:00:00Z')).toBe(6);
    expect(chargeableDays('2026-09-20T14:00:00Z', '2026-09-26T15:00:00Z')).toBe(7); // 6 days 1 hour → 7
    expect(chargeableDays('2026-09-20T14:00:00Z', '2026-09-20T15:00:00Z')).toBe(1); // minimum 1
  });
});

describe('adversarial: deadline and amount extraction', () => {
  it('modal passives are demands: "must be made by", "should be received by", "is to be paid by"', () => {
    const d = extractDeadlines('Payment must be made by 18 October 2026. The balance should be received by 19 October 2026. The invoice is to be paid by 20 October 2026.');
    expect(d.map((x) => x.iso)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);
  });

  it('past passives are events, not deadlines: "was collected by", "has been paid by"', () => {
    expect(extractDeadlines('The vehicle was collected by 1 October 2026 and the account has been paid by 2 October 2026.')).toEqual([]);
  });

  it('"within 14 days of the date of this letter" is one deadline, not two', () => {
    const d = extractDeadlines('Please remit within 14 days of the date of this letter.', { baseDate: '2026-10-04' });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ iso: '2026-10-18', days: 14, workingDays: false });
  });

  it('weeks are 7n calendar days: eight weeks from 4 October 2026 is 29 November 2026', () => {
    // 4 Oct + 27 days = 31 Oct; + 29 days = 29 Nov
    const d = extractDeadlines('Please provide your final response within eight weeks.', { baseDate: '2026-10-04' });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ iso: '2026-11-29', days: 56 });
  });

  it('a deadline with a time and weekday between "by" and the date is found', () => {
    const d = extractDeadlines('We require your response by 5:00pm on Friday 16 October 2026.');
    expect(d.map((x) => x.iso)).toEqual(['2026-10-16']);
  });

  it('records keyword strength so breakdown lines are not compared with head totals', () => {
    const a = extractAmounts('Recovery charges: call-out £90.00 plus admin £25.00. The outstanding balance is £232.60.');
    expect(a.map((x) => [x.pence, x.context, x.strength])).toEqual([
      [9_000, 'claimed', 'weak'],
      [2_500, 'claimed', 'weak'],
      [23_260, 'claimed', 'strong']
    ]);
    expect(extractAmounts('Call-out £90.')[0]!.strength).toBeUndefined();
  });

  it('"offering £900" is an offer, and a payment verb beats a nearer generic noun', () => {
    expect(extractAmounts('We received your letter of 1 October 2026 offering £900 for the PAV.')[0]!.context).toBe('offered');
    expect(extractAmounts('You have paid the storage charges of £1,287.')[0]!.context).toBe('paid');
  });

  it('chargeable days are counted on the London wall clock across the October clock change', () => {
    // 10:00 BST on 20 October → 10:00 GMT on 30 October is 10 days on the agreement (10 days 1 hour elapsed)
    expect(chargeableDays('2026-10-20T09:00:00Z', '2026-10-30T10:00:00Z')).toBe(10);
    // and across the March change the other way: 10:00 GMT 25 March → 10:00 BST 4 April is 10 days (9 days 23 hours elapsed)
    expect(chargeableDays('2027-03-25T10:00:00Z', '2027-04-04T09:00:00Z')).toBe(10);
    expect(calendarDaysBetween('2026-06-30T23:30:00Z', '2026-07-01T08:00:00Z')).toBe(0); // both 1 July in London
  });
});

describe('relative periods that describe a rule are not deadlines from this letter', () => {
  it('skips GTA/ICOBS rule descriptions and periods anchored to another event, keeps real demands', () => {
    const text = [
      'Industry practice is that a clean pack is settled within one calendar month (GTA 6.7); that month ended on 5 October 2026.',
      'We understand that ICOBS 8.2.6R requires a motor vehicle liability insurer, within three months of receiving a claim for compensation, to make a reasoned offer.',
      'Please pay within 14 days of the date of this letter.',
      'Settlement is due within one month.',
    ].join('\n');
    const d = extractDeadlines(text, { baseDate: '2026-10-04' });
    expect(d.filter((x) => x.kind === 'relative').map((x) => x.iso)).toEqual(['2026-10-18', '2026-11-04']);
  });
});
