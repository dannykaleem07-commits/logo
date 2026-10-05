/**
 * Adversarial verification of the builders in services/builders/ (litigation.ts and correspondence.ts) on all four
 * seeded archetypes (seed/archetypes.ts):
 *
 *   (a) every template drafts (201, status draft, no open block) with ONLY the fields the API reports missing, and
 *       those fields are all handler-owned; anything else is a refusal for a reason the claim itself gives (named 409);
 *   (b) ledger figures and dates print as the ledger/chronology hold them;
 *   (c) perimeter: no ombudsman to an at-fault insurer, no regulated-status wording, litigation documents signed by
 *       the claimant or witness, GTA only as a benchmark;
 *   (d) a missing handler field is a 400 naming it, and a wrong-typed one is a 400 naming it — never a 500.
 *
 * Plus regressions for the defects found in review: a complaint addressed to the client's own insurer, a DSAR for a
 * company, an insurer's "authority to repair" or a "local authority" letter read as the claimant's authority, a witness
 * taken from another claim, a witness named as the proposed defendant, an internal note quoted as "your letter", and
 * an unsigned draft witness statement indexed in a hearing bundle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConsistencyFlag, GeneratedDocument } from '@ccguk/domain';
import { htmlToText } from '@ccguk/documents';
import { createTestApp, type TestApp } from './helpers.js';
import { seedArchetypes, type SeedSummary } from '../seed/archetypes.js';

type ErrorBody = { error: { code: string; message: string; details?: { code?: string; missing?: string[]; fields?: string[]; field?: string } } };
type Doc = GeneratedDocument & ErrorBody;
type FileKey = keyof SeedSummary['claimIds'];

let t: TestApp;
let s: SeedSummary;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z'); // Monday
  s = await seedArchetypes(t.ctx);
}, 60_000);
afterEach(async () => {
  await t.close();
});

function draft(claimId: string, templateId: string, data?: Record<string, unknown>, recipientPartyId?: string) {
  return t.api<Doc>('POST', `/claims/${claimId}/documents`, { templateId, ...(data ? { data } : {}), ...(recipientPartyId ? { recipientPartyId } : {}) });
}

async function logEvent(claimId: string, body: Record<string, unknown>): Promise<string> {
  const res = await t.api<{ event: { id: string } }>('POST', `/claims/${claimId}/events`, body);
  expect(res.status).toBe(201);
  return res.body.event.id;
}

const openBlocks = (doc: GeneratedDocument): ConsistencyFlag[] => (doc.consistency?.flags ?? []).filter((f) => f.severity === 'block' && !f.clearedAt);

/**
 * Two blocks on the vendor pack come from the template's fixed wording, not from builder data (see
 * builders-correspondence.test.ts): "Confirmation of Payee" + line break read as a payee label, and "payment of £X
 * will clear" read as a payment made. The reconcile step cannot clear them because the pack needs the handler's
 * identity-document text. They are the only blocks tolerated, and only on that template.
 */
const vendorTemplateMisread = (f: ConsistencyFlag): boolean =>
  (f.code === 'PAYEE_MISMATCH' && /Confirmation of Payee/.test(f.excerpt ?? '')) || (f.code === 'AMOUNT_PAID_MISMATCH' && /payment of £[\d,.]+ will clear/.test(f.excerpt ?? ''));

