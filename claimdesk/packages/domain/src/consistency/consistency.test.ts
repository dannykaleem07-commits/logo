import { describe, it, expect } from 'vitest';
import type { ClaimBundle, ConsistencyFlag, GeneratedDocument } from '../types.js';
import { formatGBP } from '../money.js';
import { checkDraft, clearFlag, legacyCheck, bannedPhraseCheck, legacy, LEGACY_BLOCKED_STRINGS, LEGACY_ALLOWED_EXACT_CASE, type DraftContext } from './index.js';
import { greenBundle, fixtureClock, fixtureDocument, fixtureOffer, fixtureStorage, fixtureHire } from '../evidence/bundle.fixture.js';

const DRAFT_AT = '2026-10-04T10:00:00Z';

function ctx(bundle: ClaimBundle, overrides: Partial<DraftContext> = {}): DraftContext {
  return { bundle, priorOutgoing: [], draftCreatedAt: DRAFT_AT, templateId: 'letter.chaser_7', ...overrides };
}

const codes = (flags: ConsistencyFlag[]) => flags.map((f) => f.code);
const of = (flags: ConsistencyFlag[], code: ConsistencyFlag['code']) => flags.filter((f) => f.code === code);

describe('AMOUNT_PAID_MISMATCH — live File 1 (£1,287 stated, £1,112 received)', () => {
  it('blocks £1,287 paid when the ledger shows £1,112 received', () => {
    const b = greenBundle();
    const report = checkDraft('We acknowledge that you have paid £1,287 in respect of storage.', ctx(b));
    const f = of(report.flags, 'AMOUNT_PAID_MISMATCH');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('block');
    expect(f[0]!.draftValue).toBe('£1,287.00');
    expect(f[0]!.ledgerValue).toBe('£1,112.00');
    expect(f[0]!.message).toContain('the ledger records £1,112.00 received');
    expect(f[0]!.message).toContain('storage £1,112.00 on 1 October 2026 ref REM-77');
    expect(report.blocked).toBe(true);
    expect(report.checkedAt).toBe(DRAFT_AT);
  });

  it('does not flag the correct figure, in text or HTML, net or gross', () => {
    const b = greenBundle();
    expect(of(checkDraft('We acknowledge receipt of £1,112.00 on 1 October 2026.', ctx(b)).flags, 'AMOUNT_PAID_MISMATCH')).toEqual([]);
    expect(of(checkDraft('<p>You have paid &pound;1,112 to date.</p>', ctx(b)).flags, 'AMOUNT_PAID_MISMATCH')).toEqual([]);
    // HTML with the wrong figure still blocks
    expect(checkDraft('<p>You have paid &pound;1,287 to date.</p>', ctx(b)).blocked).toBe(true);
  });

  it('blocks any "paid" figure when nothing has been paid, and accepts a sum of several payments', () => {
    const b = greenBundle();
    b.ledger = b.ledger.filter((e) => e.kind !== 'paid');
    const none = checkDraft('You have paid £500.', ctx(b));
    expect(of(none.flags, 'AMOUNT_PAID_MISMATCH')[0]!.message).toContain('records no payment');
    const b2 = greenBundle();
    b2.ledger.push({ ...b2.ledger[4]!, id: 'led-6', head: 'recovery', kind: 'interim_paid', amountPence: 11_500, reference: 'REM-78' });
    // 111,200 + 11,500 = 122,700 → £1,227.00
    expect(of(checkDraft('We have received £1,227.00 in total.', ctx(b2)).flags, 'AMOUNT_PAID_MISMATCH')).toEqual([]);
    expect(of(checkDraft('We have received £115.00 for recovery.', ctx(b2)).flags, 'AMOUNT_PAID_MISMATCH')).toEqual([]);
  });

  it('ignores negated payment language ("not received £1,287") for the paid check', () => {
    const b = greenBundle();
    const report = checkDraft('We have not received the £1,287 claimed.', ctx(b));
    expect(of(report.flags, 'AMOUNT_PAID_MISMATCH')).toEqual([]);
  });
});

describe('AMOUNT_CLAIMED_MISMATCH', () => {
  // ledger claimed: hire 49,800 (+9,960) · storage 27,000 (+5,400) · recovery 11,500 (+2,300) · engineer 28,500
  // totals: net 116,800 · gross 134,460 · outstanding gross 134,460 − 111,200 = 23,260
  it('accepts per-head, total, gross and outstanding figures', () => {
    const b = greenBundle();
    const text = 'Hire charges claimed: £498.00 net (£597.60 gross). Storage £324.00. The total claimed is £1,344.60 and the outstanding balance is £232.60.';
    expect(of(checkDraft(text, ctx(b)).flags, 'AMOUNT_CLAIMED_MISMATCH')).toEqual([]);
  });

  it('warns on a figure no ledger entry supports, naming the head', () => {
    const b = greenBundle();
    const report = checkDraft('Hire charges claimed total £640.00.', ctx(b));
    const f = of(report.flags, 'AMOUNT_CLAIMED_MISMATCH');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.message).toContain('for hire');
    expect(f[0]!.message).toContain('hire £498.00 net / £597.60 gross');
    expect(f[0]!.message).toContain('total claimed £1,168.00 net / £1,344.60 gross, outstanding £232.60');
    expect(f[0]!.ledgerValue).toBe('£597.60');
    expect(report.blocked).toBe(false);
  });

  it('does not compare daily rates or offered figures', () => {
    const b = greenBundle();
    expect(of(checkDraft('Hire is claimed at £49.80 per day. You offered £20.37 per day.', ctx(b)).flags, 'AMOUNT_CLAIMED_MISMATCH')).toEqual([]);
  });
});

