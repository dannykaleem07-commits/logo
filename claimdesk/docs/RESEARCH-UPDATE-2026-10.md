# Knowledge base research update: October 2026

Date: 7 October 2026. Scope: `packages/kb/data/*.json`. Four topic researchers worked on it (GTA, insurers, legal, ops), and a separate validator checked their work afterwards.

## Read this first

**Nothing was marked `verified`.** In this sandbox the official sites (gov.uk, legislation.gov.uk, BAILII, Find Case Law, FOS, the FCA Handbook, justice.gov.uk, gtacredithire.com and insurer sites) could not be fetched. All the new evidence is search-result titles, URLs and snippets or summaries. Every entry that was touched still has `verification.status: "unverified"`, `verifiedAt: "2026-10-07"` and `verifiedBy: "research-agent (search snippet)"`. Each `sourceNote` says what the snippet showed and that it was not a fetched page. A person should open each source URL on the owner's PC before any entry is upgraded to `verified` (see the "To check" section).

Rules the researchers followed:

- A value was changed only when a snippet from an authoritative source (the official site or the body itself), or two independent reputable sources, clearly showed the current figure.
- No phone numbers, emails, IVR options, citations, rule numbers or rates were invented.
- The service-perimeter rules still apply:
  - GTA is a benchmark only, because CCGUK is not a subscriber.
  - FOS is never mentioned to at-fault insurers.
  - Personal injury is referred out with no fee.

## Validation results

| Check | Result |
|---|---|
| All `packages/kb/data/*.json` parse and pass the kb loaders and validators | Pass |
| `pnpm --filter @ccguk/kb typecheck` | Pass |
| `pnpm --filter @ccguk/kb test` | 239 passed, 1 skipped (after the two test updates below) |
| `pnpm --filter @ccguk/domain test` | 967 passed |
| `pnpm --filter @ccguk/api test` | 477 passed, 1 failed: `src/test/queue.test.ts` > "a thrown error and a timeout are retried as failed attempts". It also fails when run on its own. That test covers job-queue retry logic, does not read kb data, and is in an area another build is changing at the same time. It is not caused by this update. |

### Test assertions updated (kb only)

Each of these tests pinned a count that the research changed on purpose and correctly:

- `packages/kb/src/gtaRates.test.ts`
  - The 2026-27 group list now includes `'S4'` after `'S3'`.
  - `ratesForPeriod('2026-27')` now has length 10 (it was 9).
  - Reason: the S4 2026-27 row was added (see below).
- `packages/kb/src/directory.test.ts`
  - The shipped directory now has 55 entries and 55 unique ids (it had 49).
  - Reason: six insurers and handlers were added on purpose (saga, qbe-uk, adrian-flux, swinton, endsleigh-howden, crawford-uk).
  - The assertion that no entry is `verified` is unchanged and still passes.

### Validator reverts

I spot-checked 18 changes against their evidence: S4, S1, S3, gta-5-3, Ageas (both numbers), INSHUR, Tesco, Hiscox, Direct Line, Tescher, cpr-26-9, cpr-45-frc, uk-gdpr-art-15, cjca-2015-s57, fos-professional-representative-case-fee, companies-house-public-data-api and mib-v-houston-2025. Five did not meet the evidence rule and were put back. Each reverted entry's `sourceNote` now ends with a "VALIDATOR 2026-10-07" line.

