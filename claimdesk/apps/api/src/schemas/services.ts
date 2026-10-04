/**
 * zod schemas for the services half of the API: evidence, documents, engineering, fleet, directory/KB, watch,
 * analytics and settings. Money is integer pence, dates ISO strings (schemas/common.ts).
 */
import { z } from 'zod';
import { addressSchema, bankDetailsSchema, id, isoDate, isoDateTime, pence, vatRate } from './common.js';

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const evidenceKind = z.enum([
  'photo', 'video', 'audio', 'document', 'pdf', 'screenshot', 'advert', 'bank_statement', 'payslip', 'licence', 'v5c', 'mot_certificate',
  'insurance_certificate', 'estimate', 'invoice', 'engineer_report', 'correspondence', 'call_recording', 'cctv', 'dashcam', 'witness_statement', 'other',
]);
export const guidedShot = z.enum([
  'front_left', 'front_right', 'rear_left', 'rear_right', 'damage_close_1', 'damage_close_2', 'damage_close_3', 'odometer', 'vin_plate',
  'tyre_fl', 'tyre_fr', 'tyre_rl', 'tyre_rr', 'interior', 'number_plate',
]);

/** Multipart text fields accompanying the file part. */
export const evidenceFields = z.object({
  kind: evidenceKind.default('other'),
  description: z.string().max(2000).optional(),
  capturedAt: isoDateTime.optional(),
  captureShot: guidedShot.optional(),
  sourceUrl: z.string().url().optional(),
  /** SHA-256 computed on the device before upload (guided capture); refused when it does not match the bytes. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});
export type EvidenceFields = z.infer<typeof evidenceFields>;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const createDocumentBody = z.object({
  templateId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/, 'expected <kind>.<name>'),
  /** Only the extra free-text fields the template declares. Amounts and dates the ledger knows are refused. */
  data: z.record(z.unknown()).optional(),
  recipientPartyId: id.optional(),
});
export const clearDocumentFlagBody = z.object({ code: z.string().min(1), excerpt: z.string().optional(), reason: z.string().trim().min(3), index: z.number().int().optional() });
export const approveDocumentBody = z.object({ note: z.string().optional() }).partial().optional();
export const sendDocumentBody = z.object({ via: z.enum(['email', 'post', 'portal', 'whatsapp', 'hand']), to: z.string().optional(), note: z.string().optional() });
export const supersedeDocumentBody = z.object({ data: z.record(z.unknown()).optional(), reason: z.string().optional(), reExecutedOn: isoDate.optional() }).optional();
export const signStartBody = z.object({ signerPartyId: id, signerName: z.string().optional(), contact: z.string().trim().min(3), channel: z.enum(['email', 'sms']) });
export const signVerifyBody = z.object({ challengeId: id.optional(), code: z.string().trim().min(4).max(8) });
export const documentListQuery = z.object({ status: z.string().optional(), templateId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() });

// ---------------------------------------------------------------------------
// Engineering
// ---------------------------------------------------------------------------

export const estimateLineKind = z.enum(['labour', 'part', 'paint', 'materials', 'adas', 'diagnostic', 'sundry', 'specialist']);
export const estimateLineInput = z.object({
  id: z.string().optional(),
  kind: estimateLineKind,
  operation: z.string().trim().min(1),
  panel: z.string().optional(),
  description: z.string().trim().min(1),
  partNumber: z.string().optional(),
  partSource: z.enum(['oem', 'aftermarket', 'green', 'unknown']).optional(),
  quantity: z.number().min(0).default(1),
  unitPence: pence.optional(),
  hours: z.number().min(0).optional(),
  ratePence: pence.optional(),
  materialsPence: pence.optional(),
  source: z.enum(['manual', 'import', 'library', 'vision_suggestion']).default('manual'),
  confirmedByEngineer: z.boolean().default(false),
  preExisting: z.boolean().optional(),
  note: z.string().optional(),
});
export type EstimateLineInput = z.infer<typeof estimateLineInput>;

