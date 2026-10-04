/**
 * Development seed (ARCHITECTURE "Seed"): users, settings with the rate card, the four live-file archetypes with full
 * chronologies, ledgers, offers, hire/storage/recovery, a few evidence rows (PNGs generated programmatically),
 * CARFLEX LTD (12640635) on the watch list as high risk, two fleet units (one Collingwood policy covering
 * credit_hire only) and no directory overrides. Idempotent: the caller skips it when claims already exist.
 *
 *   File 1 — "£1,287 stated vs £1,112 received / bank validation"   (packages/db fixture seedFileOne)
 *   File 2 — "storage capped at report + 48 h / engineer fee refused"
 *   File 3 — "lane-merge liability dispute"
 *   File 4 — "non-independent witness"
 */
import type { Db } from '@ccguk/db';
import type { EventType, HeadOfLoss, LedgerKind } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { recomputeClocks } from '../services/claimView.js';
import { storeEvidenceBuffer } from '../services/evidence.js';
import { pollWatchList } from '../routes/watch.js';
import { makePng } from './png.js';

export interface SeedSummary {
  users: string[];
  claimIds: Record<'file1' | 'file2' | 'file3' | 'file4', string>;
  fleetUnitIds: string[];
  policyId: string;
  penaltyId: string;
  evidenceIds: string[];
  watch: string[];
  flagsRaised: number;
}

const VAT = 0.2;
const vat = (p: number) => Math.round(p * VAT);