describe('DEADLINE_TOO_EARLY / DEADLINE_MISMATCH', () => {
  const withClock = () => {
    const b = greenBundle();
    b.clocks = [fixtureClock('gta_6_7_settlement_1_month', '2026-10-02T09:00:00Z', '2026-11-02T17:00:00Z', { label: 'GTA 6.7 settlement (1 month from clean pack)', basis: 'GTA 6.7 (16 March 2026 wording) — benchmark' })];
    return b;
  };

  it('blocks a pack covering letter demanding payment before the GTA 6.7 month expires', () => {
    const report = checkDraft('We require payment of the enclosed pack by 18 October 2026.', ctx(withClock(), { templateId: 'pack.gta_payment' }));
    const f = of(report.flags, 'DEADLINE_TOO_EARLY');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('block');
    expect(f[0]!.draftValue).toBe('2026-10-18');
    expect(f[0]!.ledgerValue).toBe('2026-11-02');
    expect(f[0]!.message).toContain('15 days earlier'); // 18 Oct → 2 Nov
    expect(report.blocked).toBe(true);
  });

  it('accepts a deadline within a day of the clock and warns when it drifts', () => {
    const b = withClock();
    expect(codes(checkDraft('Payment is due by 3 November 2026.', ctx(b, { templateId: 'pack.gta_payment' })).flags)).not.toContain('DEADLINE_MISMATCH');
    const late = checkDraft('Payment is due by 10 November 2026.', ctx(b, { templateId: 'pack.gta_payment' }));
    const f = of(late.flags, 'DEADLINE_MISMATCH');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.message).toContain('by 8 days');
  });

  it('relative "within 14 days" is measured from the draft date; unmapped templates only warn', () => {
    const b = withClock();
    const mapped = checkDraft('Please remit within 14 days.', ctx(b, { templateId: 'pack.gta_payment' }));
    expect(of(mapped.flags, 'DEADLINE_TOO_EARLY')[0]!.draftValue).toBe('2026-10-18');
    const unmapped = checkDraft('Please remit within 14 days.', ctx(b, { templateId: 'letter.pav_challenge' }));
    const f = of(unmapped.flags, 'DEADLINE_TOO_EARLY');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(unmapped.blocked).toBe(false);
  });

  it('past dates and stopped clocks are ignored', () => {
    const b = withClock();
    b.clocks[0]!.status = 'met';
    expect(codes(checkDraft('We require payment by 18 October 2026.', ctx(b, { templateId: 'pack.gta_payment' })).flags)).not.toContain('DEADLINE_TOO_EARLY');
    const b2 = withClock();
    expect(codes(checkDraft('Payment was due by 1 September 2026.', ctx(b2, { templateId: 'pack.gta_payment' })).flags)).not.toContain('DEADLINE_TOO_EARLY');
  });
});

describe('OFFER_DENIED_BUT_LOGGED', () => {
  it('blocks "no alternative vehicle was offered" when the register holds an offer', () => {
    const b = greenBundle();
    const report = checkDraft('No alternative vehicle was offered to our customer at any stage.', ctx(b));
    const f = of(report.flags, 'OFFER_DENIED_BUT_LOGGED');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('block');
    expect(f[0]!.message).toContain('esure on 22 September 2026 by phone at £20.37/day inc VAT (small hatchback), client declined');
    expect(report.blocked).toBe(true);
  });

  it('catches the other denial phrasings and is silent with an empty register', () => {
    const b = greenBundle();
    for (const phrase of ['There was no offer of a replacement vehicle.', 'Your insured did not offer our customer a vehicle.', 'You never made an offer of hire.', 'The claimant was not offered a courtesy car.']) {
      expect(of(checkDraft(phrase, ctx(b)).flags, 'OFFER_DENIED_BUT_LOGGED'), phrase).toHaveLength(1);
    }
    b.offers = [];
    expect(of(checkDraft('No alternative vehicle was offered.', ctx(b)).flags, 'OFFER_DENIED_BUT_LOGGED')).toEqual([]);
    // describing the logged offer is fine
    const b2 = greenBundle();
    expect(of(checkDraft('Your offer of 22 September 2026 was declined for the reasons given.', ctx(b2)).flags, 'OFFER_DENIED_BUT_LOGGED')).toEqual([]);
  });
});

describe('STORAGE_END_MISMATCH', () => {
  // storage record: 20 Sep 2026 14:00 → 26 Sep 2026 12:00 → calendar diff 6, inclusive 7, chargeable 6
  it('blocks an end date that differs from the record and accepts the recorded one', () => {
    const b = greenBundle();
    const bad = checkDraft('Storage ran from 20 September 2026 until 28 September 2026.', ctx(b));
    const f = of(bad.flags, 'STORAGE_END_MISMATCH');
    expect(f).toHaveLength(1);
    expect(f[0]!.draftValue).toBe('2026-09-28');
    expect(f[0]!.ledgerValue).toBe('2026-09-26');
    expect(f[0]!.message).toContain('ends on 26 September 2026');
    expect(of(checkDraft('Storage ran from 20 September 2026 until 26 September 2026 (6 days).', ctx(b)).flags, 'STORAGE_END_MISMATCH')).toEqual([]);
  });

  it('blocks a wrong start date and a wrong day count', () => {
    const b = greenBundle();
    const start = checkDraft('Storage commenced on 19 September 2026.', ctx(b));
    expect(of(start.flags, 'STORAGE_END_MISMATCH')[0]!.message).toContain('started on 19 September 2026 but the storage record starts on 20 September 2026');
    const days = checkDraft('We claim 9 days of storage at £45 per day.', ctx(b));
    const f = of(days.flags, 'STORAGE_END_MISMATCH');
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toBe('Draft states 9 days of storage; the storage record gives 6 chargeable days (20 September 2026 to 26 September 2026).');
    // 7 (inclusive calendar days) is also accepted
    expect(of(checkDraft('Storage for 7 days.', ctx(b)).flags, 'STORAGE_END_MISMATCH')).toEqual([]);
  });

  it('blocks an end date while storage is still running, and when there is no record at all', () => {
    const b = greenBundle();
    b.storage = [fixtureStorage({ endAt: undefined, endTrigger: undefined })];
    const f = of(checkDraft('Storage ceased on 26 September 2026.', ctx(b)).flags, 'STORAGE_END_MISMATCH');
    expect(f[0]!.message).toContain('still running');
    b.storage = [];
    expect(of(checkDraft('Storage ceased on 26 September 2026.', ctx(b)).flags, 'STORAGE_END_MISMATCH')[0]!.ledgerValue).toBe('no storage record');
  });

  it('ignores dates near "storage" that are not period claims', () => {
    const b = greenBundle();
    expect(of(checkDraft('We wrote to you about storage on 30 September 2026.', ctx(b)).flags, 'STORAGE_END_MISMATCH')).toEqual([]);
  });
});

