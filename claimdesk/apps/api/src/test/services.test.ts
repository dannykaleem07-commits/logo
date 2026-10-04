/**
 * Services half of @ccguk/api: evidence store, documents (consistency, approval → PDF, send, sign), engineering,
 * fleet (s.172 refusal), directory status ageing, watch poll, analytics on the seed, settings, full seed.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Claim, GeneratedDocument } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { absoluteEvidencePath, manifestPath } from '../services/evidence.js';
import { recomputeClocks } from '../services/claimView.js';
import { seedArchetypes } from '../seed/archetypes.js';
import { makePng } from '../seed/png.js';

const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!process.env.CHROMIUM_PATH && existsSync(CHROMIUM)) process.env.CHROMIUM_PATH = CHROMIUM;

function multipart(fields: Record<string, string>, file: { name: string; mime: string; data: Buffer }): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----claimdesk${Date.now()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

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

describe('evidence store', () => {
  it('hashes while streaming, stores write-once with a manifest, dedupes, verifies and refuses mutation', async () => {
    const ids = seedFileOne();
    const png = makePng({ seed: 11 });
    const { payload, headers } = multipart({ kind: 'photo', captureShot: 'front_left', description: 'front left' }, { name: 'front_left.png', mime: 'image/png', data: png });
    const res = await t.app.inject({ method: 'POST', url: `/api/claims/${ids.claimId}/evidence`, payload, headers });
    expect(res.statusCode).toBe(201);
    const ev = res.json() as { id: string; sha256: string; bytes: number; storagePath: string; exif?: { widthPx: number }; deduped: boolean; captureShot: string };
    const expected = (await import('node:crypto')).createHash('sha256').update(png).digest('hex');
    expect(ev.sha256).toBe(expected);
    expect(ev.bytes).toBe(png.length);
    expect(ev.captureShot).toBe('front_left');
    expect(ev.exif?.widthPx).toBe(64);
    const abs = absoluteEvidencePath(t.ctx, ev.storagePath);
    expect(existsSync(abs)).toBe(true);
    expect(statSync(abs).mode & 0o222).toBe(0);
    expect(existsSync(manifestPath(abs))).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath(abs), 'utf8')).sha256).toBe(expected);

    // same bytes again → existing record
    const again = await t.app.inject({ method: 'POST', url: `/api/claims/${ids.claimId}/evidence`, payload, headers });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { id: string; deduped: boolean }).id).toBe(ev.id);
    expect((again.json() as { deduped: boolean }).deduped).toBe(true);

    // device hash mismatch is refused
    const bad = multipart({ kind: 'photo', sha256: 'a'.repeat(64) }, { name: 'x.png', mime: 'image/png', data: makePng({ seed: 12 }) });
    const badRes = await t.app.inject({ method: 'POST', url: `/api/claims/${ids.claimId}/evidence`, payload: bad.payload, headers: bad.headers });
    expect(badRes.statusCode).toBe(409);
    expect((badRes.json() as ErrorBody).error.code).toBe('HASH_MISMATCH');

    // metadata, file stream, verify
    const meta = await t.api<{ id: string; immutable: boolean }>('GET', `/evidence/${ev.id}`);
    expect(meta.body.immutable).toBe(true);
    const file = await t.app.inject({ method: 'GET', url: `/api/evidence/${ev.id}/file` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(String(file.headers['content-disposition'])).toContain('front_left.png');
    expect(file.rawPayload.equals(png)).toBe(true);
    const verify = await t.api<{ status: string; manifest: string }>('POST', `/evidence/${ev.id}/verify`);
    expect(verify.body.status).toBe('intact');
    expect(verify.body.manifest).toBe('ok');

    // tamper → detected
    chmodSync(abs, 0o644);
    writeFileSync(abs, Buffer.concat([png, Buffer.from([1])]));
    const tampered = await t.api<{ status: string }>('POST', `/evidence/${ev.id}/verify`);
    expect(tampered.body.status).toBe('tampered');

    // immutable rows
    const patch = await t.api<ErrorBody>('PATCH', `/evidence/${ev.id}`, { description: 'x' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('IMMUTABLE');
    const del = await t.api<ErrorBody>('DELETE', `/evidence/${ev.id}`);
    expect(del.status).toBe(409);
    const audit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'evidence', entityId: ev.id }).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['evidence.upload', 'evidence.verify']));
  });
});

describe('documents: draft → consistency → approve → PDF → send → sign', () => {
  it('lists templates with requiredData', async () => {
    const res = await t.api<{ items: Array<{ id: string; requiredData: string[]; recipientRole?: string }> }>('GET', '/templates');
    const chaser = res.body.items.find((x) => x.id === 'letter.chaser_7');
    expect(chaser).toBeDefined();
    expect(chaser!.requiredData).toContain('totals.receivedPence');
  });

  it('intervention reply: refuses until the client decision and the terms-explained answer are recorded, then drafts against the chosen offer', async () => {
    const ids = seedFileOne();
    const now = t.ctx.now();
    const at = new Date(Date.parse(now) - 3_600_000).toISOString();
    const created = await t.api<{ offer?: { id: string }; id?: string }>('POST', `/claims/${ids.claimId}/offers`, { receivedAt: at, channel: 'phone', offerorName: 'Example Insurance intervention team', vehicleClassOffered: 'Group B', dailyRatePence: 2037 });
    expect(created.status).toBe(201);
    const offerId = (created.body.offer?.id ?? created.body.id)!;
    const pending = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.intervention_reply', data: { offerId } });
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('OFFER_DECISION_PENDING');
    const patched = await t.api('PATCH', `/claims/${ids.claimId}/offers/${offerId}`, { clientDecision: 'declined', clientReasons: 'Smaller class and a £500 excess.', clientDecisionAt: now, suitable: false, suitabilityReasons: ['Smaller vehicle class'] });
    expect(patched.status).toBe(200);
    const noTerms = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.intervention_reply', data: { offerId } });
    expect(noTerms.status).toBe(400);
    expect(noTerms.body.error.details?.code).toBe('OFFER_TERMS_EXPLAINED_REQUIRED');
    const ok = await t.api<GeneratedDocument>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.intervention_reply', data: { offerId, offer: { termsExplained: false } } });
    expect(ok.status).toBe(201);
    expect(ok.body.html).toContain('Copley v Lawn');
    expect(ok.body.html).toContain('£20.37');
    const unknownOffer = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.intervention_reply', data: { offerId: '00000000-0000-4000-8000-000000000000', offer: { termsExplained: false } } });
    expect(unknownOffer.status).toBe(404);
  });

  it('warns when handler text is supplied in a field the template never prints (no silent loss)', async () => {
    const ids = seedFileOne();
    const res = await t.api<GeneratedDocument>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.chaser_7', data: { additionalParagraph: 'We note that £1,287 was received on 25 September 2026.' } });
    expect(res.status).toBe(201);
    expect(res.body.html).not.toContain('1,287');
    const warn = res.body.consistency?.flags.find((f) => f.code === 'UNKNOWN_REFERENCE');
    expect(warn?.severity).toBe('warn');
    expect(warn?.message).toContain('additionalParagraph');
  });

  it('builds letter.chaser_7 on File 1 from the ledger (unblocked), blocks a draft asserting £1,287 received, and approves to PDF only after clearing', async () => {
    const ids = seedFileOne();
    const clean = await t.api<GeneratedDocument>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.chaser_7' });
    expect(clean.status).toBe(201);
    expect(clean.body.status).toBe('draft');
    expect(clean.body.consistency?.blocked).toBe(false);
    // Every block the engine raised on the ledger-written table was reconciled by the system, with a reason; none is open.
    expect(clean.body.consistency?.flags.filter((f) => f.severity === 'block' && !f.clearedAt)).toEqual([]);
    const systemCleared = clean.body.consistency?.flags.filter((f) => f.clearedBy === 'system') ?? [];
    expect(systemCleared.every((f) => f.code === 'AMOUNT_PAID_MISMATCH' && /ledger/i.test(f.clearedReason ?? ''))).toBe(true);
    const snap = clean.body.dataSnapshot as { totals: { receivedPence: number; claimedPence: number }; hire: { days: number; dailyRatePence: number }; pack: { sentAt: string } };
    expect(snap.totals.receivedPence).toBe(111200);
    expect(snap.hire.days).toBe(23);
    expect(snap.hire.dailyRatePence).toBe(4980);
    expect(snap.pack.sentAt).toBe('2026-09-05');
    expect(clean.body.html).toContain('1,112.00');
    expect(clean.body.html).not.toContain('1,287');

    // The handler may not retype ledger figures
    const override = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.chaser_7', data: { totals: { receivedPence: 128700 } } });
    expect(override.status).toBe(400);
    expect(override.body.error.details?.code).toBe('EXTRA_OVERRIDES_LEDGER');

    // Free text that contradicts the ledger is blocked (lesson a)
    const wrong = await t.api<GeneratedDocument>('POST', `/claims/${ids.claimId}/documents`, {
      templateId: 'letter.chaser_7',
      data: { insurerPosition: { statedAt: '2026-09-26', summary: 'You stated that £1,287 was received in full and final settlement.', response: ['The remittance received was £1,112.00; the balance remains outstanding.'] } },
    });
    expect(wrong.status).toBe(201);
    expect(wrong.body.status).toBe('blocked');
    const flag = wrong.body.consistency?.flags.find((f) => f.code === 'AMOUNT_PAID_MISMATCH' && !f.clearedAt);
    expect(flag?.severity).toBe('block');
    expect(flag?.draftValue).toBe('£1,287.00'); // the handler's figure is the only open block — the system never clears a typed amount
    const blockedApprove = await t.api<ErrorBody>('POST', `/documents/${wrong.body.id}/approve`, {});
    expect(blockedApprove.status).toBe(409);
    expect(blockedApprove.body.error.code).toBe('DOCUMENT_BLOCKED');
    const cleared = await t.api<GeneratedDocument>('POST', `/documents/${wrong.body.id}/clear-flag`, { code: 'AMOUNT_PAID_MISMATCH', excerpt: flag?.excerpt, reason: 'Quoting the insurer’s own wrong figure to correct it; the letter states £1,112.00 received.' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.status).toBe('draft');
    expect(cleared.body.consistency?.flags.find((f) => f.draftValue === '£1,287.00')?.clearedReason).toContain('wrong figure');

    const approved = await t.api<GeneratedDocument>('POST', `/documents/${wrong.body.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approvedBy).toBe('handler');
    expect(approved.body.pdfPath).toBeTruthy();
    expect(approved.body.sha256).toMatch(/^[a-f0-9]{64}$/);
    const pdf = await t.app.inject({ method: 'GET', url: `/api/documents/${wrong.body.id}/pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const audit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'documents', entityId: wrong.body.id }).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['document.create', 'document.flag.clear', 'document.approve', 'document.pdf']));
  }, 120_000);

  it('send records sentAt + events without transmitting, and the OTP sign flow round-trips to a certificate', async () => {
    const ids = seedFileOne();
    const draft = await t.api<GeneratedDocument>('POST', `/claims/${ids.claimId}/documents`, { templateId: 'letter.chaser_7' });
    expect(draft.body.status).toBe('draft');
    const notApproved = await t.api<ErrorBody>('POST', `/documents/${draft.body.id}/send`, { via: 'email' });
    expect(notApproved.status).toBe(409);
    const approved = await t.api<GeneratedDocument>('POST', `/documents/${draft.body.id}/approve`, {});
    expect(approved.status).toBe(200);

    // sign: start → verify
    const noCode = await t.api<ErrorBody>('POST', `/documents/${draft.body.id}/sign/verify`, { code: '000000' });
    expect(noCode.status).toBe(400);
    const start = await t.api<{ challengeId: string; expiresAt: string; devCode?: string; channel: string }>('POST', `/documents/${draft.body.id}/sign/start`, { signerPartyId: ids.claimantId, contact: 'jane.doe@example.test', channel: 'email' });
    expect(start.status).toBe(200);
    expect(start.body.devCode).toMatch(/^\d{6}$/);
    const wrongCode = await t.api<ErrorBody>('POST', `/documents/${draft.body.id}/sign/verify`, { challengeId: start.body.challengeId, code: start.body.devCode === '123456' ? '654321' : '123456' });
    expect(wrongCode.status).toBe(400);
    expect(wrongCode.body.error.code).toBe('OTP_INVALID');
    t.setNow('2026-10-05T09:03:00.000Z');
    const signed = await t.api<GeneratedDocument & { certificateId: string; certificatePdfPath?: string }>('POST', `/documents/${draft.body.id}/sign/verify`, { challengeId: start.body.challengeId, code: start.body.devCode! });
    expect(signed.status).toBe(200);
    expect(signed.body.status).toBe('signed');
    expect(signed.body.signature?.signerPartyId).toBe(ids.claimantId);
    expect(signed.body.signature?.documentSha256).toBe(approved.body.sha256);
    expect(signed.body.certificateId).toMatch(/^CERT-/);
    expect(signed.body.certificatePdfPath).toBeTruthy();
    // a signed document can still be sent (recorded only)
    const sent = await t.api<GeneratedDocument & { send: { events: Array<{ type: string }>; note: string }; pdfBase64?: string }>('POST', `/documents/${draft.body.id}/send`, { via: 'email', to: 'thirdparty.claims@example-insurer.test' });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.sentVia).toBe('email');
    expect(sent.body.send.events.map((e) => e.type)).toEqual(expect.arrayContaining(['email_out', 'chaser_sent']));
    expect(sent.body.send.note).toMatch(/nothing has been transmitted/i);
    expect(Buffer.from(sent.body.pdfBase64 ?? '', 'base64').subarray(0, 4).toString()).toBe('%PDF');
    const events = await t.api<{ events: Array<{ type: string; documentId?: string }> }>('GET', `/claims/${ids.claimId}/events?type=chaser_sent`);
    expect(events.body.events.some((e) => e.documentId === draft.body.id)).toBe(true);

    // supersede → new draft carrying the re-execution line
    const superseded = await t.api<GeneratedDocument>('POST', `/documents/${draft.body.id}/supersede`, { reExecutedOn: '2026-10-05' });
    expect(superseded.status).toBe(201);
    expect(superseded.body.supersedesId).toBe(draft.body.id);
    expect(superseded.body.reExecutedOn).toBe('2026-10-05');
    expect(superseded.body.html).toContain('re-executed on 5 October 2026');
    expect((await t.api<GeneratedDocument>('GET', `/documents/${draft.body.id}`)).body.status).toBe('superseded');
  }, 120_000);
});

describe('intake: web-client FNOL body, domain validation and witness independence', () => {
  const WEB_FNOL = {
    channel: 'phone',
    disclosure: { callRecordingReadAt: '2026-10-05T08:55:00.000Z', acknowledged: true, acknowledgedBy: 'Priya Shah' },
    claimant: { name: 'Priya Shah', phone: '07700 900555', email: 'priya@example.test', address: { line1: '8 Mill Lane', town: 'Ilford', postcode: 'IG1 2AB' } },
    vehicle: { registration: 'LB19 XYZ', make: 'BMW', model: '320d', gtaGroup: 'M' },
    accident: { occurredAt: '2026-10-03T08:30:00.000Z', location: 'High Road, Ilford, at the junction with Ley Street', circumstances: 'I was stationary at the red light when the van behind failed to stop and hit the back of my car. The driver got out and said he was looking at his phone.', policeAttended: false, injuries: false, roadworthyAfter: false, driveable: false, cctvAvailable: true },
    thirdParty: { registration: 'AB12 CDE', driverName: 'Mark Ellis', insurerName: 'Example Insurance plc', insurerPolicyNumber: 'POL-77' },
    witnesses: [{ name: 'Rohan Shah', phone: '07700 900555', relationshipToClaimant: 'brother' }],
    clientInsurer: { name: 'Own Insurer Ltd', policyNumber: 'OWN-1' },
    injury: { reported: false },
    services: { hire: true, recovery: true, storage: false, engineer: true },
    gtaSubscriber: false,
  };

  it('accepts the wizard body, answers as a Claim with intake, defaults roles, links the witness and flags the connection', async () => {
    const res = await t.api<Claim & { claim: Claim; intake: { validation: { ok: boolean; incomplete: Array<{ field: string }> }; witnesses: Array<{ independent: boolean; reasons: string[] }>; flags: Array<{ code: string }> } }>('POST', '/claims', WEB_FNOL);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(res.body.claim.id);
    expect(res.body.reference).toMatch(/^CCG-/);
    const claimant = await t.api<{ roles: string[] }>('GET', `/parties/${res.body.claimantId}`);
    expect(claimant.body.roles).toEqual(['claimant', 'driver']);
    expect(res.body.clientPolicyNumber).toBe('OWN-1');
    expect(res.body.clientInsurerId).toBeTruthy();
    expect(res.body.thirdPartyVehicleId).toBeTruthy();
    expect(res.body.thirdPartyIds).toHaveLength(2); // the other driver + the witness
    const codes = res.body.flags.map((f) => f.code);
    expect(codes).toContain('NON_INDEPENDENT_WITNESS');
    expect(res.body.intake.witnesses[0]).toMatchObject({ independent: false });
    expect(res.body.intake.witnesses[0]!.reasons.join(' ')).toMatch(/brother|phone/);
    // the script-guard question was not answered in this body → the domain's mandatory question becomes an open flag, not a 400
    expect(codes).toContain('INTAKE_INCOMPLETE');
    expect(res.body.intake.validation.incomplete.map((i) => i.field)).toEqual(['offerDisclosed']);
    const events = await t.api<{ events: Array<{ type: string; data?: { callRecordingDisclosed?: boolean; channel?: string } }> }>('GET', `/claims/${res.body.id}/events`);
    const fnol = events.body.events.find((e) => e.type === 'fnol');
    expect(fnol?.data).toMatchObject({ callRecordingDisclosed: true, channel: 'phone' });
  });

  it('hard-stops a bad third-party plate, a short account and an account not taken cold', async () => {
    const plate = await t.api<ErrorBody>('POST', '/claims', { ...WEB_FNOL, thirdParty: { ...WEB_FNOL.thirdParty, registration: '1NVALID!!' } });
    expect(plate.status).toBe(400);
    expect((plate.body.error.details?.missing as string[]).join(' ')).toContain('thirdParty.registration');
    const cold = await t.api<ErrorBody>('POST', '/claims', { ...WEB_FNOL, takenCold: false });
    expect(cold.status).toBe(400);
    expect((cold.body.error.details?.missing as string[]).join(' ')).toContain('accident.takenCold');
    const short = await t.api<ErrorBody>('POST', '/claims', { ...WEB_FNOL, accident: { ...WEB_FNOL.accident, circumstances: 'Rear-ended at the lights.' } });
    expect(short.status).toBe(400);
    expect((short.body.error.details?.missing as string[]).join(' ')).toContain('accident.circumstances');
  });

  it('allocate-check reports the domain warnings alongside the hard reasons', async () => {
    const ids = seedFileOne();
    const check = await t.api<{ allowed: boolean; reasons: string[]; warnings: string[] }>('POST', `/fleet/${ids.fleetUnitId}/allocate-check`, { use: 'credit_hire' });
    expect(check.status).toBe(200);
    expect(Array.isArray(check.body.warnings)).toBe(true);
    expect(check.body.allowed).toBe(false); // File 1's unit has no policy linked
    expect(check.body.reasons.join(' ')).toMatch(/polic/i);
  });
});

describe('engineering', () => {
  it('computes estimate totals with pre-existing damage excluded, reconciles, and predicts total loss', async () => {
    const ids = seedFileOne();
    const created = await t.api<{ id: string; totals: { netPence: number; preExistingExcludedPence: number; labourHours: number } }>('POST', `/claims/${ids.claimId}/estimate`, {
      labourRatePence: 4800,
      paintRatePence: 4800,
      paintMaterialsMethod: 'per_hour',
      paintMaterialsPerHourPence: 2200,
      lines: [
        { kind: 'labour', operation: 'Replace', panel: 'Rear bumper', description: 'Remove and replace rear bumper', quantity: 1, hours: 1.5, confirmedByEngineer: true },
        { kind: 'part', operation: 'Replace', panel: 'Rear bumper', description: 'Rear bumper cover OEM', partSource: 'oem', quantity: 1, unitPence: 28500, confirmedByEngineer: true },
        { kind: 'paint', operation: 'Refinish', panel: 'Rear bumper', description: 'Refinish bumper', quantity: 1, hours: 2, confirmedByEngineer: true },
        { kind: 'labour', operation: 'Repair', panel: 'Bonnet', description: 'Stone chips (pre-existing)', quantity: 1, hours: 1, preExisting: true, confirmedByEngineer: true },
      ],
      importedTotalPence: 50900,
    });
    expect(created.status).toBe(201);
    expect(created.body.totals.labourHours).toBe(1.5);
    expect(created.body.totals.preExistingExcludedPence).toBe(4800);
    expect(created.body.totals.netPence).toBe(7200 + 28500 + 9600 + 4400);
    const rec = await t.api<{ reconciled: boolean; differencePence: number }>('POST', `/claims/${ids.claimId}/estimate/${created.body.id}/reconcile`, { importedTotalPence: 49700 });
    expect(rec.body.reconciled).toBe(true);
    const approved = await t.api<{ approvedBy: string; labourEntriesAdded: number }>('POST', `/claims/${ids.claimId}/estimate/${created.body.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.labourEntriesAdded).toBe(2);
    const lib = await t.api<{ total: number; items: Array<{ suggestedHours: number | null }> }>('GET', '/engineering/labour-library/suggest?make=VOLKSWAGEN');
    expect(lib.body.total).toBe(2);
    expect(lib.body.items.every((i) => i.suggestedHours === null)).toBe(true);
    const predict = await t.api<{ probability: number; band: string; calibrated: boolean }>('POST', `/claims/${ids.claimId}/total-loss/predict`, { vehicleAgeYears: 7, pavBandPence: 650000, roughRepairPence: 520000, damageZones: ['rear'], airbagsDeployed: false, structuralIndicators: ['chassis_leg'], driveable: false });
    expect(predict.body.band).toBe('high');
    expect(predict.body.calibrated).toBe(false);
    const assess = await t.api<{ decision: string; totalLossRouteCostPence: number }>('POST', `/claims/${ids.claimId}/total-loss/assess`, { salvagePence: 120000, salvageSource: 'bid', repairNetPence: 520000 });
    expect(['repair', 'total_loss', 'borderline']).toContain(assess.body.decision);
    const comparable = await t.api<ErrorBody>('POST', `/claims/${ids.claimId}/pav/comparables`, { source: 'Auto Trader', pricePence: 640000, mileage: 50000, year: 2019, make: 'VOLKSWAGEN', model: 'GOLF', seller: 'dealer' });
    expect(comparable.status).toBe(400); // needs evidenceId or url + capturedAt
  });
});

describe('fleet', () => {
  it('refuses a s.172 response that both pleads s.172(4) and names a driver, and raises alerts', async () => {
    const ids = seedFileOne();
    const pen = await t.api<{ id: string }>('POST', '/fleet/penalties', { fleetUnitId: ids.fleetUnitId, kind: 'nip_s172', issuer: 'Example Police', noticeNumber: 'NIP/EX/1', contraventionAt: '2026-09-30T08:00:00.000Z', receivedAt: '2026-10-03T00:00:00.000Z', amountPence: 10000, responseDeadline: '2026-10-31' });
    expect(pen.status).toBe(201);
    const refused = await t.api<ErrorBody>('POST', `/fleet/penalties/${pen.body.id}/documents`, { templateId: 'notice.s172_response', data: { cannotIdentify: true, driverName: 'Somebody Else' } });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details?.code).toBe('S172_REFUSAL');
    // no hire covered 30 Sep (File 1 hire ended 2 Sep) → naming the File 1 hirer is refused too
    const unsupported = await t.api<ErrorBody>('POST', `/fleet/penalties/${pen.body.id}/documents`, { templateId: 'notice.s172_response', data: { cannotIdentify: false, driverName: 'Jane Doe' } });
    expect(unsupported.status).toBe(400);
    const honest = await t.api<GeneratedDocument>('POST', `/fleet/penalties/${pen.body.id}/documents`, { templateId: 'notice.s172_response', data: { cannotIdentify: true, diligence: ['Hire records: no agreement covering 30 Sep 2026', 'Key log: vehicle in yard, keys signed out by a yard employee for a test drive'], issuerAddressLines: ['PO Box 1', 'Example Town', 'EX1 1AA'] } });
    expect(honest.status).toBe(201);
    expect(honest.body.templateId).toBe('notice.s172_response');
    expect(honest.body.html).toContain('172(4)');
    const transition = await t.api<ErrorBody>('POST', `/fleet/penalties/${pen.body.id}/transition`, { stage: 'liability_transferred' });
    expect(transition.status).toBe(409);
    const alerts = await t.api<{ items: Array<{ code: string }> }>('GET', '/fleet/alerts');
    expect(alerts.body.items.map((a) => a.code)).toContain('INSURANCE_EXPIRED'); // no policy linked on the File 1 unit
    const check = await t.api<{ allowed: boolean; reasons: string[] }>('POST', `/fleet/${ids.fleetUnitId}/allocate-check`, { use: 'pco' });
    expect(check.body.allowed).toBe(false);
  });
});

describe('directory and knowledge base', () => {
  it('ages a verified entry into stale, verifies with a source URL, and records failures', async () => {
    const list = await t.api<{ items: Array<{ id: string; directoryStatus: string }>; total: number }>('GET', '/directory?q=admiral');
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThan(0);
    const id = list.body.items[0]!.id;
    t.ctx.repos.verifyDirectoryEntry(t.ctx.db, id, { userId: 'handler' }, { sourceUrl: 'https://www.example-insurer.test/claims', verifiedAt: '2025-01-10' });
    const stale = await t.api<{ directoryStatus: string; statusInfo: { ageDays?: number } }>('GET', `/directory/${id}`);
    expect(stale.body.directoryStatus).toBe('stale');
    expect(stale.body.statusInfo.ageDays).toBeGreaterThan(180);
    const verified = await t.api<{ directoryStatus: string; verification: { verifiedBy?: string } }>('PATCH', `/directory/${id}/verify`, { sourceUrl: 'https://www.example-insurer.test/claims', verifiedBy: 'approver' });
    expect(verified.status).toBe(200);
    expect(verified.body.directoryStatus).toBe('verified');
    const failed = await t.api<{ directoryStatus: string }>('POST', `/directory/${id}/report-failed`, { field: 'thirdPartyClaimsPhone', note: 'number unobtainable' });
    expect(failed.body.directoryStatus).toBe('failed');
    const search = await t.api<{ items: Array<{ id: string; score: number }> }>('GET', '/kb/search?q=impecuniosity');
    expect(search.body.items.length).toBeGreaterThan(0);
    const advise = await t.api<{ summary: string; points: unknown[]; caveats: string[] }>('GET', '/kb/advise?topic=fos');
    expect(advise.body.caveats.some((c) => /DISP 2.7/.test(c))).toBe(true);
    const rates = await t.api<{ items: Array<{ group: string; dailyRatePence: number }>; note: string }>('GET', '/kb/gta-rates?date=2026-10-01&group=S1');
    expect(rates.body.items[0]?.dailyRatePence).toBe(4232);
    expect(rates.body.note).toMatch(/benchmark|subscriber/i);
    const ladder = await t.api<{ items: Array<{ code: string }> }>('GET', '/kb/get-paid-faster');
    expect(ladder.body.items.map((i) => i.code)).toContain('SEND_NCAF');
  });
});

describe('watch, analytics, settings', () => {
  it('polls gracefully without a key and keeps CARFLEX high risk', async () => {
    const add = await t.api<{ companyNumber: string; riskLevel: string }>('POST', '/watch', { companyNumber: '12640635', name: 'CARFLEX LTD', role: 'supplier', riskLevel: 'high' });
    expect(add.status).toBe(201);
    const poll = await t.api<{ polled: number; skipped: number; items: Array<{ riskLevel: string; riskReasons: string[] }>; note?: string }>('POST', '/watch/poll', {});
    expect(poll.body.polled).toBe(0);
    expect(poll.body.skipped).toBe(1);
    expect(poll.body.items[0]?.riskLevel).toBe('high');
    expect(poll.body.items[0]?.riskReasons.some((r) => /unverified/i.test(r))).toBe(true);
  });

  it('computes debtor days, reductions, cycle times and interventions on File 1', async () => {
    seedFileOne();
    const dd = await t.api<{ byInsurer: Array<{ insurerName: string; days: number; outstandingPence: number; payments: number }>; outstandingPence: number }>('GET', '/analytics/debtor-days');
    const ins = dd.body.byInsurer.find((i) => i.insurerName === 'Example Insurance Ltd');
    expect(ins?.payments).toBe(1);
    expect(ins?.days).toBeGreaterThanOrEqual(19);
    expect(ins?.days).toBeLessThanOrEqual(20);
    // claimed 853,140p (recovery 15,100 + engineer 28,500 + PAV 650,000 + storage 45,000 + hire 114,540) less 111,200p paid
    expect(ins?.outstandingPence).toBe(741940);
    expect(dd.body.outstandingPence).toBe(741940);
    const red = await t.api<{ byHead: Array<{ head: string; claimedPence: number; paidPence: number; reducedPence: number }> }>('GET', '/analytics/reductions');
    const hire = red.body.byHead.find((h) => h.head === 'hire');
    expect(hire).toMatchObject({ claimedPence: 114540, paidPence: 111200, reducedPence: 3340 });
    const ct = await t.api<{ stages: Array<{ code: string; medianDays: number; claims: number }> }>('GET', '/analytics/cycle-times');
    const packToPay = ct.body.stages.find((s) => s.code === 'pack_to_payment');
    expect(packToPay?.claims).toBe(1);
    expect(packToPay?.medianDays).toBeGreaterThanOrEqual(19);
    const inter = await t.api<{ offers: number; declined: number; replied: number; averageOfferedDailyRatePence?: number }>('GET', '/analytics/interventions');
    expect(inter.body).toMatchObject({ offers: 1, declined: 1, replied: 1, averageOfferedDailyRatePence: 2037 });
    const overview = await t.api<{ claims: { open: number }; debtorDays: { outstandingPence: number }; blockedDocuments: unknown[] }>('GET', '/analytics/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.claims.open).toBe(1);
  });

  it('warns when the bank account name is not the registered name and refuses legacy details', async () => {
    const legacy = await t.api<ErrorBody>('PATCH', '/settings', { bank: { accountName: 'Carflex Ltd', sortCode: '00-00-00', accountNumber: '00000000', bankName: 'Bank' } });
    expect(legacy.status).toBe(400);
    expect(legacy.body.error.details?.code).toBe('LEGACY_DETAIL');
    const mismatch = await t.api<{ warnings: Array<{ code: string }> }>('PATCH', '/settings', { bank: { accountName: 'Courtesy Cars UK', sortCode: '00-00-00', accountNumber: '00000000', bankName: 'Bank' } });
    expect(mismatch.status).toBe(200);
    expect(mismatch.body.warnings.map((w) => w.code)).toContain('CONFIRMATION_OF_PAYEE');
    const ok = await t.api<{ warnings: Array<{ code: string }>; rateCard: { storageDailyPence: number } }>('PATCH', '/settings', { bank: { accountName: 'Courtesy Cars Group UK Ltd', sortCode: '00-00-00', accountNumber: '00000000', bankName: 'Bank' }, rateCard: { recoveryPerLoadedMilePence: 300 } });
    expect(ok.body.warnings.map((w) => w.code)).not.toContain('CONFIRMATION_OF_PAYEE');
    expect(ok.body.rateCard.storageDailyPence).toBe(4500);
  });
});

describe('seed', () => {
  it('creates the four archetypes, fleet, watch list and evidence, and raises SUPPLIER_HIGH_RISK on the CARFLEX file', async () => {
    const summary = await seedArchetypes(t.ctx);
    expect(Object.keys(summary.claimIds)).toHaveLength(4);
    expect(summary.evidenceIds.length).toBeGreaterThanOrEqual(7);
    expect(summary.flagsRaised).toBeGreaterThanOrEqual(1);
    const file2 = await t.api<{ claim: { flags: Array<{ code: string }> }; ledger: unknown[] }>('GET', `/claims/${summary.claimIds.file2}`);
    expect(file2.body.claim.flags.map((f) => f.code)).toContain('SUPPLIER_HIGH_RISK');
    const file4 = await t.api<{ claim: { flags: Array<{ code: string }> } }>('GET', `/claims/${summary.claimIds.file4}`);
    expect(file4.body.claim.flags.map((f) => f.code)).toContain('NON_INDEPENDENT_WITNESS');
    const alerts = await t.api<{ items: Array<{ code: string }> }>('GET', '/fleet/alerts');
    expect(alerts.body.items.map((a) => a.code)).toEqual(expect.arrayContaining(['USE_NOT_COVERED', 'KEEPER_ADDRESS_STALE']));
    const watch = await t.api<{ items: Array<{ companyNumber: string; riskLevel: string }> }>('GET', '/watch');
    expect(watch.body.items).toEqual([expect.objectContaining({ companyNumber: '12640635', riskLevel: 'high' })]);
    const red = await t.api<{ byHead: Array<{ head: string; reducedPence: number }> }>('GET', '/analytics/reductions');
    expect(red.body.byHead.find((h) => h.head === 'engineer_fee')?.reducedPence).toBe(28500);
    const verify = await t.api<{ status: string }>('POST', `/evidence/${summary.evidenceIds[0]}/verify`);
    expect(verify.body.status).toBe('intact');
    // the second seed run is a no-op guard at the CLI level; archetypes themselves are not re-run here
    const list = await t.api<{ total: number }>('GET', '/claims');
    expect(list.body.total).toBe(4);
  }, 60_000);
});
