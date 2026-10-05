// gta module — GTA benchmark rules for a non-subscriber (GTA 2.7(j)): rates, group mapping, hire
// charges, off-hire triggers, monitoring diary, late-payment uplift, payment-pack validator and the
// CCGUK recovery/storage rate card. Keep exports named; no default exports.
export { GTA_WORDING_DATE, GTA_NON_SUBSCRIBER_NOTE, defaultGtaRates, gtaRate, gtaGroupsOn } from './rates.js';

export { mapGtaGroup } from './groups.js';
export type { GtaGroupConfidence, GtaGroupMapping } from './groups.js';

export {
  GTA_ADDITIONAL_DRIVER_DAILY_PENCE,
  GTA_ADDITIONAL_DRIVER_CAP_PENCE,
  HIRE_DAY_CONVENTION,
  HIRE_END_TRIGGER_TEXT,
  hireDays,
  calculateHire,
  offHireDeadline,
} from './hire.js';
export type { HireBreakdownLine, HireBenchmark, HireCalculation, HireCalculationOptions, OffHireDeadline } from './hire.js';

export {
  MONITORING_BASIS,
  DELAY_NOTICE_MIN_WORKING_DAYS,
  DELAY_NOTICE_PCT_OVER,
  AUTHORISATION_CHECK_WD,
  PROGRESS_CHECK_WD,
  isMonitoringTouch,
  monitoringDiary,
} from './monitoring.js';
export type { MonitoringCheck, MonitoringCheckKind, MonitoringCheckStatus, DelayNotice, DelayNoticeKind, MonitoringDiary } from './monitoring.js';

export {
  GTA_LATE_PAYMENT_BASIS,
  GTA_LATE_PAYMENT_HIRES_FROM,
  GTA_PAYMENT_PACK_BASIS,
  PAYMENT_PACK_ITEMS,
  paymentPackItemLabels,
  paymentPackTemplatePrefixes,
  latePaymentUplift,
  latePaymentTierStart,
  validatePaymentPack,
  ledgerPaidInFull,
  paidInFullAt,
} from './payment.js';
export type { LatePaymentTier, LatePaymentUplift, PaymentPackItem, PaymentPackItemDetail, PaymentPackValidation } from './payment.js';

export { defaultRateCard, recoveryCharge, storageDays, storageCharge } from './ratecard.js';
export type { ChargeLine, RecoveryCharge, StorageDayConvention, StorageCharge } from './ratecard.js';

export { GTA_SUGGESTION_NOTE, noBenchmarkRateReason, suggestGtaGroup } from './suggest.js';
export type { GtaSuggestionBasis, GtaSuggestInput, GtaSuggestion } from './suggest.js';

export { gtaRateKey, mergeGtaRates } from './merge.js';
export type { ManualGtaRateRow, MergedGtaRate } from './merge.js';

export { CLIENT_GROUP_MISSING, HIRE_GROUP_MISSING, PRICING_SUGGESTION_LABELS, hirePricingGuide } from './pricing.js';
export type { ClientGroupSource, HirePricingGuide, HirePricingGuideInput, PricingGuideLine, PricingSuggestion } from './pricing.js';