describe('HIRE_PERIOD_MISMATCH', () => {
  // hire: 21 Sep 2026 10:00 → 1 Oct 2026 10:00 → 10 days (chargeable 10; inclusive 11)
  it('accepts the recorded period and blocks a different one', () => {
    const b = greenBundle();
    expect(of(checkDraft('The vehicle was on hire from 21 September 2026 to 1 October 2026, a period of 10 days.', ctx(b)).flags, 'HIRE_PERIOD_MISMATCH')).toEqual([]);
    const bad = checkDraft('The vehicle was hired from 21 September 2026 to 3 October 2026 (12 days).', ctx(b));
    const f = of(bad.flags, 'HIRE_PERIOD_MISMATCH');
    expect(f).toHaveLength(2);
    expect(f[0]!.message).toContain('hire ended on 3 October 2026 but the hire agreement ends on 1 October 2026');
    expect(f[1]!.message).toBe('Draft states 12 days of hire; the hire agreement gives 10 chargeable days (21 September 2026 to 1 October 2026).');
    expect(bad.blocked).toBe(true);
  });

  it('blocks an end date for a running hire', () => {
    const b = greenBundle();
    b.hire = [fixtureHire({ endAt: undefined, collectedAt: undefined })];
    const f = of(checkDraft('Hire ended on 1 October 2026.', ctx(b)).flags, 'HIRE_PERIOD_MISMATCH');
    expect(f[0]!.message).toContain('still running');
  });
});

describe('PAYEE_MISMATCH', () => {
  it('blocks a payee that is not the registered name on invoice templates only', () => {
    const b = greenBundle();
    const bad = checkDraft('Payee: Courtesy Cars UK Ltd\nSort code 20-00-00\nAccount number 12345678', ctx(b, { templateId: 'invoice.hire' }));
    const f = of(bad.flags, 'PAYEE_MISMATCH');
    expect(f).toHaveLength(1);
    expect(f[0]!.draftValue).toBe('Courtesy Cars UK Ltd');
    expect(f[0]!.ledgerValue).toBe('Courtesy Cars Group UK Ltd');
    expect(of(checkDraft('Account name: Courtesy Cars Group UK Ltd.\nSort code 20-00-00', ctx(b, { templateId: 'invoice.storage' })).flags, 'PAYEE_MISMATCH')).toEqual([]);
    // registered name override
    expect(of(checkDraft('Payable to: Some Other Co Ltd', ctx(b, { templateId: 'invoice.recovery', registeredName: 'Some Other Co Ltd' })).flags, 'PAYEE_MISMATCH')).toEqual([]);
    // letters are not checked for payee
    expect(of(checkDraft('Payee: Courtesy Cars UK Ltd', ctx(b, { templateId: 'letter.chaser_7' })).flags, 'PAYEE_MISMATCH')).toEqual([]);
  });
});

describe('DATE_BEFORE_CREATION and DUPLICATE_SIGNATURE_DATE', () => {
  it('blocks an agreement dated or signed before its creation', () => {
    const b = greenBundle();
    const r = checkDraft('This agreement is dated 1 October 2026.\nSigned on 1 October 2026 by the hirer.', ctx(b, { templateId: 'agreement.credit_hire' }));
    const f = of(r.flags, 'DATE_BEFORE_CREATION');
    expect(f).toHaveLength(2);
    expect(f[0]!.severity).toBe('block');
    expect(f[0]!.message).toContain('before this document was created (4 October 2026)');
    // the creation day itself is fine
    expect(of(checkDraft('Dated: 4 October 2026', ctx(b, { templateId: 'agreement.credit_hire' })).flags, 'DATE_BEFORE_CREATION')).toEqual([]);
    // forms use the strict keywords only
    expect(of(checkDraft('Date of signature: 1 October 2026', ctx(b, { templateId: 'form.statement_of_means' })).flags, 'DATE_BEFORE_CREATION')).toHaveLength(1);
    expect(of(checkDraft('The agreement dated 21 September 2026 is enclosed.', ctx(b, { templateId: 'form.statement_of_means' })).flags, 'DATE_BEFORE_CREATION')).toEqual([]);
    // a letter referring to an earlier signing date is legitimate
    expect(of(checkDraft('The hire agreement was signed on 21 September 2026.', ctx(b, { templateId: 'letter.chaser_7' })).flags, 'DATE_BEFORE_CREATION')).toEqual([]);
  });

  it('warns when two agreements on the file share a signing date', () => {
    const b = greenBundle();
    const first = b.documents.find((d) => d.templateId === 'agreement.credit_hire')!;
    b.documents.push(fixtureDocument('doc-sto', 'agreement.storage', { title: 'Storage agreement', signature: { ...first.signature!, signedAt: '2026-09-21T16:00:00Z' } }));
    const r = checkDraft('Chaser text.', ctx(b));
    const f = of(r.flags, 'DUPLICATE_SIGNATURE_DATE');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.message).toContain('2 agreements on this file are signed on 21 September 2026');
    expect(r.blocked).toBe(false);
  });
});

describe('CONTRADICTS_PRIOR_LETTER', () => {
  const prior = (): GeneratedDocument =>
    fixtureDocument('doc-ch7', 'letter.chaser_7', {
      title: 'Chaser (day 7)',
      status: 'sent',
      sentAt: '2026-10-01T09:00:00Z',
      html: '<p>Hire charges of £597.60 remain outstanding. Storage of £324.00 is also due.</p>',
      dataSnapshot: { heads: { hire: { totalPence: 59_760, days: 10, dailyRatePence: 4_980 }, storage: { totalPence: 32_400 } } }
    });

  it('warns when a head figure differs from the last letter sent, and is silent when it matches', () => {
    const b = greenBundle();
    const r = checkDraft('Hire charges of £640.00 remain outstanding. Storage of £324.00 is also due.', ctx(b, { templateId: 'letter.chaser_14', priorOutgoing: [prior()] }));
    const f = of(r.flags, 'CONTRADICTS_PRIOR_LETTER');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.message).toContain('Draft puts hire at £640.00');
    expect(f[0]!.message).toContain('"Chaser (day 7)", letter.chaser_7, 1 October 2026');
    expect(f[0]!.ledgerValue).toContain('£597.60');
    const ok = checkDraft('Hire charges of £597.60 remain outstanding. Storage of £324.00 is also due.', ctx(b, { templateId: 'letter.chaser_14', priorOutgoing: [prior()] }));
    expect(of(ok.flags, 'CONTRADICTS_PRIOR_LETTER')).toEqual([]);
  });

  it('ignores drafts and letters on other claims', () => {
    const b = greenBundle();
    const draftOnly = { ...prior(), status: 'draft' as const };
    const otherClaim = { ...prior(), claimId: 'claim-2' };
    const r = checkDraft('Hire charges of £640.00 remain outstanding.', ctx(b, { priorOutgoing: [draftOnly, otherClaim] }));
    expect(of(r.flags, 'CONTRADICTS_PRIOR_LETTER')).toEqual([]);
  });
});

