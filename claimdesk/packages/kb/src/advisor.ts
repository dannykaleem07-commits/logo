/**
 * Advisor: cited guidance per topic, composed from the knowledge base.
 *
 * Stance (danny-brain): burden first, clock second, money third. Every point cites KbEntry ids; every cited id
 * is checked against the KB and anything not 'verified' is listed in `unverifiedCitations` so the consistency
 * engine (UNVERIFIED_CITATION) and the KB screen can flag it. Forum and perimeter checks are returned as data,
 * never silently dropped: a third-party claimant cannot take the at-fault insurer to the FOS (DISP 2.7),
 * GTA terms are a benchmark for a non-subscriber (2.7(j)), litigation is drafted for the claimant to sign.
 *
 * Nothing here is sent anywhere. The advisor produces text for a human to approve.
 */
import type { KbEntry } from '@ccguk/domain';
import { entryIndex, loadPlaybookRules } from './load.js';
import { search, unverifiedAmong } from './search.js';
import type { Advice, AdvicePoint, PaidFasterStep, PlaybookRule } from './types.js';

export const ADVICE_TOPICS = [
  'impecuniosity',
  'bhr',
  'mitigation',
  'period',
  'need',
  'enforceability',
  'pav',
  'total_loss',
  'storage',
  'payment_pack',
  'interest',
  'complaint',
  'litigation',
  'costs_exposure',
  'pcn',
  'nip',
  'dsar',
  'salvage',
  'fleet',
] as const;
export type AdviceTopic = (typeof ADVICE_TOPICS)[number];

// Forum / perimeter check strings (codes mirror the consistency engine's flag names).
export const FORUM_NOT_OPEN =
  'FORUM_NOT_OPEN: a third-party claimant is not an eligible complainant against the at-fault insurer (DISP 2.7.6R; fos-eligibility). Never name the FOS to the at-fault insurer. Route: DISP 1 complaint to the insurer, then letter before claim and court.';
export const GTA_BENCHMARK =
  'GTA_CITED_AS_LAW: CCGUK is not a GTA subscriber. GTA paragraphs (periods, off-hire triggers, 6.7 settlement month, 6.8.6 late-payment additions, rates) are quoted as an industry benchmark under GTA 2.7(j), never as a legal entitlement.';
export const RESERVED_ACTIVITY =
  'REGULATED_STATUS_IMPLIED: conduct of litigation and rights of audience are reserved (Legal Services Act 2007 s.12). Litigation documents are drafts for the claimant as litigant in person or an instructed solicitor to sign; CCGUK may speak only as a lay representative in a small claim where the claimant attends.';
export const INJURY_PERIMETER =
  'PERIMETER: any injury element is referred to a solicitor with no referral fee (LASPO 2012 ss.56-60; RAO arts 89G-89M). ClaimDesk continues the damage-only claim.';
export const ICOBS_SCOPE_CAVEAT =
  'ICOBS 8.2 (three-month reasoned offer, base + 4% interest) is pleaded against a UK-authorised motor insurer only; confirm the 8.2.1R scope point (LEGAL-CAVEATS item 1) before asserting it "as of right".';
export const BENCHMARK_FIGURES_CAVEAT =
  'GTA figures (rates, £5.50/day additional driver, 10%/20% additions) are unverified until a human opens the GTA rates spreadsheet and the 16 March 2026 wording; quote them with the benchmark wording only.';
export const GTA_4_14_CAVEAT =
  'GTA 4.14 wording on off-hire after a total-loss payment (5 working days where the CHO is dealing and the vehicle is unroadworthy) is unconfirmed against the 16 March 2026 PDF; older versions say 7 calendar days. Check before quoting a number.';
export const COURT_FEES_CAVEAT =
  'Court fees (issue bands, 5% ad valorem above £10,000, small claims hearing fees £27 to £346) come from secondary sources; verify against the current HMCTS EX50 before quoting a figure (LEGAL-CAVEATS item 4).';
export const MEDIATION_CAVEAT =
  'Mediation: the PD 51ZE small claims automatic-referral pilot ran to 21 May 2026 and the OCMC road-traffic mediation pilot status is unconfirmed; check the current position before the directions questionnaire (LEGAL-CAVEATS item 5).';

interface TopicSpec {
  summary: string;
  points: AdvicePoint[];
  caveats: string[];
  forumChecks: string[];
}

const P = (text: string, ...citations: string[]): AdvicePoint => ({ text, citations });

