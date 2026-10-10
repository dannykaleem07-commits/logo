// owned by ap-autopilot
/**
 * The step catalogue (docs/SUPREME-AUTOPILOT.md §A.3) — data. 46 steps in catalogue order, each with its track,
 * stage, performer, floor / default mode, the predicates that say when it applies, is ready and is done, what it waits
 * on, what it needs, which clashes block it, its deadline and the action the runner takes.
 *
 * Predicates and requirements are ids into PREDICATES / REQUIREMENTS (predicates.ts); the integrity test checks every
 * id exists, every floor equals STEP_FLOORS (settings.ts, perimeter) and every action code is a playbook code.
 *
 * Notes on the hire steps: `hire.search`, `hire.choose` and `hire.hold` share one exit (a reservation exists). The
 * runner executes `hire.search` and `hire.choose` together — search, choose, and hold the chosen car with
 * `booking_hold` under the `hire.hold` step context — so `hire.hold` only shows as done when the hold exists.
 */
import type { NeedsYouKind } from '../agents/types.js';
import type { AutopilotStepId, StepDef } from './types.js';

const GTA = 'GTA (16 March 2026 wording) — industry benchmark only; CCGUK is not a subscriber (GTA 2.7(j))';

export const STEP_CATALOGUE: readonly StepDef[] = [
  // ---------------------------------------------------------------- intake
  {
    id: 'intake.new_claim', track: 'intake', stage: 'enquiry', title: 'Confirm the new claim', performer: 'person', floor: 'owner', defaultMode: 'owner',
    appliesWhen: 'always', after: [], readyWhen: [], doneWhen: 'claim.exists', requires: [], blockingClashes: [],
    action: { kind: 'needs_you', needsYouKind: 'new_claim' }, basis: ['SD §G.3 — new client relationships are confirmed by the owner'],
  },
  {
    id: 'intake.acknowledge', track: 'intake', stage: 'intake', title: 'Acknowledge the client', performer: 'ai_wording', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'client.emailOnFile', after: ['intake.new_claim'], readyWhen: [], doneWhen: 'ack.sent', requires: [], blockingClashes: [],
    deadline: { fromFact: 'claim.openedAt', hours: 4, businessHoursOnly: true },
    action: { kind: 'draft', templateId: null, emailKind: 'ack', actionCode: 'CHECK_NEED', recipient: 'client' }, actionCode: 'CHECK_NEED',
    basis: ['Owner rule: acknowledge every new client the same day'],
  },
  {
    id: 'intake.complete_fnol', track: 'intake', stage: 'intake', title: 'Complete the first notification details', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'always', after: ['intake.new_claim'], readyWhen: [], doneWhen: 'intake.fnolComplete', waitingOn: { who: 'client', when: 'intake.detailsRequested' },
    requires: [], blockingClashes: [], deadline: { fromFact: 'claim.openedAt', workingDays: 1 },
    action: { kind: 'draft', templateId: null, emailKind: 'doc_request', actionCode: 'CHECK_NEED', recipient: 'client' }, actionCode: 'CHECK_NEED',
    basis: ['validateFnol (intake) — the cold account, place, time, third party and hire needs'],
  },
  {
    id: 'intake.cross_file', track: 'intake', stage: 'intake', title: 'Check other files for clashes', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'always', after: ['intake.new_claim'], readyWhen: [], doneWhen: 'clash.crossFileClear', requires: [],
    blockingClashes: ['DUPLICATE_CLAIM_OPEN', 'SAME_REG_ON_HIRE', 'DUPLICATE_REGISTRATION', 'VIN_REG_MISMATCH', 'FLEET_REG_AS_CLAIM_VEHICLE', 'HARD_STOP_FLAG', 'HIRER_ON_OTHER_HIRE', 'DRIVER_ON_OTHER_HIRE'],
    action: { kind: 'tool', tool: 'clash_check', build: 'clash_check' },
    basis: ['SUPREME-AUTOPILOT §C — the same car, registration or person on two files'],
  },
  {
    id: 'intake.injury_referral', track: 'intake', stage: 'intake', title: 'Refer the injury out', performer: 'ai_wording', floor: 'confirm', defaultMode: 'confirm',
    appliesWhen: 'accident.injuries', after: ['intake.new_claim'], readyWhen: [], doneWhen: 'injury.referred', requires: [], blockingClashes: [],
    action: { kind: 'tool', tool: 'legal_escalate', build: 'injury_referral' }, actionCode: 'REFER_INJURY',
    basis: ['LASPO 2012 ss.56–60 — referral-fee ban', 'FCA claims-management perimeter'],
  },
  {
    id: 'intake.cctv', track: 'notify', stage: 'intake', title: 'Ask for CCTV to be preserved', performer: 'ai_wording', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'cctv.applies', after: ['intake.new_claim'], readyWhen: [], doneWhen: 'event.cctv_request_sent', requires: [], blockingClashes: [],
    deadline: { clock: 'cctv_preservation', fromFact: 'claim.accident.date', days: 7 },
    action: { kind: 'draft', templateId: 'letter.cctv_preservation', emailKind: null, actionCode: 'REQUEST_CCTV', recipient: 'supplier' }, actionCode: 'REQUEST_CCTV', templateIds: ['letter.cctv_preservation'],
    basis: ['BLUEPRINT §7.2 — CCTV requests within days 1–7'],
  },
  // ------------------------------------------------------------- qualify
  {
    id: 'qualify.acceptance', track: 'qualify', stage: 'qualification', title: 'Decide whether to take the claim', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'always', after: ['intake.complete_fnol'], readyWhen: [], doneWhen: 'acceptance.recorded', requires: [], blockingClashes: [],
    action: { kind: 'tool', tool: 'eligibility_assess', build: 'eligibility_assess' },
    basis: ['assessAcceptance — liability, costs exposure, hire to other heads (Tescher)'],
  },
  {
    id: 'qualify.decline', track: 'qualify', stage: 'qualification', title: 'Decline the claim', performer: 'person', floor: 'owner', defaultMode: 'owner',
    appliesWhen: 'acceptance.declined', after: ['qualify.acceptance'], readyWhen: [], doneWhen: 'claim.declined', requires: [], blockingClashes: [],
    action: { kind: 'needs_you', needsYouKind: 'autopilot_step' }, templateIds: ['letter.decline'],
    basis: ['SD §B.2 rule 4 — declining a claim is the owner’s decision'],
  },
  {
    id: 'qualify.driver', track: 'qualify', stage: 'qualification', title: 'Check the driver can be insured', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'acceptance.notDeclined', after: ['qualify.acceptance'], readyWhen: [], doneWhen: 'driver.eligible', waitingOn: { who: 'client', when: 'driver.detailsRequested' },
    requires: ['driver.profile'], blockingClashes: ['DRIVER_INELIGIBLE'],
    action: { kind: 'tool', tool: 'eligibility_assess', build: 'eligibility_assess' }, actionCode: 'DRIVER_ELIGIBILITY',
    basis: ['SUPREME-AUTOPILOT §F.1–F.2 — per-policy driver criteria (generic defaults: check against the policy wording)'],
  },
  {
    id: 'qualify.need', track: 'qualify', stage: 'qualification', title: 'Assess the client’s need for a car', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'acceptance.notDeclined', after: ['qualify.acceptance'], readyWhen: [], doneWhen: 'need.settled', requires: ['needs.captured'], blockingClashes: [],
    action: { kind: 'needs_you', needsYouKind: 'autopilot_step' }, actionCode: 'CHECK_NEED',
    basis: ['Giles v Thompson; Lagden v O’Connor — need for a replacement car', 'SUPREME-AUTOPILOT §F.3'],
  },
  {
    id: 'qualify.means', track: 'qualify', stage: 'qualification', title: 'Gather evidence of means', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'means.impecuniosity_relied_on', after: ['qualify.acceptance'], readyWhen: [], doneWhen: 'means.ready', waitingOn: { who: 'client', when: 'means.requested' },
    requires: [], blockingClashes: [],
    action: { kind: 'draft', templateId: null, emailKind: 'doc_request', actionCode: 'COLLECT_IMPECUNIOSITY_EVIDENCE', recipient: 'client' }, actionCode: 'COLLECT_IMPECUNIOSITY_EVIDENCE',
    basis: ['Lagden v O’Connor [2003] UKHL 64 — impecuniosity', 'Diriye v Bojaj [2020] EWCA Civ 1400'],
  },
  {
    id: 'qualify.roadworthiness', track: 'qualify', stage: 'qualification', title: 'Work out when hire should start', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'acceptance.notDeclined', after: ['qualify.acceptance'], readyWhen: [], doneWhen: 'roadworthiness.hireFromSet', requires: ['vehicle.driveableAnswered'], blockingClashes: [],
    action: { kind: 'none' },
    basis: ['SUPREME-AUTOPILOT §F.5 — hire from now (not driveable) or from the repair start (driveable)'],
  },
  // -------------------------------------------------------------- sign-up
  {
    id: 'signup.pack', track: 'signup', stage: 'sign_up', title: 'Prepare the sign-up pack', performer: 'code', floor: 'confirm', defaultMode: 'confirm',
    appliesWhen: 'acceptance.notDeclined', after: ['qualify.acceptance'], readyWhen: ['acceptance.accepted'], doneWhen: 'pack.signup.approved', requires: [], blockingClashes: ['HARD_STOP_FLAG'],
    action: { kind: 'pack', stage: 'signup' }, actionCode: 'SIGNUP_PACK', templateIds: ['agreement.ccguk_01_customer_loa', 'form.ccguk_09_accident_report'],
    basis: ['Agreements and forms always need the owner (SD §D.2 always-ask templates)'],
  },
  {
    id: 'signup.signed', track: 'signup', stage: 'sign_up', title: 'Get the sign-up pack signed', performer: 'person', floor: 'owner', defaultMode: 'owner',
    appliesWhen: 'acceptance.notDeclined', after: ['signup.pack'], readyWhen: [], doneWhen: 'signup.signed', waitingOn: { who: 'client', when: 'pack.signup.sent' },
    requires: [], blockingClashes: [], deadline: { fromFact: 'pack.signup.sentAt', days: 5 },
    action: { kind: 'needs_you', needsYouKind: 'autopilot_step' }, actionCode: 'CHASE_SIGNATURES',
    basis: ['E-signature stays human-only (SD §B.2 rule 5)'],
  },
  // --------------------------------------------------------------- notify
  {
    id: 'notify.ncaf', track: 'notify', stage: 'sign_up', title: 'Send the New Claim Advice Form', performer: 'ai_wording', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'insurer.known', after: [], readyWhen: ['event.services_agreed'], doneWhen: 'event.ncaf_sent', requires: [], blockingClashes: [],
    deadline: { clock: 'gta_4_1_ncaf_1wd', fromFact: 'event.services_agreed.at', workingDays: 1 },
    action: { kind: 'draft', templateId: 'letter.ncaf', emailKind: null, actionCode: 'SEND_NCAF', recipient: 'at_fault_insurer' }, actionCode: 'SEND_NCAF', templateIds: ['letter.ncaf'],
    basis: ['GTA 4.1 — NCAF within 1 working day', GTA],
  },
  {
    id: 'notify.handling_ref', track: 'notify', stage: 'sign_up', title: 'Get the insurer’s handling reference', performer: 'ai_wording', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'insurer.known', after: ['notify.ncaf'], readyWhen: ['event.ncaf_sent'], doneWhen: 'event.handling_ref_received', waitingOn: { who: 'insurer', when: 'handlingRef.requested' },
    requires: [], blockingClashes: [], deadline: { clock: 'gta_4_2_handling_ref_5wd', fromFact: 'event.ncaf_sent.at', workingDays: 5 },
    action: { kind: 'draft', templateId: 'letter.handling_ref_request', emailKind: null, actionCode: 'REQUEST_HANDLING_REF', recipient: 'at_fault_insurer' }, actionCode: 'REQUEST_HANDLING_REF', templateIds: ['letter.handling_ref_request'],
    basis: ['GTA 4.2 — handling reference within 5 working days', GTA],
  },
  {
    id: 'notify.intervention', track: 'notify', stage: 'sign_up', title: 'Answer the insurer’s intervention offer', performer: 'ai_wording', floor: 'confirm', defaultMode: 'confirm',
    appliesWhen: 'intervention.any', after: [], readyWhen: ['intervention.unanswered'], doneWhen: 'intervention.answered', requires: [], blockingClashes: [],
    deadline: { clock: 'intervention_reply_1wd', fromFact: 'intervention.receivedAt', workingDays: 1 },
    action: { kind: 'draft', templateId: 'letter.intervention_reply', emailKind: null, actionCode: 'REPLY_TO_INTERVENTION_OFFER', recipient: 'at_fault_insurer' }, actionCode: 'REPLY_TO_INTERVENTION_OFFER', templateIds: ['letter.intervention_reply'],
    basis: ['Copley v Lawn [2009] EWCA Civ 580', 'Sayce v TNT [2011] EWCA Civ 1583'],
  },
  // -------------------------------------------------------------- vehicle
  {
    id: 'vehicle.recovery', track: 'vehicle', stage: 'vehicle_secured', title: 'Arrange recovery of the client’s car', performer: 'code', floor: 'confirm', defaultMode: 'confirm',
    appliesWhen: 'vehicle.notDriveable', after: ['qualify.acceptance'], readyWhen: ['acceptance.accepted'], doneWhen: 'vehicle.recovered', requires: [], blockingClashes: [],
    action: { kind: 'draft', templateId: 'letter.recovery_storage_instruction', emailKind: null, actionCode: 'ARRANGE_RECOVERY', recipient: 'supplier' }, actionCode: 'ARRANGE_RECOVERY', templateIds: ['letter.recovery_storage_instruction'],
    basis: ['Owner rule: a car that cannot be driven is recovered and secured'],
  },
  {
    id: 'vehicle.storage', track: 'vehicle', stage: 'vehicle_secured', title: 'Keep storage short', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'storage.any', after: [], readyWhen: ['playbook.SEND_COLLECT_OR_PAY'], doneWhen: 'storage.handled', requires: [], blockingClashes: [],
    action: { kind: 'draft', templateId: 'letter.collect_or_pay', emailKind: null, actionCode: 'SEND_COLLECT_OR_PAY', recipient: 'at_fault_insurer' }, actionCode: 'SEND_COLLECT_OR_PAY',
    basis: ['Storage ends on the report + 48 hours, total loss or salvage'],
  },
  {
    id: 'vehicle.engineer', track: 'vehicle', stage: 'vehicle_secured', title: 'Instruct the engineer', performer: 'ai_wording', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'vehicle.engineerNeeded', after: [], readyWhen: ['event.services_agreed'], doneWhen: 'engineer.instructedOrReported', requires: [], blockingClashes: [],
    deadline: { fromFact: 'event.services_agreed.at', workingDays: 1 },
    action: { kind: 'draft', templateId: 'letter.supplier_instruction_engineer', emailKind: null, actionCode: 'INSTRUCT_ENGINEER', recipient: 'engineer' }, actionCode: 'INSTRUCT_ENGINEER', templateIds: ['letter.supplier_instruction_engineer'],
    basis: ['Owner rule: engineer instructed 1 working day after sign-up'],
  },
  {
    id: 'vehicle.inspection', track: 'vehicle', stage: 'vehicle_secured', title: 'Get the car inspected', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'vehicle.engineerNeeded', after: ['vehicle.engineer'], readyWhen: ['event.engineer_instructed'], doneWhen: 'inspection.doneOrReported', waitingOn: { who: 'engineer', when: 'inspection.waiting' },
    requires: [], blockingClashes: [], deadline: { fromFact: 'event.engineer_instructed.at', workingDays: 3 },
    action: { kind: 'draft', templateId: null, emailKind: 'chaser', actionCode: 'INSTRUCT_ENGINEER', recipient: 'engineer' }, actionCode: 'INSTRUCT_ENGINEER',
    basis: ['Owner rule: chase the inspection 3 working days after instruction'],
  },
  {
    id: 'vehicle.report', track: 'vehicle', stage: 'on_hire', title: 'Issue the engineer’s report', performer: 'person', floor: 'owner', defaultMode: 'owner',
    appliesWhen: 'vehicle.engineerNeeded', after: ['vehicle.inspection'], readyWhen: ['report.draftWaiting'], doneWhen: 'event.report_issued', waitingOn: { who: 'engineer', when: 'report.awaited' },
    requires: [], blockingClashes: [],
    action: { kind: 'needs_you', needsYouKind: 'autopilot_step' },
    basis: ['Issuing a report is a person’s decision'],
  },
  {
    id: 'vehicle.repair_track', track: 'vehicle', stage: 'on_hire', title: 'Track the repair', performer: 'ai_judgement', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'repair.route', after: [], readyWhen: ['repair.begun'], doneWhen: 'event.repair_completed', waitingOn: { who: 'repairer', when: 'repair.underway' },
    requires: [], blockingClashes: [], deadline: { clock: 'gta_4_10_authorisation_check_3wd' },
    action: { kind: 'judge', question: 'repair_status_from_message', options: 'repair_status' }, actionCode: 'SEND_DELAY_NOTICE',
    basis: ['GTA 4.10 / 4.11 — authorisation check and repair monitoring', GTA],
  },
  {
    id: 'vehicle.total_loss_track', track: 'vehicle', stage: 'on_hire', title: 'Track the total-loss payment', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'event.total_loss_confirmed', after: [], readyWhen: [], doneWhen: 'event.tl_payment_received', waitingOn: { who: 'insurer', when: 'always' },
    requires: [], blockingClashes: [],
    action: { kind: 'none' },
    basis: ['GTA 4.14 — off hire 5 working days after the total-loss payment', GTA],
  },
  // ----------------------------------------------------------------- hire
  {
    id: 'hire.search', track: 'hire', stage: 'hire_search', title: 'Find a car', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'hire.needed', after: ['qualify.acceptance', 'qualify.driver', 'qualify.need', 'qualify.roadworthiness'], readyWhen: ['acceptance.accepted', 'hire.inLookAhead', 'offer.notExpired'],
    doneWhen: 'hire.reservationExists', requires: ['client.email'], blockingClashes: ['DUPLICATE_CLAIM_OPEN', 'SAME_REG_ON_HIRE', 'CLAIM_SECOND_HIRE', 'HARD_STOP_FLAG'],
    deadline: { fromFact: 'needs.neededFrom' },
    action: { kind: 'tool', tool: 'fleet_search', build: 'availability' },
    basis: ['SUPREME-AUTOPILOT §B.5 — free, legal and insured for the whole expected hire'],
  },
  {
    id: 'hire.choose', track: 'hire', stage: 'hire_search', title: 'Choose the car', performer: 'ai_judgement', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'hire.needed', after: ['hire.search'], readyWhen: [], doneWhen: 'hire.reservationExists', requires: [], blockingClashes: [],
    action: { kind: 'judge', question: 'choose_car', options: 'ranked_cars' },
    basis: ['Like for like compared by GTA benchmark rates (never by group code)', GTA],
  },
  {
    id: 'hire.hold', track: 'hire', stage: 'hire_search', title: 'Hold the car', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'hire.needed', after: ['hire.choose'], readyWhen: [], doneWhen: 'hire.reservationExists', requires: [], blockingClashes: [],
    action: { kind: 'tool', tool: 'booking_hold', build: 'booking_hold' },
    basis: ['SUPREME-AUTOPILOT §B.7 — a hold expires after 24 hours'],
  },
  {
    id: 'hire.offer', track: 'hire', stage: 'hire_offer', title: 'Offer the car to the client', performer: 'ai_wording', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'hire.needed', after: ['hire.hold'], readyWhen: ['reservation.held', 'choice.noneOpen'], doneWhen: 'offer.made', requires: ['client.email'], blockingClashes: ['UNIT_DOUBLE_BOOKED', 'HOLD_EXPIRED'],
    deadline: { fromFact: 'reservation.createdAt', hours: 1 },
    action: { kind: 'tool', tool: 'hire_offer_prepare', build: 'hire_offer' }, actionCode: 'OFFER_HIRE', templateIds: ['letter.hire_offer'],
    basis: ['Mitigation and promptness: a suitable car offered quickly'],
  },
  {
    id: 'hire.acceptance', track: 'hire', stage: 'hire_offer', title: 'Get the client’s answer', performer: 'ai_judgement', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'hire.needed', after: ['hire.offer'], readyWhen: ['offer.sent'], doneWhen: 'offer.accepted', waitingOn: { who: 'client', when: 'offer.awaitingReply' },
    requires: [], blockingClashes: [], deadline: { fromFact: 'offer.expiresAt' },
    action: { kind: 'judge', question: 'offer_wording', options: 'hire_reply' },
    basis: ['SUPREME-AUTOPILOT §D.4 — clear yes/no read by code; anything else goes to the reply reader or the owner'],
  },
  {
    id: 'hire.confirm', track: 'hire', stage: 'hire_booked', title: 'Confirm the booking', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'hire.needed', after: ['hire.acceptance'], readyWhen: ['offer.accepted'], doneWhen: 'reservation.confirmedOrLater', requires: [], blockingClashes: ['UNIT_DOUBLE_BOOKED'],
    action: { kind: 'tool', tool: 'booking_confirm', build: 'booking_confirm' }, actionCode: 'CONFIRM_BOOKING',
    basis: ['SUPREME-AUTOPILOT §B.7 — the agreement number is allocated at confirmation'],
  },
  {
    id: 'hire.delivery', track: 'hire', stage: 'hire_booked', title: 'Book the delivery and tell the client', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'hire.needed', after: ['hire.confirm'], readyWhen: ['reservation.confirmedOrLater'], doneWhen: 'delivery.arranged', requires: [], blockingClashes: [],
    action: { kind: 'tool', tool: 'movement_schedule', build: 'delivery' }, actionCode: 'SCHEDULE_DELIVERY', templateIds: ['letter.booking_confirmation'],
    basis: ['SUPREME-AUTOPILOT §B.8 — business hours, 2-hour windows, 2 hours’ notice'],
  },
  {
    id: 'hire.pack', track: 'hire', stage: 'hire_booked', title: 'Prepare the hire-start paperwork', performer: 'code', floor: 'confirm', defaultMode: 'confirm',
    appliesWhen: 'hire.needed', after: ['hire.confirm'], readyWhen: ['reservation.confirmedOrLater'], doneWhen: 'pack.hire_start.approved', requires: [], blockingClashes: [],
    action: { kind: 'pack', stage: 'hire_start' }, actionCode: 'PREPARE_HIRE_PACK',
    templateIds: ['agreement.ccguk_03_credit_hire', 'form.cancellation_sch3', 'form.express_request_to_start', 'form.ccguk_06_handover_condition', 'form.hire_cover_confirmation'],
    basis: ['CCR 2013 Sch 2 / Sch 3, reg 36 — pre-contract information and the express request (W v Veolia)'],
  },
  {
    id: 'hire.handover', track: 'hire', stage: 'handover', title: 'Hand the car over', performer: 'person', floor: 'owner', defaultMode: 'owner',
    appliesWhen: 'hire.needed', after: ['hire.pack', 'hire.delivery'], readyWhen: ['delivery.due', 'pack.hire_start.approved'], doneWhen: 'hire.started', requires: [], blockingClashes: ['SIGNATURES_MISSING', 'LICENCE_CHECK_STALE'],
    deadline: { fromFact: 'delivery.windowEnd' },
    action: { kind: 'needs_you', needsYouKind: 'autopilot_step' },
    basis: ['Physical handover, licence check and signatures are done by people'],
  },
  {
    id: 'hire.start_notice', track: 'notify', stage: 'handover', title: 'Tell the insurer the hire has started', performer: 'ai_wording', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'insurer.known', after: [], readyWhen: ['hire.started'], doneWhen: 'event.hire_start_notice_sent', requires: [], blockingClashes: [],
    deadline: { fromFact: 'hire.startAt', workingDays: 1 },
    action: { kind: 'draft', templateId: 'letter.hire_start_notice', emailKind: null, actionCode: 'NOTIFY_HIRE_START', recipient: 'at_fault_insurer' }, actionCode: 'NOTIFY_HIRE_START', templateIds: ['letter.hire_start_notice'],
    basis: ['Owner rule: the at-fault insurer is told of the hire within 1 working day (no rates in the notice)'],
  },
  {
    id: 'hire.monitor', track: 'hire', stage: 'on_hire', title: 'Keep the hire reasonable', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'hire.everStarted', after: [], readyWhen: ['hire.active'], doneWhen: 'hire.ended', waitingOn: { who: 'time', when: 'monitor.recent' },
    requires: [], blockingClashes: [],
    action: { kind: 'draft', templateId: null, emailKind: 'client_update', actionCode: 'CHECK_NEED', recipient: 'client' }, actionCode: 'CHECK_NEED',
    basis: ['Mitigation: the need for the car is checked weekly'],
  },
  {
    id: 'hire.offhire', track: 'hire', stage: 'off_hire', title: 'Book the collection', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'hire.everStarted', after: [], readyWhen: ['hire.offHireTrigger', 'hire.active'], doneWhen: 'collection.arranged', requires: [], blockingClashes: [],
    deadline: { fromFact: 'hire.offHireDeadline' },
    action: { kind: 'tool', tool: 'movement_schedule', build: 'collection' }, actionCode: 'BOOK_COLLECTION',
    basis: ['GTA 4.8 / 4.9 / 4.14 — off hire within 24 hours / 1 / 5 working days of the trigger', GTA],
  },
  {
    id: 'hire.return', track: 'hire', stage: 'off_hire', title: 'Collect the car and end the hire', performer: 'person', floor: 'owner', defaultMode: 'owner',
    appliesWhen: 'hire.everStarted', after: ['hire.offhire'], readyWhen: ['collection.planned'], doneWhen: 'hire.ended', requires: [], blockingClashes: [],
    deadline: { fromFact: 'collection.windowEnd' },
    action: { kind: 'needs_you', needsYouKind: 'autopilot_step' }, actionCode: 'END_HIRE_NOW',
    basis: ['Physical collection is done by people'],
  },
  // ---------------------------------------------------------------- money
  {
    id: 'money.invoices', track: 'money', stage: 'billing', title: 'Prepare the invoices', performer: 'code', floor: 'confirm', defaultMode: 'confirm',
    appliesWhen: 'billing.applies', after: [], readyWhen: ['billing.ready'], doneWhen: 'pack.billing.approved', requires: [], blockingClashes: [],
    deadline: { fromFact: 'hire.endAt', workingDays: 1 },
    action: { kind: 'pack', stage: 'billing' }, actionCode: 'RAISE_INVOICES', templateIds: ['invoice.hire', 'form.hire_period_validation'],
    basis: ['Ledger rows are written only on the owner’s approval (perimeter)'],
  },
  {
    id: 'money.payment_pack', track: 'money', stage: 'billing', title: 'Send the payment pack', performer: 'code', floor: 'confirm', defaultMode: 'confirm',
    appliesWhen: 'billing.applies', after: ['money.invoices'], readyWhen: ['pack.billing.approved'], doneWhen: 'event.payment_pack_sent', requires: [], blockingClashes: [],
    deadline: { fromFact: 'hire.endAt', workingDays: 2 },
    action: { kind: 'pack', stage: 'payment' }, actionCode: 'SEND_PAYMENT_PACK', templateIds: ['pack.gta_payment', 'schedule.loss'],
    basis: ['GTA 6.7 — the settlement month runs from a complete pack', GTA],
  },
  {
    id: 'money.chasers', track: 'money', stage: 'recovery', title: 'Chase payment', performer: 'ai_wording', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'event.payment_pack_sent', after: [], readyWhen: ['chaser.due'], doneWhen: 'money.headsResolved', waitingOn: { who: 'insurer', when: 'chaser.notDue' },
    requires: [], blockingClashes: [],
    action: { kind: 'draft', templateId: null, emailKind: 'chaser', actionCode: 'CHASER_7', recipient: 'at_fault_insurer' }, actionCode: 'CHASER_7',
    basis: ['BLUEPRINT §7.8 — chasers on day 7, 14 and 21'],
  },
  {
    id: 'money.complaint', track: 'money', stage: 'recovery', title: 'Complain about late payment', performer: 'ai_wording', floor: 'confirm', defaultMode: 'confirm',
    appliesWhen: 'playbook.COMPLAINT_28', after: [], readyWhen: [], doneWhen: 'event.complaint_sent', requires: [], blockingClashes: [],
    action: { kind: 'draft', templateId: 'letter.complaint_disp', emailKind: null, actionCode: 'COMPLAINT_28', recipient: 'at_fault_insurer' }, actionCode: 'COMPLAINT_28', templateIds: ['letter.complaint_disp'],
    basis: ['FCA DISP 1 — complaint at day 28'],
  },
  {
    id: 'money.offer', track: 'money', stage: 'recovery', title: 'Decide on the settlement offer', performer: 'person', floor: 'owner', defaultMode: 'owner',
    appliesWhen: 'settlementOffer.open', after: [], readyWhen: [], doneWhen: 'settlementOffer.noneOpen', requires: [], blockingClashes: [],
    action: { kind: 'needs_you', needsYouKind: 'offer_decision' },
    basis: ['Owner rule: offers and settlements always go to the owner (SD §D.1)'],
  },
  {
    id: 'money.payment', track: 'money', stage: 'recovery', title: 'Record the payment', performer: 'code', floor: 'confirm', defaultMode: 'confirm',
    appliesWhen: 'payment.remittanceIn', after: [], readyWhen: [], doneWhen: 'payment.recorded', requires: [], blockingClashes: [],
    action: { kind: 'needs_you', needsYouKind: 'money' },
    basis: ['Money is written by the owner (SD §D.1)'],
  },
  {
    id: 'money.client_payout', track: 'money', stage: 'recovery', title: 'Pay the client what is theirs', performer: 'person', floor: 'owner', defaultMode: 'owner',
    appliesWhen: 'money.clientPayoutDue', after: [], readyWhen: [], doneWhen: 'never', requires: [], blockingClashes: [],
    action: { kind: 'needs_you', needsYouKind: 'money' }, actionCode: 'PAY_CLIENT',
    basis: ['PAV / excess received for the client is paid on to them'],
  },
  // ---------------------------------------------------------------- close
  {
    id: 'close.readiness', track: 'close', stage: 'closure', title: 'Close the file', performer: 'code', floor: 'owner', defaultMode: 'owner',
    appliesWhen: 'always', after: [], readyWhen: ['money.headsResolved', 'event.payment_pack_sent'], doneWhen: 'claim.closed', requires: [], blockingClashes: [],
    action: { kind: 'needs_you', needsYouKind: 'autopilot_step' }, actionCode: 'CLOSE_FILE', templateIds: ['letter.closure'],
    basis: ['Closing a file is the owner’s decision (SD §B.2 rule 4)'],
  },
  {
    id: 'status.sync', track: 'close', stage: 'intake', title: 'Keep the claim status up to date', performer: 'code', floor: 'auto', defaultMode: 'auto',
    appliesWhen: 'always', after: [], readyWhen: [], doneWhen: 'status.inSync', requires: [], blockingClashes: [],
    action: { kind: 'tool', tool: 'claim_status_set', build: 'status' },
    basis: ['SUPREME-AUTOPILOT §A.9 — never declined, settled, closed, pre-action or litigation'],
  },
];