export async function seedArchetypes(ctx: AppContext): Promise<SeedSummary> {
  const { repos } = ctx;
  const db: Db = ctx.db;
  const system = repos.SYSTEM_ACTOR;

  // ----- Users ------------------------------------------------------------------
  const users: string[] = [];
  for (const u of [
    { id: 'approver', name: 'Approving Manager (dev)', email: 'approver@ccguk.local', role: 'approver' as const },
    { id: 'admin', name: 'Administrator (dev)', email: 'admin@ccguk.local', role: 'admin' as const },
    { id: 'engineer', name: 'In-house Engineer (dev)', email: 'engineer@ccguk.local', role: 'engineer' as const },
  ]) {
    if (!repos.getUser(db, u.id)) repos.createUser(db, { ...u, mfaEnabled: false });
    users.push(u.id);
  }

  // ----- Settings (rate card £90 / £3 / £25, £45/day, £285; bank name = registered name) ----
  repos.patchSettings(
    db,
    {
      bank: { accountName: 'Courtesy Cars Group UK Ltd', sortCode: '00-00-00', accountNumber: '00000000', bankName: '[bank name — set in Settings]' },
      rateCard: { recoveryCalloutPence: 9000, perMilePence: 300, adminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500, vatRate: VAT },
    },
    system,
  );

  // ----- File 1 (db fixture) ----------------------------------------------------------
  const f1 = repos.seedFileOne(db);
  const evidenceIds: string[] = [];
  const addPhoto = async (claimId: string, label: string, seed: number, shot: 'front_left' | 'odometer' | 'rear_left' | 'damage_close_1' | undefined, capturedAt: string, kind: 'photo' | 'dashcam' | 'screenshot' = 'photo') => {
    const r = await storeEvidenceBuffer(ctx, makePng({ seed, rgb: seed % 2 ? [20, 102, 210] : [7, 38, 71] }), {
      claimId,
      filename: `${label}.png`,
      mime: 'image/png',
      fields: { kind, captureShot: shot, capturedAt, description: `${label} (seed image)` },
      actor: system,
    });
    evidenceIds.push(r.evidence.id);
    return r.evidence.id;
  };
  await addPhoto(f1.claimId, 'file1-front-left', 1, 'front_left', '2026-08-10T11:20:00.000Z');
  await addPhoto(f1.claimId, 'file1-odometer', 2, 'odometer', '2026-08-10T11:22:00.000Z');

  // Helpers shared by Files 2–4
  const party = (input: Parameters<typeof repos.createParty>[1]) => repos.createParty(db, input);
  const ev = (claimId: string, type: EventType, at: string, summary: string, attributableTo: 'insurer' | 'client' | 'ccguk' | 'repairer' | 'engineer' | 'third_party' | 'none' = 'ccguk', data?: Record<string, unknown>) =>
    repos.appendEvent(db, { claimId, type, at, summary, data, attributableTo, createdBy: 'handler', recordedAt: at });
  const led = (claimId: string, head: HeadOfLoss, kind: LedgerKind, amountPence: number, date: string, description: string, extra: Partial<Parameters<typeof repos.appendLedgerEntry>[1]> = {}) =>
    repos.appendLedgerEntry(db, { claimId, head, kind, amountPence, date, description, createdBy: 'handler', ...extra });

  // ----- File 2: storage capped at report + 48 h / engineer fee refused ----------------
  const insurer2 = party({ kind: 'company', name: 'Second Example Insurance plc', companyNumber: '00000002', email: 'tp.claims@second-example.test', roles: ['insurer'], createdAt: '2026-08-10T09:00:00.000Z' });
  const claimant2 = party({ kind: 'individual', name: 'Marcus Oyelaran', dateOfBirth: '1979-11-23', address: { line1: '22 Mill Lane', town: 'Ilford', postcode: 'IG1 2AB' }, email: 'marcus.o@example.test', phone: '07700 900222', roles: ['claimant', 'driver'], createdAt: '2026-08-10T09:00:00.000Z' });
  const tp2 = party({ kind: 'individual', name: 'Priya Natarajan', roles: ['third_party', 'third_party_driver'], createdAt: '2026-08-10T09:00:00.000Z' });
  const carflex = party({ kind: 'company', name: 'CARFLEX LTD', companyNumber: '12640635', roles: ['storage_yard', 'supplier'], notes: 'Legacy supplier — Companies House strike-off proposal (lesson k). Exact registered name only.', createdAt: '2026-08-10T09:00:00.000Z' });
  const engineerParty = repos.getParty(db, f1.engineerId)!;
  const v2 = repos.upsertVehicle(db, { registration: 'LM19 KPX', make: 'FORD', model: 'FOCUS', variant: '1.0 EcoBoost Zetec', yearOfManufacture: 2019, fuelType: 'petrol', transmission: 'manual', gtaGroup: 'S1', ownership: 'client', odometer: [{ source: 'mot', date: '2026-02-11', miles: 61200 }, { source: 'engineer', date: '2026-08-14', miles: 63950 }], lookups: [], createdAt: '2026-08-10T09:00:00.000Z' });
  const tpv2 = repos.upsertVehicle(db, { registration: 'YB68 TRN', make: 'BMW', model: '3 SERIES', ownership: 'third_party', odometer: [], lookups: [], createdAt: '2026-08-10T09:00:00.000Z' });
  const claim2 = repos.createClaim(db, {
    openedAt: '2026-08-10T14:00:00.000Z',
    accident: { occurredAt: '2026-08-09T18:40:00.000Z', location: 'Cranbrook Road, Ilford', postcode: 'IG1 4PG', circumstances: 'Client stationary at a red light; third-party vehicle struck the rear at speed. Third party admitted fault at the scene and to her insurer.', policeAttended: false, cctvAvailable: false, independentWitness: false, injuries: false, roadworthyAfter: false, driveable: false },
    liability: 'admitted',
    claimantId: claimant2.id,
    driverId: claimant2.id,
    clientVehicleId: v2.id,
    thirdPartyIds: [tp2.id],
    thirdPartyVehicleId: tpv2.id,
    atFaultInsurerId: insurer2.id,
    atFaultInsurerRef: 'SEI/TP/2026/41877',
    handlerId: 'handler',
    status: 'disputed',
  });
  const c2 = claim2.id;
  ev(c2, 'fnol', '2026-08-10T14:00:00.000Z', 'FNOL by phone; call-recording disclosure given', 'client');
  ev(c2, 'services_agreed', '2026-08-10T14:20:00.000Z', 'Recovery, storage, engineer and credit hire agreed', 'client');
  ev(c2, 'recovery', '2026-08-10T16:00:00.000Z', 'Recovered from Cranbrook Road to CARFLEX LTD yard (9 loaded miles)');
  ev(c2, 'storage_started', '2026-08-10T17:00:00.000Z', 'Storage started at CARFLEX LTD yard');
  ev(c2, 'hire_started', '2026-08-11T09:00:00.000Z', 'Hire started — VW Golf FL33 EET at £49.80/day (GTA S1 benchmark)');
  ev(c2, 'ncaf_sent', '2026-08-11T10:30:00.000Z', 'New Claim Advice Form sent to Second Example Insurance plc');
  ev(c2, 'engineer_instructed', '2026-08-11T11:00:00.000Z', 'Independent engineer instructed');
  ev(c2, 'inspection', '2026-08-14T10:00:00.000Z', 'Physical inspection at CARFLEX LTD yard', 'engineer');
  ev(c2, 'report_issued', '2026-08-20T16:00:00.000Z', 'Engineer’s report issued — total loss, PAV £4,200, Cat S', 'engineer');
  ev(c2, 'total_loss_confirmed', '2026-08-20T16:00:00.000Z', 'Total loss confirmed', 'engineer');
  // No collect_or_pay_notice_sent — the lesson: storage after report + 48 h was refused.
  ev(c2, 'pav_offer_received', '2026-08-28T12:00:00.000Z', 'Insurer PAV offer £3,900 received', 'insurer', { amountPence: 390000 });
  ev(c2, 'pav_agreed', '2026-09-01T12:00:00.000Z', 'PAV agreed at £4,200 after comparables sent', 'insurer');
  ev(c2, 'hire_ended', '2026-09-01T17:00:00.000Z', 'Hire ended — client purchased replacement vehicle');
  ev(c2, 'salvage_released', '2026-09-10T11:00:00.000Z', 'Salvage collected by insurer’s agent', 'insurer');
  ev(c2, 'storage_ended', '2026-09-10T11:00:00.000Z', 'Storage ended — salvage released');
  ev(c2, 'payment_pack_sent', '2026-09-12T15:00:00.000Z', 'Payment pack sent (hire, storage, recovery, engineer fee)');
  ev(c2, 'payment_received', '2026-09-30T00:00:00.000Z', 'Payment received: hire in full, storage to report + 48 h only, engineer fee refused', 'insurer', { amountPence: 109560 + 54000 + 15100 });
  ev(c2, 'reduction_received', '2026-09-30T00:00:00.000Z', 'Insurer reduction: storage after 22 Aug 2026 refused (no collect-or-pay notice); engineer fee refused as "not recoverable"', 'insurer');
  const hire2 = repos.createHire(db, { claimId: c2, fleetUnitId: f1.fleetUnitId, startAt: '2026-08-11T09:00:00.000Z', dailyRatePence: 4980, vatRate: VAT, gtaGroup: 'S1', excessPence: 25000, deliveredAt: '2026-08-11T09:00:00.000Z', odometerOut: 31890, signedAt: '2026-08-11T09:10:00.000Z', enforceability: { cancellationInfoProvidedAt: '2026-08-11T09:10:00.000Z', schedule3FormProvidedAt: '2026-08-11T09:10:00.000Z', expressRequestToStartAt: '2026-08-11T09:10:00.000Z', cca60fCompliant: true } });
  repos.endHire(db, hire2.id, { endAt: '2026-09-01T17:00:00.000Z', endTrigger: 'replacement_purchased', collectedAt: '2026-09-01T17:00:00.000Z', odometerIn: 32410 });
  const storage2 = repos.createStorage(db, { claimId: c2, location: 'CARFLEX LTD yard', startAt: '2026-08-10T17:00:00.000Z', dailyRatePence: 4500, vatRate: VAT });
  repos.endStorage(db, storage2.id, { endAt: '2026-09-10T11:00:00.000Z', endTrigger: 'salvage_released' });
  repos.createRecovery(db, { claimId: c2, at: '2026-08-10T16:00:00.000Z', fromLocation: 'Cranbrook Road, Ilford', toLocation: 'CARFLEX LTD yard', calloutPence: 9000, loadedMiles: 9, perLoadedMilePence: 300, adminPence: 2500, vatRate: VAT });
  const pav2 = repos.createPav(db, {
    claimId: c2,
    subject: { vehicleId: v2.id, registration: 'LM19KPX', make: 'FORD', model: 'FOCUS', trim: '1.0 EcoBoost Zetec', year: 2019, fuelType: 'petrol', transmission: 'manual', odometerAtLoss: 63950, odometerBasis: 'reading', conditionGrade: 'average', conditionAdjustmentPct: 0, serviceHistory: 'partial', claimantPostcode: 'IG1 2AB' },
    comparables: [
      { id: 'f2c1', capturedAt: '2026-08-18T10:00:00.000Z', source: 'Auto Trader', url: 'https://example.test/adverts/1', pricePence: 419500, mileage: 66000, year: 2019, make: 'FORD', model: 'FOCUS', seller: 'dealer', normalisedPricePence: 421000 },
      { id: 'f2c2', capturedAt: '2026-08-18T10:05:00.000Z', source: 'Auto Trader', url: 'https://example.test/adverts/2', pricePence: 429900, mileage: 59000, year: 2019, make: 'FORD', model: 'FOCUS', seller: 'dealer', normalisedPricePence: 420000 },
      { id: 'f2c3', capturedAt: '2026-08-18T10:10:00.000Z', source: 'dealer site', url: 'https://example.test/adverts/3', pricePence: 409000, mileage: 70500, year: 2018, make: 'FORD', model: 'FOCUS', seller: 'dealer', normalisedPricePence: 418000 },
    ],
    perMilePence: 7,
    perMileSource: 'regression',
    medianPence: 420000,
    iqrLowPence: 418000,
    iqrHighPence: 421000,
    pavPence: 420000,
    reasoning: 'Three retail comparables within year ±1 and mileage ±25%, normalised at 7p/mile; median £4,200.',
    approvedBy: engineerParty.id,
    approvedAt: '2026-08-20T15:00:00.000Z',
    createdAt: '2026-08-20T14:00:00.000Z',
  });
  repos.createEngineerReport(db, {
    claimId: c2, vehicleId: v2.id, engineerPartyId: engineerParty.id, engineerQualifications: 'IAEA, IMI', instructedBy: 'Courtesy Cars Group UK Ltd', instructedAt: '2026-08-11T11:00:00.000Z', inspectionAt: '2026-08-14T10:00:00.000Z', inspectionPlace: 'CARFLEX LTD yard', inspectionBasis: 'physical', odometerMiles: 63950,
    preAccidentCondition: 'Average; partial service history; minor stone chips to bonnet (pre-existing, excluded).', damageDescription: 'Rear-end impact: tailgate, rear panel and boot floor deformed; rear chassis legs displaced.', consistentWithCircumstances: true, roadworthy: false, roadworthyReason: 'Rear structural deformation; rear lamps inoperative.', pavAssessmentId: pav2.id, salvageCategory: 'S', salvageValuePence: 80000, forCourt: false, feePence: 28500, issuedAt: '2026-08-20T16:00:00.000Z', createdAt: '2026-08-20T16:00:00.000Z',
  });
  led(c2, 'recovery', 'claimed', 9000 + 9 * 300 + 2500, '2026-08-10', 'Recovery: £90 call-out + 9 loaded miles × £3 + £25 admin', { vatPence: vat(14200) });
  led(c2, 'storage', 'claimed', 31 * 4500, '2026-09-10', 'Storage 31 days × £45 at CARFLEX LTD yard', { vatPence: vat(31 * 4500), counterpartyId: carflex.id });
  led(c2, 'engineer_fee', 'claimed', 28500, '2026-08-20', 'Engineer’s report fee', { vatPence: vat(28500) });
  led(c2, 'pav', 'claimed', 420000, '2026-08-20', 'Pre-accident value (total loss)');
  led(c2, 'hire', 'claimed', 22 * 4980, '2026-09-01', 'Credit hire 22 days × £49.80', { vatPence: vat(22 * 4980) });
  led(c2, 'hire', 'invoiced', 22 * 4980, '2026-09-12', 'Hire invoice INV-H-000102', { vatPence: vat(22 * 4980), reference: 'INV-H-000102' });
  led(c2, 'storage', 'invoiced', 31 * 4500, '2026-09-12', 'Storage invoice INV-S-000102', { vatPence: vat(31 * 4500), reference: 'INV-S-000102' });
  led(c2, 'recovery', 'invoiced', 14200, '2026-09-12', 'Recovery invoice INV-R-000102', { vatPence: vat(14200), reference: 'INV-R-000102' });
  led(c2, 'engineer_fee', 'invoiced', 28500, '2026-09-12', 'Engineer fee note INV-E-000102', { vatPence: vat(28500), reference: 'INV-E-000102' });
  led(c2, 'hire', 'paid', 22 * 4980, '2026-09-30', 'Hire paid in full — remittance SEI-REM-9921', { reference: 'SEI-REM-9921', counterpartyId: insurer2.id });
  led(c2, 'recovery', 'paid', 14200, '2026-09-30', 'Recovery paid — remittance SEI-REM-9921', { reference: 'SEI-REM-9921', counterpartyId: insurer2.id });
  led(c2, 'storage', 'paid', 12 * 4500, '2026-09-30', 'Storage paid to report + 48 h (12 days) — remittance SEI-REM-9921', { reference: 'SEI-REM-9921', counterpartyId: insurer2.id });
  led(c2, 'storage', 'reduced', 19 * 4500, '2026-09-30', 'Insurer refused storage after 22 Aug 2026 (report + 48 h): no collect-or-pay notice was sent', { counterpartyId: insurer2.id });
  led(c2, 'engineer_fee', 'reduced', 28500, '2026-09-30', 'Insurer refused engineer’s fee as "not recoverable" — challenge with the fee note and work-done list', { counterpartyId: insurer2.id });
  led(c2, 'pav', 'paid', 420000, '2026-09-05', 'PAV paid to claimant direct', { counterpartyId: insurer2.id });
  await addPhoto(c2, 'file2-rear-left', 3, 'rear_left', '2026-08-10T16:30:00.000Z');
  await addPhoto(c2, 'file2-damage-close', 4, 'damage_close_1', '2026-08-10T16:31:00.000Z');

  // ----- Fleet: Collingwood policy (credit_hire only), second unit --------------------------
  const policy = repos.createPolicy(db, { insurerName: 'Collingwood Insurance Company Limited', policyNumber: 'CIC-FLEET-2026-0042', coveredUses: ['credit_hire'], startDate: '2026-01-01', endDate: '2026-12-31' });
  repos.updateFleetUnit(db, f1.fleetUnitId, { policyId: policy.id, keeperAddressCurrent: true, serviceDueDate: '2026-11-15' });
  const fleetVehicle2 = repos.upsertVehicle(db, { registration: 'FL44 EET', make: 'VOLKSWAGEN', model: 'POLO', variant: '1.0 TSI Life', yearOfManufacture: 2024, fuelType: 'petrol', transmission: 'manual', gtaGroup: 'S1', ownership: 'fleet', motExpiryDate: '2027-03-01', taxDueDate: '2026-10-31', odometer: [{ source: 'handover', date: '2026-09-01', miles: 12400 }], lookups: [], createdAt: '2026-01-05T09:00:00.000Z' });
  const unit2 = repos.createFleetUnit(db, { vehicleId: fleetVehicle2.id, declaredUses: ['credit_hire', 'self_drive'], policyId: policy.id, dailyRatePence: 4232, gtaGroup: 'S1', keeperAddressCurrent: false, keeperAddressOnV5C: { line1: '[previous trading address — V5C not yet updated]', postcode: '[postcode]' } });

  // ----- File 3: lane-merge liability dispute (hire running) ---------------------------------
  const insurer3 = party({ kind: 'company', name: 'Third Example Mutual', companyNumber: '00000003', roles: ['insurer'], createdAt: '2026-09-15T09:00:00.000Z' });
  const claimant3 = party({ kind: 'individual', name: 'Hannah Whitfield', dateOfBirth: '1992-03-08', address: { line1: '5 Orchard Close', town: 'Romford', postcode: 'RM1 3DX' }, email: 'hannah.w@example.test', phone: '07700 900333', drivingLicenceNumber: 'WHITF903082HW9AB', roles: ['claimant', 'driver'], createdAt: '2026-09-15T09:00:00.000Z' });
  const tp3 = party({ kind: 'individual', name: 'Daniel Mercer', roles: ['third_party', 'third_party_driver'], createdAt: '2026-09-15T09:00:00.000Z' });
  const v3 = repos.upsertVehicle(db, { registration: 'KR20 VXA', make: 'NISSAN', model: 'QASHQAI', variant: '1.3 DiG-T N-Connecta', yearOfManufacture: 2020, fuelType: 'petrol', transmission: 'automatic', gtaGroup: 'M', ownership: 'client', odometer: [{ source: 'mot', date: '2026-05-02', miles: 41100 }], lookups: [], createdAt: '2026-09-15T09:00:00.000Z' });
  const tpv3 = repos.upsertVehicle(db, { registration: 'EJ17 LLM', make: 'AUDI', model: 'A4', ownership: 'third_party', odometer: [], lookups: [], createdAt: '2026-09-15T09:00:00.000Z' });
  const claim3 = repos.createClaim(db, {
    openedAt: '2026-09-15T09:30:00.000Z',
    accident: { occurredAt: '2026-09-14T17:55:00.000Z', location: 'A12 Eastern Avenue, Gants Hill — two lanes merging to one', postcode: 'IG2 6PN', circumstances: 'Client established in the left lane as two lanes merged into one; third-party vehicle in the right lane moved across without indicating and struck the client’s offside front. Third party says the client accelerated to close the gap. Dashcam footage from the client’s vehicle has been preserved; roadside CCTV requested.', highwayCodeRules: [134, 167], policeAttended: false, cctvAvailable: true, dashcamAvailable: true, independentWitness: false, injuries: false, roadworthyAfter: true, driveable: true },
    liability: 'disputed',
    liabilityScore: 58,
    claimantId: claimant3.id,
    driverId: claimant3.id,
    clientVehicleId: v3.id,
    thirdPartyIds: [tp3.id],
    thirdPartyVehicleId: tpv3.id,
    atFaultInsurerId: insurer3.id,
    atFaultInsurerRef: 'TEM/MC/55102',
    handlerId: 'handler',
    status: 'hire_active',
  });
  const c3 = claim3.id;
  ev(c3, 'fnol', '2026-09-15T09:30:00.000Z', 'FNOL by phone; account taken cold; dashcam footage confirmed preserved', 'client');
  ev(c3, 'services_agreed', '2026-09-15T10:00:00.000Z', 'Credit hire agreed (vehicle driveable but unsafe: offside headlamp and wing)', 'client');
  ev(c3, 'hire_started', '2026-09-16T09:00:00.000Z', 'Hire started — VW Polo FL44 EET at £42.32/day (GTA S1 benchmark)');
  ev(c3, 'ncaf_sent', '2026-09-16T11:00:00.000Z', 'New Claim Advice Form sent to Third Example Mutual');
  ev(c3, 'cctv_request_sent', '2026-09-16T12:00:00.000Z', 'CCTV preservation request to TfL and Redbridge Council for the Gants Hill cameras');
  ev(c3, 'handling_ref_received', '2026-09-22T14:00:00.000Z', 'Handling reference TEM/MC/55102 received', 'insurer');
  ev(c3, 'first_notification_dispute', '2026-09-24T10:00:00.000Z', 'Insurer disputes liability: alleges client accelerated into the merge (GTA 3.6 dispute notice)', 'insurer');
  ev(c3, 'intervention_offer', '2026-09-24T10:05:00.000Z', 'Insurer offered a "like-for-like" car via the client at £21.50/day', 'insurer', { dailyRatePence: 2150, channel: 'via_client', offerorName: 'Third Example Mutual', vehicleClassOffered: 'small hatchback', rateIncludesVat: true, offerorPartyId: insurer3.id });
  ev(c3, 'intervention_reply_sent', '2026-09-25T09:30:00.000Z', 'Written reply: offer declined — smaller class, no delivery, hire already in place');
  const offer3 = repos.listOffers(db, c3)[0];
  if (offer3) {
    repos.recordOfferDecision(db, offer3.id, { clientDecision: 'declined', clientReasons: 'Smaller class than own vehicle (M vs small hatchback); no delivery offered; hire already in place.', clientDecisionAt: '2026-09-24T15:00:00.000Z', suitable: false, suitabilityReasons: ['class', 'delivery'] });
    repos.recordOfferReply(db, offer3.id, { replySentAt: '2026-09-25T09:30:00.000Z' });
  }
  repos.createHire(db, { claimId: c3, fleetUnitId: unit2.id, startAt: '2026-09-16T09:00:00.000Z', dailyRatePence: 4232, vatRate: VAT, gtaGroup: 'S1', excessPence: 25000, deliveredAt: '2026-09-16T09:00:00.000Z', odometerOut: 12400, signedAt: '2026-09-16T09:05:00.000Z', enforceability: { cancellationInfoProvidedAt: '2026-09-16T09:05:00.000Z', schedule3FormProvidedAt: '2026-09-16T09:05:00.000Z', expressRequestToStartAt: '2026-09-16T09:05:00.000Z', cca60fCompliant: true } });
  repos.updateFleetUnit(db, unit2.id, { status: 'on_hire' });
  await addPhoto(c3, 'file3-dashcam-still', 5, undefined, '2026-09-14T17:55:10.000Z', 'dashcam');
  await addPhoto(c3, 'file3-front-left', 6, 'front_left', '2026-09-15T12:00:00.000Z');

  // PCN on FL44 EET during File 3's hire (council PCN → liability transfer to the hirer)
  const penalty = repos.createPenalty(db, { fleetUnitId: unit2.id, kind: 'pcn_council', issuer: 'London Borough of Redbridge', noticeNumber: 'RB12345678', contraventionAt: '2026-09-20T14:12:00.000Z', receivedAt: '2026-09-27T00:00:00.000Z', amountPence: 13000, discountDeadline: '2026-10-11', responseDeadline: '2026-10-25', notes: 'Parked in a restricted street during prescribed hours (code 01). Sent to the stale V5C address — forwarded (lesson l).' });

  // ----- File 4: non-independent witness ----------------------------------------------
  const insurer4 = party({ kind: 'company', name: 'Fourth Example Assurance Ltd', companyNumber: '00000004', roles: ['insurer'], createdAt: '2026-09-28T09:00:00.000Z' });
  const claimant4 = party({ kind: 'individual', name: 'Tomasz Nowak', dateOfBirth: '1985-06-30', address: { line1: '14 Birch Avenue', town: 'Dagenham', postcode: 'RM10 7QT' }, email: 'tomasz.n@example.test', phone: '07700 900444', roles: ['claimant', 'driver'], createdAt: '2026-09-28T09:00:00.000Z' });
  const witness4 = party({ kind: 'individual', name: 'Agnieszka Nowak', address: { line1: '14 Birch Avenue', town: 'Dagenham', postcode: 'RM10 7QT' }, phone: '07700 900444', roles: ['witness'], notes: 'Same address and phone as the claimant — not independent (lesson g).', createdAt: '2026-09-28T09:00:00.000Z' });
  const tp4 = party({ kind: 'individual', name: 'Oliver Grant', roles: ['third_party', 'third_party_driver'], createdAt: '2026-09-28T09:00:00.000Z' });
  const v4 = repos.upsertVehicle(db, { registration: 'DK18 WRE', make: 'VAUXHALL', model: 'ASTRA', variant: '1.4T SRi', yearOfManufacture: 2018, fuelType: 'petrol', transmission: 'manual', gtaGroup: 'S1', ownership: 'client', odometer: [{ source: 'client', date: '2026-09-27', miles: 72300 }], lookups: [], createdAt: '2026-09-28T09:00:00.000Z' });
  const claim4 = repos.createClaim(db, {
    openedAt: '2026-09-28T09:30:00.000Z',
    accident: { occurredAt: '2026-09-27T20:10:00.000Z', location: 'Heathway, Dagenham', postcode: 'RM10 8QS', circumstances: 'Client says the third party pulled out of a side road into his path. Third party denies and says the client was speeding. Client names his wife, a passenger, as the witness.', policeAttended: false, cctvAvailable: false, dashcamAvailable: false, independentWitness: false, injuries: false, roadworthyAfter: false, driveable: false },
    liability: 'disputed',
    liabilityScore: 44,
    claimantId: claimant4.id,
    driverId: claimant4.id,
    clientVehicleId: v4.id,
    thirdPartyIds: [tp4.id, witness4.id],
    atFaultInsurerId: insurer4.id,
    handlerId: 'handler',
    status: 'triage',
  });
  const c4 = claim4.id;
  ev(c4, 'fnol', '2026-09-28T09:30:00.000Z', 'FNOL by WhatsApp then phone; account taken cold', 'client');
  ev(c4, 'note', '2026-09-28T09:45:00.000Z', 'Witness Agnieszka Nowak shares the claimant’s address and phone — connected-party checker: NOT independent. Independent evidence (CCTV from the shop at the junction) requested.', 'ccguk', { witnessPartyId: witness4.id, independenceScore: 0.1 });
  ev(c4, 'cctv_request_sent', '2026-09-28T16:00:00.000Z', 'CCTV preservation request to the convenience store at the junction');
  repos.addClaimFlag(db, c4, { code: 'NON_INDEPENDENT_WITNESS', severity: 'warn', message: 'Witness Agnieszka Nowak shares the claimant’s address and phone number (lesson g). Do not present her as independent; seek CCTV or an unconnected witness before relying on liability.', raisedBy: 'system', raisedAt: '2026-09-28T09:45:00.000Z' });
  await addPhoto(c4, 'file4-front-right', 7, 'damage_close_1', '2026-09-27T20:30:00.000Z');

  // ----- Watch list: CARFLEX LTD high risk; poll (skips gracefully without a key) ---------
  repos.upsertCompanyWatch(db, { companyNumber: '12640635', name: 'CARFLEX LTD', role: 'supplier', status: 'active-proposal-to-strike-off', riskLevel: 'high', riskReasons: ['Companies House: active proposal to strike off (first Gazette notice) — live file lesson k', 'Legacy supplier: exact registered name only; never the legacy address or company number'], gazetteNotices: [{ date: '2026-07-15', type: 'gazette', note: 'First Gazette notice for voluntary strike-off' }] });
  const poll = await pollWatchList(ctx, system);

  // ----- Clocks + audit ----------------------------------------------------------------
  for (const id of [f1.claimId, c2, c3, c4]) recomputeClocks(ctx, id);
  repos.appendAudit(db, { actor: system, action: 'seed.archetypes', entity: 'claims', entityId: 'seed', after: { files: { file1: f1.claimId, file2: c2, file3: c3, file4: c4 }, fleetUnits: [f1.fleetUnitId, unit2.id], policy: policy.id, penalty: penalty.id, evidence: evidenceIds.length, watch: ['12640635'], flagsRaised: poll.flagsRaised.length }, at: ctx.now() });

  return { users: ['handler', ...users], claimIds: { file1: f1.claimId, file2: c2, file3: c3, file4: c4 }, fleetUnitIds: [f1.fleetUnitId, unit2.id], policyId: policy.id, penaltyId: penalty.id, evidenceIds, watch: ['12640635'], flagsRaised: poll.flagsRaised.length };
}