const TOPICS: Record<AdviceTopic, TopicSpec> = {
  impecuniosity: {
    summary:
      'Impecuniosity is the gateway to the full credit hire rate and the burden is ours: plead it and prove it with documents collected at sign-up, or price the file as a BHR file.',
    points: [
      P(
        'The test is whether the claimant could pay spot-rate hire without making sacrifices he could not reasonably be expected to make; if so he recovers the full credit hire charge because credit hire was his only realistic way of mitigating. That is the only route to the margin above BHR.',
        'lagden-v-oconnor-2003',
        'dimond-v-lovell-2000',
      ),
      P(
        'Burden: the claimant must plead impecuniosity and prove it with disclosure (bank and credit-card statements, income, outgoings, available credit). A bare assertion loses, and failing an unless order to particularise and disclose can debar the point entirely, so the Statement of Means and three months of statements for every account are collected at sign-up, not after the defence.',
        'diriye-v-bojaj-2020',
        'zurich-insurance-v-umerji-2014',
      ),
      P(
        'Available credit cuts both ways: a credit-card facility the claimant could have used to fund repair shortens the recoverable period even for an impecunious claimant, so record limits and balances honestly and expect the period argument to follow the rate argument.',
        'opoku-v-tintas-2013',
      ),
      P(
        'Expect pre-action disclosure applications for the impecuniosity documents; a file that already holds them answers the application for nothing and keeps the costs clock running the other way.',
        'holt-v-allianz-2023',
        'cpr-31-16',
      ),
      P(
        'A debarring order confined to rate does not stop impecuniosity being run on period, and a long hire can survive if the chronology shows the insurer caused the delay; keep the two arguments separate in the pleading.',
        'mib-v-houston-2025',
        'irving-v-morgan-sindall-2018',
      ),
      P(
        'Money: the difference between the agreement rate and the lowest mainstream BHR is the whole hire margin. If the client is not impecunious, say so on day one and price the hire to the BHR, because a prestige-vehicle hire without impecuniosity is assessed on a common-sense BHR with the credit element stripped out.',
        'stevens-v-equity-syndicate-2015',
        'bunting-v-zurich-2020',
      ),
    ],
    caveats: [
      'A statement of means with a false entry is a false statement of truth (CPR 32.14) and a Fraud Act exposure for the client and for whoever helped prepare it; take the figures from the documents, never from the account.',
    ],
    forumChecks: [],
  },

  bhr: {
    summary:
      'For a non-impecunious claimant the measure is the basic hire rate: the lowest reasonable rate a mainstream supplier in the locality would have charged for the kind of vehicle actually hired. The burden of proving a BHR lower than the credit rate is the defendant\'s, but the file wins with its own dated local evidence.',
    points: [
      P(
        'BHR is the lowest reasonable rate quoted by a mainstream (or local reputable) supplier for the vehicle actually hired, in the claimant\'s locality at the time of hire; the judge identifies that rate rather than averaging quotes, and the balance over it represents irrecoverable credit benefits.',
        'stevens-v-equity-syndicate-2015',
        'dimond-v-lovell-2000',
      ),
      P(
        'Burden: it is for the defendant to prove a BHR lower than the credit hire rate; absent evidence the credit rate stands. But do not rely on the insurer failing: collect date-stamped local like-for-like quotes at sign-up and again before litigation so the rate evidence is ours.',
        'dickinson-v-tesco-2013',
        'pattni-v-first-leicester-buses-bent-2011',
      ),
      P(
        'The comparator is the kind of vehicle hired, for the period actually hired; seven-day rates and nil-excess terms are handled as what they are, with the cost of excess cover treated as a separate recoverable element when the claimant reasonably took it.',
        'mcbride-v-uk-insurance-clayton-v-eui-2017',
        'irving-v-morgan-sindall-2018',
      ),
      P(
        'Courts assess BHR on a common-sense basis from imperfect evidence and dislike nit-picking either way; present a short table of quotes with dates, suppliers, vehicle group and terms rather than a surveyor\'s report built from unrepresentative numbers.',
        'bunting-v-zurich-2020',
        'irving-v-morgan-sindall-2018',
      ),
      P(
        'Rates evidence must be honest: fabricated rate surveys ended in contempt proceedings. Screenshots with URL, timestamp and hash, captured manually, are the standard.',
        'accident-exchange-v-broom-2017',
      ),
      P(
        'GTA rates are a benchmark for the group, not evidence of BHR for a non-subscriber; use them to sanity-check the agreement rate and to price the settlement range, never in a pleading as the measure of loss.',
        'gta-2-7-j',
        'gta-rates-2026-27',
      ),
    ],
    caveats: [BENCHMARK_FIGURES_CAVEAT],
    forumChecks: [GTA_BENCHMARK],
  },

  mitigation: {
    summary:
      'Mitigation is lost by silence, not by refusal. Answer every intervention offer in writing with reasons, keep the chronology, and remember an impecunious claimant must still get the car repaired within a reasonable time.',
    points: [
      P(
        'An insurer\'s offer of a replacement car is not binding unless its terms and cost were made clear enough to evaluate; and even an unreasonable refusal does not reduce damages to nil but to what the car would have cost the insurer. Reply within one working day with reasons (the GTA 3.6 benchmark) and ask for the offer\'s terms and cost in writing.',
        'copley-v-lawn-2009',
        'sayce-v-tnt-2011',
        'gta-3-6',
      ),
      P(
        'Period mitigation applies even to an impecunious claimant: after a reasonable time the claimant may be expected to fund the repair from savings or an available credit facility, cutting hire and storage from that point. Log what facilities exist and when repair could realistically have been funded.',
        'opoku-v-tintas-2013',
        'lagden-v-oconnor-2003',
      ),
      P(
        'Burden on period sits with the defendant where the delay is the insurer\'s: a claimant who cannot fund repair until the insurer pays is not failing to mitigate, provided the dated chronology shows the delay was theirs.',
        'mattocks-v-mann-1993',
      ),
      P(
        'Need is part of mitigation: a business or prestige claimant must show why a replacement of that kind was reasonably required, and a claimant with another vehicle available recovers loss of use, not an unnecessary hire.',
        'singh-v-yaqubi-2013',
        'beechwood-birmingham-v-hoyer-2010',
      ),
      P(
        'The mitigation questionnaire with a statement of truth goes in the payment pack (GTA Appendix C / 6.2 benchmark contents); the intervention register and the written replies are the evidence behind it. Never tell a client to ignore an offer (live-file lesson m).',
        'gta-appendix-c',
        'gta-6-2',
      ),
    ],
    caveats: ['The blueprint attributed the "ignored offer" principle to Opoku v Tintas; the research corrected this to Copley v Lawn / Sayce v TNT (Opoku is a period case). Templates cite accordingly.'],
    forumChecks: [GTA_BENCHMARK],
  },

  period: {
    summary:
      'The period argument is won by the chronology: every dated step from notification to collection or settlement, with the insurer\'s delays named. Hire stops when the trigger fires; a day past the trigger is a day given away.',
    points: [
      P(
        'Record every event with a date: NCAF, engineer instructed, inspection, report, authority, parts ordered and arrived, repair start and finish, ready for collection, total-loss offer and payment. Gaps caused by the insurer are days it cannot challenge; the GTA 4.10/4.11 monitoring diary is the benchmark cadence.',
        'mattocks-v-mann-1993',
        'gta-4-10',
        'gta-4-11',
      ),
      P(
        'Off-hire triggers (benchmark): repair complete and vehicle ready for collection plus 24 hours; cash in lieu of repair received; total-loss payment received with the response window; one working day termination notice. Build each into the clocks and end hire the day it fires.',
        'gta-4-7',
        'gta-4-8',
        'gta-4-9',
        'gta-4-14',
      ),
      P(
        'Where the hire outlasts a reasonable repair-funding window the court will cut it even for an impecunious claimant; where the insurer\'s rate-only debarring order left period open, a 197-day hire was upheld on the chronology. Period is a separate argument from rate and is pleaded separately.',
        'opoku-v-tintas-2013',
        'mib-v-houston-2025',
      ),
      P(
        'Delay notices (benchmark: 2+ working days or more than 20% over estimate, authorisation checks at 3 working days, progress checks every 5) are the monitoring diary; send them in writing so the delay is documented as theirs.',
        'gta-4-10',
        'gta-4-11',
      ),
      P(
        'Money: a 591-day hire invites scrutiny of everything else on the file; long periods need a reason on every page or they become the insurer\'s best argument on costs exposure.',
        'zurich-insurance-v-umerji-2014',
        'tescher-v-daml-axa-v-spectra-2025',
      ),
    ],
    caveats: [GTA_4_14_CAVEAT, BENCHMARK_FIGURES_CAVEAT],
    forumChecks: [GTA_BENCHMARK],
  },

  need: {
    summary:
      'Need is evidenced, not asserted: occupation, journeys, dependants, household vehicles and why none was available, signed at sign-up. "He needed a car" loses; a week of actual journeys wins.',
    points: [
      P(
        'A business claimant with spare fleet vehicles still recovers loss of use, but not the cost of an unnecessary hire; the question is what was reasonably needed to replace the function of the damaged vehicle.',
        'beechwood-birmingham-v-hoyer-2010',
      ),
      P(
        'Need for a particular kind of vehicle (prestige, specialist, plated private hire) must be proved: a Rolls-Royce hire failed for want of evidence of need; a taxi claimant\'s loss is normally loss of profit unless a plated replacement was genuinely required.',
        'singh-v-yaqubi-2013',
        'hussain-v-eui-2019',
      ),
      P(
        'Illegality bites on need and causation: a vehicle without a valid MOT at the time of the collision can defeat the loss-of-use claim, so check MOT, tax and insurance on the DVSA/DVLA record at FNOL and record the results.',
        'ali-v-hsf-logistics-polska-2024',
        'rta-1988-s143',
      ),
      P(
        'Loss of use is recoverable even where the claimant\'s own insurer arranged or paid for the hire; insurance arrangements are res inter alios acta.',
        'bee-v-jenson-2007',
        'sobrany-v-uab-transtira-2016',
      ),
      P(
        'Use must match need: odometer photos at delivery and collection, weekly mileage prompts and fuel receipts are the evidence the insurer will ask for under CPR Part 18 (and the GTA 6.2 pack lists as a benchmark), so capture them during the hire rather than reconstruct them.',
        'cpr-18-1',
        'gta-6-2',
      ),
    ],
    caveats: [],
    forumChecks: [GTA_BENCHMARK],
  },

  enforceability: {
    summary:
      'An unenforceable hire agreement means no loss and no hire claim. The insurer looks here first because it costs nothing; look first ourselves: RAO art 60F exemption, Consumer Contracts Regulations information and cancellation, express request to start, signed audit certificate.',
    points: [
      P(
        'If the agreement is a regulated consumer credit agreement that is improperly executed it is unenforceable and the claimant has suffered no loss; the agreement must sit inside the RAO art 60F exemption: no more than 12 payments, within 12 months of the agreement, no interest or charges.',
        'dimond-v-lovell-2000',
        'cca-1974-regulated-agreements',
        'rao-2001-art-60f',
      ),
      P(
        'An open-ended hire "until repair or settlement" is not excluded by reg 28(1)(h), so the Schedule 2 information and the Schedule 3 cancellation form must be given and an express written request to start during the cancellation period obtained and acknowledged; otherwise the cancellation period extends and nothing may be owed for the service.',
        'ccr-2013-reg-28-1-h',
        'ccr-2013-reg-29-30',
        'ccr-2013-reg-31',
        'ccr-2013-reg-36',
        'ccr-2013-sch-2',
        'ccr-2013-sch-3',
      ),
      P(
        'Doorstep and cancellation-regulation failures have zeroed hire claims before; the risk is real for a sign-up at the client\'s home or the repairer\'s premises.',
        'w-v-veolia-2011',
        'salat-v-barutis-2013',
      ),
      P(
        'The foundation is sound: credit hire is not champertous and the charges are recoverable damages. The attack is on the paperwork, so the audit certificate (dates, signatures, OTP, hashes) is part of the enforceability evidence.',
        'giles-v-thompson-1994',
        'burdis-v-livsey-clark-v-ardington-2002',
      ),
      P(
        'A hire agreement that the claimant is not genuinely liable under, or one with an assurance that it will never be enforced against them, invites the "no loss" defence; the client signs because they are liable, and the file says so.',
        'irving-v-morgan-sindall-2018',
      ),
      P(
        'Signature dates must be credible: the e-sign certificate, creation-timestamp floor and duplicate-date alert exist because a backdated agreement is a false document (live-file lesson b).',
        'cpr-32-14',
        'cpr-22-pd-22',
      ),
    ],
    caveats: [],
    forumChecks: [],
  },

  pav: {
    summary:
      'Pre-accident value is what it would cost the claimant to buy an equivalent vehicle: advertised retail prices for the same age, mileage band and specification, not trade value and not the lowest guide. Demand the insurer\'s inputs before arguing its number.',
    points: [
      P(
        'The measure for an uneconomic repair is the market value of an equivalent replacement; for a repairable vehicle it is the reasonable cost of repair (which may differ from the figure the insurer actually paid).',
        'darbishire-v-warran-1963',
        'coles-v-hetherton-2013',
        'burdis-v-livsey-clark-v-ardington-2002',
      ),
      P(
        'First move: demand the valuation basis in writing: which guides, which date, mileage and specification inputs, condition adjustments and why. Wrong trim, wrong mileage and ignored options are each worth hundreds to thousands and are common.',
        'cpr-18-1',
        'fca-icobs-8-1-1r',
      ),
      P(
        'Build comparables: live adverts for equivalent vehicles from dealers within a reasonable radius, captured with URL, date and screenshot, normalised for mileage, with outliers and Cat S/N or ex-fleet vehicles excluded. Advertised prices are the right comparator because they are what replacement costs.',
        'fos-motor-valuations',
        'databases-regs-1997-reg-16',
      ),
      P(
        'Leverage outside a formal complaint: the FOS approach for a policyholder is that guides are the starting point and an insurer should pay the highest guide unless it evidences a lower figure is fair; quote it as industry practice to the at-fault insurer, not as a forum available to the claimant.',
        'fos-motor-valuations',
        'fos-fair-and-reasonable',
      ),
      P(
        'Add the forgotten heads: recovery, storage, unexpired road tax and insurance, personal effects, recent major work with invoices, and interest. A schedule with a source document against every line settles for more.',
        'county-courts-act-1984-s69',
        'cpr-16-4',
      ),
      P(
        'A salvage-retention deduction is negotiated separately and is routinely set high; see the salvage topic.',
        'abi-salvage-code-2025',
      ),
    ],
    caveats: ['Scraping valuation sites is not a feature (Databases Regulations 1997 reg 16): comparables are captured manually with URL, timestamp and hash.'],
    forumChecks: [FORUM_NOT_OPEN],
  },

  total_loss: {
    summary:
      'A total loss decision changes the clocks: hire runs to the payment-plus-response window, storage runs until collect-or-pay, and the money moves to PAV less salvage. Challenge the economics and the valuation together.',
    points: [
      P(
        'Uneconomic repair limits recovery to replacement market value; the engineer\'s repair-versus-PAV arithmetic (repair cost plus projected hire and storage against PAV less salvage) is the document the decision turns on, so get the report dated and in the file early.',
        'darbishire-v-warran-1963',
        'coles-v-hetherton-2013',
      ),
      P(
        'Off-hire after total loss (benchmark): the hire ends after the total-loss payment and the response window; cash in lieu of repair ends hire on receipt, with a re-hire if the vehicle is repaired within three months. Diarise the payment date the day the offer arrives.',
        'gta-4-14',
        'gta-4-7',
      ),
      P(
        'Where the claimant cannot fund a replacement until the insurer pays, the delay is the insurer\'s, but an impecunious claimant with a usable credit facility may still be expected to replace sooner; both cases turn on the chronology and the statement of means.',
        'mattocks-v-mann-1993',
        'opoku-v-tintas-2013',
      ),
      P(
        'Salvage category (A/B/S/N) is set by an Appropriately Qualified Person and recorded on MIAFTR; a Cat S/N marker depresses the PAV comparables and must be disclosed, and the retention deduction is negotiable.',
        'abi-salvage-code-2025',
      ),
      P(
        'Split the heads: an agreed PAV should be paid now while hire is disputed; ask for an interim payment and, if litigated, apply under CPR Part 25 Section V on the admitted head.',
        'cpr-25-interim-payments',
        'cpr-14',
      ),
    ],
    caveats: [GTA_4_14_CAVEAT],
    forumChecks: [GTA_BENCHMARK, FORUM_NOT_OPEN],
  },

  storage: {
    summary:
      'Storage is the first head an insurer caps and the easiest to lose by silence. Put the insurer on notice to collect or pay the day the report issues, invoice at the rate card, and stop the clock when the vehicle moves.',
    points: [
      P(
        'Storage and recovery are recoverable as consequential loss of the damage, measured by what was reasonably incurred; a yard invoice at a published daily rate with dated in/out records is the evidence.',
        'coles-v-hetherton-2013',
        'opoku-v-tintas-2013',
      ),
      P(
        'Clock: once the vehicle is a total loss, put the insurer on written notice to collect the salvage or pay storage from a stated date, using the GTA 4.14 off-hire window as the benchmark timing (live-file lesson: storage capped at report + 48 hours when no notice was sent). The collect-or-pay letter moves the clock to their side.',
        'gta-4-14',
        'mattocks-v-mann-1993',
      ),
      P(
        'Storage past a reasonable repair-funding point is cut along with hire; a claimant who could have had the vehicle repaired or moved should have done so.',
        'opoku-v-tintas-2013',
      ),
      P(
        'The storage and recovery accounts form part of the payment pack and are paid on the same settlement clock as hire (GTA 6.3 / 6.7 benchmark); they are often undisputed, so demand them as split heads.',
        'gta-6-3',
        'gta-6-7',
        'cpr-25-interim-payments',
      ),
      P(
        'Expect the engineer\'s fee and storage to be refused as "not our contract" (live-file File 2): the answer is that they are the claimant\'s loss, invoiced to the claimant and claimed as damages, with the invoices in the pack (GTA 6.3 benchmark contents).',
        'burdis-v-livsey-clark-v-ardington-2002',
        'gta-6-3',
      ),
    ],
    caveats: ['Supplier risk: a storage yard or engineer in strike-off (CARFLEX LTD, 12640635) invites invoice challenges; qualify a second yard and engineer.', GTA_4_14_CAVEAT],
    forumChecks: [GTA_BENCHMARK],
  },

  payment_pack: {
    summary:
      'Debtor days start at the clean pack. Send it the day hire ends, complete, to the right handling centre; a pack missing one item restarts the month and gives the insurer a reason.',
    points: [
      P(
        'Contents (benchmark): covering letter, Mitigation Questionnaire with statement of truth, Advice Form, Hire Period Validation Form, engineer\'s report, storage and recovery accounts, with the hire invoice and agreement. Run the validator before sending.',
        'gta-6-1',
        'gta-6-2',
        'gta-6-3',
        'gta-appendix-c',
      ),
      P(
        'Clock: the settlement month runs from the clean pack reaching the correct handling centre, which is why the handling reference was requested on day 1. Late-payment additions (10% from day 31, 20% from day 61 for hires from 16 March 2026) are quoted as the industry benchmark, not claimed as of right.',
        'gta-6-7',
        'gta-6-8-6',
        'gta-4-2',
      ),
      P(
        'The FCA rules run in parallel and do apply to a non-subscriber: the insurer must handle the claim promptly and fairly and give a reasoned offer or reply within three months of the claim; after that, base + 4% interest.',
        'fca-icobs-8-1-1r',
        'fca-icobs-8-2-6r',
        'fca-icobs-8-2-9r-11r',
      ),
      P(
        'Chaser cadence: day 7 handler, day 14 team leader, day 21 claims manager, day 28 DISP complaint; every step is logged in the ledger so the complaint shows the firm was given its chance.',
        'fca-disp-1-6-2r',
        'fca-icobs-8-1-1r',
      ),
      P(
        'Payee validation: the bank letter, certificate of incorporation, proof of registered office and director ID go to the insurer before the first pack, in the exact registered name, or the payment bounces (live-file File 1).',
        'companies-act-2006-part-6-trading-disclosures',
      ),
    ],
    caveats: [BENCHMARK_FIGURES_CAVEAT, ICOBS_SCOPE_CAVEAT],
    forumChecks: [GTA_BENCHMARK],
  },

  interest: {
    summary:
      'Interest is free money and it is routinely left off. Claim ICOBS base + 4% from the end of the three-month window, s.69 CCA 1984 in the alternative at court, and the Late Payment Act only on business-to-business debts.',
    points: [
      P(
        'If a UK motor insurer makes no reasoned offer within three months of a fully quantified claim it must pay simple interest at Bank of England base rate plus 4% from the date the offer was due until payment. Put it on the schedule the day the window closes.',
        'fca-icobs-8-2-9r-11r',
        'fca-icobs-8-2-6r',
        'fca-glossary-injured-party',
      ),
      P(
        'In court, s.69 County Courts Act 1984 (s.35A Senior Courts Act 1981 in the High Court) gives simple interest at the court\'s rate on each head from the date it fell due; plead it in the particulars with the rate and the daily amount.',
        'county-courts-act-1984-s69',
        'senior-courts-act-1981-s35a',
        'cpr-16-4',
      ),
      P(
        'The Late Payment of Commercial Debts (Interest) Act 1998 (8% over base plus fixed compensation) applies only between businesses, so it is for supplier invoices and fleet clients, not for a consumer claimant\'s damages.',
        'late-payment-act-1998',
      ),
      P(
        'GTA late-payment additions (10%/20%) are a subscriber entitlement; for CCGUK they are a negotiating benchmark alongside the interest claim, never pleaded.',
        'gta-6-8-6',
        'gta-2-7-j',
      ),
      P(
        'A claimant\'s Part 36 offer that is beaten at trial adds enhanced interest of up to 10% over base on the sum awarded; it is the cheapest pressure in the litigation toolkit.',
        'cpr-36',
      ),
    ],
    caveats: [ICOBS_SCOPE_CAVEAT],
    forumChecks: [GTA_BENCHMARK],
  },

  complaint: {
    summary:
      'A DISP 1 complaint to the insurer at day 28 is leverage because complaints are costed and reported; it is not a route to the FOS for a third-party claimant. Cite ICOBS 8.1 and 8.2, state the figures, and set the eight-week clock.',
    points: [
      P(
        'The firm must send a final response within eight weeks of receiving the complaint (or a holding letter explaining why not); the complaint is logged against the handler and the file is reviewed by someone else, which is the point.',
        'fca-disp-1-6-2r',
        'fca-icobs-8-1-1r',
        'fca-icobs-8-2-1r',
      ),
      P(
        'Forum: a third-party claimant has no DISP 2.7.6R relationship with the at-fault insurer (the Rights against Insurers Regulations route is expressly carved out), so the FOS is not open and must not be named; the next step after the final response is the letter before claim.',
        'fca-disp-2-7-6r',
        'fos-eligibility',
        'ec-rights-against-insurers-regs-2002',
      ),
      P(
        'The client can complain to the FOS about their own insurer or broker (courtesy car not provided, repair delay, the credit hire referral and the warnings given), and that complaint has an eight-week then six-month clock and a fair-and-reasonable standard; diarise the six months the day the final response lands.',
        'fos-time-limits',
        'fos-credit-hire-referral',
        'fos-courtesy-car-repairs',
        'fos-fair-and-reasonable',
        'fca-disp-2-8-2r',
      ),
      P(
        'A DSAR for call recordings and claim notes runs in parallel with the complaint when the insurer alleges an ignored offer or late notification; one month, free.',
        'uk-gdpr-art-15',
        'copley-v-lawn-2009',
      ),
      P(
        'Money: the FOS award limit (£455,000 for referrals from 1 April 2026) is far above any CCGUK file; the figure matters only for the client-facing explanation of their own-insurer route.',
        'fos-award-limit-2026',
      ),
    ],
    caveats: ['CCGUK is not FCA-authorised: complaints are drafted for the client to send about their own insurer, and sent in CCGUK\'s own name only about CCGUK\'s own providers.', ICOBS_SCOPE_CAVEAT],
    forumChecks: [FORUM_NOT_OPEN],
  },

  litigation: {
    summary:
      'Litigation is the claimant\'s, drafted here: letter before claim under the Practice Direction, issue with a Part 36 offer, default judgment if they sleep, interim payment on admitted heads. Small claims costs are fixed, which is the whole point.',
    points: [
      P(
        'Pre-action: a compliant letter of claim with the schedule, documents relied on and a reasonable response period (14 days to 3 months depending on complexity), then issue. Non-compliance costs the party that ignored the Practice Direction.',
        'pd-pre-action-conduct',
        'cpr-7-4-7-5',
      ),
      P(
        'Perimeter: conduct of litigation is reserved. Documents are prepared for the claimant as litigant in person or an instructed solicitor to sign; CCGUK may address the court as a lay representative in a small claim only if the claimant attends, and fees for that are capped.',
        'legal-services-act-2007-s12-sch2',
        'lay-representatives-order-1999',
        'cpr-27-14',
      ),
      P(
        'Default judgment under CPR 12.3 if no acknowledgment within 14 days of service of the particulars or no defence within 28 days after acknowledging; the request is the claimant\'s on form N225 and a set-aside is the insurer\'s problem.',
        'cpr-12-3',
        'cpr-15-4-15-5',
        'cpr-13-2-13-3',
      ),
      P(
        'Interim payment on admitted heads (PAV, recovery) under CPR Part 25 Section V; admissions under Part 14 are the trigger.',
        'cpr-25-interim-payments',
        'cpr-14',
      ),
      P(
        'A claimant\'s Part 36 offer at issue, pitched at the walk-away number written down beforehand, puts costs and enhanced-interest consequences on the insurer from day 21; fixed recoverable costs (Part 45) and the small claims regime limit but do not remove the pressure.',
        'cpr-36',
        'cpr-45-frc',
        'cpr-27-14',
      ),
      P(
        'Track and fees: small claims to £10,000, fast track to £25,000; issue fees are banded then 5% above £10,000, hearing fees £27 to £346 on the small claims track. Check the EX50 table carried in court-fees.json before quoting a number.',
        'cpr-26-9',
        'cpr-27-2',
        'pd-27a-7-3',
      ),
      P(
        'Mediation: automatic referral pilots (PD 51ZE, OCMC road-traffic pilot) changed in 2026; confirm the current position before the allocation questionnaire.',
        'pd-51ze-mediation',
        'pd-51r-ocmc-rta',
      ),
      P(
        'Dishonesty exposure: an exaggerated or false claim can be struck out and a false statement of truth is contempt; the file must survive disclosure and cross-examination, which is why intake takes the account cold.',
        'summers-v-fairclough-homes-2012',
        'cpr-32-14',
      ),
    ],
    caveats: ['Limitation: six years in tort from the collision; three years for any injury element (referred out).', COURT_FEES_CAVEAT, MEDIATION_CAVEAT],
    forumChecks: [RESERVED_ACTIVITY, INJURY_PERIMETER],
  },

  costs_exposure: {
    summary:
      'The hire company can be made to pay the insurer\'s costs when a QOCS-protected claim fails and hire dwarfs the other heads. Weak-liability, hire-heavy files are declined or run only on strong evidence; the acceptance engine measures the ratio.',
    points: [
      P(
        'Two-stage test: is the hire company, as a matter of practical and economic reality, the real party or real beneficiary of the litigation (where hire dwarfs the other heads it is, for all practical purposes, the hire company\'s claim); and if so what order is just. Orders of 100% and 65% were made.',
        'tescher-v-daml-axa-v-spectra-2025',
      ),
      P(
        'A non-party costs order against a credit hire company was upheld where the claim was dismissed for fundamental dishonesty and the company controlled the litigation; QOCS protects the claimant, not the funder.',
        'kindertons-v-murtagh-2024',
        'cpr-44-16',
      ),
      P(
        'Money: before accepting, compute hire as a share of total heads, the liability score and the impecuniosity and enforceability readiness; a 591-day or £95,000 hire on a disputed-liability collision is an exposure, not an asset.',
        'zurich-insurance-v-umerji-2014',
        'tescher-v-daml-axa-v-spectra-2025',
      ),
      P(
        'Dishonesty on any head is the fastest route to a costs order: strike-out for abuse, contempt for false statements, and s.57 fundamental dishonesty in injury claims. Take the account cold and reconcile it with the evidence before the hire starts.',
        'summers-v-fairclough-homes-2012',
        'cpr-32-14',
        'cjca-2015-s57',
      ),
      P(
        'Liability evidence is the mitigation of costs exposure: Highway Code rules via RTA 1988 s.38(7), CCTV preservation within days, independent witnesses (checked for connections), and the police report where liability is genuinely disputed.',
        'rta-1988-s38-7',
        'highway-code-rule-126',
        'met-police-collision-report-fees-2026',
      ),
    ],
    caveats: ['Tescher: a further appeal to the UK Supreme Court appears to have been lodged (UKSC 2025/0116); check its status before relying on the Court of Appeal test.'],
    forumChecks: [RESERVED_ACTIVITY],
  },

  pcn: {
    summary:
      'Council PCNs run on 28-day clocks and the burden of proving the contravention is the council\'s. For a hire vehicle, transfer liability to the hirer with the Schedule 2 particulars and a signed statement of liability; for private parking charges, test POFA Schedule 4 compliance line by line and never ignore one.',
    points: [
      P(
        'Clock (TMA 2004 regime): PCN → 28 days to pay or make informal representations (discount usually 14 days) → Notice to Owner → 28 days formal representations → rejection → 28 days to appeal to the tribunal → charge certificate (+50%) → order for recovery → warrant. Diarise each stage on receipt.',
        'tma-2004-part-6',
        'ce-rtc-general-provisions-regs-2022',
        'ce-rtc-representations-appeals-regs-2022',
      ),
      P(
        'Hire vehicle: the hire firm is not liable if the hire agreement contains the Schedule 2 particulars (hirer\'s full name, date of birth, permanent address, licence details, vehicle, hire dates) with a signed statement of liability; CCGUK\'s agreement captures every field at sign-up so the notice.pcn_liability_transfer pack can be sent with a copy.',
        'owner-liability-regs-2000-sch-2',
        'ce-rtc-representations-appeals-regs-2022',
      ),
      P(
        'Grounds that work: contravention did not occur, non-compliant signs or lines, defective PCN content, procedural failure in service, vehicle sold or stolen with evidence, penalty exceeds the applicable amount. Photograph signage and approach sightlines; councils concede these rather than defend them.',
        'ce-rtc-representations-appeals-regs-2022',
      ),
      P(
        'Private parking charges are contract, not statute: keeper liability requires strict POFA Schedule 4 compliance on notice content and timing, and a hire vehicle transfers to the hirer only with the para 13-14 hire documents; appeal to POPLA or IAS is free. Never ignore one — default judgments are what they are built on.',
        'pofa-2012-sch-4-para-13-14',
      ),
      P(
        'Fleet hygiene: PCNs go to the V5C keeper address; a stale address (live-file lesson l) means missed stages and charge certificates. Keeper-address checks are part of fleet compliance.',
        'dvla-v888-fee',
      ),
    ],
    caveats: ['Out-of-time routes (TE7/TE9, PE2/PE3 to the Traffic Enforcement Centre) require a true statement; non-receipt because the keeper record was wrong is a genuine ground, convenience is not.'],
    forumChecks: [],
  },

  nip: {
    summary:
      'A notice of intended prosecution must be served within 14 days of the offence; the s.172 request must be answered within 28 days with the driver\'s identity from the allocation record. "Ignore it" is the worst advice available: failing to respond is 6 points and a fine, usually worse than the offence.',
    points: [
      P(
        'Clock: for scheduled offences no conviction without a warning at the time or a NIP/summons served within 14 days of the offence; check the offence date against the date of service (deemed service to the last known address counts even if returned), not the letter date.',
        'rtoa-1988-s1',
      ),
      P(
        'The keeper must give the driver\'s identity when required; the lawful routes for a fleet are to nominate the actual driver from the allocation records or, where genuinely unknown, run the s.172(4) reasonable-diligence defence with the records and enquiries documented. Nominating someone who was not driving is perverting the course of justice.',
        'rta-1988-s172',
        'perjury-act-1911-s5',
      ),
      P(
        'Hire vehicle: the hire agreement\'s Schedule 2 particulars identify the hirer as the person to be named; the s172 response template draws the hirer\'s details from the agreement, never from memory.',
        'owner-liability-regs-2000-sch-2',
      ),
      P(
        'Driving-conviction data is criminal-offence data: holding it for fleet drivers needs an appropriate policy document and a lawful basis.',
        'dpa-2018-sch-1',
        'uk-gdpr-art-10',
      ),
      P(
        'Related duties: stop and report after a collision (s.170), produce insurance (s.165, s.154) and the insurance requirement itself (s.143) are the questions a police enquiry asks alongside identity.',
        'rta-1988-s170',
        'rta-1988-s165',
        'rta-1988-s154',
        'rta-1988-s143',
      ),
    ],
    caveats: ['Whatever the outcome the fleet needs a driver-allocation record; that is the system that prevents the next one.'],
    forumChecks: [],
  },

  dsar: {
    summary:
      'The DSAR is the workhorse: one month, free, and it tests the insurer\'s allegation (ignored offer, late call, fraud suspicion) against its own recordings and notes. Draft it wide and specific; answer the standard evasions; ICO at day 31.',
    points: [
      P(
        'Right of access: confirmation, a copy of the personal data and the purposes, recipients, retention and source, within one month (extendable by two for complex requests). Ask specifically for call recordings, claim notes, intervention logs, engineer instructions, fraud-investigation files and third-party disclosures.',
        'uk-gdpr-art-15',
        'uk-gdpr-art-13-14',
      ),
      P(
        'Evasions and answers: privilege is narrow (demand a schedule of what is withheld and why); the crime-prevention exemption is purpose-limited and item by item; third-party redaction covers identities, not the substance of decisions about the client; silence is an ICO complaint on day 31, said in advance.',
        'uk-gdpr-art-15',
        'uk-gdpr-art-5',
      ),
      P(
        'Since the 2025 Act the controller\'s search need only be reasonable and proportionate and the clock can stop for clarification; and controllers must run a complaints process the ICO expects to see used first (s.103, in force 19 June 2026). Build the complaint step into the sequence rather than being surprised by it.',
        'duaa-2025',
        'duaa-2025-commencement-2026',
      ),
      P(
        'Accuracy, rectification, erasure and objection (Arts 5(1)(d), 16, 17, 21) are the grounds when the insurer\'s record about the client is wrong (a "fraud" flag, an "ignored offer" note); compensation for distress is a court claim under Art 82, kept separate from the ICO route.',
        'uk-gdpr-art-16',
        'uk-gdpr-art-17',
        'uk-gdpr-art-21',
        'uk-gdpr-art-82',
      ),
      P(
        'CCGUK\'s own side: obtaining personal data without the controller\'s consent is an offence (DPA 2018 s.170), the ICO fee is tier 1 (£52) and the call-recording disclosure at intake is the lawful basis for our own recordings.',
        'dpa-2018-s170',
        'ico-data-protection-fee',
        'uk-gdpr-art-6',
      ),
    ],
    caveats: ['The DSAR is made by the data subject (the client) or by CCGUK with the client\'s written authority; the insurer may insist on identity checks before the clock starts.'],
    forumChecks: [],
  },

  salvage: {
    summary:
      'Salvage is a negotiation inside the total loss: the category is set by an Appropriately Qualified Person under the ABI Code, the deduction for retention is routinely set high, and a Cat S/N marker must be disclosed in PAV comparables.',
    points: [
      P(
        'Categories A (scrap, crush), B (break for parts), S (repairable, structural) and N (repairable, non-structural) are assigned by an AQP who takes responsibility in a dispute, notified to DVLA and recorded on MIAFTR; the 2025 Code brings EVs and high-voltage batteries within scope.',
        'abi-salvage-code-2025',
      ),
      P(
        'Where the client keeps the vehicle, negotiate the salvage deduction separately from PAV with evidence of salvage market value for that category; do not accept a percentage.',
        'abi-salvage-code-2025',
        'darbishire-v-warran-1963',
      ),
      P(
        'A Cat S/N history depresses value and is excluded from PAV comparables for an unrecorded vehicle; equally, if the client\'s vehicle had a marker, the PAV reflects it. Record the category, AQP and source; CCGUK does not write to MIAFTR.',
        'abi-salvage-code-2025',
        'fos-motor-valuations',
      ),
      P(
        'Storage of the salvage is for the insurer\'s account from the collect-or-pay date (GTA 4.14 off-hire window as the benchmark); the salvage buyer\'s collection date closes the storage account.',
        'gta-4-14',
      ),
    ],
    caveats: [GTA_4_14_CAVEAT],
    forumChecks: [GTA_BENCHMARK],
  },

  fleet: {
    summary:
      'Fleet compliance is the hire head\'s foundation and the PCN/NIP defence: MOT, tax, insurance class of use, keeper address and PHV eligibility checked before a unit goes out, with a driver-allocation record for every day.',
    points: [
      P(
        'Class of use: a unit insured for self-drive hire cannot be used for credit hire (or vice versa) without cover for that use; the fleet policy requires a fair presentation of the risk, and a misdescribed use is a declinature on the day it matters.',
        'insurance-act-2015-fair-presentation',
        'rta-1988-s143',
      ),
      P(
        'A vehicle without a valid MOT at the time of a collision can defeat the loss-of-use claim; MOT, tax and insurance are checked against the DVSA/DVLA record before allocation and the results logged.',
        'ali-v-hsf-logistics-polska-2024',
      ),
      P(
        'London PHV: every vehicle licensed as a London PHV for the first time must be zero-emission capable and Euro 6; neither current unit qualifies, so PCO allocation is blocked for non-ZEC units.',
        'tfl-phv-zec-rule',
        'phv-london-act-1998',
      ),
      P(
        'Penalties: PCNs and NIPs follow the V5C keeper address and the hire agreement\'s Schedule 2 particulars; a stale address or a missing field means the fleet, not the hirer, pays.',
        'owner-liability-regs-2000-sch-2',
        'rta-1988-s172',
        'rtoa-1988-s1',
      ),
      P(
        'Cross-file hygiene: a fleet unit must never appear as a "client vehicle" on a claim and the same registration must never sit on two live files (live-file lessons f and h); the registration check is a hard stop.',
        'cpr-32-14',
      ),
      P(
        'Fleet client debts are business-to-business: the Late Payment Act interest and fixed compensation apply to those invoices, unlike consumer hire.',
        'late-payment-act-1998',
      ),
    ],
    caveats: ['Collingwood will not cover credit hire and self-drive together (LEGAL-CAVEATS item 15); check the policy wording per use before allocation.'],
    forumChecks: [],
  },
};