/** Steps whose stage is "(any)" in §A.3: they never decide the claim's stage. */
export const STAGELESS_STEPS: ReadonlySet<AutopilotStepId> = new Set<AutopilotStepId>(['notify.intervention', 'status.sync', 'hire.start_notice']);

/**
 * Existing Needs-you kinds that, when open on the claim, mean the owner already has this step in front of them (§A.5
 * rule 8): the step shows `waiting` on the owner instead of raising a second card.
 */
export const STEP_RELATED_NEEDS_YOU: Readonly<Partial<Record<AutopilotStepId, readonly NeedsYouKind[]>>> = {
  'intake.new_claim': ['new_claim'],
  'intake.complete_fnol': ['missing_info'],
  'intake.injury_referral': ['legal_review'],
  'qualify.driver': ['eligibility_review', 'missing_info'],
  'qualify.need': ['eligibility_review'],
  'qualify.means': ['eligibility_review'],
  'signup.pack': ['approve_pack'],
  'signup.signed': ['confirm_signed'],
  'hire.search': ['choose_car'],
  'hire.choose': ['choose_car'],
  'hire.acceptance': ['question'],
  'hire.pack': ['approve_pack'],
  'money.invoices': ['approve_pack', 'money'],
  'money.payment_pack': ['approve_pack'],
  'money.offer': ['offer_decision'],
  'money.payment': ['money'],
};