| File / entry | Proposed by researcher | Why reverted | Now |
|---|---|---|---|
| cases.json `tescher-v-daml-axa-v-spectra-2025` | Principle said the Supreme Court refused permission to appeal; tag changed to "Supreme Court permission refused (check)" | The refusal appeared only in the search tool's own summary of the supremecourt.uk page. The researcher never saw the page's wording. | Original caution restored: "a further appeal ... appears to have been lodged (UKSC 2025/0116); check its status". Original tag "Supreme Court pending" restored. |
| cpr.json `cpr-26-9` | Principle sentence: the CJC announced a review of track limits in June 2026 | The only source is one blog (Kerry Underwood, 23 June 2026). It is not official and no second source confirmed it. | Principle as before. The finding is kept in the sourceNote and listed under To check. |
| gta-rates.json S3 (2026-27) | Description added "Vauxhall Astra 1.4" | The snippet printed no group code beside the Astra. It was placed in S3 only because the £51.18 rate matches. | Description back to "e.g. Toyota Corolla". Rate unchanged (5118). |
| insurer-directory.json `ageas-uk.policyholderClaimsPhone` | 0345 122 3018 | The search was run for the number itself, and no quoted snippet printed it as Ageas's motor claims line. | Field removed. The number is kept in notes as "to confirm". Third Party Assist 01452 626649 is kept, because it is quoted from the ageas.co.uk/claims/tpa/ snippet. |
| insurer-directory.json `inshur.policyholderClaimsPhone` / `claimsEmail` | 0808 169 9165 / help@inshur.com | The only source is a 2022 inshur.com blog post, so it does not show the current figure. | Both fields removed. The details are kept in notes as "to confirm". |

## Changes kept (before → after, source)

### GTA (`gta-rates.json`, `gta.json`)

| Entry | Before → after | Source |
|---|---|---|
| gta-rates S1 2026-27 | Rate 4232 unchanged. "Nissan Micra 1.0 per a search snippet" added to the description. | https://www.gtacredithire.com/rates/car-hire/ (snippet: "Group S1 ... Nissan Micra (1.0) ... £42.32 for the 2026-27 period") |
| gta-rates CP2 2025-26 | Rate 7334 unchanged. Examples added to the description: Ford Ranger Double Cab 2.5, Toyota Hilux Extended Cab. | https://www.gtacredithire.com/rates/commercial/ |
| gta-rates CP1 2025-26 | Rate 6464 unchanged; note only. A snippet again labels it 2025-26, and no 2026-27 figure was found. | https://www.gtacredithire.com/rates/commercial/ |
| gta-rates PV2 2025-26 | Rate 5513 unchanged; note supports the 2025-26 attribution. | https://www.gtacredithire.com/rates/commercial/ |
| gta.json `gta-5-4` | Figures unchanged (£5.50 a day, £110 cap, £148.50 for bikes); note only. The dual-control add-on is recorded in the note only, because it comes from the 2021 wording. | https://www.gtacredithire.com/wp-content/uploads/2026/02/GTA_new_wording_10_02_26-v11.1-FINAL-Clean-1.pdf |
| gta.json `gta-rates-2026-27` | Principle unchanged. Note records the re-check; the single-snippet F1, F2, P1 and S5 figures are expressly not recorded. | https://iloveclaims.com/motor_claims/new-credit-hire-rates-for-gta/ ; Insurance Times EV article |

### Insurer directory (`insurer-directory.json`)

None of these entries is `verified`. Every number below was read from a search snippet or summary of the insurer's own domain.