export const paintMaterialsMethod = z.enum(['per_hour', 'paint_system', 'fixed']);
export const estimateBody = z.object({
  vehicleId: id.optional(),
  lines: z.array(estimateLineInput).default([]),
  labourRatePence: pence,
  paintRatePence: pence.optional(),
  paintMaterialsMethod: paintMaterialsMethod.default('per_hour'),
  paintMaterialsPerHourPence: pence.optional(),
  vatRate: vatRate.optional(),
  importedFromEvidenceId: id.optional(),
  importedTotalPence: pence.optional(),
});
export const estimatePatchBody = estimateBody.partial();
export const estimateImportBody = z
  .object({
    text: z.string().optional(),
    evidenceId: id.optional(),
    importedTotalPence: pence.optional(),
    labourRatePence: pence.optional(),
    paintRatePence: pence.optional(),
    paintMaterialsMethod: paintMaterialsMethod.optional(),
    paintMaterialsPerHourPence: pence.optional(),
  })
  .refine((b) => Boolean(b.text?.trim()) || Boolean(b.evidenceId), { message: 'Supply the estimate text (PDF → text runs in the browser or via the optional provider) or an evidenceId of a text file' });
export const reconcileBody = z.object({ importedTotalPence: pence.optional(), tolerancePence: pence.optional() }).optional();
export const labourSuggestQuery = z.object({ make: z.string().optional(), model: z.string().optional(), panel: z.string().optional(), operation: z.string().optional() });
export const labourAddBody = z.object({ estimateId: id });

export const fuelType = z.enum(['petrol', 'diesel', 'hybrid', 'plugin_hybrid', 'electric', 'lpg', 'other']);
export const transmission = z.enum(['manual', 'automatic', 'unknown']);
export const salvageCategory = z.enum(['A', 'B', 'S', 'N']);

export const comparableBody = z
  .object({
    evidenceId: id.optional(),
    url: z.string().url().optional(),
    capturedAt: isoDateTime.optional(),
    source: z.string().trim().min(1),
    pricePence: pence,
    priceOnApplication: z.boolean().optional(),
    mileage: z.number().int().min(0),
    year: z.number().int().min(1950).max(2100),
    make: z.string().trim().min(1),
    model: z.string().trim().min(1),
    trim: z.string().optional(),
    fuelType: fuelType.optional(),
    transmission: transmission.optional(),
    seller: z.enum(['dealer', 'private', 'unknown']).default('unknown'),
    distanceMiles: z.number().min(0).optional(),
    writeOffCategory: salvageCategory.optional(),
    exFleet: z.boolean().optional(),
    optionsAdjustmentPence: z.number().int().optional(),
  })
  .refine((c) => Boolean(c.evidenceId) || (Boolean(c.url) && Boolean(c.capturedAt)), {
    message: 'A comparable needs the saved advert (evidenceId) or its url + capturedAt — adverts are captured manually, never scraped',
  });

export const pavSubjectInput = z.object({
  vehicleId: id.optional(),
  registration: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  trim: z.string().optional(),
  year: z.number().int().optional(),
  fuelType: fuelType.optional(),
  transmission: transmission.optional(),
  odometerAtLoss: z.number().int().min(0).optional(),
  odometerBasis: z.enum(['reading', 'projected_from_mot']).optional(),
  conditionGrade: z.enum(['excellent', 'good', 'average', 'poor']).optional(),
  conditionAdjustmentPct: z.number().min(-10).max(10).optional(),
  serviceHistory: z.enum(['full', 'partial', 'none', 'unknown']).optional(),
  exFleet: z.boolean().optional(),
  previousWriteOffCategory: salvageCategory.optional(),
  claimantPostcode: z.string().optional(),
  vatRegisteredClaimant: z.boolean().optional(),
});
export const pavBody = z.object({
  subject: pavSubjectInput.optional(),
  comparables: z.array(comparableBody).optional(),
  tradeGuidePence: pence.optional(),
  tradeGuideSource: z.string().optional(),
  override: z.object({ pavPence: pence, reason: z.string().trim().min(3) }).optional(),
  iqrMultiplier: z.number().positive().optional(),
  /** FilterOptions passed through to the PAV engine (radius, year/mileage windows). */
  filter: z.record(z.unknown()).optional(),
});

