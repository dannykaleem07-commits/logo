# Research corrections to the blueprint (4 October 2026)

The knowledge-base research agents attempted to verify every figure and citation in `BLUEPRINT.md` online. **The build environment's egress policy blocked every external host** (gtacredithire.com, legislation.gov.uk, bailii.org, caselaw.nationalarchives.gov.uk, handbook.fca.org.uk, gov.uk and all insurer domains returned CONNECT 403). Consequently:

- **Nothing in `packages/kb/data` is marked `verified`.** Every entry carries `status: 'unverified'`, the primary `sourceUrl` to open, and a `sourceNote` saying what was seen (search-engine snippets only). The app shows amber badges, the advisor lists unverified citations, and the consistency engine raises `UNVERIFIED_CITATION` on drafts until a human records a source via the verify routes (`PATCH /api/directory/:id/verify`; KB entries via the data file for now).
- Where a snippet **contradicted** the blueprint, the entry is `status: 'failed'` and the correction is recorded below. Treat each as "check, then fix the template wording".

## Corrections found (check these first)

| # | Blueprint said | Research found | Where it bites |
|---|---|---|---|
| 1 | Irani v Duchon [2019] EWCA Civ 1846 is a BHR/vehicle-class case | It is a personal-injury appeal about a Blamire award for future loss of earnings. **Do not cite for BHR.** Use Pattni/Bent [2011] EWCA Civ 1384 or Stevens v Equity [2015] EWCA Civ 93 | `cases.json` (failed), advisor `bhr` |
| 2 | Hussain v EUI [2019] EWHC 2647 (QB): comparators for BHR | It is about taxi/PHV drivers: the measure is ordinarily lost profit; where hire greatly exceeds avoided lost profit, damages are limited to lost profit | PHV/taxi client files — hire may be capped at lost profit |
| 3 | Opoku v Tintas [2013] EWCA Civ 1299: failing to respond to an insurer offer | It is about failing to mitigate by not funding repair sooner (savings/credit available); the offer cases are Copley v Lawn and Sayce v TNT | advisor `mitigation`, `period` |
| 4 | Sayce v TNT [2011] EWCA Civ 1583: unenforceable agreement = no loss | It is an intervention-offer case following Copley (damages = the insurer's cost of the offered car) | `letter.intervention_reply` basis |
| 5 | Irving v Morgan Sindall [2018] EWHC 1147 (QB): BHR on a common-sense basis | It decides the "assured she will never pay" no-loss defence and the impecuniosity threshold; the common-sense BHR point better fits Bunting v Zurich [2020] EWHC 1807 (QB) | advisor `bhr`, `impecuniosity` |
| 6 | Tescher / AXA v Spectra Drive [2025] EWCA Civ 733 is the governing non-party-costs test | Confirmed (Birss LJ; 100% NPCO against DAML, 65% against Spectra reinstated), **but a Supreme Court listing (UKSC 2025/0116) surfaced** — treat the CA test as not final | acceptance scoring, `LEGAL-CAVEATS` #11 |
| 7 | CPR 25.6–25.9 / 25.7 for interim payments | Part 25 was rewritten from 6 April 2025 (SI 2025/106); interim payments are now Section V, **rr.25.20–25.26** | playbook SPLIT_HEADS_INTERIM, chaser/LBC templates — update citations |
| 8 | Litigant-in-person rate £19/hour | PD 46 para 3.4 now **£24/hour** (186th PD Update, 1 October 2025) | schedule of loss, LBC |
| 9 | PD 51ZE small-claims mediation pilot ran to 21 May 2026 | Extended to **6 April 2027**; the 196th PD Update (1 October 2026) brings non-PI RTA claims into mandatory mediation. Expect automatic referral on defended small-claims credit hire files from 1 October 2026 | litigation playbook, client updates |
| 10 | ICOBS 8.2 scope uncertain | On the handbook text as returned, 8.2.1R(1) applies the section to any motor vehicle liability insurer; only 8.2.1R(2) is EEA-limited. 8.2.6R (3 months) and 8.2.9R–8.2.11R (base + 4%) **appear to apply** to domestic third-party claims. Also 8.2.7R (fresh 3 months after a later admission) and 8.2.8R (claim fully quantified only once written evidence is supplied — the payment pack starts the clock). Still to be read by a human | ICOBS clock, chasers, complaint letter |
| 11 | FOS: guides are a starting point, not a ceiling | FOS treats the **highest** trade-guide valuation as the starting point, requires the insurer to evidence a lower figure, rejects averaging and considers adverts | `letter.pav_challenge` (own-insurer variant) |
| 12 | TfL ZEC: ≤50 g/km with 10 miles or ≤75 g/km with 20 miles | TfL pages show **≤75 g/km CO2 and ≥20 miles zero-emission range** plus Euro 6 for PHVs first licensed from 1 January 2023; the 50 g/km limb belongs to the taxi definition | fleet `PHV_NOT_ELIGIBLE` |
| 13 | DISP 2.7: third party cannot go to FOS | Mechanism confirmed: DISP 2.7.6R's devolved-right limb excludes the European Communities (Rights against Insurers) Regulations 2002 | `FORUM_NOT_OPEN` rationale |
| 14 | Credit hire recovery sits outside the FCA claims-management perimeter | PERG 2.7.20M–N / RAO arts 89G–89M list six kinds of claim; motor-damage tort recovery is not among them. **But** representing a policyholder in a complaint against their *own* insurer for a fee may be a "financial services claim" (art 89I). Take regulatory advice before offering that service | perimeter flags |
| 15 | GTA 4.14: off-hire 5 working days after total-loss payment | Not surfaced in 2026 snippets; older wording said 7 calendar days. Plausible but unconfirmed | clock `gta_4_14_offhire_tl_payment_5wd` |
| 16 | 2026–27 rates M £56.66 / M1 £65.49 | A page titled "Car Hire Rates 2025" shows M £61.59 / M1 £71.18 (higher). Confirm which year each pair belongs to from the GTA rates spreadsheet | `gta-rates.json` |
| 17 | Insurer rows "Advantage", "Highway", "Zenith", "Elephant", "Diamond", "By Miles" as separate operations | Advantage = Hastings underwriter; Highway = LV= brand; Zenith = Markerstudy-administered; Elephant/Diamond/Bell/Veygo = Admiral Group (EUI); By Miles = Direct Line Group (Aviva plc since July 2025). Ageas agreed to acquire esure in July 2025. Swinton is a broker, not a Covéa brand | `insurer-directory.json` routing notes |
| 18 | "Civil Enforcement of Road Traffic Contraventions (England) General Regulations 2022" | The 2022 instruments are SI 2022/71 (Approved Devices, Charging Guidelines and General Provisions) and SI 2022/576 (Representations and Appeals); the vehicle-hire-firm ground is in SI 2022/576 | `statutes.json`, PCN notice |
| 19 | Holt v Allianz [2023] EWHC 790 (KB) | Decided by Andrew Baker J; insurer's pre-action disclosure application failed on CPR 31.16(3)(b) | advisor `litigation` |

## What a human must do before go-live

1. Open the GTA rates page and the 16 March 2026 PDF; confirm every rate row and the 4.14 wording; set `verified` with the URL.
2. Read ICOBS 8.2.1R on the FCA Handbook and confirm the scope reading above.
3. Open each insurer's own "not our customer" page; record the third-party line and IVR path through the Directory screen's "Mark verified today" (it stores the URL, date and verifier).
4. Confirm the EX50 fee bands and the PD 46 litigant-in-person rate.
5. Re-check the five "failed" case glosses above in the templates and advisor text.