| Entry | Before → after | Source |
|---|---|---|
| admiral | 0333 220 2047 unchanged; now backed by a snippet. Anti-copycat page noted. | https://www.admiral.com/existing-customers/make-a-claim.php/motor |
| aviva | portalUrl: none → third-party claim form (reply within 48 working hours) | https://www.aviva.co.uk/help-and-support/claims/third-party-claim |
| direct-line-group | Policyholder line: none → 0345 303 1714 (Mon-Fri 8am-9pm, Sat 9am-5pm, Sun 11am-5pm). Portal: Churchill "Third Party Vehicle Solutions" (a capture offer). "Green Flag" added to brands. | https://www.directline.com/claims/car-common-questions ; https://www.churchill.com/car-insurance/claims/third-party |
| lv | none → 0330 678 5550, 24/7; portal is the claims FAQ | https://www.lv.com/car-insurance/car-faqs/how-do-i-make-a-claim-on-my-car-insurance |
| axa-uk | none → 0330 024 1305, 24/7 | https://www.axa.co.uk/car-insurance/make-a-claim/ |
| ageas-uk | Third-party line: none → 01452 626649, Third Party Assist (a capture service), Mon-Fri 8am-7pm, Sat 9am-5pm. Single snippet; confirm before first use. | https://www.ageas.co.uk/claims/tpa/ |
| zurich-uk | none → 0800 055 6767 and commercialmotorclaims@uk.zurich.com (business/commercial motor) | https://www.zurich.co.uk/business-insurance/claims/motor-claims (PDF snippets) |
| covea-insurance | none → 0330 024 2240 (Personal Motor) | https://www.coveainsurance.co.uk/make-a-claim/ |
| nfu-mutual | none → 0800 282 652, 24 hours (Claim Notification Line) | nfumutual.co.uk Motor Insurance Claims Guide |
| 1st-central | Third-party line: none → 0333 043 2011, 24/7 (a capture service) | https://help.1stcentralinsurance.com/motor/claims/i-ve-had-a-car-accident-with-a-1st-central-customer-how-do-i-make-a-claim |
| markerstudy | none → 0344 873 8184, 24 hours | https://www.markerstudy.com/policyholders/guidance/how-to-make-a-claim |
| tradex | none → 0333 313 3131 (First Response) | https://www.tradex.com/my-policy/how-to/notify-tradex-of-a-claim |
| collingwood | none → 0345 370 0008, 24 hours; sourceUrl changed from collingwoodinsurance.co.uk/claims to collingwood.co.uk/claims | https://www.collingwood.co.uk/claims |
| marshmallow | none → 0800 060 8622, 24/7 (policyholders) | https://intercom.help/marshmallow/en/articles/1660659-how-do-i-report-an-accident-for-my-claim |
| zego | portalUrl added (third-party route); no number recorded | https://help.zego.com/en/articles/567925-how-do-i-make-a-claim-against-a-zego-driver |
| cuvva | portalUrl added; underwriter lines (Wakam/Crawford, ERS/Crawford) in notes only | https://support.cuvva.com/en/articles/89942-how-to-report-an-incident |
| by-miles | none → 0330 088 3838, 24/7, plus a wind-down note (no new quotes from 26 Nov 2025, no renewals from 6 Jan 2026; UKIL still pays claims) | https://help.bymiles.co.uk/hc/en-us/articles/18111364673437 |
| hiscox-uk | none → 0800 840 2405. The earlier recalled note "does not write motor" was corrected. | https://www.hiscox.co.uk/existing-customers/motor-insurance |
| tesco-bank-insurance | none → 0345 677 3377, 7 days. portalUrl moved to tescoinsurance.com. | https://www.tescoinsurance.com/car-insurance/making-a-claim |
| sainsburys-bank-insurance | none → 0344 600 9021, 24 hours. portalUrl moved to money.sainsburys.co.uk. | https://money.sainsburys.co.uk/support/car-insurance/faqs/make-a-claim |
| allianz-commercial | Email: none → claims.start@allianz.co.uk (commercial motor). portalUrl → third-party page. | https://www.allianz.co.uk/broker/documents-and-tools/claims/third-party.html |
| esure, hastings-direct, sabre, highway, veygo, mib | Notes and verification only; no values changed. The esure number conflict is noted. | see each entry's sourceNote |

### Legal (`cases.json`, `cpr.json`, `fos.json`, `fca.json`, `statutes.json`, `guidance.json`, `court-fees.json`)