function isKnownTopic(topic: string): topic is AdviceTopic {
  return (ADVICE_TOPICS as readonly string[]).includes(topic);
}

const COMMON_CAVEAT =
  'Citations carry their own verification; nothing in this knowledge base is marked verified until a human records a source URL and date. Unverified citations are listed and must be checked before a document relies on them.';

function finish(topic: string, spec: TopicSpec): Advice {
  const cited = spec.points.flatMap((p) => p.citations);
  const index = entryIndex();
  const unknown = [...new Set(cited)].filter((id) => !index.has(id));
  const caveats = [...spec.caveats];
  if (unknown.length) caveats.push(`Unknown knowledge-base ids cited: ${unknown.join(', ')}.`);
  caveats.push(COMMON_CAVEAT);
  return {
    topic,
    summary: spec.summary,
    points: spec.points.map((p) => ({ text: p.text, citations: [...p.citations] })),
    caveats,
    forumChecks: [...spec.forumChecks],
    unverifiedCitations: unverifiedAmong(cited),
  };
}

/** Points assembled from search when no curated playbook exists for the topic. */
function searchFallback(topic: string): TopicSpec {
  const hits = search(topic.replace(/_/g, ' '), { limit: 8 });
  const points = hits.map((h) => P(`${h.entry.title}: ${h.entry.principle}`, h.entry.id));
  return {
    summary: hits.length
      ? `No curated playbook for '${topic}'. The points below are the closest knowledge-base entries, ranked by relevance; each is the entry's own principle and must be read with its verification status.`
      : `No curated playbook for '${topic}' and no knowledge-base entry matched it.`,
    points,
    caveats: ['Search-assembled advice has no stance applied: check burden, clock and money before acting on it.'],
    forumChecks: [],
  };
}