/** Every field a handler may be asked for, with a value of the right type. Anything else reported missing is a defect. */
const HANDLER_FIELDS: Record<string, unknown> = {
  complaintSummary: 'The payment pack was complete when sent. No line in it has been disputed and no reasoned reply has been received.',
  authorityDate: '2026-10-02',
  liabilityBasis: 'You drove into my vehicle. You failed to keep a proper lookout and to stop in time.',
  offerPence: 50000,
  allegationQuoted: 'Our enquiries have identified irregularities with this claim.',
  allegationKind: 'irregularity',
  'witness.occupation': 'Delivery driver',
  'witness.capacity': 'a witness for the Claimant',
  paragraphs: ['I was driving my car when the other vehicle collided with it.'],
  accountGivenAt: '2026-10-01',
  operatorType: 'council',
  'recipient.name': 'Example Borough Council',
  'recipient.addressLines': ['Town Hall', '1 Town Square', 'Barking', 'IG11 7LU'],
  whatThisMeans: 'Under your hire agreement the charges are deferred while they are claimed from the other driver’s insurer. You are not being asked to pay anything now.',
  'whatHappensNext.text': 'I will review the insurer’s reply and write to you with the next step.',
  damageReported: 'Damage reported by the claimant at first notification; to be confirmed at inspection.',
  'vehicle.location': 'The claimant’s home address, by appointment',
  'director.name': 'D. Kaleem',
  'director.idDocument': 'UK passport, certified copy of the photo page',
};

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[keys[keys.length - 1]!] = value;
}

const TEMPLATES = [
  'letter.complaint_disp',
  'letter.dsar',
  'letter.letter_before_claim',
  'letter.part36_offer',
  'letter.particularisation_demand',
  'bundle.litigation_index',
  'statement.witness',
  'letter.cctv_preservation',
  'letter.client_update',
  'letter.supplier_instruction_engineer',
  'letter.vendor_verification_pack',
] as const;
type TemplateId = (typeof TEMPLATES)[number];

const TO_AT_FAULT_INSURER = new Set<TemplateId>(['letter.complaint_disp', 'letter.dsar', 'letter.letter_before_claim', 'letter.part36_offer', 'letter.particularisation_demand', 'letter.vendor_verification_pack']);

/** Refusals the claim itself justifies (nothing a handler can type fixes them). Everything else must draft. */
const GENUINE_REFUSALS: Partial<Record<FileKey, Partial<Record<TemplateId, string>>>> = {
  file3: { 'letter.letter_before_claim': 'NOTHING_OUTSTANDING', 'letter.part36_offer': 'NOTHING_OUTSTANDING', 'letter.vendor_verification_pack': 'NOTHING_OUTSTANDING' }, // hire running, nothing on the ledger
  file4: {
    'letter.complaint_disp': 'NO_NCAF', // triage: the claim has not been presented to the insurer
    'letter.letter_before_claim': 'NOTHING_OUTSTANDING',
    'letter.part36_offer': 'NOTHING_OUTSTANDING',
    'letter.cctv_preservation': 'NO_SIGNED_AUTHORITY', // no hire agreement, no authority on file: no letter
    'letter.vendor_verification_pack': 'NOTHING_OUTSTANDING',
  },
};

/** Records each archetype must hold before the court, allegation and vendor letters can be drafted at all. */
async function logPrerequisites(claimId: string): Promise<void> {
  await logEvent(claimId, { type: 'proceedings_issued', at: '2026-10-02T10:00:00.000Z', summary: 'Claim issued by the claimant in person', attributableTo: 'client', data: { court: 'County Court Money Claims Centre', claimNumber: 'K1QZ123A' } });
  await logEvent(claimId, { type: 'email_in', at: '2026-09-29T10:00:00.000Z', summary: 'Payments team: bank details could not be validated', attributableTo: 'insurer', data: { reason: 'bank_validation', reference: 'VEN-REQ-5531' } });
  await logEvent(claimId, { type: 'letter_in', at: '2026-10-01T10:00:00.000Z', summary: 'Letter alleging irregularities', attributableTo: 'insurer', data: { kind: 'allegation', reference: 'CF/2026/1', author: 'Claims Validation Team' } });
}