export const engineerReportBody = z.object({
  vehicleId: id.optional(),
  engineerPartyId: id.optional(),
  engineerQualifications: z.string().optional(),
  instructedBy: z.string().optional(),
  instructedAt: isoDateTime.optional(),
  inspectionAt: isoDateTime.optional(),
  inspectionPlace: z.string().optional(),
  inspectionBasis: z.enum(['physical', 'desktop']).optional(),
  inspectionConditions: z.string().optional(),
  odometerMiles: z.number().int().min(0).optional(),
  preAccidentCondition: z.string().optional(),
  damageDescription: z.string().optional(),
  consistentWithCircumstances: z.boolean().optional(),
  consistencyNote: z.string().optional(),
  repairMethod: z.string().optional(),
  estimateId: id.optional(),
  roadworthy: z.boolean().optional(),
  roadworthyReason: z.string().optional(),
  repairDurationWorkingDays: z.number().int().min(0).optional(),
  pavAssessmentId: id.optional(),
  salvageCategory: salvageCategory.optional(),
  salvageValuePence: pence.optional(),
  adasNotes: z.string().optional(),
  evNotes: z.string().optional(),
  diagnosticFaultCodes: z.array(z.string()).optional(),
  photoEvidenceIds: z.array(id).optional(),
  forCourt: z.boolean().optional(),
  feePence: pence.optional(),
});