| Entry | Before → after | Source |
|---|---|---|
| cases `mib-v-houston-2025` | url: none → Find Case Law. Licence: link_only → Open Justice Licence. Principle adds "Cavanagh J (judgment 2 December 2025)". | https://caselaw.nationalarchives.gov.uk/ewhc/kb/2025/3178 |
| cases `zurich-insurance-v-umerji-2014` | "about £95,130" → "£95,130.14 (about £161 a day)"; full bench added | https://caselaw.nationalarchives.gov.uk/ewca/civ/2014/357 |
| cases `pattni-...-bent-2011`, `mcbride-...-2017`, `armstead-v-rsa-2024` | sourceNote only (conjoinders corroborated; the Bent v Highways [2011] EWCA Civ 1539 mix-up warning added) | Find Case Law; Parklane Plowden |
| cpr `cpr-45-frc` | Principle adds: tables uprated (reported as 3.2%) from 6 April 2024; MoJ review reported for October 2026; a claim stays on the table in force at its issue date | https://dwfgroup.com/en/news-and-insights/insights/2025/6/fixed-costs-transitional-provisions (plus TMC Legal and 39 Essex; secondary sources) |
| cpr `pd-51r-ocmc-rta` | Title and principle rewritten: OCMC mandation from 28 July 2025; 12-month mediation pilot for defended non-PI RTA claims under £10,000 on OCMC; PD 51ZE covers bent-metal claims from 1 October 2026 | https://ccua.org.uk/wp-content/uploads/2025/08/OCMC-mandation-letter-Update-to-PD51R58.pdf ; LexisNexis; DWF; DAC Beachcroft |
| cpr `pd-51ze-mediation`, `cpr-46-5-pd-46-3-4`, `pd-27a-7-3`, `cpr-25-interim-payments`; fca `fca-disp-1-6-2r` | Re-check note only; values unchanged | justice.gov.uk / legislation.gov.uk listings |
| fos `fos-award-limit-2026` | £455,000 / £205,000 unchanged; sourceUrl → FOS news item | https://www.financial-ombudsman.org.uk/news/fca-confirms-increase-award-limits-2 |
| fos `fos-time-limits` | Limits unchanged. Adds: HM Treasury (16 March 2026) will legislate for a 10-year absolute longstop; the current limits apply until that is in force. | https://assets.publishing.service.gov.uk/media/69b4301efdbfc4d58fc8cf64/Consultation_Response_FOS_Reform_March_2026.pdf |
| statutes `cjca-2015-s57` | **Corrected.** The old text said a "related claim includes a credit hire or vehicle damage claim". Now: the primary claim is dismissed in full (honest heads too, so hire and vehicle-damage heads in the same proceedings fall with it); the order records the damages that would have been awarded; a "related claim" is another person's claim from the same incident. | https://www.legislation.gov.uk/ukpga/2015/2/section/57 |
| statutes `uk-gdpr-art-15` | Adds Article 12A (from 5 February 2026): the month runs from the "relevant time", the clock stops while awaiting clarification, and the search need only be reasonable and proportionate | https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/subject-access-requests/a-guide-to-subject-access/ |
| statutes `fsma-2000-s19`, `duaa-2025` | sourceUrl added (legislation.gov.uk); wording unchanged | https://www.legislation.gov.uk/ukpga/2000/8/section/19 ; https://www.legislation.gov.uk/ukpga/2025/18/contents |
| guidance `mib-uninsured-drivers-agreement-2015` | Adds the 2017 Supplementary Agreement (in force 1 March 2017) and the June 2025 government decision to reintroduce the uninsured-driver property-damage exclusion (check whether it is in force) | mib.org.uk 2017 supplementary agreement PDF; https://www.gov.uk/government/consultations/removal-of-uninsured-drivers-access-to-property-damage-compensation/outcome/government-response-to-exclusion-of-uninsured-drivers-from-property-damage-compensation |
| court-fees (all 18 rows) | No fee changed; re-check note only | gov.uk "Court and tribunal fees: updates from July 2026"; EX50A listing |

### Ops (`guidance.json`)

| Entry | Before → after | Source |
|---|---|---|
| `askmid-one-off-search-fee` | Fee £10.00 unchanged. Adds what the enquirer needs: the accident date, the other vehicle's registration and their own vehicle details. | https://mib.org.uk/check-insurance-details/check-a-vehicle-not-at-the-roadside-after-an-accident |

## Additions (all `unverified`)