/** (c) Perimeter checks on the rendered text. */
function assertPerimeter(templateId: TemplateId, doc: GeneratedDocument, claimantName: string): void {
  const text = htmlToText(doc.html ?? '');
  if (TO_AT_FAULT_INSURER.has(templateId)) expect(text, `${templateId}: no ombudsman to an at-fault insurer`).not.toMatch(/Financial Ombudsman|\bFOS\b/);
  expect(text, `${templateId}: no regulated-status wording`).not.toMatch(/\bour client\b|\bwe act for\b|\bour solicitors?\b|\bauthorised by the (?:FCA|SRA)\b/i);
  // GTA only as an industry benchmark: never an obligation or entitlement (CCGUK is not a subscriber). A chronology
  // event typed on the file ("NCAF sent (GTA 4.1 …)") or a sent document's own title ("GTA payment pack — …") may
  // name it; neither is a claim of right.
  expect(text, `${templateId}: GTA never cited as an obligation`).not.toMatch(
    /\b(?:entitled|required|obliged|bound)\s+(?:to\s+[^.]{0,40}?\s+)?(?:under|by)\s+the\s+GTA\b|\bthe\s+GTA\s+(?:requires|obliges|entitles|mandates)\b|\bpursuant\s+to\s+(?:the\s+)?GTA\b|\bbreach\s+of\s+(?:the\s+)?GTA\b|\byour\s+obligations?\s+under\s+the\s+GTA\b/i,
  );
  const snap = doc.dataSnapshot as { signatory?: { name: string; role: string } };
  if (templateId === 'letter.letter_before_claim' || templateId === 'letter.part36_offer') {
    expect(snap.signatory).toEqual({ name: claimantName, role: 'Claimant' });
  }
  if (templateId === 'letter.letter_before_claim') expect(text).toContain('It is not a firm of solicitors and does not act for me in any proceedings.');
  if (templateId === 'statement.witness') {
    expect(snap.signatory?.role).toMatch(/^(Claimant|Witness)$/);
    expect(text).toContain('not a firm of solicitors; the witness signs in person');
  }
  if (templateId === 'bundle.litigation_index') {
    expect(text).toContain('acts in person (litigant in person)');
    expect(text).toContain('is not a firm of solicitors');
  }
}

