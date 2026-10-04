/**
 * Litigation-stage builders (services/builders/litigation.ts) on the File 1 archetype: every amount and date comes from
 * the claim (ledger, events, offers, clocks, documents, evidence); the handler supplies only the free text the template
 * declares and that only they can write. Each draft must be created (201) with no open 'block' consistency flag.
 *
 * File 1 (packages/db/src/fixtures/fileOne.ts): NCAF sent 11 Aug 2026; pack sent 5 Sep 2026; £1,112.00 received on hire
 * 25 Sep 2026; position (net) hire £1,145.40, storage £450.00, recovery £151.00, engineer £285.00, PAV £6,500.00;
 * intervention offer £20.37/day on 11 Aug 2026, declined, reply 12 Aug 2026. Clock: 5 Oct 2026 09:00 UTC.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeneratedDocument } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';

type ErrorBody = { error: { code: string; message: string; details?: { code?: string; missing?: string[]; fields?: string[]; field?: string } } };
type Snap = Record<string, unknown>;

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z');
});
afterEach(async () => {
  await t.close();
});

function seedFileOne() {
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  return ids;
}

function openBlocks(doc: GeneratedDocument) {
  return (doc.consistency?.flags ?? []).filter((f) => f.severity === 'block' && !f.clearedAt);
}

async function draft(claimId: string, templateId: string, data?: Record<string, unknown>, recipientPartyId?: string) {
  return t.api<GeneratedDocument & ErrorBody>('POST', `/claims/${claimId}/documents`, { templateId, data, recipientPartyId });
}

async function logEvent(claimId: string, body: Record<string, unknown>) {
  const res = await t.api('POST', `/claims/${claimId}/events`, body);
  expect(res.status).toBe(201);
  return res.body as { event: { id: string } };
}

const PROCEEDINGS = { type: 'proceedings_issued', at: '2026-10-02T10:00:00.000Z', summary: 'Claim issued by the claimant in person', attributableTo: 'client', data: { court: 'County Court Money Claims Centre', claimNumber: 'K1QZ123A' } };

describe('letter.complaint_disp', () => {
  it('derives the ICOBS and DISP dates from the clocks and the outstanding heads from the ledger; the summary is the handler’s', async () => {
    const { claimId } = seedFileOne();
    const missing = await draft(claimId, 'letter.complaint_disp');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details?.code).toBe('TEMPLATE_DATA_MISSING');
    expect(missing.body.error.details?.missing).toEqual(['complaintSummary']);
    expect(missing.body.error.message).toContain('complaintSummary');

    const res = await draft(claimId, 'letter.complaint_disp', { complaintSummary: 'The payment pack was complete when sent. No line in it has been disputed, and the remittance came with no explanation of the shortfall.' });
    expect(res.status).toBe(201);
    expect(openBlocks(res.body)).toEqual([]);
    expect(res.body.status).toBe('draft');
    const s = res.body.dataSnapshot as Snap;
    expect(s).toMatchObject({
      againstOwnInsurer: false,
      notificationDate: '2026-08-11',
      icobsDeadline: '2026-11-11',
      icobsDeadlinePassed: false,
      daysSinceNotification: 55,
      outstandingPence: 741940,
      acknowledgementDeadline: '2026-10-12',
      finalResponseDeadline: '2026-11-30',
      recipient: { name: 'Example Insurance Ltd', attention: 'Complaints Team' },
    });
    const hireRow = (s.heads as Array<{ label: string; valuePence: number; note?: string }>).find((h) => h.label.startsWith('Hire'));
    expect(hireRow).toMatchObject({ label: 'Hire, 23 days at £49.80 per day', valuePence: 3340 });
    expect((s.chronology as unknown[]).length).toBeGreaterThan(10);
    const html = res.body.html;
    expect(html).toContain('£1,112.00 received');
    expect(html).toContain('£33.40');
    expect(html).toContain('£7,419.40');
    expect(html).toContain('11 November 2026');
    expect(html).not.toMatch(/Financial Ombudsman|\bFOS\b/);
    expect(html).not.toContain('1,287');
  });

  it('never names the ombudsman to the at-fault insurer, and refuses a handler-typed ledger figure', async () => {
    const { claimId } = seedFileOne();
    const forum = await draft(claimId, 'letter.complaint_disp', { complaintSummary: 'No reasoned reply has been received.', againstOwnInsurer: true });
    expect(forum.status).toBe(400);
    expect(forum.body.error.details?.code).toBe('FORUM_NOT_OPEN');
    const typed = await draft(claimId, 'letter.complaint_disp', { complaintSummary: 'No reasoned reply has been received.', outstandingPence: 128700 });
    expect(typed.status).toBe(400);
    expect(typed.body.error.details?.code).toBe('EXTRA_OVERRIDES_LEDGER');
    expect(typed.body.error.details?.fields).toEqual(['outstandingPence']);
  });

  it('adds the FOS route only for a complaint addressed to the client’s own insurer, dated from the notification to it', async () => {
    const { claimId } = seedFileOne();
    const own = t.ctx.repos.createParty(t.ctx.db, { kind: 'company', name: 'Own Cover Insurance plc', roles: ['insurer'], email: 'complaints@owncover.test', createdAt: '2026-08-10T09:00:00.000Z' });
    expect((await t.api('PATCH', `/claims/${claimId}`, { clientInsurerId: own.id, clientPolicyNumber: 'OC-123456' })).status).toBe(200);
    const noNotice = await draft(claimId, 'letter.complaint_disp', { complaintSummary: 'The claim has not been handled.', againstOwnInsurer: true }, own.id);
    expect(noNotice.status).toBe(409);
    expect(noNotice.body.error.code).toBe('NO_NOTIFICATION');
    await logEvent(claimId, { type: 'email_out', at: '2026-08-12T10:00:00.000Z', summary: 'Claim notified to Own Cover Insurance plc', attributableTo: 'ccguk', data: { recipientPartyId: own.id } });
    const res = await draft(claimId, 'letter.complaint_disp', { complaintSummary: 'The claim has not been handled.', againstOwnInsurer: true }, own.id);
    expect(res.status).toBe(201);
    const s = res.body.dataSnapshot as Snap & { claim: { theirReference?: string } };
    expect(s).toMatchObject({ againstOwnInsurer: true, notificationDate: '2026-08-12', icobsDeadline: '2026-11-12', recipient: { name: 'Own Cover Insurance plc', attention: 'Complaints Team' } });
    expect(s.claim.theirReference).toBeUndefined(); // the at-fault insurer's reference is not theirs
    expect(res.body.html).toContain('Financial Ombudsman Service');
    expect(res.body.html).toContain('OC-123456');
  });
});

describe('letter.dsar', () => {
  it('takes the data subject, offer dates, references and the one-month deadline from the claim and the authority from the evidence', async () => {
    const ids = seedFileOne();
    const none = await draft(ids.claimId, 'letter.dsar');
    expect(none.status).toBe(400);
    expect(none.body.error.details?.missing).toEqual(['authorityDate']);
    const future = await draft(ids.claimId, 'letter.dsar', { authorityDate: '2026-10-09' });
    expect(future.status).toBe(400);
    expect(future.body.error.details?.code).toBe('DATE_IN_FUTURE');

    t.ctx.repos.insertEvidence(t.ctx.db, {
      claimId: ids.claimId,
      kind: 'document',
      filename: 'signed_authority.pdf',
      mime: 'application/pdf',
      bytes: 48_211,
      sha256: 'b'.repeat(64),
      storagePath: `evidence/${ids.claimId}/signed_authority.pdf`,
      capturedAt: '2026-10-02T11:00:00.000Z',
      uploadedAt: '2026-10-02T11:05:00.000Z',
      uploadedBy: ids.handlerId,
      description: 'Signed authority for subject access request',
    });
    const res = await draft(ids.claimId, 'letter.dsar');
    expect(res.status).toBe(201);
    expect(openBlocks(res.body)).toEqual([]);
    expect(res.body.dataSnapshot).toMatchObject({
      authorityDate: '2026-10-02',
      allegedOfferDates: ['2026-08-11'],
      references: ['EXI/2026/778899'],
      responseDeadline: '2026-11-05',
      icoComplaintDate: '2026-11-06',
      dataSubject: { name: 'Jane Doe', dateOfBirth: '1988-04-02', addressLines: ['1 Example Street', 'London', 'E1 6AN'] },
      recipient: { name: 'Example Insurance Ltd', attention: 'Data Protection Officer' },
    });
    expect(res.body.html).toContain('11 August 2026');
    expect(res.body.html).toContain('Signed authority of Jane Doe dated 2 October 2026');
    expect(res.body.html).toContain('5 November 2026');
    // The authority on file is the source of truth: a different hand-typed date is refused.
    const typed = await draft(ids.claimId, 'letter.dsar', { authorityDate: '2026-09-30' });
    expect(typed.status).toBe(400);
    expect(typed.body.error.details?.code).toBe('EXTRA_OVERRIDES_LEDGER');
  });
});

describe('letter.letter_before_claim', () => {
  it('schedules the loss from the ledger position (less the £1,112.00 received), adds s.69 interest and is signed by the claimant', async () => {
    const { claimId } = seedFileOne();
    const missing = await draft(claimId, 'letter.letter_before_claim');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details?.missing).toEqual(['liabilityBasis']);

    const res = await draft(claimId, 'letter.letter_before_claim', { liabilityBasis: 'You drove into the rear of my car while it was stationary in a queue of traffic. You failed to keep a safe distance and to stop in time.' });
    expect(res.status).toBe(201);
    expect(openBlocks(res.body)).toEqual([]);
    const s = res.body.dataSnapshot as Snap & { schedule: Array<{ description: string; netPence: number }> };
    expect(s).toMatchObject({
      scheduleTotalPence: 782568, // gross position £8,937.68 less £1,112.00 received
      interest: { rate: 0.08, fromDate: '2026-09-05', toDate: '2026-10-05', accruedPence: 5146, dailyPence: 172 },
      totalWithInterestPence: 787714,
      responseDays: 14,
      responseDeadline: '2026-10-19',
      track: { expected: 'small_claims' },
      claimant: { name: 'Jane Doe', isBusiness: false },
      signatory: { name: 'Jane Doe', role: 'Claimant' },
      recipient: { name: 'John Smith', addressLines: ['c/o Example Insurance Ltd', 'Third Party Claims Team', '[address to be confirmed]'] },
      insurer: { name: 'Example Insurance Ltd', reference: 'EXI/2026/778899' },
    });
    expect(s.schedule.find((l) => l.description === 'Hire of a replacement vehicle')?.netPence).toBe(137448);
    expect(s.schedule.find((l) => l.description.startsWith('Less: paid on account'))?.netPence).toBe(-111200);
    expect(s.schedule.reduce((a, l) => a + l.netPence, 0)).toBe(s.scheduleTotalPence);
    const html = res.body.html;
    expect(html).toContain('-£1,112.00');
    expect(html).toContain('£1,145.40 plus VAT £229.08');
    expect(html).toContain('£7,825.68');
    expect(html).toContain('£51.46');
    expect(html).toContain('£1.72 per day');
    expect(html).toContain('From 10 August 2026 to 2 September 2026, 23 days at £49.80 per day');
    expect(html).toContain('Credit hire agreement CCG-H-000101 dated 10 August 2026');
    expect(html).toContain('It is not a firm of solicitors and does not act for me in any proceedings.');
    expect(html).not.toContain('1,287');
  });
});

describe('letter.part36_offer', () => {
  it('fixes the 21-day relevant period and the amount claimed from the ledger; the offer figure is the handler’s judgement', async () => {
    const { claimId } = seedFileOne();
    const missing = await draft(claimId, 'letter.part36_offer');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details?.missing).toEqual(['offerPence']);
    const short = await draft(claimId, 'letter.part36_offer', { offerPence: 700000, relevantPeriodDays: 14 });
    expect(short.status).toBe(400);
    expect(short.body.error.details?.field).toBe('relevantPeriodDays');
    const tooHigh = await draft(claimId, 'letter.part36_offer', { offerPence: 900000 });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.error.details?.code).toBe('OFFER_EXCEEDS_CLAIM');

    const res = await draft(claimId, 'letter.part36_offer', { offerPence: 700000 });
    expect(res.status).toBe(201);
    expect(openBlocks(res.body)).toEqual([]);
    expect(res.body.dataSnapshot).toMatchObject({
      offerPence: 700000,
      relevantPeriodDays: 21,
      relevantPeriodEnd: '2026-10-26',
      claimedPence: 787714,
      expectedTrack: 'small_claims',
      signatory: { name: 'Jane Doe', role: 'Claimant' },
      recipient: { name: 'John Smith' },
    });
    const html = res.body.html;
    expect(html).toContain('£7,000.00');
    expect(html).toContain('£7,877.14');
    expect(html).toContain('26 October 2026');
    expect(html).toContain('WITHOUT PREJUDICE SAVE AS TO COSTS');
  });
});

describe('letter.particularisation_demand', () => {
  it('dates the demand from the logged letter and states the intervention register; the quoted allegation is the insurer’s words', async () => {
    const { claimId } = seedFileOne();
    const noLetter = await draft(claimId, 'letter.particularisation_demand', { allegationQuoted: 'Irregularities have been identified.', allegationKind: 'irregularity' });
    expect(noLetter.status).toBe(409);
    expect(noLetter.body.error.code).toBe('NO_ALLEGATION_LETTER');
    await logEvent(claimId, { type: 'letter_in', at: '2026-10-01T10:00:00.000Z', summary: 'Letter from Example Insurance Ltd alleging irregularities', attributableTo: 'insurer', data: { reference: 'EXI/2026/778899/CF', author: 'Claims Validation Team' } });
    const missing = await draft(claimId, 'letter.particularisation_demand');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details?.missing).toEqual(['allegationQuoted', 'allegationKind']);
    const badKind = await draft(claimId, 'letter.particularisation_demand', { allegationQuoted: 'Irregularities have been identified.', allegationKind: 'dishonesty' });
    expect(badKind.status).toBe(400);

    const quoted = 'Our enquiries have identified irregularities with this claim and we are not prepared to make any further payment.';
    const res = await draft(claimId, 'letter.particularisation_demand', { allegationQuoted: quoted, allegationKind: 'irregularity' });
    expect(res.status).toBe(201);
    expect(openBlocks(res.body)).toEqual([]);
    expect(res.body.dataSnapshot).toMatchObject({ allegationLetter: { date: '2026-10-01', reference: 'EXI/2026/778899/CF', author: 'Claims Validation Team' }, responseDeadline: '2026-10-19' });
    const html = res.body.html;
    expect(html).toContain('Your letter of 1 October 2026');
    expect(html).toContain('irregularities with this claim');
    expect(html).toContain('Our intervention register records one offer of a replacement vehicle');
    expect(html).toContain('£20.37 per day');
    expect(html).toContain('our written reply was sent on 12 August 2026');
  });
});

describe('bundle.litigation_index', () => {
  it('indexes the documents and evidence on the claim, correspondence in the order sent, and keeps Part 36 offers out', async () => {
    const ids = seedFileOne();
    const noCourt = await draft(ids.claimId, 'bundle.litigation_index');
    expect(noCourt.status).toBe(400);
    expect(noCourt.body.error.details?.missing).toEqual(['court.name']);
    await logEvent(ids.claimId, PROCEEDINGS);

    const offer = await draft(ids.claimId, 'letter.part36_offer', { offerPence: 700000 });
    expect(offer.status).toBe(201);
    t.ctx.repos.approveDocument(t.ctx.db, offer.body.id, { userId: ids.approverId }, '2026-10-05T09:00:00.000Z');

    const res = await draft(ids.claimId, 'bundle.litigation_index');
    expect(res.status).toBe(201);
    expect(openBlocks(res.body)).toEqual([]);
    const s = res.body.dataSnapshot as Snap & { sections: Array<{ key: string; documents: Array<{ description: string; date: string; startPage: number; endPage?: number }> }> };
    expect(s).toMatchObject({ court: { name: 'County Court Money Claims Centre', claimNumber: 'K1QZ123A' }, parties: { claimant: 'Jane Doe', defendant: 'John Smith' }, claimantActsInPerson: true, totalPages: 3 });
    expect(s.sections.map((x) => x.key)).toEqual(['correspondence', 'other']);
    expect(s.sections[0]!.documents.map((d) => [d.date, d.startPage])).toEqual([
      ['2026-08-11', 1],
      ['2026-09-05', 2],
    ]);
    expect(s.sections[0]!.documents[0]!.description).toContain('New Claim Advice Form');
    expect(s.sections.some((x) => x.key === 'part_36')).toBe(false); // CPR 36.16
    expect(res.body.html).toContain('K1QZ123A');
    expect(res.body.html).toContain('litigant in person');

    // A costs bundle may include the offer when the handler asks; pagination stays consecutive.
    const costs = await draft(ids.claimId, 'bundle.litigation_index', { includePart36: true, solicitorName: 'Example Law LLP' });
    expect(costs.status).toBe(201);
    const c = costs.body.dataSnapshot as typeof s;
    expect(c.claimantActsInPerson).toBe(false);
    expect(c.sections.map((x) => x.key)).toEqual(['correspondence', 'part_36', 'other']);
    let last = 0;
    for (const sec of c.sections) for (const d of sec.documents) {
      expect(d.startPage).toBe(last + 1);
      last = d.endPage ?? d.startPage;
    }
    expect(c.totalPages).toBe(last);
  });
});

describe('statement.witness', () => {
  it('derives the heading from the claim and proceedings; the paragraphs and occupation are the witness’s own', async () => {
    const ids = seedFileOne();
    await logEvent(ids.claimId, PROCEEDINGS);
    const missing = await draft(ids.claimId, 'statement.witness');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details?.missing).toEqual(['witness.occupation', 'paragraphs', 'accountGivenAt']);
    await logEvent(ids.claimId, { type: 'call', at: '2026-10-03T10:00:00.000Z', summary: 'Account taken from Jane Doe by telephone for her witness statement', attributableTo: 'ccguk', data: { kind: 'witness_account', partyId: ids.claimantId } });

    const extras = {
      witness: { occupation: 'Community nurse' },
      paragraphs: [
        'On 8 August 2026 at about 3.30pm I was stationary in a queue of traffic on the A13 Alfred’s Way at Barking when a van struck the rear of my car.',
        'My car could not be driven. It was recovered from the scene the next working day and I hired a replacement car the same day.',
      ],
    };
    const res = await draft(ids.claimId, 'statement.witness', extras);
    expect(res.status).toBe(201);
    expect(openBlocks(res.body)).toEqual([]);
    expect(res.body.dataSnapshot).toMatchObject({
      court: { name: 'County Court Money Claims Centre', claimNumber: 'K1QZ123A' },
      parties: { claimant: 'Jane Doe', defendant: 'John Smith' },
      witness: { name: 'Jane Doe', addressLines: ['1 Example Street', 'London', 'E1 6AN'], capacity: 'the Claimant', shortName: 'J. Doe', occupation: 'Community nurse' },
      statementNumber: 1,
      accountGivenAt: '2026-10-03',
      isDraft: true,
      createdAt: '2026-10-05T09:00:00.000Z',
    });
    const html = res.body.html;
    expect(html).toContain('First witness statement of Jane Doe');
    expect(html).toContain('Claim No. K1QZ123A');
    expect(html).toContain('3 October 2026');
    expect(html).toContain('stationary in a queue of traffic');

    // Once the first statement is approved, the next draft for the same witness is the second.
    t.ctx.repos.approveDocument(t.ctx.db, res.body.id, { userId: ids.approverId }, '2026-10-05T09:00:00.000Z');
    const second = await draft(ids.claimId, 'statement.witness', extras);
    expect(second.status).toBe(201);
    expect((second.body.dataSnapshot as Snap).statementNumber).toBe(2);
    expect(second.body.html).toContain('Second witness statement of Jane Doe');
  });
});