| File | Entry | Summary | Source |
|---|---|---|---|
| gta-rates.json | S4 2026-27 | 5488 pence (£54.88) a day, 1 July 2026 to 30 June 2027. Three separate snippets gave the same figure, and it sits between S3 and S6. The example vehicles differed between snippets. | https://www.gtacredithire.com/rates/car-hire/ |
| gta.json | `gta-4-6` | The hire period starts when the customer both needs and takes delivery of the replacement vehicle (quote_only) | GTA 16 March 2026 wording PDF |
| gta.json | `gta-5-3` | The daily settlement rate is per 24 hours and includes delivery and collection, breakdown cover, unlimited mileage and insurance (quote_only) | GTA 16 March 2026 wording PDF |
| insurer-directory.json | `saga` | Routes "M..." policies to Ageas; no phone recorded | https://www.saga.co.uk/insurance/ageas-claims |
| insurer-directory.json | `qbe-uk` | 0808 100 8181 (24/7); newclaim.motor@uk.qbe.com; NI number in notes | https://qbeeurope.com/claims/reporting-a-motor-incident |
| insurer-directory.json | `adrian-flux` (broker) | 0344 381 4420 (24/7) | https://customers.adrianflux.co.uk/claims/ |
| insurer-directory.json | `swinton` (broker) | 0333 035 9003 (24 hours) | https://www.swinton.co.uk/car-insurance/contact/claims |
| insurer-directory.json | `endsleigh-howden` | 0333 234 1663 (Mon-Fri 9am-5pm; hours conflict, see To check) | https://www.howdengroup.com/uk-en/endsleigh-claims |
| insurer-directory.json | `crawford-uk` (TPA) | 0141 229 7500; claimsalert@crawco.co.uk; complaints customer.services@crawco.co.uk | https://uk.crawfordandcompany.com/contact-us.aspx |
| cpr.json | `cpr-26-9-rta-pi-small-claims` | RTA PI small-claims limits (£5,000 PSLA / £10,000 total; £1,000 where the CPR 26.10 exceptions apply). Perimeter: refer out, no fee. | justice.gov.uk RTA Small Claims Protocol; legislation.gov.uk r.26.9 |
| statutes.json | `rta-1988-s152` | Since 1 November 2019 only a pre-accident declaration relieves the insurer under s.151 | https://www.legislation.gov.uk/ukpga/1988/52/section/152 ; SI 2019/1047 reg 6 |
| statutes.json | `civil-liability-act-2018-whiplash` | Tariff rose about 15% for injuries on or after 31 May 2025. No tariff figures recorded; perimeter: refer out. | https://www.officialinjuryclaim.org.uk/news/revised-whiplash-tariff-now-approved/ |
| fos.json | `fos-professional-representative-case-fee` | £250 a case after 10 free cases a year, from 1 April 2025; £175 refunded if the outcome favours the consumer | https://www.financial-ombudsman.org.uk/news/financial-ombudsman-service-start-charging-professional-representatives-refer-cases |
| fca.json | `fca-cmcob-4-pre-contract` | CMCOB 4 pre-contract requirements (alternatives, written confirmation). CCGUK is outside the perimeter. No rule number invented. | https://www.handbook.fca.org.uk/handbook/CMCOB.pdf |
| guidance.json | `dvla-vehicle-enquiry-service-api` | Endpoints, x-api-key, 429 handling; no numeric rate limit is published | DVLA developer portal (VES description) |
| guidance.json | `dvsa-mot-history-api` | OAuth client credentials; tokens last 60 minutes; key revoked after 90 days unused; client secret expires every 2 years | https://documentation.history.mot.api.gov.uk/mot-history-api/authentication/ |
| guidance.json | `companies-house-public-data-api` | 600 requests per 5 minutes, then 429; identity_verification_details from 18 November 2025 | https://developer-specs.company-information.service.gov.uk/guides/rateLimiting |

## To check on the owner's PC (open the real pages)

### Highest priority (affects advice or money)

