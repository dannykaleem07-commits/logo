// owned by intake-server
/**
 * Smart intake end to end (docs/SMART-INTAKE.md §16.6): a mixed upload for "Jane Doe – Corsa crash" read with the
 * agents off (documents' text only), then with the agents on (fake AI), reconciled, corrected by the owner and
 * registered — and a clean bundle registered automatically when Settings > Intake allows it. Every document is
 * generated at test time; no model or network is ever called (FakeDriver fixtures).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BANNED_INTAKE_WORDS } from '@ccguk/domain';
import { closeBrowser, renderPdf, resolveChromium } from '@ccguk/documents';
import { createTestApp, type TestApp } from './helpers.js';
import {
  A,
  BUNDLE_A,
  claimFormA,
  CLEAN,
  cleanCaseFiles,
  drain,
  editedEstimateA,
  emlA,
  letterB,
  letterForClaim1,
  liabilityLetterA,
  licencePhotoA,
  NOW,
  photo1999,
  photo2041,
  photo2041Copy,
  scannedPackA,
  seedClaims,
  setAgents,
  textPackA,
  uploadToBundle,
  v5cA,
  v5cB,
  zipA,
} from './fixtures/smartIntake/scenario.js';
import { drain as mailDrain, setUpMail } from './fixtures/mail/helpers.js';
import { captureCorrections } from '../knowledge/learners/corrections.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Detail = any;

let t: TestApp;
let bundleId: string;
let claim1: { id: string; reference: string };
let claim2: { id: string; reference: string };

const detail = async (): Promise<Detail> => {
  const r = await t.api<Detail>('GET', `/intake/bundles/${bundleId}`);
  expect(r.status).toBe(200);
  return r.body;
};
const field = (d: Detail, key: string) => d.draft.fields.find((f: Detail) => f.key === key);
const fileNamed = (d: Detail, name: string) => d.files.filter((f: Detail) => f.filename === name);

beforeAll(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
  ({ claim1, claim2 } = await seedClaims(t));
  setAgents(t.ctx, false);
}, 60_000);

afterAll(async () => {
  await closeBrowser();
  await t?.close();
});

// One insurer letter is rendered by Chromium (a real producer string) when Chromium is available.
const chromium = resolveChromium();
// eslint-disable-next-line no-console
if (!chromium) console.info('smart-intake-e2e: no Chromium found — the liability letter is generated with pdf-lib instead');

describe('smart intake end to end', () => {
  it('reads a mixed upload with the agents off (documents’ text only)', async () => {
    expect(claim1.reference).toBe('CCG-2026-00001');
    const created = await t.api<Detail>('POST', '/intake/bundles', { name: BUNDLE_A });
    expect(created.status).toBe(201);
    bundleId = created.body.id;
    const batch1 = [await v5cA(), await claimFormA(), licencePhotoA(), photo2041(), photo2041Copy(), photo1999(), await textPackA(), await editedEstimateA(), await emlA(), zipA()];
    const up1 = await uploadToBundle(t, bundleId, batch1);
    expect(up1.status).toBe(201);
    expect(up1.body.files).toHaveLength(10);
    const batch2 = [await scannedPackA(), await v5cB(), await letterB(), await letterForClaim1(), await liabilityLetterA(chromium ? async (html) => (await renderPdf(html, { reference: 'TPI/778812' })).pdf : undefined)];
    const up2 = await uploadToBundle(t, bundleId, batch2);
    expect(up2.status).toBe(201);

    const jobs = await drain(t);
    expect(jobs.filter((j) => j.outcome === 'failed' || j.outcome === 'dead')).toEqual([]);
    const d = await detail();

    // ZIP unpacked; the photo inside it is the same file as the one uploaded
    expect(fileNamed(d, 'SMART-A-PHOTOS.zip')[0].stage).toBe('unpacked');
    const copies2041 = fileNamed(d, 'SMART-A-PHOTO-2041.png');
    expect(copies2041).toHaveLength(2);
    expect(copies2041.some((f: Detail) => f.duplicate?.kind === 'same_file')).toBe(true);
    expect(fileNamed(d, 'SMART-A-PHOTO-2041 (1).png')[0].duplicate?.kind).toBe('near_photo');
    // the text pack is split in three; the e-mail's attachment is in the bundle
    expect(d.files.filter((f: Detail) => f.role === 'segment' && f.filename.startsWith('SMART-A-PACK ('))).toHaveLength(3);
    expect(fileNamed(d, 'SMART-A-TP-LETTER.pdf')[0].role).toBe('attachment');
    // the draft from the documents' text
    const reg = field(d, 'vehicle.registration');
    expect(reg.value).toBe('KX21 ABC');
    expect(reg.source.page).toBe(1);
    expect(reg.source.quote).toContain('KX21 ABC');
    const vin = d.conflicts.find((c: Detail) => c.key === 'vehicle.vin');
    expect(vin.status).toBe('open');
    expect(vin.options.find((o: Detail) => o.preselected).sources[0].docType).toBe('v5c');
    // groups: this case, case B (Ali Example — YB68 KDL), the existing claim
    expect(d.groups.find((g: Detail) => g.key === 'case:B')?.suggestedName).toBe('Ali Example — YB68 KDL');
    expect(d.groups.find((g: Detail) => g.key === `claim:${claim1.id}`)).toBeTruthy();
    // waiting for the AI; the owner could register once the conflicts are settled; nothing automatic
    expect(d.reasoning.status).toBe('waiting_ai');
    expect(d.reasoning.waiting?.reason).toBe('agents_off');
    expect(d.register.canRegister).toBe(false);
    expect(d.register.blockers.map((b: Detail) => b.code)).toEqual(['OPEN_CONFLICTS']);
    expect(d.autoRegister.eligible).toBe(false);
    expect(claim2.reference).toBe('CCG-2026-00002');
    for (const s of [...d.signals.map((x: Detail) => `${x.title} ${x.message}`), ...d.register.blockers.map((b: Detail) => b.text)]) expect(BANNED_INTAKE_WORDS.test(s)).toBe(false);
    expect(A.vrm).toBe('KX21 ABC');
  }, 120_000);

  it('reads everything again with the agents on (fake AI) and checks the AI by code', async () => {
    setAgents(t.ctx, true);
    const jobs = await drain(t);
    expect(jobs.filter((j) => j.outcome === 'failed' || j.outcome === 'dead')).toEqual([]);
    const d = await detail();
    // the AI read the photos (plate matched to the client's car) and the zones
    const p2041 = fileNamed(d, 'SMART-A-PHOTO-2041.png').find((f: Detail) => !f.duplicate);
    expect(p2041.engine).toBe('ai');
    expect(p2041.photo.plates[0]).toMatchObject({ normalised: 'KX21ABC', matches: 'client' });
    expect(p2041.photo.zones.map((z: Detail) => z.zoneId)).toEqual(['rear_bumper', 'tailgate']);
    // the blank scanned pack split by the AI's segments: licence back + insurance certificate
    const scanned = d.files.filter((f: Detail) => f.filename.startsWith('SMART-A-SCANNED ('));
    expect(scanned.map((f: Detail) => [f.docType, f.segment])).toEqual([['driving_licence', { fromPage: 1, toPage: 1 }], ['insurance_certificate', { fromPage: 2, toPage: 3 }]]);
    // the bundle reasoning is stored with its checks: one unverifiable quote capped
    expect(d.reasoning.status).toBe('done');
    const reasonings = t.ctx.repos.listBundleReasonings(t.ctx.db, bundleId);
    expect(reasonings.length).toBeGreaterThanOrEqual(1);
    expect((reasonings.at(-1)!.checks as Detail).cappedQuotes).toBe(1);
    expect(d.aiSummary).toContain('KX21 ABC');
    // DOB conflict: the licence is preselected over the claim form
    const dob = d.conflicts.find((c: Detail) => c.key === 'client.dateOfBirth');
    expect(dob.options.find((o: Detail) => o.preselected).sources[0].docType).toBe('driving_licence');
    expect(dob.options.find((o: Detail) => o.preselected).value).toBe('1988-03-14');
    // the licence photo joined the case (same licence number as the claim form)
    expect(fileNamed(d, 'SMART-A-LICENCE-FRONT.png')[0].groupKey).toBe('main');
    // chronology proposals; owner-only types never ticked
    const types = d.timeline.map((x: Detail) => x.eventType);
    for (const ty of ['note', 'letter_in', 'email_in', 'estimate_received']) expect(types).toContain(ty);
    expect(d.timeline.filter((x: Detail) => x.class === 'owner_only' && x.ticked)).toEqual([]);
    // signals for the owner (never accusations)
    const codes = d.signals.map((x: Detail) => x.code);
    for (const c of ['PHOTO_BEFORE_ACCIDENT', 'PDF_EDITED_AFTER_CREATION', 'PDF_EDITOR_PRODUCER', 'CONTACT_ON_OTHER_CLAIM']) expect(codes).toContain(c);
    for (const x of d.signals) expect(BANNED_INTAKE_WORDS.test(`${x.title} ${x.message}`)).toBe(false);
    // liability: a guide only, with the insurer's statement quoted
    expect(d.liability.statements.some((x: Detail) => /accept/i.test(x.source.quote ?? ''))).toBe(true);
    // the AI's bundle reading and the per-file reading of the same sentence show once, not twice
    expect(d.liability.statements.filter((x: Detail) => /accept/i.test(x.source.quote ?? '')).length).toBe(1);
    expect(d.liability.note).toMatch(/your decision/);
    // no automatic registration (setting off); the owner's card is up
    expect(d.autoRegister.eligible).toBe(false);
    expect(t.ctx.repos.listAgentJobs(t.ctx.db, { type: 'intake.bundle_register', limit: 10 })).toEqual([]);
    const card = t.ctx.repos.getNeedsYouItem(t.ctx.db, d.needsYouId);
    expect(card?.kind).toBe('new_claim');
    expect((card?.payload as Detail).bundleId).toBe(bundleId);
  }, 180_000);

  let reg: Detail;
  it('takes the owner’s decisions and registers the claim', async () => {
    await setUpMail(t.ctx);
    // the owner corrects the client's phone (a correction for the Knowledge Builder)
    let r = await t.api<Detail>('POST', `/intake/bundles/${bundleId}/fields`, { key: 'client.phone', value: '07700 900999', note: 'new number from the call' });
    expect(r.status).toBe(200);
    expect(field(r.body, 'client.phone')).toMatchObject({ value: '07700 900999', status: 'owner_set' });
    // a bad value is refused with the validator's message
    r = await t.api<Detail>('POST', `/intake/bundles/${bundleId}/fields`, { key: 'vehicle.registration', value: 'NOT A PLATE 123' });
    expect(r.status).toBe(400);
    // acknowledges one signal
    const d0 = await detail();
    const sig = d0.signals.find((x: Detail) => x.code === 'PDF_INCREMENTAL_UPDATES');
    r = await t.api<Detail>('POST', `/intake/bundles/${bundleId}/signals/${sig.id}/ack`, { note: 'saved twice by the bodyshop' });
    expect(r.body.signals.find((x: Detail) => x.id === sig.id).acknowledged).toMatchObject({ note: 'saved twice by the bodyshop' });
    // unticks one chronology item
    const est = r.body.timeline.find((x: Detail) => x.eventType === 'estimate_received' && x.at.startsWith('2026-10-04'));
    r = await t.api<Detail>('POST', `/intake/bundles/${bundleId}/timeline/${est.id}`, { ticked: false });
    expect(r.body.timeline.find((x: Detail) => x.id === est.id)).toMatchObject({ ticked: false, tickedBy: 'owner' });
    // splits case B off into its own bundle
    const split = await t.api<Detail>('POST', `/intake/bundles/${bundleId}/groups/case:B/split-off`, {});
    expect(split.status).toBe(201);
    expect(split.body.bundle.name).toBe('Ali Example — YB68 KDL');
    expect(split.body.source.groups.find((g: Detail) => g.key === 'case:B')).toBeUndefined();
    // register with the preselected values; the letter for CCG-2026-00001 goes to that claim
    reg = (await t.api<Detail>('POST', `/intake/bundles/${bundleId}/register`, { acceptPreselected: true, groups: { [`claim:${claim1.id}`]: 'attach' } })).body;
    expect(reg.claim?.reference).toBe('CCG-2026-00003');
    expect(reg.error).toBeNull();
    expect(reg.bundle.status).toBe('registered');
    expect(reg.filed.duplicatesSkipped).toBe(2);
    expect(reg.attached).toEqual([{ claimId: claim1.id, reference: 'CCG-2026-00001', files: 1 }]);
    expect(reg.request.outboxId).toBeTruthy();
  }, 180_000);

  it('opened the claim exactly as the documents say', async () => {
    const view = (await t.api<Detail>('GET', `/claims/${reg.claim.id}`)).body;
    expect(view.claimant).toMatchObject({ name: 'Jane Doe', dateOfBirth: '1988-03-14', phone: '07700 900999', drivingLicenceNumber: 'DOE99853148J99AB' });
    expect(view.vehicle).toMatchObject({ registration: 'KX21ABC', vin: 'WVWZZZ1JZXW000123', make: 'VAUXHALL' });
    expect(view.thirdPartyVehicle?.registration ?? view.thirdPartyVehicles?.[0]?.registration).toBe('LM19XYZ');
    expect(view.claim).toMatchObject({ atFaultInsurerRef: 'TPI/778812', liability: 'unknown', clientPolicyNumber: 'EDI-1234567' });
    expect(view.claim.atFaultInsurerId).toBeTruthy();
    expect(view.claim.accident).toMatchObject({ occurredAt: '2026-10-01T07:35:00.000Z', policeReference: 'EXC/4512/26', injuries: false });
    // evidence: kinds by document type, duplicates not filed twice, segments filed
    const ev = (await t.api<Detail>('GET', `/claims/${reg.claim.id}/evidence`)).body.items as Detail[];
    const kinds = ev.map((e) => e.kind);
    for (const k of ['v5c', 'licence', 'photo', 'estimate', 'correspondence', 'document', 'mot_certificate', 'insurance_certificate']) expect(kinds).toContain(k);
    expect(ev.filter((e) => e.kind === 'photo')).toHaveLength(3);
    expect(ev.filter((e) => e.filename === 'SMART-A-PHOTO-2041.png')).toHaveLength(1);
    expect(ev.find((e) => e.filename === 'SMART-A-PACK (page 1).pdf')?.description).toMatch(/pages? 1–1 of SMART-A-PACK\.pdf|pages 1–1/);
    // chronology: the FNOL event and the ticked entries, each with the evidence it came from
    const events = view.events as Detail[];
    expect(events.some((e) => e.type === 'fnol')).toBe(true);
    const fromIntake = events.filter((e) => e.data?.intakeBundleId === bundleId);
    expect(fromIntake.length).toBe(reg.events);
    for (const e of fromIntake) expect(e.evidenceIds.length).toBeGreaterThan(0);
    expect(fromIntake.some((e) => e.at.startsWith('2026-10-04') && e.type === 'estimate_received')).toBe(false);
    // damage zones from the photos and the estimate
    const zones = (await t.api<Detail>('GET', `/claims/${reg.claim.id}/damage-zones`)).body;
    expect(zones.zones.rear_bumper.severity).toBeGreaterThanOrEqual(2);
    expect(zones.observations.some((o: Detail) => o.source === 'estimate_text')).toBe(true);
    // the letter for CCG-2026-00001 is filed there; case B waits in its own bundle
    const ev1 = (await t.api<Detail>('GET', `/claims/${claim1.id}/evidence`)).body.items as Detail[];
    expect(ev1.some((e) => e.filename === 'SMART-C-LETTER.pdf')).toBe(true);
    const open = (await t.api<Detail>('GET', '/intake/bundles?status=open')).body;
    expect(open.items.map((b: Detail) => b.name)).toContain('Ali Example — YB68 KDL');
    // clash check and Autopilot nudged
    const types = t.ctx.repos.listAgentJobs(t.ctx.db, { claimId: reg.claim.id, limit: 200 }).map((j) => j.type);
    expect(types).toContain('clash.check');
    expect(types).toContain('autopilot.tick');
  });

  it('prepared the request for the missing documents for the owner’s approval', async () => {
    await mailDrain(t.ctx, 'review.check');
    await mailDrain(t.ctx, 'outbox.after_review');
    const outbox = t.ctx.repos.getOutbox(t.ctx.db, reg.request.outboxId)!;
    expect(outbox.kind).toBe('doc_request');
    expect(outbox.toJson).toEqual(['jane.doe@example.test']);
    expect(outbox.status).not.toBe('sent');
    const cards = t.ctx.repos.listNeedsYou(t.ctx.db, { claimId: reg.claim.id, kind: 'missing_info', status: 'open' } as never) as Detail[];
    expect(cards.length).toBeGreaterThanOrEqual(1);
  });

  it('gives the owner a one-glance brief', async () => {
    const brief = (await t.api<Detail>('GET', `/claims/${reg.claim.id}/intake-brief`)).body;
    expect(brief.summarySource).toBe('ai');
    expect(brief.summary).toContain('KX21 ABC');
    expect(brief.liability.position).toBe('unknown');
    expect(brief.liability.note).toMatch(/your decision/);
    expect(brief.missing.map((i: Detail) => i.id)).toContain('bank_details');
    expect(brief.request.status).toBe('waiting_for_you');
    expect(brief.callReminder).toMatch(/Call the client/);
    expect(Array.isArray(brief.autopilot.firstSteps)).toBe(true);
    expect(brief.signals.length).toBeGreaterThan(0);
    // "damage on N parts" counts parts, not observations (several photos of one part count once)
    const parts = (await t.api<Detail>('GET', `/claims/${reg.claim.id}/damage-zones`)).body;
    expect(brief.filed.damageZones).toBe(Object.keys(parts.zones).length);
    expect(brief.filed.photos).toBe(3);
    // signals never reach the case brief the agents read
    const caseBrief = (await t.api<Detail>('GET', `/claims/${reg.claim.id}/brief`)).body;
    expect(JSON.stringify(caseBrief)).not.toMatch(/PHOTO_BEFORE_ACCIDENT|PDF_EDITOR_PRODUCER/);
    expect((await t.api<Detail>('GET', `/intake/bundles/${bundleId}/brief`)).body.claim.id).toBe(reg.claim.id);
  });

  it('records the owner’s correction for the Knowledge Builder', async () => {
    const mem = t.ctx.handle.sqlite.prepare(`SELECT data FROM memory_items WHERE kind = 'correction'`).all() as Array<{ data: string }>;
    const intake = mem.map((m) => JSON.parse(m.data)).filter((d: Detail) => d.before?.intakeField);
    expect(intake.map((d: Detail) => d.before.intakeField.key)).toContain('client.phone');
    captureCorrections(t.ctx);
    const rows = t.ctx.handle.sqlite.prepare(`SELECT target_kind, agent, template_id FROM corrections WHERE target_kind = 'intake_field'`).all() as Array<{ target_kind: string; agent: string; template_id: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ agent: 'intake' });
  });

  it('writes the daily log, the audit trail and keeps the history append-only', async () => {
    const log = (await t.api<Detail>('GET', '/daily-log?day=2026-10-05')).body.log;
    const lines = (log.sections.intake ?? []) as Detail[];
    expect(lines.some((l) => /^Registered CCG-2026-00003 from 'Jane Doe – Corsa crash'/.test(l.text) && l.why === 'you pressed Register')).toBe(true);
    expect(lines.some((l) => /^Read \d+ files for bundle 'Jane Doe – Corsa crash'/.test(l.text))).toBe(true);
    expect(lines.some((l) => /^Prepared a request for/.test(l.text))).toBe(true);
    expect(lines.some((l) => /^Unpacked SMART-A-PHOTOS\.zip/.test(l.text))).toBe(true);
    expect(lines.some((l) => /^Split SMART-A-PACK\.pdf into 3 documents/.test(l.text))).toBe(true);
    for (const l of lines) expect(BANNED_INTAKE_WORDS.test(l.text)).toBe(false);
    const actions = new Set((t.ctx.handle.sqlite.prepare(`SELECT action FROM audit_log WHERE action LIKE 'intake.%'`).all() as Array<{ action: string }>).map((r) => r.action));
    for (const a of ['intake.bundle.create', 'intake.bundle.add_files', 'intake.bundle.reconcile', 'intake.bundle.reason', 'intake.bundle.set_field', 'intake.bundle.ack_signal', 'intake.bundle.untick_timeline', 'intake.bundle.split_off', 'intake.bundle.accept_preselected', 'intake.bundle.register', 'intake.bundle.attach', 'intake.bundle.request_docs', 'intake.unpack', 'intake.split_pack', 'intake.damage_observation']) expect(actions).toContain(a);
    expect(() => t.ctx.handle.sqlite.prepare(`UPDATE intake_bundle_decisions SET note = 'x'`).run()).toThrow();
    expect(() => t.ctx.handle.sqlite.prepare(`DELETE FROM intake_bundle_reasonings`).run()).toThrow();
    expect(() => t.ctx.handle.sqlite.prepare(`UPDATE claim_damage_observations SET severity = 0`).run()).toThrow();
  });

  it('registers a clean bundle automatically only when Settings and the autonomy policy allow it', async () => {
    const on = await t.api<Detail>('PATCH', '/settings/intake', { bundles: { autoRegister: true } });
    expect(on.status).toBe(200);
    expect(on.body.settings.bundles.autoRegister).toBe(true);
    await t.api('PATCH', '/settings/autonomy', { killSwitch: true });
    const b = (await t.api<Detail>('POST', '/intake/bundles', { name: CLEAN })).body;
    expect((await uploadToBundle(t, b.id, await cleanCaseFiles())).status).toBe(201);
    await drain(t);
    let d = (await t.api<Detail>('GET', `/intake/bundles/${b.id}`)).body;
    expect(d.status).not.toBe('registered');
    expect(d.autoRegister.blockers.map((x: Detail) => x.code)).toContain('POLICY_ASKS');
    expect(d.autoRegister.eligible).toBe(false);
    // kill switch off: the AI checks the bundle and nothing needs the owner → registered by agent:intake
    await t.api('PATCH', '/settings/autonomy', { killSwitch: false });
    await drain(t);
    d = (await t.api<Detail>('GET', `/intake/bundles/${b.id}`)).body;
    expect(d.status).toBe('registered');
    const regAudit = t.ctx.handle.sqlite.prepare(`SELECT user_id, after FROM audit_log WHERE action = 'intake.bundle.register' AND entity_id = ?`).get(b.id) as { user_id: string; after: string };
    expect(regAudit.user_id).toBe('agent:intake');
    expect(JSON.parse(regAudit.after).mode).toBe('auto');
    const q = t.ctx.repos.findOpenNeedsYouByDedupeKey(t.ctx.db, `intake:auto_registered:${b.id}`);
    expect(q?.kind).toBe('question');
    const log = (await t.api<Detail>('GET', '/daily-log?day=2026-10-05')).body.log;
    expect((log.sections.intake as Detail[]).some((l) => l.why === 'registered automatically (Settings > Intake)')).toBe(true);
  }, 120_000);
});

