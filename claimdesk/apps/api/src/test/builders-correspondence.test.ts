/**
 * Correspondence builders (services/builders/correspondence.ts) on the File 1 archetype: each letter is drafted
 * through POST /api/claims/:id/documents with only the handler-owned extras, prints the claim's own figures and dates,
 * and leaves no block open that the builder's data caused. Derived fields cannot be retyped (EXTRA_OVERRIDES_LEDGER),
 * missing handler fields are named (TEMPLATE_DATA_MISSING), and missing claim data is a 409 that says what to record.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConsistencyFlag, GeneratedDocument } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';

type ErrorBody = { error: { code: string; message: string; details?: { code?: string; missing?: string[]; fields?: string[] } } };

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z'); // Monday
});
afterEach(async () => {
  await t.close();
});

function seedFileOne() {
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  return ids;
}

const openBlocks = (doc: GeneratedDocument): ConsistencyFlag[] => (doc.consistency?.flags ?? []).filter((f) => f.severity === 'block' && !f.clearedAt);

function draft(claimId: string, templateId: string, data?: Record<string, unknown>, recipientPartyId?: string) {
  return t.api<GeneratedDocument & ErrorBody>('POST', `/claims/${claimId}/documents`, { templateId, ...(data ? { data } : {}), ...(recipientPartyId ? { recipientPartyId } : {}) });
}

const WHAT_THIS_MEANS =
  'Under your hire agreement the charges are deferred while they are claimed from the other driver’s insurer as your loss. You are not being asked to pay anything now.';

describe('letter.client_update (File 1)', () => {
  it('names the handler-owned explanation when it is missing', async () => {
    const ids = seedFileOne();
    const res = await draft(ids.claimId, 'letter.client_update');
    expect(res.status).toBe(400);
    expect(res.body.error.details?.code).toBe('TEMPLATE_DATA_MISSING');
    expect(res.body.error.details?.missing).toEqual(['whatThisMeans']);
    expect(res.body.error.message).toContain('whatThisMeans');
  });

  it('prints the ledger position, the gate items and the playbook next step with no open block', async () => {
    const ids = seedFileOne();
    const res = await draft(ids.claimId, 'letter.client_update', { whatThisMeans: WHAT_THIS_MEANS });
    expect(res.status).toBe(201);
    const html = res.body.html!;
    // ledger: claimed £8,531.40 net (hire 1,145.40 + storage 450 + recovery 151 + engineer 285 + PAV 6,500), £1,112.00 received
    expect(html).toContain('has paid £1,112.00 so far');
    expect(html).toContain('£7,419.40 remains outstanding');
    expect(html).toContain('£8,531.40');
    expect(html).not.toContain('1,287');
    // chronology: hire end and payment pack
    expect(html).toContain('Your hire ended on 2 September 2026');
    expect(html).toContain('sent to Example Insurance Ltd on 5 September 2026');
    expect(openBlocks(res.body)).toEqual([]);
    expect(res.body.consistency?.blocked).toBe(false);

    const snap = res.body.dataSnapshot as {
      salutationName: string;
      needFromYou: Array<{ action: string; byDate: string }>;
      whatHappensNext: { text: string; date: string };
      figures: Array<{ label: string; valuePence: number }>;
      handler: { name: string; role: string };
      recipient: { name: string };
    };
    expect(snap.recipient.name).toBe('Jane Doe');
    expect(snap.salutationName).toBe('Jane Doe');
    expect(snap.figures.map((f) => f.valuePence)).toEqual([853140, 111200, 741940]);
    // evidence gates: need, means, bank statements, income and the mitigation questionnaire are missing on File 1
    const needs = snap.needFromYou.map((n) => n.action).join(' | ');
    expect(needs).toMatch(/statement of need/);
    expect(needs).toMatch(/statement of means/);
    expect(needs).toMatch(/bank statements/);
    expect(needs).toMatch(/mitigation questionnaire/);
    expect(snap.needFromYou.every((n) => n.byDate === '2026-10-12')).toBe(true); // 5 working days
    // playbook: the day-28 complaint is overdue on File 1 and supersedes the chaser ladder
    expect(snap.whatHappensNext.text).toMatch(/formal complaint is going to Example Insurance Ltd/);
    expect(snap.whatHappensNext.text).not.toMatch(/chasing/);
    expect(snap.whatHappensNext.date).toBe('2026-10-19');
    // perimeter: no forum that is not open, no regulated-status wording
    expect(html).not.toMatch(/Financial Ombudsman|\bFOS\b|our client/i);
  });

  it('lets the handler choose the form of address but never retype the facts', async () => {
    const ids = seedFileOne();
    const named = await draft(ids.claimId, 'letter.client_update', { whatThisMeans: WHAT_THIS_MEANS, salutationName: 'Jane' });
    expect(named.status).toBe(201);
    expect(named.body.html).toContain('Dear Jane,');
    const retyped = await draft(ids.claimId, 'letter.client_update', { whatThisMeans: WHAT_THIS_MEANS, whereWeAre: 'The insurer has paid £1,287.00.' });
    expect(retyped.status).toBe(400);
    expect(retyped.body.error.details?.code).toBe('EXTRA_OVERRIDES_LEDGER');
    expect(retyped.body.error.details?.fields).toContain('whereWeAre');
  });
});

describe('letter.cctv_preservation (File 1)', () => {
  it('takes the place, time and window from the accident record; the operator is the handler’s', async () => {
    const ids = seedFileOne();
    const missing = await draft(ids.claimId, 'letter.cctv_preservation');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details?.missing).toEqual(expect.arrayContaining(['recipient.name', 'recipient.addressLines', 'operatorType']));

    const res = await draft(ids.claimId, 'letter.cctv_preservation', {
      operatorType: 'council',
      recipient: { name: 'London Borough of Barking and Dagenham', attention: 'CCTV Control Room', addressLines: ['Town Hall', '1 Town Square', 'Barking', 'IG11 7LU'] },
    });
    expect(res.status).toBe(201);
    const html = res.body.html!;
    expect(html).toContain('A13 Alfred’s Way, Barking, IG11 0AA');
    expect(html).toContain('8 August 2026, 15:30'); // 14:30Z in BST
    expect(html).toContain('8 August 2026, 15:15 to 8 August 2026, 15:45');
    expect(html).toContain('signed authority dated 10 August 2026'); // the signed hire agreement
    expect(html).toContain('Thursday 8 October 2026'); // 3 working days
    expect(html).not.toContain('EXI/2026/778899'); // never the insurer's reference to an operator
    expect(openBlocks(res.body)).toEqual([]);
    const snap = res.body.dataSnapshot as { incidentAt: string; windowStart: string; windowEnd: string; authorityDate: string; responseDeadline: string };
    expect(snap).toMatchObject({ incidentAt: '2026-08-08T14:30:00.000Z', windowStart: '2026-08-08T14:15:00.000Z', windowEnd: '2026-08-08T14:45:00.000Z', authorityDate: '2026-08-10', responseDeadline: '2026-10-08' });

    const moved = await draft(ids.claimId, 'letter.cctv_preservation', { operatorType: 'council', recipient: { name: 'Council', addressLines: ['Town Hall'] }, incidentAt: '2026-08-08T09:00:00.000Z' });
    expect(moved.status).toBe(400);
    expect(moved.body.error.details?.code).toBe('EXTRA_OVERRIDES_LEDGER');
  });

  it('derives the operator type from a council recipient party, so no extras are needed', async () => {
    const ids = seedFileOne();
    const council = await t.api<{ id: string }>('POST', '/parties', { kind: 'public_body', name: 'London Borough of Barking and Dagenham', roles: ['council'], address: { line1: 'Town Hall', town: 'Barking', postcode: 'IG11 7LU' } });
    expect(council.status).toBe(201);
    const res = await draft(ids.claimId, 'letter.cctv_preservation', undefined, council.body.id);
    expect(res.status).toBe(201);
    expect((res.body.dataSnapshot as { operatorType: string }).operatorType).toBe('council');
    expect(res.body.html).toContain('London Borough of Barking and Dagenham');
    expect(openBlocks(res.body)).toEqual([]);
  });
});

describe('letter.supplier_instruction_engineer (File 1)', () => {
  const DAMAGE = 'Rear bumper, boot floor and rear panel deformed; rear lights inoperative. The vehicle was recovered from the scene and has not been driven since.';

  it('names the damage and, once storage has ended, the vehicle location as the handler’s to supply', async () => {
    const ids = seedFileOne();
    const res = await draft(ids.claimId, 'letter.supplier_instruction_engineer');
    expect(res.status).toBe(400);
    expect(res.body.error.details?.missing).toEqual(expect.arrayContaining(['damageReported', 'vehicle.location']));
  });

  it('instructs the file’s engineer at the rate-card fee with dates from the calendar', async () => {
    const ids = seedFileOne();
    const res = await draft(ids.claimId, 'letter.supplier_instruction_engineer', { damageReported: DAMAGE, vehicle: { location: 'Salvage agent’s yard — address to be confirmed with the agent' } });
    expect(res.status).toBe(201);
    const html = res.body.html!;
    expect(html).toContain('I. Engineer'); // the report's engineer party
    expect(html).toContain('£285.00'); // settings rate card engineerFeePence
    expect(html).toContain('AB12 CDE');
    expect(html).toContain('VOLKSWAGEN GOLF 1.5 TSI Life, 2019, petrol, manual');
    expect(html).toContain('49,980 miles');
    expect(html).toContain('Wednesday 7 October 2026'); // inspection: 2 working days
    expect(html).toContain('Monday 12 October 2026'); // report: 3 working days after inspection
    expect(html).toContain('Client stationary in traffic');
    expect(html).not.toContain('CPR Part 35');
    expect(html).not.toContain('EXI/2026/778899');
    expect(openBlocks(res.body)).toEqual([]);
    const snap = res.body.dataSnapshot as { forCourt: boolean; feePence: number; enclosures: string[]; inspectionBy: string; reportBy: string };
    expect(snap).toMatchObject({ forCourt: false, feePence: 28500, inspectionBy: '2026-10-07', reportBy: '2026-10-12' });
    expect(snap.enclosures).toEqual(['Photographs of the vehicle (1)', 'Recovery record']);

    const fee = await draft(ids.claimId, 'letter.supplier_instruction_engineer', { damageReported: DAMAGE, vehicle: { location: 'Salvage yard' }, feePence: 25000 });
    expect(fee.status).toBe(400);
    expect(fee.body.error.details?.fields).toContain('feePence');
  });

  it('takes the location from open storage and lets the handler make the report one for court', async () => {
    const ids = seedFileOne();
    t.ctx.repos.createStorage(t.ctx.db, { claimId: ids.claimId, location: 'CCGUK yard, Unit 4, Thames Road, Barking IG11 0HZ', startAt: '2026-10-01T10:00:00.000Z', dailyRatePence: 4500, vatRate: 0.2 });
    const res = await draft(ids.claimId, 'letter.supplier_instruction_engineer', { damageReported: DAMAGE, forCourt: true });
    expect(res.status).toBe(201);
    expect(res.body.html).toContain('CCGUK yard, Unit 4, Thames Road, Barking IG11 0HZ');
    expect(res.body.html).toContain('CPR Part 35');
    expect((res.body.dataSnapshot as { forCourt: boolean }).forCourt).toBe(true);
    expect(openBlocks(res.body)).toEqual([]);
  });
});

describe('letter.vendor_verification_pack (File 1)', () => {
  /**
   * Two blocks come from the template's fixed wording, not from this builder's data, and no builder can avoid them:
   * the engine reads the callout heading "Confirmation of Payee" + line break as a payee field label, and reads
   * "payment of £X will clear" as a statement that £X was paid. They are reported for a fix in packages/; until
   * then the handler clears them with a reason. Nothing else may be open.
   */
  const knownTemplateMisread = (f: ConsistencyFlag): boolean =>
    (f.code === 'PAYEE_MISMATCH' && /Confirmation of Payee The account is held in the exact registered name/.test(f.excerpt ?? '')) ||
    (f.code === 'AMOUNT_PAID_MISMATCH' && /payment of £919\.40 will clear/.test(f.excerpt ?? ''));

  async function bankAndRequest(claimId: string) {
    const s = await t.api('PATCH', '/settings', { bank: { accountName: 'Courtesy Cars Group UK Ltd', sortCode: '12-34-56', accountNumber: '12345678', bankName: 'Example Bank plc' } });
    expect(s.status).toBe(200);
    const ev = await t.api('POST', `/claims/${claimId}/events`, {
      type: 'email_in',
      at: '2026-09-29T10:00:00.000Z',
      summary: 'Payments team: bank details could not be validated; vendor set-up documents requested',
      data: { reason: 'bank_validation', reference: 'VEN-REQ-5531' },
      attributableTo: 'insurer',
    });
    expect(ev.status).toBe(201);
  }

  it('refuses until the insurer’s request is logged on the chronology', async () => {
    const ids = seedFileOne();
    const res = await draft(ids.claimId, 'letter.vendor_verification_pack', { director: { name: 'D. Kaleem', idDocument: 'UK passport, certified copy of the photo page' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_VENDOR_REQUEST');
  });

  it('lists CCGUK’s outstanding invoices from the ledger with the exact registered name and bank details from settings', async () => {
    const ids = seedFileOne();
    await bankAndRequest(ids.claimId);
    const missing = await draft(ids.claimId, 'letter.vendor_verification_pack');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details?.missing).toEqual(expect.arrayContaining(['director.name', 'director.idDocument']));

    const res = await draft(ids.claimId, 'letter.vendor_verification_pack', { director: { name: 'D. Kaleem', idDocument: 'UK passport, certified copy of the photo page' } });
    expect(res.status).toBe(201);
    const html = res.body.html!;
    // request from the chronology
    expect(html).toContain('On 29 September 2026 you told us by email that our bank details could not be validated');
    expect(html).toContain('VEN-REQ-5531');
    // payee from settings
    expect(html).toContain('Courtesy Cars Group UK Ltd');
    expect(html).toContain('17430389');
    expect(html).toContain('12-34-56');
    expect(html).toContain('12345678');
    // ledger: hire £1,145.40 less £1,112.00 received = £33.40; recovery £151, engineer £285, storage £450; PAV is not a CCGUK invoice
    expect(html).toContain('INV-H-000101');
    for (const figure of ['£33.40', '£151.00', '£285.00', '£450.00', '£919.40']) expect(html).toContain(figure);
    expect(html).not.toContain('£6,500.00');
    expect(html).not.toContain('1,287');
    const snap = res.body.dataSnapshot as { outstandingPence: number; invoices: Array<{ number: string; amountPence: number }>; responseDeadline: string; request: { receivedAt: string } };
    expect(snap.outstandingPence).toBe(91940);
    expect(snap.invoices.map((i) => i.amountPence)).toEqual([15100, 28500, 45000, 3340]);
    expect(snap.request.receivedAt).toBe('2026-09-29');
    expect(snap.responseDeadline).toBe('2026-10-12');
    // never the FOS to an at-fault insurer
    expect(html).not.toMatch(/Financial Ombudsman|\bFOS\b/);
    // No block from the builder's data; only the two template-wording misreads documented above remain.
    expect(openBlocks(res.body).filter((f) => !knownTemplateMisread(f))).toEqual([]);

    const retyped = await draft(ids.claimId, 'letter.vendor_verification_pack', { director: { name: 'D. Kaleem', idDocument: 'UK passport' }, outstandingPence: 128700 });
    expect(retyped.status).toBe(400);
    expect(retyped.body.error.details?.code).toBe('EXTRA_OVERRIDES_LEDGER');
  });

  it('refuses when the bank account name in settings is not the exact registered name', async () => {
    const ids = seedFileOne();
    await bankAndRequest(ids.claimId);
    const s = await t.api('PATCH', '/settings', { bank: { accountName: 'Courtesy Cars UK', sortCode: '12-34-56', accountNumber: '12345678', bankName: 'Example Bank plc' } });
    expect(s.status).toBe(200);
    const res = await draft(ids.claimId, 'letter.vendor_verification_pack', { director: { name: 'D. Kaleem', idDocument: 'UK passport' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BANK_NAME_NOT_REGISTERED_NAME');
  });
});

describe('integration fixes: vendor pack wording, own-insurer complaints, re-issue keeps handler text', () => {
  async function bankAndRequest(claimId: string) {
    expect((await t.api('PATCH', '/settings', { bank: { accountName: 'Courtesy Cars Group UK Ltd', sortCode: '12-34-56', accountNumber: '12345678', bankName: 'Example Bank plc' } })).status).toBe(200);
    expect((await t.api('POST', `/claims/${claimId}/events`, { type: 'email_in', at: '2026-09-29T10:00:00.000Z', summary: 'Payments team: bank details could not be validated; vendor set-up documents requested', data: { reason: 'bank_validation', reference: 'VEN-REQ-5531' }, attributableTo: 'insurer' })).status).toBe(201);
  }
  it('a vendor verification pack drafted from File 1 has no open block (no payee or payment misreads)', async () => {
    const ids = seedFileOne();
    await bankAndRequest(ids.claimId);
    const res = await draft(ids.claimId, 'letter.vendor_verification_pack', { director: { name: 'D. Kaleem', idDocument: 'UK passport, certified copy of the photo page' } });
    expect(res.status).toBe(201);
    const open = (res.body.consistency?.flags ?? []).filter((f: ConsistencyFlag) => f.severity === 'block' && !f.clearedAt);
    expect(open).toEqual([]);
    expect(res.body.status).toBe('draft');
  });

  it('re-issuing a complaint carries the handler’s own complaint summary forward', async () => {
    const ids = seedFileOne();
    const summary = 'The pack of 5 September 2026 has not been settled or answered with reasons, and repeated chasers have gone unanswered.';
    const first = await draft(ids.claimId, 'letter.complaint_disp', { complaintSummary: summary });
    expect(first.status).toBe(201);
    const re = await t.api<GeneratedDocument>('POST', `/documents/${first.body.id}/supersede`, {});
    expect(re.status).toBe(201);
    expect(re.body.html).toContain('repeated chasers have gone unanswered');
  });
});