export const totalLossAssessBody = z.object({
  salvagePence: pence.optional(),
  salvageSource: z.enum(['bid', 'offer', 'estimate']).optional(),
  salvageCategory: salvageCategory.optional(),
  hireDailyRatePence: pence.optional(),
  storageDailyRatePence: pence.optional(),
  projectedRepairWorkingDays: z.number().int().min(0).optional(),
  repairNetPence: pence.optional(),
  pavPence: pence.optional(),
  /** Working days expected between a total-loss decision and the insurer's PAV payment (GTA 4.14 benchmark: hire runs 5 WD after payment). */
  daysToPavPayment: z.number().int().min(0).optional(),
});
export const totalLossPredictBody = z.object({
  vehicleAgeYears: z.number().min(0),
  pavBandPence: pence,
  roughRepairPence: pence.optional(),
  damageZones: z.array(z.enum(['front', 'rear', 'nearside', 'offside', 'roof', 'underside', 'multiple'])),
  airbagsDeployed: z.boolean(),
  structuralIndicators: z.array(z.enum(['wheel_displaced', 'suspension', 'pillar', 'chassis_leg', 'floor', 'roof_rail', 'none'])),
  driveable: z.boolean(),
  fluidLeaks: z.boolean().optional(),
  isEvOrHybrid: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export const fleetUse = z.enum(['credit_hire', 'self_drive', 'pco']);
export const fleetVehicleInput = z.object({
  registration: z.string().trim().min(2).max(10),
  make: z.string().trim().min(1).default('UNKNOWN'),
  model: z.string().trim().min(1).default('UNKNOWN'),
  variant: z.string().optional(),
  yearOfManufacture: z.number().int().optional(),
  fuelType: fuelType.optional(),
  transmission: transmission.optional(),
  colour: z.string().optional(),
  vin: z.string().optional(),
  motExpiryDate: isoDate.optional(),
  taxDueDate: isoDate.optional(),
  gtaGroup: z.string().optional(),
});
export const fleetUnitBody = z
  .object({
    vehicleId: id.optional(),
    vehicle: fleetVehicleInput.optional(),
    declaredUses: z.array(fleetUse).min(1),
    policyId: id.optional(),
    dailyRatePence: pence,
    gtaGroup: z.string().trim().min(1),
    keeperAddressOnV5C: addressSchema.optional(),
    keeperAddressCurrent: z.boolean().optional(),
    serviceDueDate: isoDate.optional(),
    status: z.enum(['available', 'on_hire', 'off_road', 'disposed']).optional(),
    phvLicensed: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.vehicleId) || Boolean(b.vehicle), { message: 'vehicleId or vehicle is required' });
export const fleetUnitPatchBody = z.object({
  declaredUses: z.array(fleetUse).min(1).optional(),
  policyId: id.nullable().optional(),
  dailyRatePence: pence.optional(),
  gtaGroup: z.string().optional(),
  keeperAddressOnV5C: addressSchema.optional(),
  keeperAddressCurrent: z.boolean().optional(),
  serviceDueDate: isoDate.optional(),
  status: z.enum(['available', 'on_hire', 'off_road', 'disposed']).optional(),
  phvLicensed: z.boolean().optional(),
});
export const allocateCheckBody = z.object({ use: fleetUse, at: isoDateTime.optional(), claimId: id.optional() });
export const policyBody = z.object({
  insurerName: z.string().trim().min(1),
  policyNumber: z.string().trim().min(1),
  coveredUses: z.array(fleetUse).min(1),
  startDate: isoDate,
  endDate: isoDate,
  evidenceId: id.optional(),
});
export const penaltyKind = z.enum(['pcn_council', 'pcn_private', 'nip_s172', 'fpn', 'congestion_ulez', 'dart_charge']);
export const penaltyStage = z.enum(['received', 'hirer_identified', 'liability_transferred', 'representations', 'appeal', 'paid', 'cancelled', 'escalated']);
export const penaltyBody = z.object({
  fleetUnitId: id,
  kind: penaltyKind,
  issuer: z.string().trim().min(1),
  noticeNumber: z.string().trim().min(1),
  contraventionAt: isoDateTime,
  receivedAt: isoDateTime,
  amountPence: pence,
  discountDeadline: isoDate.optional(),
  responseDeadline: isoDate,
  hireAgreementId: id.optional(),
  stage: penaltyStage.optional(),
  notes: z.string().optional(),
});
export const penaltyPatchBody = penaltyBody.omit({ fleetUnitId: true }).partial();
export const penaltyTransitionBody = z.object({ stage: penaltyStage, note: z.string().optional(), hireAgreementId: id.optional(), documentId: id.optional() });
export const penaltyDocumentBody = z.object({ templateId: z.enum(['notice.pcn_liability_transfer', 'notice.s172_response']), data: z.record(z.unknown()).optional() });

// ---------------------------------------------------------------------------
// Directory & KB
// ---------------------------------------------------------------------------

export const directoryQuery = z.object({ q: z.string().optional(), status: z.enum(['verified', 'unverified', 'failed', 'stale']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
export const directoryVerifyBody = z.object({ sourceUrl: z.string().url(), verifiedBy: z.string().trim().min(1), note: z.string().optional(), field: z.string().optional() });
export const directoryFailedBody = z.object({ field: z.string().optional(), note: z.string().optional(), reportedBy: z.string().optional() });
export const kbSearchQuery = z.object({ q: z.string().default(''), type: z.string().optional(), topic: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
export const kbAdviseQuery = z.object({ topic: z.string().trim().min(1) });
export const gtaRatesQuery = z.object({ date: isoDate.optional(), group: z.string().optional() });

// ---------------------------------------------------------------------------
// Watch, settings, jobs
// ---------------------------------------------------------------------------

export const watchBody = z.object({
  companyNumber: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).optional(),
  role: z.enum(['supplier', 'insurer', 'repairer', 'engineer', 'client', 'other']).default('supplier'),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  riskReasons: z.array(z.string()).optional(),
});

export const rateCardPatch = z
  .object({
    recoveryCalloutPence: pence.optional(),
    perMilePence: pence.optional(),
    adminPence: pence.optional(),
    storageDailyPence: pence.optional(),
    engineerFeePence: pence.optional(),
    vatRate: vatRate.optional(),
    // web-client spellings
    recoveryPerLoadedMilePence: pence.optional(),
    recoveryAdminPence: pence.optional(),
  })
  .transform(({ recoveryPerLoadedMilePence, recoveryAdminPence, ...rest }) => ({
    ...rest,
    ...(recoveryPerLoadedMilePence !== undefined ? { perMilePence: recoveryPerLoadedMilePence } : {}),
    ...(recoveryAdminPence !== undefined ? { adminPence: recoveryAdminPence } : {}),
  }));

export const settingsPatchBody = z.object({
  companyName: z.string().trim().min(1).optional(),
  companyNumber: z.string().trim().min(1).optional(),
  registeredOffice: addressSchema.optional(),
  vatNumber: z.string().optional(),
  bank: bankDetailsSchema.optional(),
  icoRegistration: z.string().optional(),
  rateCard: rateCardPatch.optional(),
});

export const jobsRunBody = z.object({ job: z.enum(['watch_poll', 'clocks_refresh']) });