describe('LEGACY_DETAIL — lesson i', () => {
  it('blocks every legacy string but allows the exact "CARFLEX LTD"', () => {
    const text = 'Formerly Car Flex, trading as Carflex Ltd (company 17360033) of 66 Paul Street, London EC2A 4PX; www.courtesycarsuk.co.uk. Engineer: CARFLEX LTD (12640635).';
    const flags = legacyCheck(text);
    expect(flags.map((f) => f.draftValue)).toEqual(['Car Flex', 'Carflex Ltd', '17360033', '66 Paul Street', 'EC2A 4PX', 'courtesycarsuk.co.uk']);
    expect(flags.every((f) => f.code === 'LEGACY_DETAIL' && f.severity === 'block')).toBe(true);
    expect(flags[2]!.message).toContain('17430389');
    // case variants of the company name are still blocked
    expect(legacyCheck('carflex ltd').map((f) => f.draftValue)).toEqual(['carflex ltd']);
    expect(legacyCheck('CARFLEX LTD')).toEqual([]);
    expect(legacyCheck('Car-Flex and CAR  FLEX').map((f) => f.draftValue)).toEqual(['Car-Flex', 'CAR  FLEX']);
    expect(legacyCheck('ec2a4px')).toHaveLength(1);
  });

  it('keeps the dictionary identical to packages/documents brand.legacy', () => {
    expect(LEGACY_BLOCKED_STRINGS).toEqual(['Car Flex', 'Carflex Ltd', '17360033', '66 Paul Street', 'EC2A 4PX', 'courtesycarsuk.co.uk']);
    expect(LEGACY_ALLOWED_EXACT_CASE).toEqual(['CARFLEX LTD']);
    expect(legacy.bannedPhrases).toEqual([
      'ignore any offer of a courtesy car',
      'do not accept a vehicle from the insurer',
      'our solicitors',
      'we act as your solicitors',
      'regulated by the SRA',
      'legal advice from our lawyers'
    ]);
  });

  it('surfaces through checkDraft as a block', () => {
    const r = checkDraft('Please remit to Carflex Ltd.', ctx(greenBundle()));
    expect(of(r.flags, 'LEGACY_DETAIL')).toHaveLength(1);
    expect(r.blocked).toBe(true);
  });
});

describe('BANNED_PHRASE and REGULATED_STATUS_IMPLIED', () => {
  it('blocks the disclaimer phrases', () => {
    const flags = bannedPhraseCheck('You should ignore any offer of a courtesy car and do not accept a vehicle from the insurer.');
    expect(of(flags, 'BANNED_PHRASE').map((f) => f.draftValue)).toEqual(['ignore any offer of a courtesy car', 'do not accept a vehicle from the insurer']);
    expect(flags[0]!.severity).toBe('block');
  });

  it('blocks regulated-status wording but allows the mandatory negated status line', () => {
    const text = 'Our solicitors will issue proceedings; we act as your solicitors and you have legal advice from our lawyers. Courtesy Cars Group UK Ltd is not a firm of solicitors and is not regulated by the SRA.';
    const flags = bannedPhraseCheck(text);
    const blocks = flags.filter((f) => f.code === 'REGULATED_STATUS_IMPLIED' && f.severity === 'block');
    expect(blocks.map((f) => f.draftValue)).toEqual(['Our solicitors', 'we act as your solicitors', 'legal advice from our lawyers']);
    expect(flags.some((f) => f.draftValue === 'regulated by the SRA')).toBe(false);
    // positive assertion of SRA regulation is blocked
    expect(bannedPhraseCheck('We are regulated by the SRA.').map((f) => f.draftValue)).toEqual(['regulated by the SRA']);
  });

  it('warns on "our client" with the suggested wording', () => {
    const flags = bannedPhraseCheck("Our client's vehicle was struck. We write on behalf of our clients.");
    expect(flags).toHaveLength(2);
    expect(flags[0]).toMatchObject({ code: 'REGULATED_STATUS_IMPLIED', severity: 'warn', ledgerValue: 'the claimant / our customer' });
    expect(flags[0]!.message).toContain('Legal Services Act 2007 s.12');
    const r = checkDraft('We write on behalf of our client.', ctx(greenBundle()));
    expect(r.blocked).toBe(false);
  });
});

describe('FORUM_NOT_OPEN — DISP 2.7', () => {
  it('blocks a FOS threat to the at-fault insurer, by explicit role or inferred template', () => {
    const b = greenBundle();
    const explicit = checkDraft('Failing which we will refer the matter to the Financial Ombudsman Service.', ctx(b, { templateId: 'letter.other', recipientRole: 'at_fault_insurer' }));
    expect(of(explicit.flags, 'FORUM_NOT_OPEN')).toHaveLength(1);
    expect(explicit.flags[0]!.message).toContain('DISP 2.7');
    expect(explicit.blocked).toBe(true);
    const inferred = checkDraft('We reserve the right to refer this to the FOS.', ctx(b, { templateId: 'letter.complaint_disp' }));
    expect(of(inferred.flags, 'FORUM_NOT_OPEN')).toHaveLength(1);
  });

  it('allows FOS in a complaint to the client\'s own insurer', () => {
    const b = greenBundle();
    const r = checkDraft('Our customer may refer this to the Financial Ombudsman Service after your final response.', ctx(b, { templateId: 'letter.complaint_disp', recipientRole: 'own_insurer' }));
    expect(of(r.flags, 'FORUM_NOT_OPEN')).toEqual([]);
  });
});