describe('(a)(c)(d) every builder on every archetype, with only the handler fields the API asks for', () => {
  it('drafts each of the 11 templates on Files 1–4 or refuses for a reason the claim gives', async () => {
    const claimants: Record<FileKey, string> = { file1: 'Jane Doe', file2: 'Marcus Oyelaran', file3: 'Hannah Whitfield', file4: 'Tomasz Nowak' };
    const outcome: Record<string, string> = {};
    for (const [file, claimId] of Object.entries(s.claimIds) as Array<[FileKey, string]>) {
      await logPrerequisites(claimId);
      for (const templateId of TEMPLATES) {
        const label = `${file} ${templateId}`;
        let res = await draft(claimId, templateId);
        expect(res.status, `${label}: ${JSON.stringify(res.body.error ?? {})}`).not.toBe(500);
        if (res.status === 400) {
          // (d) the 400 names the missing fields, and every one is the handler's to write
          expect(res.body.error.details?.code, label).toBe('TEMPLATE_DATA_MISSING');
          const missing = res.body.error.details?.missing ?? [];
          expect(missing.length, label).toBeGreaterThan(0);
          for (const m of missing) {
            expect(Object.keys(HANDLER_FIELDS), `${label}: "${m}" is reported missing but is not handler-owned`).toContain(m);
            expect(res.body.error.message, label).toContain(m);
          }
          const extras: Record<string, unknown> = {};
          for (const m of missing) setPath(extras, m, HANDLER_FIELDS[m]);
          res = await draft(claimId, templateId, extras);
          outcome[label] = `400 [${missing.join(', ')}] → ${res.status}`;
        } else outcome[label] = String(res.status);

        const refusal = GENUINE_REFUSALS[file]?.[templateId];
        if (refusal) {
          expect(res.status, `${label}: ${JSON.stringify(res.body.error ?? {})}`).toBe(409);
          expect(res.body.error.code, label).toBe(refusal);
          continue;
        }
        expect(res.status, `${label}: ${JSON.stringify(res.body.error ?? {})}`).toBe(201);
        const blocks = openBlocks(res.body).filter((f) => !(templateId === 'letter.vendor_verification_pack' && vendorTemplateMisread(f)));
        expect(blocks, label).toEqual([]);
        if (templateId !== 'letter.vendor_verification_pack') expect(res.body.status, label).toBe('draft');
        assertPerimeter(templateId, res.body, claimants[file]);
      }
    }
    // The handler fields actually asked for, per archetype (documents the derived/handler split).
    expect(outcome['file1 letter.complaint_disp']).toBe('400 [complaintSummary] → 201');
    expect(outcome['file1 letter.dsar']).toBe('400 [authorityDate] → 201');
    expect(outcome['file1 letter.letter_before_claim']).toBe('400 [liabilityBasis] → 201');
    expect(outcome['file1 letter.part36_offer']).toBe('400 [offerPence] → 201');
    expect(outcome['file1 letter.particularisation_demand']).toBe('400 [allegationQuoted, allegationKind] → 201');
    expect(outcome['file1 bundle.litigation_index']).toBe('201');
    expect(outcome['file1 statement.witness']).toBe('400 [witness.occupation, paragraphs, accountGivenAt] → 201');
    expect(outcome['file1 letter.client_update']).toBe('400 [whatThisMeans] → 201');
    expect(outcome['file1 letter.supplier_instruction_engineer']).toBe('400 [vehicle.location, damageReported] → 201');
    expect(outcome['file1 letter.vendor_verification_pack']).toBe('400 [director.idDocument] → 201');
    expect(outcome['file2 letter.client_update']).toBe('400 [whatThisMeans] → 201');
    expect(outcome['file3 letter.supplier_instruction_engineer']).toBe('400 [recipient.name, recipient.addressLines, vehicle.location, damageReported] → 201'); // no engineer on file
  }, 120_000);

  it('asks the handler for the next step only when the playbook has no client-facing one (File 2 before issue)', async () => {
    const claimId = s.claimIds.file2;
    const missing = await draft(claimId, 'letter.client_update');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details?.missing).toEqual(['whatThisMeans', 'whatHappensNext.text']);
    const res = await draft(claimId, 'letter.client_update', { whatThisMeans: HANDLER_FIELDS.whatThisMeans, whatHappensNext: { text: HANDLER_FIELDS['whatHappensNext.text'] } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(openBlocks(res.body)).toEqual([]);
    expect(res.body.html).toContain('I will review the insurer’s reply');
  }, 60_000);
});

describe('(b) ledger figures and dates on Files 1 and 2', () => {
  it('prints the ledger position, never a typed figure', async () => {
    const { file1, file2 } = s.claimIds;
    const c1 = await draft(file1, 'letter.complaint_disp', { complaintSummary: HANDLER_FIELDS.complaintSummary });
    expect(c1.status).toBe(201);
    expect(c1.body.html).toContain('£1,112.00 received');
    expect(c1.body.html).toContain('£7,419.40');
    expect(c1.body.html).not.toContain('1,287');
    expect(c1.body.dataSnapshot).toMatchObject({ notificationDate: '2026-08-11', icobsDeadline: '2026-11-11', outstandingPence: 741940 });

    // File 2: storage paid to report + 48 h only, engineer fee refused — both still outstanding on our position.
    const c2 = await draft(file2, 'letter.complaint_disp', { complaintSummary: HANDLER_FIELDS.complaintSummary });
    expect(c2.status).toBe(201);
    expect(c2.body.dataSnapshot).toMatchObject({ notificationDate: '2026-08-11', outstandingPence: 114000 });
    expect(c2.body.html).toContain('£1,395.00 claimed, of which £540.00 received');

    const l2 = await draft(file2, 'letter.letter_before_claim', { liabilityBasis: HANDLER_FIELDS.liabilityBasis });
    expect(l2.status).toBe(201);
    const s2 = l2.body.dataSnapshot as { scheduleTotalPence: number; schedule: Array<{ description: string; netPence: number }>; interest: { fromDate: string } };
    // no VAT (none is charged): storage £1,395.00 − £540.00 paid + engineer fee £285.00 refused = £1,140.00
    expect(s2.scheduleTotalPence).toBe(114000);
    expect(s2.schedule.reduce((a, l) => a + l.netPence, 0)).toBe(114000);
    expect(s2.interest.fromDate).toBe('2026-09-12'); // the payment pack date
    expect(l2.body.html).toContain('£1,140.00');

    const typed = await draft(file2, 'letter.letter_before_claim', { liabilityBasis: HANDLER_FIELDS.liabilityBasis, scheduleTotalPence: 200000 });
    expect(typed.status).toBe(400);
    expect(typed.body.error.details?.code).toBe('EXTRA_OVERRIDES_LEDGER');
  }, 60_000);
});

describe('(d) a wrong-typed handler field is a 400 naming it, never a 500', () => {
  const RECIPIENT = { name: 'Example Borough Council', addressLines: ['Town Hall'] };
  const cases: Array<[TemplateId, Record<string, unknown>, string]> = [
    ['letter.complaint_disp', { complaintSummary: 42 }, 'complaintSummary'],
    ['letter.complaint_disp', { complaintSummary: 'No reply.', againstOwnInsurer: 'yes' }, 'againstOwnInsurer'],
    ['letter.dsar', { authorityDate: 'last Tuesday' }, 'authorityDate'],
    ['letter.letter_before_claim', { liabilityBasis: { text: 'You hit me.' } }, 'liabilityBasis'],
    ['letter.part36_offer', { offerPence: '700000' }, 'offerPence'],
    ['letter.particularisation_demand', { allegationQuoted: ['Irregularities.'], allegationKind: 'fraud' }, 'allegationQuoted'],
    ['letter.particularisation_demand', { allegationQuoted: 'Irregularities.', allegationKind: 'dishonesty' }, 'allegationKind'],
    ['bundle.litigation_index', { solicitorName: 7 }, 'solicitorName'],
    ['statement.witness', { witness: { occupation: 7 }, paragraphs: ['I was there.'], accountGivenAt: '2026-10-01' }, 'witness.occupation'],
    ['statement.witness', { witness: { occupation: 'Nurse' }, paragraphs: 'I was there.', accountGivenAt: '2026-10-01' }, 'paragraphs'],
    ['letter.cctv_preservation', { operatorType: 'shop', recipient: RECIPIENT }, 'operatorType'],
    ['letter.cctv_preservation', { operatorType: 'premises', recipient: { name: 'Corner Shop', addressLines: 'High Street' } }, 'recipient.addressLines'],
    ['letter.client_update', { whatThisMeans: 12 }, 'whatThisMeans'],
    ['letter.supplier_instruction_engineer', { damageReported: 5, vehicle: { location: 'Yard' } }, 'damageReported'],
    ['letter.supplier_instruction_engineer', { damageReported: 'Rear damage.', vehicle: { location: 'Yard' }, questions: 'Is it repairable?' }, 'questions'],
    ['letter.vendor_verification_pack', { director: { idDocument: 5 } }, 'director.idDocument'],
  ];

  it('refuses each with the field named (File 1)', async () => {
    const claimId = s.claimIds.file1;
    await logPrerequisites(claimId);
    for (const [templateId, data, field] of cases) {
      const res = await draft(claimId, templateId, data);
      expect(res.status, `${templateId} ${field}: ${JSON.stringify(res.body.error ?? {})}`).toBe(400);
      expect(res.body.error.details?.field, `${templateId} ${field}`).toBe(field);
    }
  }, 60_000);
});

describe('regressions found in review', () => {
  it('a complaint addressed to the client’s own insurer is the policyholder’s: dated from the notice to that insurer, FOS route, no at-fault reference', async () => {
    const claimId = s.claimIds.file1;
    const own = t.ctx.repos.createParty(t.ctx.db, { kind: 'company', name: 'Own Cover Insurance plc', roles: ['insurer'], createdAt: '2026-08-10T09:00:00.000Z' });
    expect((await t.api('PATCH', `/claims/${claimId}`, { clientInsurerId: own.id })).status).toBe(200);
    const summary = { complaintSummary: 'The claim has not been handled at all.' };
    // Before: the at-fault framing told this insurer the claim was "presented to you" on the NCAF date (11 August).
    const noNotice = await draft(claimId, 'letter.complaint_disp', summary, own.id);
    expect(noNotice.status).toBe(409);
    expect(noNotice.body.error.code).toBe('NO_NOTIFICATION');
    await logEvent(claimId, { type: 'email_out', at: '2026-08-13T10:00:00.000Z', summary: 'Claim notified to Own Cover Insurance plc', attributableTo: 'ccguk', data: { recipientPartyId: own.id } });
    const res = await draft(claimId, 'letter.complaint_disp', summary, own.id);
    expect(res.status).toBe(201);
    expect(res.body.dataSnapshot).toMatchObject({ againstOwnInsurer: true, notificationDate: '2026-08-13', icobsDeadline: '2026-11-13' });
    expect((res.body.dataSnapshot as { claim: { theirReference?: string } }).claim.theirReference).toBeUndefined();
    expect(res.body.html).toContain('Financial Ombudsman Service');
    expect(res.body.html).not.toContain('EXI/2026/778899');
    const contradicted = await draft(claimId, 'letter.complaint_disp', { ...summary, againstOwnInsurer: false }, own.id);
    expect(contradicted.status).toBe(400);
    expect(contradicted.body.error.details).toMatchObject({ code: 'FORUM_MISMATCH', field: 'againstOwnInsurer' });
    // …and the at-fault insurer still never hears of the ombudsman.
    const atFault = await draft(claimId, 'letter.complaint_disp', summary);
    expect(atFault.status).toBe(201);
    expect(atFault.body.html).not.toMatch(/Financial Ombudsman|\bFOS\b/);
  }, 60_000);

  it('a DSAR is refused for a company claimant: the right of access belongs to individuals', async () => {
    const bundle = await t.api<{ claim: { claimantId: string } }>('GET', `/claims/${s.claimIds.file2}`);
    t.ctx.repos.updateParty(t.ctx.db, bundle.body.claim.claimantId, { kind: 'company', name: 'Oyelaran Logistics Ltd', companyNumber: '00000099' });
    const res = await draft(s.claimIds.file2, 'letter.dsar', { authorityDate: '2026-10-02' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_A_DATA_SUBJECT');
  }, 60_000);

  it('an insurer’s “authority to repair” or a “local authority” letter is never read as the claimant’s signed authority', async () => {
    const add = (claimId: string, description: string, filename: string, kind: 'document' | 'correspondence' = 'document') =>
      t.ctx.repos.insertEvidence(t.ctx.db, { claimId, kind, filename, mime: 'application/pdf', bytes: 1000, sha256: 'c'.repeat(64), storagePath: `evidence/${claimId}/${filename}`, capturedAt: '2026-09-20T10:00:00.000Z', uploadedAt: '2026-09-20T10:05:00.000Z', uploadedBy: 'handler', description });
    const { file1, file4 } = s.claimIds;
    add(file1, 'Insurer authority to repair the vehicle', 'authority_to_repair.pdf', 'correspondence');
    add(file1, 'Bodyshop repair authorisation', 'repair_authorisation.pdf');
    const dsar = await draft(file1, 'letter.dsar');
    expect(dsar.status).toBe(400);
    expect(dsar.body.error.details?.missing).toEqual(['authorityDate']);

    add(file4, 'Letter from the local authority about the junction', 'local_authority_letter.pdf');
    const cctv = await draft(file4, 'letter.cctv_preservation', { operatorType: 'premises', recipient: { name: 'Corner Shop', addressLines: ['Heathway', 'Dagenham'] } });
    expect(cctv.status).toBe(409);
    expect(cctv.body.error.code).toBe('NO_SIGNED_AUTHORITY');

    add(file4, 'Signed authority of Tomasz Nowak to correspond on his behalf', 'signed_authority.pdf');
    const ok = await draft(file4, 'letter.cctv_preservation', { operatorType: 'premises', recipient: { name: 'Corner Shop', addressLines: ['Heathway', 'Dagenham'] } });
    expect(ok.status).toBe(201);
    expect((ok.body.dataSnapshot as { authorityDate: string }).authorityDate).toBe('2026-09-20');
  }, 60_000);

  it('a witness must be on this claim, and a witness is never named as the proposed defendant', async () => {
    const { file3, file4 } = s.claimIds;
    await logPrerequisites(file4);
    const claim4 = (await t.api<{ claim: { thirdPartyIds: string[] } }>('GET', `/claims/${file4}`)).body.claim;
    const claim3 = (await t.api<{ claim: { claimantId: string } }>('GET', `/claims/${file3}`)).body.claim;
    const extras = { witness: { occupation: 'Retail assistant', capacity: 'a witness for the Claimant' }, paragraphs: ['I was the front-seat passenger in my husband’s car.'], accountGivenAt: '2026-09-28' };
    const foreign = await draft(file4, 'statement.witness', { ...extras, witnessPartyId: claim3.claimantId });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details).toMatchObject({ code: 'PARTY_NOT_ON_CLAIM', field: 'witnessPartyId' });

    // The witness listed first among the third parties (a third party not yet identified at FNOL) is still not the defendant.
    const [driverId, witnessId] = claim4.thirdPartyIds;
    t.ctx.repos.updateClaim(t.ctx.db, file4, { thirdPartyIds: [witnessId!, driverId!] });
    const res = await draft(file4, 'statement.witness', { ...extras, witnessPartyId: witnessId });
    expect(res.status).toBe(201);
    expect(res.body.dataSnapshot).toMatchObject({ witness: { name: 'Agnieszka Nowak', capacity: 'a witness for the Claimant' }, parties: { claimant: 'Tomasz Nowak', defendant: 'Oliver Grant' }, signatory: { name: 'Agnieszka Nowak', role: 'Witness' } });
    expect(openBlocks(res.body)).toEqual([]);
  }, 60_000);

  it('an internal note is never quoted back to the insurer as “your letter”', async () => {
    const claimId = s.claimIds.file1;
    const noteId = await logEvent(claimId, { type: 'note', at: '2026-10-02T10:00:00.000Z', summary: 'Internal: handler view on the allegation', attributableTo: 'ccguk' });
    const res = await draft(claimId, 'letter.particularisation_demand', { allegationQuoted: 'Irregularities.', allegationKind: 'irregularity', allegationEventId: noteId });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toMatchObject({ code: 'INVALID_FIELD', field: 'allegationEventId' });
  }, 60_000);

  it('a hearing bundle indexes a witness statement only once it is signed, never the approved draft', async () => {
    const ids = s.claimIds;
    await logPrerequisites(ids.file1);
    const statement = await draft(ids.file1, 'statement.witness', { witness: { occupation: 'Community nurse' }, paragraphs: ['I was stationary in traffic when a van struck the rear of my car.'], accountGivenAt: '2026-10-03' });
    expect(statement.status).toBe(201);
    t.ctx.repos.approveDocument(t.ctx.db, statement.body.id, { userId: 'approver' }, '2026-10-05T09:00:00.000Z');
    const res = await draft(ids.file1, 'bundle.litigation_index');
    expect(res.status).toBe(201);
    const sections = (res.body.dataSnapshot as { sections: Array<{ key: string; documents: Array<{ description: string }> }> }).sections;
    expect(sections.some((x) => x.key === 'witness_statements')).toBe(false);
    expect(res.body.html).not.toContain('Witness statement of Jane Doe');
  }, 60_000);
});