/**
 * Cited guidance for a topic. Known topics return the curated playbook; any other string falls back to a
 * search-assembled list. Every cited id is checked against the KB and listed in `unverifiedCitations` unless
 * its verification is 'verified'.
 */
/** Common handler words mapped onto the curated topics, so "fos" or "ombudsman" get the complaint playbook and its forum check. */
export const TOPIC_ALIASES: Readonly<Record<string, AdviceTopic>> = {
  fos: 'complaint',
  ombudsman: 'complaint',
  financial_ombudsman: 'complaint',
  complaints: 'complaint',
  disp: 'complaint',
  basic_hire_rate: 'bhr',
  rate: 'bhr',
  offer: 'mitigation',
  intervention: 'mitigation',
  courtesy_car: 'mitigation',
  impecunious: 'impecuniosity',
  hire_period: 'period',
  valuation: 'pav',
  write_off: 'total_loss',
  payment: 'payment_pack',
  pack: 'payment_pack',
  court: 'litigation',
  proceedings: 'litigation',
  non_party_costs: 'costs_exposure',
  s172: 'nip',
  parking: 'pcn',
  subject_access: 'dsar',
};

/** Forum and perimeter checks that must accompany any advice whose topic text touches these words. */
function keywordForumChecks(key: string): string[] {
  const out: string[] = [];
  if (/fos|ombudsman|complain|disp/.test(key)) out.push(FORUM_NOT_OPEN);
  if (/gta|rate|credit_hire|bhr/.test(key)) out.push(GTA_BENCHMARK);
  if (/litig|court|proceed|part_?36|judgment|claim_form/.test(key)) out.push(RESERVED_ACTIVITY);
  if (/injur|whiplash|personal_injury/.test(key)) out.push(INJURY_PERIMETER);
  return out;
}