describe('GTA_CITED_AS_LAW — GTA 2.7(j)', () => {
  it('blocks GTA-as-entitlement wording for a non-subscriber', () => {
    const b = greenBundle(); // gtaSubscriber: false
    const r = checkDraft('You are obliged under the GTA to settle within one month, and payment is due pursuant to the GTA.', ctx(b));
    const f = of(r.flags, 'GTA_CITED_AS_LAW');
    expect(f).toHaveLength(2);
    expect(f[0]!.severity).toBe('block');
    expect(f[0]!.message).toContain('GTA 2.7(j)');
    expect(f.map((x) => x.draftValue)).toEqual(['obliged under the GTA', 'pursuant to the GTA']);
    for (const phrase of ['We are entitled under the GTA to the full rate.', 'The GTA requires payment within one month.', 'In accordance with GTA paragraph 6.7 you must pay.', 'You are in breach of the GTA.']) {
      expect(of(checkDraft(phrase, ctx(b)).flags, 'GTA_CITED_AS_LAW'), phrase).toHaveLength(1);
    }
  });

  it('allows the benchmark framing and does not apply to subscribers', () => {
    const b = greenBundle();
    expect(of(checkDraft('As an industry benchmark, GTA 6.7 provides for settlement within one month and we invite you to meet it. Pursuant to the GTA, as a benchmark only, late payment attracts 10%.', ctx(b)).flags, 'GTA_CITED_AS_LAW')).toEqual([]);
    b.claim.gtaSubscriber = true;
    expect(of(checkDraft('You are obliged under the GTA to settle within one month.', ctx(b)).flags, 'GTA_CITED_AS_LAW')).toEqual([]);
  });
});

describe('UNVERIFIED_CITATION', () => {
  const kb = [
    { citation: 'Stevens v Equity Syndicate Management [2015] EWCA Civ 93', verified: true },
    { citation: 'Irani v Duchon [2019] EWCA Civ 1846', verified: false }
  ];

  it('warns for unverified and unknown citations, once each, and passes verified ones', () => {
    const b = greenBundle();
    const text = 'See Stevens v Equity Syndicate Management [2015] EWCA Civ 93; Irani v Duchon [2019] EWCA Civ 1846; and Copley v Lawn [2009] EWCA Civ 580. Copley v Lawn is on point.';
    const r = checkDraft(text, ctx(b, { kbCitations: kb }));
    const f = of(r.flags, 'UNVERIFIED_CITATION');
    expect(f.map((x) => x.draftValue)).toEqual(['Irani v Duchon [2019] EWCA Civ 1846', 'Copley v Lawn [2009] EWCA Civ 580', 'Copley v Lawn']);
    expect(f[0]!.message).toContain('in the knowledge base but not verified');
    expect(f[1]!.message).toContain('not in the knowledge base');
    expect(f.every((x) => x.severity === 'warn')).toBe(true);
    expect(r.blocked).toBe(false);
    // a bare case name that the kb holds as verified passes
    expect(of(checkDraft('Stevens v Equity applies.', ctx(b, { kbCitations: kb })).flags, 'UNVERIFIED_CITATION')).toEqual([]);
    // no kb at all → everything is unverified
    expect(of(checkDraft('Stevens v Equity applies.', ctx(b)).flags, 'UNVERIFIED_CITATION')).toHaveLength(1);
  });
});

describe('UNKNOWN_REFERENCE', () => {
  it('warns when the quoted insurer reference differs from the claim record', () => {
    const b = greenBundle();
    expect(of(checkDraft('Your ref: ESR/2026/44871. Our ref: CCG-2026-00012.', ctx(b)).flags, 'UNKNOWN_REFERENCE')).toEqual([]);
    const f = of(checkDraft('Your ref: ESR/2026/44872', ctx(b)).flags, 'UNKNOWN_REFERENCE');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warn', draftValue: 'ESR/2026/44872', ledgerValue: 'ESR/2026/44871' });
    // not checked for letters to the client
    expect(of(checkDraft('Your ref: ESR/2026/44872', ctx(b, { recipientRole: 'client' })).flags, 'UNKNOWN_REFERENCE')).toEqual([]);
  });
});

