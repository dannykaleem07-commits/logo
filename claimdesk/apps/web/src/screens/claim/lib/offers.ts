/**
 * Intervention register helpers (pure). Lesson c: every offer is logged with what / who / when and answered in
 * writing within 1 working day. Lesson m: the register records the client's decision in the client's words;
 * nothing here advises on it.
 */
import type { Clock, InterventionOffer, ISODateTime, Pence } from '@ccguk/domain';
import type { InterventionOfferInput } from '../../../api/client';
import { dueState } from '../../../lib/clocks';
import type { FormResult } from './chronology';

export const CHANNEL_LABEL: Record<InterventionOffer['channel'], string> = {
  phone: 'Phone call',
  email: 'Email',
  letter: 'Letter',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  portal: 'Portal',
  via_client: 'Told to the client in person'
};
export const CHANNEL_OPTIONS = (Object.keys(CHANNEL_LABEL) as InterventionOffer['channel'][]).map((value) => ({ value, label: CHANNEL_LABEL[value] }));

export const DECISION_LABEL: Record<InterventionOffer['clientDecision'], string> = {
  pending: 'Not decided yet',
  accepted: 'Client accepted it',
  declined: 'Client declined it'
};

export interface OfferForm {
  receivedAt: ISODateTime | '';
  channel: InterventionOffer['channel'] | '';
  offerorName: string;
  offerorPartyId: string;
  vehicleClassOffered: string;
  dailyRatePence: Pence | null;
  rateIncludesVat: boolean;
  excessPence: Pence | null;
  mileageLimitPerDay: string;
  deliveryIncluded: boolean | undefined;
  insuranceIncluded: boolean | undefined;
  durationStated: string;
  otherTerms: string;
  suitable: boolean | undefined;
  suitabilityReasons: string;
  evidenceIds: string[];
}

export function emptyOfferForm(nowIso: ISODateTime): OfferForm {
  return {
    receivedAt: nowIso,
    channel: 'phone',
    offerorName: '',
    offerorPartyId: '',
    vehicleClassOffered: '',
    dailyRatePence: null,
    rateIncludesVat: false,
    excessPence: null,
    mileageLimitPerDay: '',
    deliveryIncluded: undefined,
    insuranceIncluded: undefined,
    durationStated: '',
    otherTerms: '',
    suitable: undefined,
    suitabilityReasons: '',
    evidenceIds: []
  };
}

export function offerFormFrom(o: InterventionOffer): OfferForm {
  return {
    receivedAt: o.receivedAt,
    channel: o.channel,
    offerorName: o.offerorName,
    offerorPartyId: o.offerorPartyId ?? '',
    vehicleClassOffered: o.vehicleClassOffered ?? '',
    dailyRatePence: o.dailyRatePence ?? null,
    rateIncludesVat: o.rateIncludesVat ?? false,
    excessPence: o.terms.excessPence ?? null,
    mileageLimitPerDay: o.terms.mileageLimitPerDay !== undefined ? String(o.terms.mileageLimitPerDay) : '',
    deliveryIncluded: o.terms.deliveryIncluded,
    insuranceIncluded: o.terms.insuranceIncluded,
    durationStated: o.terms.durationStated ?? '',
    otherTerms: o.terms.otherTerms ?? '',
    suitable: o.suitable,
    suitabilityReasons: o.suitabilityReasons.join('\n'),
    evidenceIds: o.evidenceIds
  };
}