1. **Tescher v DAML / AXA v Spectra:** open https://www.supremecourt.uk/cases/uksc-2025-0116 and /uksc-2025-0117. Was permission to appeal refused, and on what date? If so, update the case principle.
2. **Court fees after the 13 July 2026 uplift** (SI 2026/642): no snippet showed new banded issue fees (£35-£455) or small-claims hearing fees (£27-£346). Check the EX50 table at https://www.gov.uk/government/publications/fees-in-the-civil-and-family-courts-main-fees-ex50/civil-court-fees-ex50 before the quantum engine relies on them. Application fees £321/£126 and the fast-track hearing fee of £619 were corroborated.
3. **GTA 2026-27 rows not yet held:** S5, F1, F2, P1-P4, M4, CP1, CP2, PV1-PV3, Luton, minibus, private hire/taxi and motorcycle B1-B6. Single-snippet candidates were deliberately not recorded: S5 £58.05 (conflicting), F1 £112.10, F2 £111.74 (lower than F1, suspicious) and P1 £84.61. Pages: https://www.gtacredithire.com/rates/car-hire/, /rates/commercial/, /rates/private-hire-taxi/, /rates/motorcycle/. Also confirm the S4 examples and the Vauxhall Astra's group.
4. **GTA wording:** confirm that the dual-control add-on (£12 a day, or £7 a day without insurance) is in the 16 March 2026 PDF under para 5.4; whether any automatic-transmission add-on still exists; whether 25 June 2026 is the approval date or only the announcement date; and the "£50 + VAT combined fee" snippet (not recorded).
5. **CPR 26.9 track limits:** look for an official CJC or MoJ paper on the reported June 2026 review (the only source so far is Kerry Underwood's blog).
6. **FRC uprating (3.2% from 6 April 2024) and an MoJ review in October 2026:** check the PD 45 Tables 12 and 14 on justice.gov.uk.
7. **DISP 1.6:** secondary sources say that from 1 June 2026 acknowledgements must state the date of the final response (FCA PS25/18). Check the Handbook and the 8-week clock template.
8. **MIB property-damage exclusion** for uninsured claimants: is it now in the Uninsured or Untraced Drivers Agreements, and from what date?

### Insurer numbers to confirm before first use

- Ageas: Third Party Assist 01452 626649 (one snippet; the Gloucester area code is unexpected) and policyholder line 0345 122 3018 (removed by the validator). Age Co 0345 601 6687.
- INSHUR: 0808 169 9165 and help@inshur.com (removed by the validator; the only source is from 2022).
- esure: 0345 603 7970 (24/7 car claims) or the held 0345 603 7872. Open https://www.esure.com/need-further-help.
- LV= third-party line 0330 678 5888 (seen on aggregators only).
- Zego third-party line 020 3885 0622 (unattributed).
- Highway third-party line 0330 678 5552 (seen only on the lifesure.co.uk broker page).
- Haven: 0113 487 1074 or 0345 092 0700.
- Churchill 0345 603 3590, Privilege 0345 246 8539 or 0345 878 5222, Green Flag 0800 051 0636, MORE THAN 0800 300 252, Co-op 0345 999 8888, Policy Expert, GoSkippy: all seen on aggregators only.
- Allianz third-party contacts (0370 606 4912; 0344 893 9598 options; customerclaims@allianz.co.uk; Wigston PO Box).
- Covéa motor trade and fleet lines; older Tradex First Response details.
- Endsleigh hours: Mon-Fri 9am-5pm (Howden) or 24/7 (aggregators).
- MIB email: the held contact@mibclaims.org.uk was not seen. The snippets show enquiries@mib.org.uk.
- Not found anywhere: Probus, Watford, Tesla UK, Sedgwick, Davies, Claims Consortium, the Sabre and Hastings third-party lines, and any IVR options.
- By Miles: retire the entry once all policies have expired (around early 2027).

### Legal citations

- Giles v Thompson: find the HL judgment link.
- Stevens v Equity Syndicate: check [2015] 4 WLR 24.
- McBride: check [2017] RTR 27.
- Armstead: the [2025] AC 406 citation came from Wikipedia; check it on ICLR.
- Pattni / Bent: is the "(No 2)" label correct?
- UK GDPR Art 12A: check that it was inserted by DUAA 2025 s.76(3).
- RTA s.152(1): the exceptions were not summarised; read the section.
- FOS: is a non-upheld professionally represented complaint now £475?

### Ops (no evidence gathered; the search budget ran out)

- IONOS IMAP/SMTP settings.
- Twilio GB sender ID rules and pricing.
- The Total Car Check free-check URL.
- Thatcham ADAS guidance.
- Bodyshop labour rates.
- The DVSA MOT endpoint path and rate quota.
- The Companies House auth model.
- ABI salvage codes.
- The DVLA V888 fee.

## Not changed

- `playbook-rules.json`: no operational fact found that changes a rule.
- `gta-segment-defaults.json`: not in scope.

Scratch notes from the researchers and validator are under `/tmp/claude-0/-home-user-logo/811a135a-35cb-5723-858d-e84fbd9027fa/scratchpad/research/` (gta, insurers, legal, ops, validator).