describe('clearFlag and report shape', () => {
  it('clears a block with a logged reason and recomputes blocked, without mutating the input', () => {
    const b = greenBundle();
    const report = checkDraft('You have paid £1,287. No alternative vehicle was offered.', ctx(b));
    expect(codes(report.flags).sort()).toEqual(['AMOUNT_PAID_MISMATCH', 'OFFER_DENIED_BUT_LOGGED']);
    expect(report.blocked).toBe(true);
    const paid = report.flags.find((f) => f.code === 'AMOUNT_PAID_MISMATCH')!;
    const once = clearFlag(report, 'AMOUNT_PAID_MISMATCH', paid.excerpt, 'u-approver', 'Second remittance of £175 confirmed by bank on 3 Oct; ledger entry to follow', '2026-10-04T11:00:00Z');
    expect(once.blocked).toBe(true); // the offer denial still blocks
    expect(once.flags.find((f) => f.code === 'AMOUNT_PAID_MISMATCH')).toMatchObject({ clearedBy: 'u-approver', clearedAt: '2026-10-04T11:00:00Z', clearedReason: 'Second remittance of £175 confirmed by bank on 3 Oct; ledger entry to follow' });
    expect(report.flags.find((f) => f.code === 'AMOUNT_PAID_MISMATCH')!.clearedAt).toBeUndefined(); // immutable
    expect(report.blocked).toBe(true);
    const twice = clearFlag(once, 'OFFER_DENIED_BUT_LOGGED', undefined, 'u-approver', 'Letter rewritten to state the declined offer', '2026-10-04T11:05:00Z');
    expect(twice.blocked).toBe(false);
    expect(twice.flags.every((f) => f.clearedAt)).toBe(true);
    // a non-matching excerpt clears nothing
    expect(clearFlag(report, 'AMOUNT_PAID_MISMATCH', 'nope', 'u', 'r', '2026-10-04T11:00:00Z').blocked).toBe(true);
    expect(() => clearFlag(report, 'AMOUNT_PAID_MISMATCH', undefined, 'u', '  ', '2026-10-04T11:00:00Z')).toThrow();
  });

  it('a clean letter produces an empty, unblocked report ordered block → warn', () => {
    const b = greenBundle();
    const clean = checkDraft(
      'We refer to your ref ESR/2026/44871. The claimant\'s vehicle was on hire from 21 September 2026 to 1 October 2026 (10 days at £49.80 per day). Storage ran from 20 September 2026 until 26 September 2026 (6 days). We acknowledge receipt of £1,112.00 on 1 October 2026 and the outstanding balance is £232.60. Your offer of 22 September 2026 was declined for the reasons stated in the enclosed questionnaire. Courtesy Cars Group UK Ltd is not a firm of solicitors and is not regulated by the SRA.',
      ctx(b, { templateId: 'letter.chaser_7', now: '2026-10-04T10:30:00Z' })
    );
    expect(clean.flags).toEqual([]);
    expect(clean.blocked).toBe(false);
    expect(clean.checkedAt).toBe('2026-10-04T10:30:00Z');
    const mixed = checkDraft('Our client has paid £1,287.', ctx(b));
    expect(mixed.flags.map((f) => f.severity)).toEqual(['block', 'warn']);
  });

  it('many offers are all listed and one logged offer suffices', () => {
    const b = greenBundle();
    b.offers.push(fixtureOffer({ id: 'offer-2', offerorName: 'Enterprise (for esure)', receivedAt: '2026-09-24T09:00:00Z', channel: 'email', dailyRatePence: 2330, rateIncludesVat: false }));
    const r = checkDraft('No offer of a replacement vehicle was made.', ctx(b));
    expect(of(r.flags, 'OFFER_DENIED_BUT_LOGGED')[0]!.message).toContain('2 offers');
    expect(of(r.flags, 'OFFER_DENIED_BUT_LOGGED')[0]!.message).toContain('Enterprise (for esure) on 24 September 2026 by email at £23.30/day');
  });
});