const BY_ID = new Map<string, StepDef>(STEP_CATALOGUE.map((s) => [s.id, s]));

/** The catalogue entry of a step (throws for an unknown id). */
export function stepDef(id: string): StepDef {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`autopilot: unknown step ${id}`);
  return d;
}

/** Plain title of a step id (falls back to the id). */
export function stepTitle(id: string): string {
  return BY_ID.get(id)?.title ?? id;
}

/** Map an outbound email kind or template to the step that sends it (§D.3 STEP_FOR_SEND). */
export const STEP_FOR_SEND: Readonly<Record<string, AutopilotStepId>> = {
  hire_offer: 'hire.offer',
  booking_update: 'hire.delivery',
  ack: 'intake.acknowledge',
  'letter.ncaf': 'notify.ncaf',
  ncaf_cover: 'notify.ncaf',
  'letter.handling_ref_request': 'notify.handling_ref',
  handling_ref_request: 'notify.handling_ref',
  'letter.intervention_reply': 'notify.intervention',
  'letter.cctv_preservation': 'intake.cctv',
  cctv_request: 'intake.cctv',
  'letter.supplier_instruction_engineer': 'vehicle.engineer',
  'letter.hire_start_notice': 'hire.start_notice',
  'letter.booking_confirmation': 'hire.delivery',
  'letter.complaint_disp': 'money.complaint',
  'letter.chaser_7': 'money.chasers',
  'letter.chaser_14': 'money.chasers',
  'letter.chaser_21': 'money.chasers',
};