function splitReasons(text: string): string[] {
  return text
    .split(/\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function offerBodyFrom(form: OfferForm, nowIso: ISODateTime): FormResult<InterventionOfferInput> {
  const errors: Record<string, string> = {};
  if (!form.receivedAt) errors.receivedAt = 'When was the offer made? (starts the 1-working-day reply clock)';
  else if (Date.parse(form.receivedAt) > Date.parse(nowIso) + 5 * 60_000) errors.receivedAt = 'Cannot be in the future';
  if (!form.channel) errors.channel = 'How was it made?';
  if (form.offerorName.trim().length < 2) errors.offerorName = 'Who made the offer?';
  if (!form.vehicleClassOffered.trim() && !form.otherTerms.trim()) errors.vehicleClassOffered = 'What exactly was offered?';
  const mileage = form.mileageLimitPerDay.trim() === '' ? undefined : Number(form.mileageLimitPerDay);
  if (mileage !== undefined && (!Number.isInteger(mileage) || mileage < 0)) errors.mileageLimitPerDay = 'Whole miles per day';
  if (form.suitable === false && splitReasons(form.suitabilityReasons).length === 0) errors.suitabilityReasons = 'Say why the offer was not suitable (one reason per line)';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      receivedAt: form.receivedAt,
      channel: form.channel as InterventionOffer['channel'],
      offerorName: form.offerorName.trim(),
      offerorPartyId: form.offerorPartyId || undefined,
      vehicleClassOffered: form.vehicleClassOffered.trim() || undefined,
      dailyRatePence: form.dailyRatePence ?? undefined,
      rateIncludesVat: form.dailyRatePence !== null ? form.rateIncludesVat : undefined,
      terms: {
        excessPence: form.excessPence ?? undefined,
        mileageLimitPerDay: mileage,
        deliveryIncluded: form.deliveryIncluded,
        insuranceIncluded: form.insuranceIncluded,
        durationStated: form.durationStated.trim() || undefined,
        otherTerms: form.otherTerms.trim() || undefined
      },
      suitable: form.suitable,
      suitabilityReasons: splitReasons(form.suitabilityReasons),
      clientDecision: 'pending',
      evidenceIds: form.evidenceIds
    }
  };
}

/** The 1-working-day reply clock the engine derived for this offer (keyed on the offer instant or its event). */
export function replyClockForOffer(clocks: Clock[], offer: Pick<InterventionOffer, 'receivedAt'>, offerEventId?: string): Clock | undefined {
  const at = Date.parse(offer.receivedAt);
  return clocks.find((c) => c.kind === 'intervention_reply_1wd' && ((offerEventId && c.sourceEventId === offerEventId) || Date.parse(c.startsAt) === at));
}

export type ReplyState = 'sent' | 'overdue' | 'due' | 'late' | 'none';

/** 'sent' on time, 'late' when sent after the clock, 'overdue' / 'due' while open, 'none' when the engine has not derived a clock yet. */
export function replyState(offer: Pick<InterventionOffer, 'replySentAt'>, clock: Clock | undefined, now: Date | ISODateTime = new Date()): ReplyState {
  if (offer.replySentAt) {
    if (clock && Date.parse(offer.replySentAt) > Date.parse(clock.dueAt)) return 'late';
    return 'sent';
  }
  if (!clock) return 'none';
  return dueState(clock, now) === 'overdue' ? 'overdue' : 'due';
}

export interface OfferDecisionForm {
  clientDecision: 'accepted' | 'declined' | '';
  clientReasons: string;
  clientDecisionAt: ISODateTime | '';
}

export type OfferDecisionBody = { clientDecision: 'accepted' | 'declined'; clientReasons: string; clientDecisionAt: ISODateTime };

export function decisionBodyFrom(form: OfferDecisionForm): FormResult<OfferDecisionBody> {
  const errors: Record<string, string> = {};
  if (!form.clientDecision) errors.clientDecision = "Record the client's decision";
  if (form.clientReasons.trim().length < 3) errors.clientReasons = "Record the client's reasons in their own words";
  if (!form.clientDecisionAt) errors.clientDecisionAt = 'When did the client decide?';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { clientDecision: form.clientDecision as 'accepted' | 'declined', clientReasons: form.clientReasons.trim(), clientDecisionAt: form.clientDecisionAt } };
}

export const REGISTER_NOTE =
  'Record what was offered, by whom and when, exactly as the client reports it, and answer the offeror in writing within 1 working day. The client decides; the register records the decision and the reasons given.';