describe('adversarial verification — misses, false positives and clock traps', () => {
  const gta67 = () => {
    const b = greenBundle();
    b.clocks = [fixtureClock('gta_6_7_settlement_1_month', '2026-10-02T09:00:00Z', '2026-11-02T17:00:00Z', { label: 'GTA 6.7 settlement (1 month from clean pack)', basis: 'GTA 6.7 (16 March 2026 wording) — benchmark' })];
    return b;
  };

  it('"Payment must be made by 18 October 2026" is a deadline and is blocked before the GTA 6.7 month runs', () => {
    const r = checkDraft('Payment must be made by 18 October 2026.', ctx(gta67(), { templateId: 'pack.gta_payment' }));
    const f = of(r.flags, 'DEADLINE_TOO_EARLY');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('block');
    expect(f[0]!.message).toContain('15 days earlier');
    expect(r.blocked).toBe(true);
    // the same date in a past-tense event sentence is not a deadline
    expect(of(checkDraft('The vehicle was collected by 18 October 2026.', ctx(gta67(), { templateId: 'pack.gta_payment' })).flags, 'DEADLINE_TOO_EARLY')).toEqual([]);
  });

  it('"within 14 days of the date of this letter" produces exactly one deadline flag', () => {
    const r = checkDraft('Please remit within 14 days of the date of this letter.', ctx(gta67(), { templateId: 'pack.gta_payment' }));
    expect(of(r.flags, 'DEADLINE_TOO_EARLY')).toHaveLength(1);
    expect(of(r.flags, 'DEADLINE_TOO_EARLY')[0]!.draftValue).toBe('2026-10-18');
  });

  it('the £1,287 case is caught when "paid" is further from the figure than "charges"', () => {
    const r = checkDraft('You have paid the storage charges of £1,287.', ctx(greenBundle()));
    expect(of(r.flags, 'AMOUNT_PAID_MISMATCH')).toHaveLength(1);
    expect(r.blocked).toBe(true);
  });

  it('the £1,287 case is caught in a two-cell HTML table ("Amount received" | "£1,287.00")', () => {
    const html = '<table><tr><td>Amount received</td><td>&pound;1,287.00</td></tr><tr><td>Balance outstanding</td><td>&pound;232.60</td></tr></table>';
    const r = checkDraft(html, ctx(greenBundle()));
    expect(of(r.flags, 'AMOUNT_PAID_MISMATCH').map((f) => f.draftValue)).toEqual(['£1,287.00']);
    expect(of(r.flags, 'AMOUNT_CLAIMED_MISMATCH')).toEqual([]);
  });

  it('invoice VAT lines and itemised breakdown lines are not claimed-total mismatches', () => {
    const b = greenBundle();
    // hire 49,800 net + VAT 9,960 = 59,760; total VAT across the ledger 9,960 + 5,400 + 2,300 = 17,660
    const text = 'Hire £498.00, VAT £99.60, total £597.60. Total VAT £176.60. Recovery charges: call-out £90.00 plus admin £25.00. Recovery total £115.00.';
    expect(of(checkDraft(text, ctx(b, { templateId: 'invoice.hire' })).flags, 'AMOUNT_CLAIMED_MISMATCH')).toEqual([]);
    // but a wrong total still warns
    expect(of(checkDraft('Recovery total £135.00.', ctx(b, { templateId: 'invoice.recovery' })).flags, 'AMOUNT_CLAIMED_MISMATCH')).toHaveLength(1);
  });

  it('"You have not made any offer in respect of the pre-accident value" is not an intervention denial', () => {
    expect(of(checkDraft('You have not made any offer in respect of the pre-accident value.', ctx(greenBundle())).flags, 'OFFER_DENIED_BUT_LOGGED')).toEqual([]);
    expect(of(checkDraft('You have not made any offer of a replacement vehicle.', ctx(greenBundle())).flags, 'OFFER_DENIED_BUT_LOGGED')).toHaveLength(1);
  });

  it('storage that ended at 00:30 BST on 1 July is "until 1 July 2026", and the UTC date 30 June is wrong', () => {
    const b = greenBundle();
    b.storage = [fixtureStorage({ startAt: '2026-06-24T14:00:00Z', endAt: '2026-06-30T23:30:00Z' })];
    expect(of(checkDraft('Storage ran from 24 June 2026 until 1 July 2026.', ctx(b)).flags, 'STORAGE_END_MISMATCH')).toEqual([]);
    const wrong = of(checkDraft('Storage ran from 24 June 2026 until 30 June 2026.', ctx(b)).flags, 'STORAGE_END_MISMATCH');
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.message).toContain('ends on 1 July 2026');
  });

  it('hire across the October clock change: 10:00 BST 20 Oct → 10:00 GMT 30 Oct is 10 days, and 11 is an inflated head', () => {
    const b = greenBundle();
    b.hire = [fixtureHire({ startAt: '2026-10-20T09:00:00Z', deliveredAt: '2026-10-20T09:00:00Z', endAt: '2026-10-30T10:00:00Z', collectedAt: '2026-10-30T10:00:00Z' })];
    const c = ctx(b, { draftCreatedAt: '2026-11-01T10:00:00Z' });
    expect(of(checkDraft('The vehicle was on hire from 20 October 2026 to 30 October 2026 (10 days).', c).flags, 'HIRE_PERIOD_MISMATCH')).toEqual([]);
    const inflated = of(checkDraft('The vehicle was on hire for 11 days.', c).flags, 'HIRE_PERIOD_MISMATCH');
    expect(inflated).toHaveLength(1);
    expect(inflated[0]!.message).toBe('Draft states 11 days of hire; the hire agreement gives 10 chargeable days (20 October 2026 to 30 October 2026).');
  });

  it('a chaser sent on day 7 stating "within 7 days" matches the day-14 rung and is clean', () => {
    const b = greenBundle();
    b.clocks = [
      fixtureClock('chaser_day_7', '2026-10-01T09:00:00Z', '2026-10-08T17:00:00+01:00'),
      fixtureClock('chaser_day_14', '2026-10-01T09:00:00Z', '2026-10-15T17:00:00+01:00')
    ];
    expect(checkDraft('Please remit within 7 days.', ctx(b, { templateId: 'letter.chaser_7', draftCreatedAt: '2026-10-08T10:00:00Z' })).flags).toEqual([]);
  });

  it('a complaint stating "within eight weeks" agrees with the DISP clock; "within four weeks" is too early', () => {
    const b = greenBundle();
    // complaint sent 4 Oct 2026; DISP 1.6.2R eight weeks → 29 Nov 2026
    b.clocks = [fixtureClock('disp_final_response_8_weeks', '2026-10-04T10:00:00Z', '2026-11-29T17:00:00Z', { label: 'DISP final response (8 weeks)', basis: 'DISP 1.6.2R' })];
    expect(checkDraft('Please provide your final response within eight weeks.', ctx(b, { templateId: 'letter.complaint_disp' })).flags).toEqual([]);
    const early = of(checkDraft('Please provide your final response within four weeks.', ctx(b, { templateId: 'letter.complaint_disp' })).flags, 'DEADLINE_TOO_EARLY');
    expect(early).toHaveLength(1);
    expect(early[0]!.draftValue).toBe('2026-11-01');
    expect(early[0]!.message).toContain('28 days earlier');
  });

  it('GTA as law: "GTA 6.7 requires", "under the GTA you are required", "GTA entitles" each block once', () => {
    const b = greenBundle();
    for (const phrase of ['GTA 6.7 requires settlement within one month.', 'Under the GTA you are required to settle within one month.', 'The GTA entitles us to the full rate.', 'GTA paragraph 6.8.6 entitles us to a 10% uplift.']) {
      expect(of(checkDraft(phrase, ctx(b)).flags, 'GTA_CITED_AS_LAW'), phrase).toHaveLength(1);
    }
    expect(of(checkDraft('The GTA requires payment within one month.', ctx(b)).flags, 'GTA_CITED_AS_LAW')).toHaveLength(1);
    // the templates' own framing passes
    expect(of(checkDraft('Industry practice is that a clean pack is settled within one calendar month (GTA 6.7). The GTA is an industry benchmark for a non-subscriber.', ctx(b)).flags, 'GTA_CITED_AS_LAW')).toEqual([]);
  });

  it('the claim\'s own parties in a heading are not an unverified case citation', () => {
    const b = greenBundle(); // claimant Amir Hussain, insurer esure Insurance Ltd
    const r = checkDraft('Re: Hussain v Esure Insurance Ltd. Copley v Lawn applies.', ctx(b));
    expect(of(r.flags, 'UNVERIFIED_CITATION').map((f) => f.draftValue)).toEqual(['Copley v Lawn']);
  });

  it('regulated status: giving legal advice is blocked, recommending independent legal advice is not', () => {
    expect(bannedPhraseCheck('We can provide you with legal advice on the claim.').map((f) => [f.code, f.severity])).toEqual([['REGULATED_STATUS_IMPLIED', 'block']]);
    expect(bannedPhraseCheck('We are a firm of solicitors.').map((f) => f.draftValue)).toEqual(['We are a firm of solicitors']);
    expect(bannedPhraseCheck('We are regulated by the Solicitors Regulation Authority.')).toHaveLength(1);
    expect(bannedPhraseCheck('You may wish to seek independent legal advice. We do not provide legal advice and we are not a firm of solicitors.')).toEqual([]);
  });

  it('the invoice payee check tolerates table layout and still catches the trading name', () => {
    const b = greenBundle();
    const ok = '<table><tr><td>Account name</td><td>Courtesy Cars Group UK Ltd</td></tr><tr><td>Sort code</td><td>20-00-00</td></tr></table>';
    expect(of(checkDraft(ok, ctx(b, { templateId: 'invoice.hire' })).flags, 'PAYEE_MISMATCH')).toEqual([]);
    const bad = '<table><tr><td>Account name</td><td>Courtesy Cars UK</td></tr><tr><td>Sort code</td><td>20-00-00</td></tr></table>';
    expect(of(checkDraft(bad, ctx(b, { templateId: 'invoice.hire' })).flags, 'PAYEE_MISMATCH')[0]!.draftValue).toBe('Courtesy Cars UK');
  });

  it('a legitimate full letter built from the live-file figures stays clean', () => {
    const b = greenBundle();
    // the pack covering letter is the dispatch: the GTA 6.7 month runs from its date, 4 Oct → 4 Nov 2026
    b.clocks = [fixtureClock('gta_6_7_settlement_1_month', DRAFT_AT, '2026-11-04T17:00:00Z', { label: 'GTA 6.7 settlement (1 month from clean pack)', basis: 'GTA 6.7 (16 March 2026 wording) — benchmark' })];
    const text = [
      'Your ref: ESR/2026/44871. Our ref: CCG-2026-00012.',
      'We are instructed to correspond on behalf of the claimant, Mr Amir Hussain.',
      'The claimant\'s vehicle was on hire from 21 September 2026 to 1 October 2026 (10 days at £49.80 per day plus VAT). Storage ran from 20 September 2026 until 26 September 2026 (6 days at £45.00 per day).',
      'Hire £498.00, VAT £99.60, total £597.60. Storage £270.00, VAT £54.00, total £324.00. Recovery £115.00. Engineer fee £285.00.',
      'We acknowledge receipt of £1,112.00 on 1 October 2026. The outstanding balance is £232.60.',
      'Your offer of a small hatchback at £20.37 per day on 22 September 2026 was declined for the reasons in the enclosed questionnaire.',
      'Industry practice is that a clean pack is settled within one calendar month (GTA 6.7); payment must be made by 4 November 2026.',
      'Courtesy Cars Group UK Ltd is not a firm of solicitors and is not regulated by the SRA.'
    ].join('\n');
    const r = checkDraft(text, ctx(b, { templateId: 'pack.gta_payment' }));
    expect(r.flags).toEqual([]);
    expect(r.blocked).toBe(false);
  });
});