export function advise(topic: AdviceTopic | string): Advice {
  const key = topic.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const resolved = isKnownTopic(key) ? key : TOPIC_ALIASES[key];
  const advice = resolved ? finish(resolved, TOPICS[resolved]) : finish(key, searchFallback(key));
  for (const check of keywordForumChecks(key)) if (!advice.forumChecks.includes(check)) advice.forumChecks.push(check);
  return advice;
}

/** The entries cited by a piece of advice, in first-citation order (for rendering a sources list). */
export function citedEntries(advice: Advice): KbEntry[] {
  const index = entryIndex();
  const out: KbEntry[] = [];
  const seen = new Set<string>();
  for (const p of advice.points) {
    for (const id of p.citations) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = index.get(id);
      if (e) out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Get-paid-faster plan (BLUEPRINT §7)
// ---------------------------------------------------------------------------

function timingText(rule: PlaybookRule): string {
  const anchor = rule.due?.from.replace(/_/g, ' ') ?? '';
  if (!rule.due) return rule.trigger;
  switch (rule.due.kind) {
    case 'immediate':
      return `immediately on ${anchor}`;
    case 'working_days':
      return `within ${rule.due.n} working day${rule.due.n === 1 ? '' : 's'} of ${anchor}`;
    case 'calendar_days':
      return rule.due.n === 0 ? `on ${anchor}` : `day ${rule.due.n} after ${anchor}`;
    case 'calendar_months':
      return `${rule.due.n} calendar month${rule.due.n === 1 ? '' : 's'} after ${anchor}`;
  }
}

/**
 * The ordered get-paid-faster plan: every playbook rule in `order`, with its BLUEPRINT §7 step, timing,
 * citations, template and the citations that are not yet verified.
 */
export function getPaidFasterPlan(rules: readonly PlaybookRule[] = loadPlaybookRules()): PaidFasterStep[] {
  return [...rules]
    .sort((a, b) => a.order - b.order)
    .map((rule, i) => ({
      step: i + 1,
      blueprintStep: rule.blueprintStep,
      code: rule.code,
      title: rule.title,
      why: rule.why,
      timing: timingText(rule),
      citations: [...rule.basis],
      templateId: rule.templateId,
      benchmarkOnly: rule.benchmarkOnly === true,
      unverifiedCitations: unverifiedAmong(rule.basis),
    }));
}

/** BLUEPRINT §7 step headings, for grouping the plan in the UI. */
export const BLUEPRINT_STEP_TITLES: Readonly<Record<number, string>> = {
  1: 'Day 1: NCAF and handling reference; start the ICOBS clock',
  2: 'Days 1-7: CCTV, dashcam, witnesses, police report; injury referred out',
  3: 'Clean payment pack as soon as hire ends',
  4: 'Split heads of claim; interim payment',
  5: 'Complaint escalation (DISP 1) and DSAR',
  6: 'Litigation levers: Part 36, default judgment, interest',
  7: 'Vendor onboarding and bank validation',
  8: 'Chaser cadence: day 7, 14, 21, complaint at day 28',
};