describe('PAYEE_MISMATCH — prose and HTML entities are not payee fields (live pack false positives)', () => {
  it('ignores explanatory prose and reads the name up to a middle-dot separator', () => {
    const b = greenBundle();
    const html =
      '<p>Payment details Account name: Courtesy Cars Group UK Ltd &middot; Sort code 00-00-00 &middot; Account number 00000000</p>' +
      '<p>The account name is our exact registered name, so Confirmation of Payee returns a full match.</p>';
    expect(of(checkDraft(html, ctx(b, { templateId: 'pack.gta_payment' })).flags, 'PAYEE_MISMATCH')).toEqual([]);
  });
  it('still blocks a trading name in a labelled field followed by a middle dot', () => {
    const b = greenBundle();
    const html = '<p>Account name: Courtesy Cars UK &middot; Sort code 00-00-00</p>';
    const f = of(checkDraft(html, ctx(b, { templateId: 'pack.gta_payment' })).flags, 'PAYEE_MISMATCH');
    expect(f).toHaveLength(1);
    expect(f[0]!.draftValue).toBe('Courtesy Cars UK');
  });
  it('reads "payable to" in prose but not "pay to"', () => {
    const b = greenBundle();
    expect(of(checkDraft('Cheques payable to Courtesy Cars Ltd.', ctx(b, { templateId: 'invoice.hire' })).flags, 'PAYEE_MISMATCH')[0]!.draftValue).toBe('Courtesy Cars Ltd');
    expect(of(checkDraft('You agreed to pay to the claimant the sum due.', ctx(b, { templateId: 'invoice.hire' })).flags, 'PAYEE_MISMATCH')).toEqual([]);
  });
});

describe('ledger totals do not double-count an invoice of a claimed head', () => {
  it('a claimed hire figure plus its invoice is one figure, so the true outstanding balance raises no warning', () => {
    const b = greenBundle();
    const hireClaimed = b.ledger.filter((e) => e.head === 'hire' && e.kind === 'claimed');
    if (hireClaimed.length === 0) return; // fixture without a hire claim: nothing to check
    const inv = { ...hireClaimed[0]!, id: 'inv-dup', kind: 'invoiced' as const, description: 'Hire invoice' };
    const withInvoice = { ...b, ledger: [...b.ledger, inv] };
    const claimedTotal = withInvoice.ledger.filter((e) => e.kind === 'claimed').reduce((a, e) => a + e.amountPence, 0);
    const text = `The total claimed is ${formatGBP(claimedTotal)}.`;
    const flags = checkDraft(text, ctx(withInvoice, { templateId: 'letter.chaser_7' })).flags.filter((f) => f.code === 'AMOUNT_CLAIMED_MISMATCH');
    expect(flags).toEqual([]);
  });
});

describe('CONTRADICTS_PRIOR_LETTER ignores unit figures and nil columns', () => {
  it('does not compare "× £45", "at £49.80", "£90 call-out" or £0.00 with a prior letter\'s head totals', () => {
    const b = greenBundle();
    const prior = fixtureDocument('prior-pack', 'pack.gta_payment', { claimId: b.claim.id, status: 'sent', html: '<p>Storage £450.00. Hire £1,145.40. Recovery £151.00.</p>', sentAt: '2026-09-05T10:00:00Z', dataSnapshot: {} });
    const text = 'Storage 10 days × £45 · 10 days at £45.00 per day. Hire 23 days × £49.80. Recovery: £90 call-out + 12 loaded miles × £3 + £25 admin. Claimed £6,500.00 £0.00 £6,500.00.';
    const flags = checkDraft(text, ctx(b, { templateId: 'schedule.loss', priorOutgoing: [prior] })).flags.filter((f) => f.code === 'CONTRADICTS_PRIOR_LETTER');
    expect(flags.map((f) => f.draftValue)).not.toContain('£45.00');
    expect(flags.map((f) => f.draftValue)).not.toContain('£49.80');
    expect(flags.map((f) => f.draftValue)).not.toContain('£90.00');
    expect(flags.map((f) => f.draftValue)).not.toContain('£0.00');
    // control: a genuinely different storage total IS still flagged against the prior letter
    const changed = checkDraft('Storage £520.00 is now claimed.', ctx(b, { templateId: 'schedule.loss', priorOutgoing: [prior] })).flags.filter((f) => f.code === 'CONTRADICTS_PRIOR_LETTER');
    expect(changed.map((f) => f.draftValue)).toContain('£520.00');
  });
});
