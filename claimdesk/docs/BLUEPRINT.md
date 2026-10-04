# CCGUK Claims Platform: Research Brief and Product Blueprint for an Audatex-Beating Credit Hire and Accident Management System (England & Wales, October 2026)

> This is the product specification for ClaimDesk. Every module in `packages/` and `apps/` traces back to a section here. Where this brief says "verify" or "UNVERIFIED", the code must carry that status in data (never silently assert it).

CCGUK should build one web app covering hire, storage, recovery, engineering, valuation, salvage, payment, letters, litigation bundles and analytics, with a "position ledger" that checks every outgoing letter. It should use free government data (DVLA Vehicle Enquiry Service, DVSA MOT History, Companies House), pay-per-check provenance and valuation lookups costing a few pence to a few pounds, and engineer-approved manual or imported estimate lines. It should not try to copy Audatex's licensed repair-time database. Audatex is built for insurers and bodyshops estimating repairs. CCGUK's money is made or lost on proving need, period, rate and impecuniosity, keeping a consistent file, and paying insurers' payment-pack rules on time. No Solera product does that for a credit hire company.

## TL;DR

- **Build a vertically integrated credit hire and accident management system, not an estimating clone.** Match Audatex/Qapter where it matters to a 2–4 person credit hire company: vehicle identification by registration, guided photo capture, an engineer-in-the-loop estimate, total-loss and salvage handling, and analytics. Beat it on what it does not do at all. That means the hire, storage and recovery clocks, ABI GTA payment-pack compliance (wording dated 16 March 2026; 2026–27 maximum rates from 1 July 2026), intervention-offer logging, impecuniosity evidence, the position-consistency engine, tamper-evident signatures and evidence, and supplier and fleet compliance monitoring.
- **Data is cheap; repair-time data is not.** DVLA VES and DVSA MOT History APIs are free; you need a key, and DVSA also uses OAuth 2.0. Commercial gateways sell tax/MOT/spec lookups for pence and valuations for about £0.10–£0.25. Write-off, finance and stolen checks cost about £1.25–£4.99. Thatcham escribe and its web services are licensed products. Building a labour-time library from your own historic estimates, plus AI extraction of lines from imported Audatex or bodyshop PDFs, is the lawful route. Scraping advert sites is not.
- **The legal engine must be cited, retrieval-based and human-approved.** Use a curated knowledge base, not a "trained" model. Bulk or programmatic use of Find Case Law needs a free computational-analysis (transactional) licence, because the Open Justice Licence excludes it. The biggest legal and commercial risks to design against are these:
  - non-party costs orders against credit hire companies when claims fail (Tescher v Direct Accident Management / AXA v Spectra Drive [2025] EWCA Civ 733);
  - debarring orders on impecuniosity;
  - unenforceable hire agreements under the cancellation rules;
  - missed insurer intervention offers.

## Key Findings

1. **Audatex/Qapter is built for the insurer, not the credit hire company.** Its core is damage capture, estimating on licensed manufacturer and Thatcham repair data, triage, total-loss and salvage disposal (AUTOonline), subrogation (HyperQuest) and analytics. A UK credit hire company does not need to own estimating data. It needs an engineer's report that survives challenge and a file that proves need, period, rate and impecuniosity.
2. **The GTA is the de facto rulebook insurers use to judge a credit hire file, even for non-subscribers.**
   - The current GTA wording is dated 16 March 2026. The source file is named v11.1, with amendments dated 10 February 2026. So the project note "v11.1, 10 February 2026" is the amendment date, and the operative date is 16 March 2026.
   - The 2026–27 maximum daily rates apply to new hires from 1 July 2026 to 30 June 2027. Published examples include S1 £42.32, M £56.66 and M1 £65.49, all excluding VAT.
   - Para 2.7(j) says GTA terms "have no relevance in law" for claims taken outside the GTA and "cannot be cited in any legal proceedings". GTA rates are therefore a commercial benchmark, not BHR evidence.
3. **The ICOBS 8.2 three-month rule and interest at base + 4% are real and usable** (ICOBS 8.2.6R, 8.2.9R–8.2.11R). Their territorial scope (ICOBS 8.2.1R) must be confirmed before templates assert them as of right in purely domestic claims; see Caveats.
4. **The costs risk from failed claims has gone up.** The Court of Appeal in Tescher v Direct Accident Management Ltd / AXA Insurance UK Plc v Spectra Drive Ltd [2025] EWCA Civ 733 held that where an impecunious claimant's hire charges dwarf the other heads of claim, the litigation is "for all practical purposes" driven by the hire provider. That opens the door to non-party costs orders. The System's case-acceptance scoring must therefore be strict.
5. **Impecuniosity is a pleading and disclosure exercise from day one.** Under Diriye v Bojaj [2020] EWCA Civ 1400 the claimant must plead and prove it. MIB v Houston [2025] EWHC 3178 (KB) shows that the wording of a debarring order decides whether impecuniosity is lost for rate only or for period as well. The System must collect bank statements and a statement of means at sign-up, not after a defence arrives.
6. **Vehicle data access is mostly free or cheap.**
   - DVLA VES is free and returns tax, MOT status, make, colour, fuel, CO2, first registration, export marker, V5C issue date and more.
   - DVSA MOT History is free and returns every test, odometer reading, defect and advisory. Authentication is OAuth 2.0 client credentials plus an API key. The client secret expires every two years, and an API key unused for 90 days is revoked.
   - Commercial provenance (write-off, finance, stolen) and valuation are licensed resale products priced per lookup.
7. **Salvage categorisation now follows the ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage dated 28 May 2025.** It keeps the A (Scrap), B (Break), S (structural, repairable) and N (non-structural, repairable) categories. It adds dedicated EV/hybrid battery rules. Categorisation is made by an Appropriately Qualified Person and recorded on MIAFTR.

## Details

### 1. Executive summary and recommended product concept

**Product name (working):** CCGUK ClaimDesk.

**Concept:** a browser-based progressive web app for 2–4 users. It runs one claim file from first notification to settlement, with every head of loss managed in one place:
- hire;
- recovery;
- storage;
- engineer's fee;
- pre-accident value (PAV) or repair cost;
- excess;
- loss of use;
- miscellaneous.

It produces branded PDFs (letters, invoices, reports, notices, witness statements and bundles) from structured data, so figures and dates cannot drift between documents.

**Three design principles drawn from the live files:**
1. **One source of truth.** Every amount, date, offer and position lives once in the ledger. Documents read from it and never retype it.
2. **Prove it as you go.** Each stage has an evidence gate (need, use, period, rate, impecuniosity, mitigation). A claim cannot move to "payment pack" until its gate is green.
3. **Stop the clocks before the insurer does.** Hire and storage end triggers fire on total-loss confirmation, payment cleared or vehicle collected. The live files show insurers capping storage at "engineer's report + 48 hours" and challenging end dates.

### 2. Feature matrix: Audatex/Qapter/Solera list, matched and exceeded

| Solera item | What it does / data it relies on | UK equivalent or CCGUK approach | Match / beat |
|---|---|---|---|
| Guided Image Capture (Qapter) | Directs the policyholder to take set photos for AI damage assessment | PWA camera flow with an 8–12 shot overlay (four corners, damage close-ups, odometer, VIN plate, tyres). Captures EXIF time, device, GPS, upload time and SHA-256 hash at capture. | Match, and beat on chain of custody |
| Intelligent Triage / AudaTarget | Predicts total loss early from claim data and photos using machine learning | Rules-first total-loss predictor using age, PAV, damage zones, airbag deployment, structural flags and rough repair estimate against PAV, then refined on CCGUK's own outcomes | Match (rules) → beat (tuned to credit hire period economics) |
| Intelligent Damage Detection (Qapter) | Computer vision identifies damaged parts and severity | Optional third-party vision API (e.g. Tractable-type vendor) as a suggestion only. The engineer confirms every line. | Partial; engineer-in-the-loop is the defensible position |
| BPO FNOL (LYNX, North America) | Outsourced first-notice call centre | 24-hour line 020 7052 5403 plus WhatsApp intake form, call recording disclosure, transcription and auto file note | Equivalent, in-house |
| Claims Management / Damage Capturing / Mobile Estimating | Estimate on licensed manufacturer and Thatcham times, parts and paint | Engineer's estimate module: import Audatex or bodyshop PDF → AI line extraction → engineer edits; in-house labour library; manual lines | Functional equivalent without a licensed times database |
| Heavy Duty Estimating | HGV/commercial estimating | Out of scope at launch; import a third-party estimate | Not needed |
| BPO Glass / Right Glass (NA) | Glass claims network | UK glass handled by supplier invoice import; ADAS calibration line flagged | Adequate |
| BPO Damage Appraisal (NA) | Outsourced desk appraisal | Engineer instruction workflow (CARFLEX or independent IAEA-qualified engineer) with service-level timers | Equivalent |
| PlanManager (body shop management) | Workshop scheduling and repair tracking | Repair monitoring diary built to GTA para 4.10–4.11: authorisation check within 3 working days, mid-repair and pre-completion checks, delay notices | Beat: tied to hire-period defence |
| VHC2 (diagnostic scan) | Full-system diagnostic scan report | Upload the scan PDF to the evidence store; parse fault codes into the engineer's report | Match via import |
| Global InPart (parts ordering) | Parts marketplace | Not needed for a credit hire company; record parts-delay evidence for the period argument | Not needed; delay evidence beats it |
| AUTOonline (salvage auction) | Online salvage auction | Salvage module: record bids from UK platforms (e.g. Copart, SYNETIQ, e2e), CCGUK's own salvage-purchase offer, Agreement 11 | Match |
| Total Loss Manager / Settlement / Reinspection / Salvage Manager | Total-loss valuation and settlement workflow | PAV engine with comparables, confidence range and audit trail; total-loss payment tracker; salvage-retention deduction | Beat: comparables audit trail |
| NMVTIS Reporting (NA) | US national title/salvage reporting | ABI Salvage Code categorisation by an Appropriately Qualified Person, recorded on MIAFTR; DVLA notified of write-off. CCGUK records the category and source; it does not write to MIAFTR. | UK equivalent mapped |
| HyperQuest subrogation BPO | Outsourced recovery of subrogated claims | The core of CCGUK's business: recovery engine with letters, chasers, ICOBS clock, Part 36 and default-judgment workflow | Beat |
| Vehicle Replacement Services (Canada) | Replacement-vehicle management | Hire module: fleet allocation, GTA group mapping, delivery within 4 working hours, insurance cover, PCN transfer | Beat |
| Business Intelligence / Analytics | Insurer KPIs | Debtor days by insurer and handler, reductions by head of claim, cycle times, intervention-offer outcomes | Beat: tuned to credit hire |
| AudaVIN vehicle identification | VIN/registration decode to exact variant | DVLA VES + DVSA MOT + commercial spec decode (pence per lookup) | Match |
| Claims Verification / compliance review | Audit of estimates against rules | Position-consistency engine + GTA payment-pack validator + name/legacy-detail checker | Beat |
| AI end-to-end (Qapter) | AI-assisted whole workflow | Retrieval-based legal and claims assistant with citations; human approval before sending | Match, with stronger controls |

**Other benchmarks.**
- CCC Intelligent Solutions, Mitchell/Enlyte and Tractable are insurer- and repairer-side estimating and AI vendors. They solve the same problem as Audatex for the US market (CCC, Mitchell) and AI photo estimating worldwide (Tractable). None manages credit hire.
- Glass's/Autovista, cap hpi (part of Solera), Experian AutoCheck, Percayso, Cazana and Auto Trader supply valuation and provenance data under licence. Most quote prices on request, so plan on a reseller gateway first.
- **UK credit hire case management.** Eclipse Proclaim is the established platform. Its own case study says Auxillis (Redde) has almost 600 staff on Proclaim running "the full end-to-end accident management and vehicle hire process", with e-signed hire agreements through Eclipse's SecureDocs. Auxillis estimates cost per case fell by "approximately 20%" (vendor-published, not independently verified). Proclaim prices are not published.
- For a 2–4 person firm, a licensed enterprise platform is expensive and still lacks the position ledger. Build is justified.

### 3. Module-by-module blueprint (including the live-file lessons)

**3.1 Intake and triage**
- Accident line, WhatsApp, web form and agent entry all feed one FNOL record. The script opens with the recording disclosure. Mandatory fields cover accident time, place, the circumstances in a structured liability narrative, third-party registration, witnesses, injuries (yes means an automatic personal injury referral-out task), roadworthiness, and the client's own insurer and policy.
- **Script guard (lesson m):** the scripts never tell a client to ignore an insurer's courtesy-car offer. The script asks: "Has anyone offered you a vehicle? What exactly, by whom, when?" It logs the answer to the intervention register.
- **Perimeter routing (lesson j):** an injury flag sends a referral to a personal injury solicitor and is logged. CCGUK continues the damage-only claim. Litigation documents are produced as drafts for signature by the claimant or the instructed solicitor.
- Liability score: Highway Code rule references, CCTV and dashcam availability, independent witness, a contradiction check against the third-party version, and the prior-claim check on the same registration.

**3.2 Vehicle identification and lookups**
- Registration → DVLA VES (free) → DVSA MOT history (free) → optional spec decode, valuation and provenance (paid).
- **Mileage conflict engine (lesson e):** compare the odometer from MOT history, the accident report, the handover report, the engineer's report and photos. Flag non-monotonic readings or any variance above a set tolerance.
- **Cross-file registration check (lessons f, h):** each registration is unique per incident. A second claim on the same registration creates a linked but separate file, with a separate ledger, documents and insurer, and a banner on both. A fleet-unit registration matching any client vehicle triggers a hard stop.

**3.3 Hire module**
- Fleet register with the declared class of use per vehicle (credit hire, self-drive, PCO); hire start and stop events; GTA group mapping; daily rate per agreement (e.g. £49.80/day Golf, £53/day Outlander); additional-driver and non-standard-driver evidence (GTA para 5.4 allows £5.50/day, capped at £110, for qualifying non-standard risk drivers).
- **End triggers (lesson d):** repair complete, so off-hire within 24 hours (GTA 4.8); total-loss payment received, so off-hire within 5 working days (GTA 4.14 table, CHO dealing, unroadworthy); insurer termination notice of 1 working day (GTA 4.9); cash in lieu, so hire stops on receipt (GTA 4.7).
- **Monitoring diary:** checks at 3 working days for repair authorisation; delay notices where the delay is 2 or more working days or over 20% of the estimate (GTA 4.10–4.11); checks every 5 working days thereafter.

**3.4 Recovery and storage**
- Rate card: £90 call-out + £3 per loaded mile + £25 admin; storage £45/day.
- Storage end triggers: engineer's report issued; total loss confirmed; payment received; vehicle collected or released to salvage.
- The System warns that insurers commonly cap storage at report + 48 hours (live File 2). It sends a "collect or pay" notice to the insurer and client on report day, so further storage is either avoided or clearly caused by the insurer.

**3.5 Engineering and valuation:** see section 4.

**3.6 Intervention and mitigation register (lesson c)**
- Each offer is logged with: date and time received, channel, offeror, vehicle class, rate (e.g. £20.37/day File 1; £23.30 + VAT/day File 2), terms (excess, mileage, delivery, insurance), whether it was suitable, and the client's decision with reasons, signed through the Mitigation Questionnaire/Statement of Truth (GTA Appendix C).
- Automatic written reply to the insurer within 1 working day.
- The GTA para 3.6 clock: an insurer believing it was first must say so within 5 working days of the New Claim Advice Form. The CHO must send that form within 1 working day of agreeing services (GTA 4.1).

**3.7 Position-consistency engine (lesson a)**
- Every outgoing draft is parsed for amounts, dates, deadlines, offers and assertions. These are compared with the ledger and with all prior outgoing letters.
- Hard blocks: amount paid ≠ ledger (e.g. £1,287 stated when £1,112 was received); a deadline earlier than the computed deadline; "no alternative vehicle was offered" when the register holds an offer; a storage end date that differs from the ledger; an invoice whose payee or supplier differs from the source.
- The approver must clear each flag with a reason, and that reason is itself logged.

**3.8 Document integrity (lesson b)**
- Documents are generated from templates with an immutable version and a SHA-256 hash.
- The e-signature records signer identity, email or SMS one-time passcode, IP address, timestamp and document hash, and produces a completion certificate.
- Re-executed documents carry the actual signing date and a "re-executed on [date], supersedes version [n]" line.
- The System refuses any date earlier than the creation timestamp.
- Two agreements with the same signature date on one file trigger an alert.
- Evidence is held in write-once (object-lock) storage.

**3.9 Connected-party and witness checker (lesson g):** matches names, phone numbers, emails, addresses, vehicles and bank details across staff, relatives, suppliers, previous clients and witnesses. A non-independent witness (live File 4) is flagged, and the System suggests corroborating evidence such as CCTV or the third party's own admission.

**3.10 Name and legacy-detail checker (lesson i):** a regex and dictionary block on "Car Flex", "Carflex Ltd" (unless the case is exactly "CARFLEX LTD"), 17360033, "66 Paul Street", "EC2A 4PX" and "courtesycarsuk.co.uk". It also blocks the banned disclaimer phrases.

**3.11 Counterparty monitoring (lesson k):** a nightly Companies House API poll for CARFLEX LTD (12640635) and every supplier and insurer counterparty: status, filing deadlines, gazette notices (strike-off), and officer changes. A manual Register of Judgments search (paid, via the Registry Trust) runs at onboarding and quarterly. CARFLEX's suspended strike-off and dormant, overdue accounts make it a high-risk supplier. Insurers checking the vendor will see the same thing, so expect challenges to invoices from CARFLEX.

**3.12 Fleet compliance (lesson l)**
- MOT, tax, insurance and service expiry alerts.
- DVLA keeper address kept current. RENTX's CCJs arose from tickets sent to an old V5C address.
- PCN/NIP workflow: log on receipt; respond to s.172 within 28 days; transfer liability to the hirer using the Schedule 2 particulars of the Road Traffic (Owner Liability) Regulations 2000 and the signed statement of liability.
- Collingwood will not cover credit hire and self-drive together. The fleet register must hold the declared use per unit and per policy, and block allocation outside cover.

**3.13 Communications:** shared mailbox claims@courtesycars.net with auto-file by reference and a sent-mail parser feeding the ledger; WhatsApp Business API; VoIP with recording, transcription and an AI file-note draft.

### 4. Vehicle data, valuation and engineering methodology

**4.1 Lookups: what is free, what is cheap, what is manual**

| Source | Fields | Cost | Access / terms |
|---|---|---|---|
| DVLA Vehicle Enquiry Service API | registration, taxStatus, taxDueDate, motStatus, motExpiryDate, make, yearOfManufacture, monthOfFirstRegistration, engineCapacity, co2Emissions, fuelType, colour, markedForExport, typeApproval, wheelplan, dateOfLastV5CIssued, euroStatus, revenueWeight | Free | Register on the DVLA developer portal; x-api-key header; only one key per company; overall rate limit; support at dvlaapiaccess@dvla.gov.uk |
| DVSA MOT History API | all MOT tests, results, odometer readings, defects and advisories, expiry | Free | Register at documentation.history.mot.api.gov.uk; OAuth 2.0 client credentials plus X-API-Key; client secret expires every 2 years; key revoked after 90 days of non-use |
| Companies House API | company profile, status, filing history, officers, charges, insolvency | Free (key required) | Developer account; rate-limited |
| askMID "Other Vehicle Look-up" | insurer, policy number for the third-party vehicle at the accident date | £10.00 per one-off search, per the MIB's askmid.com homepage ("One-off search £10.00"); an annual subscription is offered for frequent enquiries. The £4.50 figure in some secondary sources appears to be out of date. | Only for a party involved in an accident; misuse is prohibited |
| DVLA keeper enquiry (V888) | registered keeper name and address | £2.50 per enquiry (DVLA form V888, Option A: "The name and address of the registered keeper of a vehicle at a specific date – the fee is £2.50"); £5 for Option B (own vehicle record); sent to Vehicle Record Enquiries, DVLA, Swansea | "Reasonable cause" required; a road traffic accident with an uninsured or untraced party is a recognised reason |
| MIAFTR | write-off and theft register | No direct access | Insurer and authorised access only; reach it through commercial provenance checks |
| Commercial gateways | spec, VIN, valuation, provenance | CarAnalytics: tax & MOT £0.02, vehicle data £0.08, valuation £0.10. Vehicle Smart: tax/MOT from 2.5p, provenance from £1.25 or £4.99. DealerPricing (pay as you go): valuation £0.25, full provenance £2.99. | Read each licence for "no resale" and "internal use" clauses |
| HPI (Solera), Experian AutoCheck, cap hpi, MotorCheck | finance, stolen (PNC), write-off category, mileage register, valuations | Pricing on quotation (except retail checks) | Business contract |

**Direct answer to "do I need an API".** Not for everything. Registration, tax, MOT, mileage history and Companies House data are free through government APIs. Valuation and provenance cost pence to a few pounds per call through a gateway. Comparable adverts, engineer's photos, estimate PDFs and bodyshop invoices can be loaded manually or by PDF import. **Budget:** about £50–£150 a month in paid lookups at 30–60 claims a month (estimate).

**4.2 Scraping vs manual capture**
- Scraping Auto Trader or other advert sites by bot breaches their terms of use. Repeated extraction of substantial parts may also infringe database right under the Copyright and Rights in Databases Regulations 1997 (reg 16).
- **The lawful method:** an engineer or handler views the adverts manually and saves a PDF or screenshot of each comparable with its URL and capture time. The System stores it as evidence and keys in price, mileage, year, trim and location. A small number of individual adverts used as evidence is defensible; systematic extraction is not.

**4.3 How PAV is decided**
- The measure is the cost of buying a replacement of similar make, model, age, mileage, condition and specification in the retail market (Darbishire v Warran [1963] 1 WLR 1067, where repair exceeding market value was not recoverable).
- Engineers use trade guides (Glass's, cap hpi) cross-checked against retail adverts, then adjust for mileage, condition, service history, options and modifications.
- Typical disputes are: guide price (trade) vs retail; outlier adverts; dealer vs private prices; Cat N/S history; and VAT where the claimant is not VAT registered.

**4.4 CCGUK PAV algorithm (defensible and auditable)**
1. **Inputs:** registration → VES/MOT; variant and trim; odometer at loss (the latest MOT reading projected forward using the vehicle's own MOT-derived annual mileage); condition grade (engineer); service history; options; previous write-off category.
2. **Comparables:** at least 6 retail adverts. Same model and generation; year ±1; mileage within ±25% of the projected odometer; same fuel and transmission; within 50 miles of the claimant's postcode, widened in stages if fewer than 6 are found.
3. **Normalise** each advert to the subject vehicle. Mileage adjustment = (advert mileage − subject mileage) × a per-mile factor derived from the comparables' own price-to-mileage regression (fallback £0.05–£0.10 per mile by price band, flagged as an assumption). Add option adjustments. Apply a condition adjustment of ±0–10% (engineer).
4. **Outliers:** exclude adverts more than 1.5 × IQR from the median after normalisation. Also exclude Cat S/N vehicles, ex-fleet unless the subject is ex-fleet, and adverts priced on application.
5. **Output:** the median as the PAV; an interquartile range as the confidence band; a trade guide value shown alongside; and a written reasoning paragraph generated from the data and approved by the engineer.
6. **Audit trail:** each advert's capture (PDF, URL, timestamp, hash), each adjustment, each exclusion and its reason, and the identity of the approver.

**4.5 Estimating: lawful equivalents to Audatex**
- Audatex and other estimating systems price repairs from licensed data: manufacturer and Thatcham repair methods and times, OEM part numbers and prices, and paint-time and materials formulas.
- Thatcham's escribe gives engineers and repairers methods, recommendations, times, parts and ADAS fitment information. It is compliant with BS 10125, offered on subscription, and integrated with major estimating systems through Thatcham Integrated Methods.
- Thatcham also sells "Risk and Repair Web Services" APIs for parts, times, methods, ADAS, Vehicle Risk (Code44) and variant data.
- Use is governed by an end-user licence: non-exclusive, non-transferable, and limited to the licensee's own use.

**CCGUK route:**
- (a) the engineer subscribes to escribe if needed;
- (b) import Audatex or bodyshop estimate PDFs and extract lines (operation, part number, part price, labour hours, paint hours, materials) with AI, then check that the totals reconcile;
- (c) build an in-house labour-time library from CCGUK's own approved estimates, by model, panel and operation, as statistical medians, not copied third-party tables;
- (d) allow manual lines.

Paint and materials should follow the engineer's stated method: hours × rate plus materials, either as a per-hour materials rate or a paint-maker system figure. The basis is always stated on the report.

**4.6 Engineer's report contents**
- Instructions and the instructing party; the engineer's identity and qualifications (IAEA/IMI); date, place and conditions of inspection; vehicle identification (registration, VIN, odometer, MOT); pre-accident condition; damage description with photos; repair method and estimate; whether the vehicle is roadworthy or unroadworthy and why; repair duration in working days; total-loss assessment, PAV with comparables, salvage category and salvage value; ADAS and EV notes; and an opinion consistent with the accident circumstances.
- If the report is for court: CPR Part 35 and PD 35 content, including the substance of instructions, the expert's duty to the court, a statement of truth and the declaration in the Guidance for the Instruction of Experts.
- On the small claims track, most of Part 35 does not apply (CPR 27.2). No expert evidence may be used without permission (CPR 27.5). Recoverable expert fees are capped at £750 per expert by PD 27A para 7.3(2) ("for experts' fees, a sum not exceeding £750 for each expert").
- Engineer's fee (£285): the System should produce a fee note showing the instruction date and the work done, to answer "fee not recoverable" refusals (live File 2).

**4.7 Salvage categories and total-loss economics**
- The ABI Code dated 28 May 2025 is current: A (scrap), B (break), S (structurally damaged, repairable), N (non-structurally damaged, repairable).
- Categorisation is by an Appropriately Qualified Person, input to MIAFTR with an AQP ID.
- Since 2017, categories are based on structural vs non-structural damage, not cost. A vehicle can be Cat N even where repair exceeds value without structural damage.
- **Total-loss decisions are commercial.** Insurers typically compare repair cost plus hire with PAV less salvage. The System models: repair + projected hire + storage vs PAV − salvage.
- Salvage-value percentages vary by category and age. Use actual bids, not a fixed percentage.

**4.8 AI damage detection and total-loss prediction**
- Use computer vision for triage and as a parts list suggestion only. The engineer approves every line, and the photos keep their original hash and EXIF data.
- **First-notification total-loss prediction:** use a logistic score on vehicle age, PAV band, damage zones, airbag deployment, structural indicators (wheel or suspension displacement, pillars) and driveability. Calibrate it on CCGUK's own outcomes once there are more than 100 files.

### 5. Legal knowledge base (England & Wales)

**5.1 Credit hire and damages cases.** Principles are stated briefly. Unless marked as checked, citations are from established authority and must be re-verified on Find Case Law or BAILII before they go into templates.

| Case | Principle |
|---|---|
| Giles v Thompson [1994] 1 AC 142 | Credit hire agreements are not champertous; hire charges are recoverable damages |
| Dimond v Lovell [2002] 1 AC 384 | A non-impecunious claimant recovers only the basic hire rate (BHR); an agreement unenforceable under the CCA 1974 means no recoverable loss |
| Burdis v Livsey [2002] EWCA Civ 510 | Reasonable repair cost is recoverable as the measure of loss; credit repair and hire principles |
| Lagden v O'Connor [2003] UKHL 64 | An impecunious claimant recovers the full credit hire charge |
| Bee v Jenson [2007] EWCA Civ 923 | Reasonable hire cost is recoverable even where the claimant's insurer pays; spot rates relevant |
| Copley v Lawn [2009] EWCA Civ 580 | Rejecting an insurer's free-car offer is not automatically unreasonable where its cost and terms were not explained; damages may be capped at what the offer would have cost |
| Beechwood Birmingham v Hoyer Group [2010] EWCA Civ 647 | A business with a spare fleet still recovers loss-of-use damages |
| W v Veolia [2011] EWHC 2020 (QB) | Hire agreement unenforceable under the cancellation regulations, so hire charges not recoverable |
| Pattni v First Leicester Buses Ltd; Bent v Highways and Utilities Construction Ltd [2011] EWCA Civ 1384, [2012] Lloyd's Rep IR 577 | One conjoined judgment (Aikens LJ, handed down 24 November 2011, as confirmed in Stevens v Equity [2015] EWCA Civ 93 at para 2); approach to BHR evidence, comparable vehicles and judicial assessment |
| Sayce v TNT [2011] EWCA Civ 1583 | Unenforceable hire agreement means no recoverable hire loss |
| Opoku v Tintas [2013] EWCA Civ 1299 | Unreasonably failing to respond to a suitable insurer offer is a failure to mitigate |
| Coles v Hetherton [2013] EWCA Civ 1704 | The reasonable cost of repair is the measure of loss for a repairable vehicle |
| Stevens v Equity Syndicate Management [2015] EWCA Civ 93 | BHR = lowest reasonable rate quoted by mainstream suppliers in the locality for the kind of vehicle hired; strip out irrecoverable benefits |
| McBride v UK Insurance [2017] EWCA Civ 144 | Credit hire nil excess handled separately as the cost of excess cover |
| Irving v Morgan Sindall [2018] EWHC 1147 (QB) | BHR assessed on a common-sense basis from imperfect evidence |
| Hussain v EUI [2019] EWHC 2647 (QB) | Comparators for BHR evidence |
| Irani v Duchon [2019] EWCA Civ 1846 | BHR comparators and the vehicle class |
| Diriye v Bojaj [2020] EWCA Civ 1400 | Impecuniosity must be pleaded and proved; burden on the claimant; question is whether they could reasonably afford basic hire |
| Mattocks v Mann [1993] RTR 13 | Hire period can extend where the claimant cannot fund repair until the insurer pays |
| Darbishire v Warran [1963] 1 WLR 1067 | Uneconomic repair: recovery limited to replacement market value |
| Zurich Insurance v Umerji [2014] EWCA Civ 357 | Claimant must prove impecuniosity; 591-day, £95,130 hire scrutinised |
| Kindertons Ltd v Murtagh [2024] EWHC 471 (KB) | Non-party costs order upheld against a credit hire company (checked via secondary source) |
| Tescher v Direct Accident Management / AXA v Spectra Drive [2025] EWCA Civ 733 | Two-stage non-party costs test; litigation "for all practical purposes" driven by the hire provider where hire dwarfs other heads (checked via secondary source) |
| MIB v Houston [2025] EWHC 3178 (KB) | A debarring order confined to "rate" did not bar impecuniosity on period; 197-day hire upheld (checked via secondary source) |

**5.2 Key statutes and rules**
- **Credit hire enforceability:**
  - CCA 1974 / RAO art 60F: exempt if credit is repayable in 12 or fewer payments within 12 months, with no interest or charges. Draft the agreement to fit.
  - Consumer Contracts Regulations 2013: off-premises credit hire is a service contract. The reg 28(1)(h) vehicle-rental exclusion applies only where the contract "provides for a specific date or period of performance". An open-ended hire "until repair or settlement" should be treated as not excluded.
  - So the System must provide the Sch 2 information and the Sch 3 cancellation form, and obtain an express request to start during the cancellation period with acknowledgement (regs 29–36). If this is missed, the cancellation period extends and the consumer may owe nothing for the service, which is the W v Veolia risk.
- **Interest:** County Courts Act 1984 s.69; Senior Courts Act 1981 s.35A; ICOBS 8.2.9R–8.2.11R (base + 4% where an insurer fails to make a reasoned offer or reply in time); Late Payment of Commercial Debts (Interest) Act 1998 for business-to-business debts only (e.g. supplier invoices, fleet clients).
- **Liability:** Highway Code via RTA 1988 s.38(7); Compensation Act 2006 s.2 (apology not an admission).
- **Direct rights:** RTA 1988 s.151 (insurer to satisfy judgments); European Communities (Rights against Insurers) Regulations 2002 (direct action; check its current status as assimilated law on legislation.gov.uk); Third Parties (Rights against Insurers) Act 2010 (insolvent insured).
- **MIB:** Uninsured Drivers Agreement 2015 and Untraced Drivers Agreement 2017. New claims go through the online MIB portal (verify the time limits in each agreement text).
- **Limitation:** Limitation Act 1980 s.2 (tort, 6 years), s.5 (contract, 6 years), s.11 (personal injury, 3 years; refer out).
- **CPR:**
  - Parts 7, 12 (default judgment), 13, 14, 15, 16, 18, 22 (statement of truth);
  - Part 25 (interim payments, rr.25.6–25.9);
  - Part 26 and Part 27 (r.27.14 small claims costs; PD 27 witness and expert caps);
  - Part 28; Part 31 (r.31.16 pre-action disclosure); Part 32 (r.32.14 false statements);
  - Parts 35 and 36; r.44.16;
  - Part 45 fixed recoverable costs (extended from 1 October 2023);
  - r.46.5 litigant in person.
- **Track limits:** small claims up to £10,000; fast track up to £25,000; intermediate track £25,000–£100,000.
- **Mediation:** from 22 May 2024, PD 51ZE automatically referred most specified small money claims to a free one-hour telephone mediation. That pilot ran to 21 May 2026 and originally excluded road traffic claims. Separately, from July 2025 HMCTS piloted automatic mediation referral for OCMC-issued road traffic claims without personal injury. Confirm the post-May 2026 position before relying on either.
- **Court fees (2026 tables from secondary sources):**
  - issue fee: £35 (up to £300), £50, £70, £80, £115, £205 (£3,000.01–£5,000), £455 (£5,000.01–£10,000), then 5% to £200,000;
  - small claims hearing fees: £27 to £346 (over £3,000).
  - Verify against the HMCTS EX50 before go-live.
- **Regulation:**
  - ICOBS 8.1 (prompt, fair claims handling) and ICOBS 8.2.6R (reasoned offer or reply within three months).
  - DISP 1 (complaints; eight-week final response) and DISP 2.7 (eligible complainant). A third-party claimant generally cannot take the at-fault insurer to the FOS. A client can complain about their own insurer.
  - Insurance Act 2015 ss.3–5, 8 and Sch 1 (fair presentation for the fleet policy).
  - LASPO 2012 ss.56–60 (personal injury referral-fee ban; refer injury cases out without a fee).
  - FCA claims management perimeter (RAO art 89G onwards) is aimed at personal injury, financial products, housing disrepair, employment, criminal injury and specified benefits claims. Vehicle-damage and credit hire recovery is generally understood to sit outside it; confirm against PERG 2.7 before running referral schemes.
  - Legal Services Act 2007 s.12 and Sch 2: conduct of litigation and rights of audience are reserved, so documents are prepared for signature by the claimant or a solicitor.
- **Data:**
  - UK GDPR arts 5, 6, 9, 10, 13–15, 28, 32.
  - DPA 2018 Sch 1: driving convictions are criminal offence data, so an appropriate policy document is needed.
  - DPA 2018 s.170 (unlawfully obtaining personal data).
  - Data (Use and Access) Act 2025: the core Part 5 reforms commenced 5 February 2026 (SI 2026/82); s.103 and Sch 10 (data subject complaints) commenced 19 June 2026. Firms must have a complaints process in place before an ICO complaint.
  - ICO data protection fee: tier 1 is £52 a year per the ICO Registration FAQs ("The fee for tier 1 is £52"; tier 1 covers turnover up to £632,000 or no more than 10 staff), set by the Data Protection (Charges and Information) (Amendment) Regulations 2025 from 17 February 2025, with a £5 discount for Direct Debit.
- **Road traffic and criminal law:**
  - RTA 1988 ss.143 (insurance), 154, 165, 170 (duty to stop and report), 172 (driver identification).
  - RTOA 1988 s.1 (notice of intended prosecution within 14 days).
  - Owner liability transfer: Road Traffic (Owner Liability) Regulations 2000, Sch 2 particulars plus a signed statement of liability. London councils require a signed hire agreement with the hirer's full name, permanent address, date of birth and licence details (company hirers excepted).
  - Traffic Management Act 2004 and the 2022 England General Provisions Regulations; Protection of Freedoms Act 2012 Sch 4 paras 13–14 (private parking: hire agreement and statement of liability to the creditor).
  - Fraud Act 2006 ss.1–4; CJCA 2015 s.57 (fundamental dishonesty, personal injury only); Summers v Fairclough Homes [2012] UKSC 26 (dishonest claims and strike-out); contempt for false statements of truth (CPR 32.14).
  - Private Hire Vehicles (London) Act 1998 ss.2, 6, 7, 12. TfL requires every vehicle licensed as a London PHV for the first time to be zero-emission capable: at most 50g/km CO2 with 10 miles of zero-emission range, or at most 75g/km with 20 miles, and Euro 6. Neither current CCGUK unit qualifies.

**5.3 Licensing for the AI knowledge base**
- legislation.gov.uk: Open Government Licence.
- Find Case Law: the Open Justice Licence permits reuse, including commercial use, but excludes computational analysis. Programmatic bulk searching, extraction or enrichment needs a free transactional (computational analysis) licence, assessed by The National Archives.
- BAILII: terms restrict bulk downloading; link only.
- CPR (justice.gov.uk) and the FCA Handbook: link and quote, don't bulk-copy.

### 6. Evidence checklists

| Element | Must capture | When |
|---|---|---|
| Need | Occupation, journeys, dependants, other vehicles in household (none or unavailable), mobility needs; signed statement | Sign-up |
| Use | Odometer and photo at delivery and collection; weekly mileage prompts; optional telematics; fuel receipts; journey diary | Throughout hire |
| Period | Roadworthiness evidence; engineer instruction, inspection and report dates; repair authorisation; parts delays; total-loss offer and payment dates; GTA monitoring calls | Event-driven |
| Rate | Agreement rate; GTA group; BHR comparator quotes (screenshots of mainstream supplier rates, date-stamped, local, like-for-like); excess terms | Sign-up and before litigation |
| Impecuniosity | Statement of Means (07); 3 months' bank statements for all accounts; credit card limits and balances; savings; income evidence; dependants; outgoings | Sign-up, before pleading |
| Mitigation | Intervention offers log; client decisions and reasons; Mitigation Questionnaire with GTA statement of truth | Sign-up and on every offer |
| Enforceability | Cancellation info, Sch 3 form, express request to start, signed audit certificate | Sign-up |

### 7. Get-paid-faster playbook

1. **Day 1:** New Claim Advice Form to the at-fault insurer within 1 working day (GTA 4.1). Ask for the handling centre and reference within 5 working days (GTA 4.2). Start the ICOBS clock.
2. **Days 1–7:** CCTV requests to council or TfL within days (footage is often overwritten within weeks; check each operator's retention); dashcam; witness statements; police report where needed (Met Police collision report £215.10, third-party details £49.00, per the 2026 fee schedule).
3. **Clean payment pack as soon as hire ends** (GTA 6.1–6.3): covering letter, Mitigation Questionnaire, Advice Form, Hire Period Validation Form, engineer's report, storage and recovery accounts. Under GTA 6.7, insurers settle within one calendar month of a clean pack. For hires from 16 March 2026, late-payment additions are 10% (days 31–60) and 20% (day 61 onwards) for subscribers (GTA 6.8.6). Non-subscribers can quote these figures as an industry benchmark, not as of right.
4. **Split heads of claim:** pay undisputed heads (PAV, recovery) now and dispute hire separately. Ask for an interim payment, and apply under CPR 25.7 if litigated.
5. **Complaint escalation:** a formal complaint to the insurer under DISP 1 (eight weeks), citing ICOBS 8.1 and 8.2. Use a DSAR for call recordings of alleged intervention offers (one month to respond).
6. **Litigation levers:** Part 36 offer at issue; default judgment under CPR 12 if no acknowledgment or defence; interest under s.69 CCA 1984.
7. **Vendor onboarding and bank validation:** the business account must be in the exact registered name "Courtesy Cars Group UK Ltd" so Confirmation of Payee returns a full match. Send insurers a bank letter on bank letterhead, the certificate of incorporation (17430389), proof of registered office and a director ID. Never send legacy details. File 1's "bank details could not be validated" is typical of a new company with a trading-name mismatch.
8. **Chaser cadence:** day 7, 14, 21 → team leader → claims manager → complaint at day 28. Log each step in the ledger.

### 8. Insurer and authority directory (checked 4 October 2026; most entries need confirming)

| Organisation | Third-party / claims contact | Source / status |
|---|---|---|
| Admiral | Third-party line 0333 220 2047 (policyholder claims 0333 220 2033) | admiral.com motor claims page; verified |
| Aviva (incl. Quote Me Happy) | Motor claims 0345 030 6925 (24h); no separate third-party line published | aviva.co.uk claims page; third-party line UNVERIFIED |
| Direct Line / Churchill / Privilege | Aviva is moving UKIL business to Aviva Insurance Ltd; contacts split for van policies bought before or on/after 2 July 2026 | directlineforbusiness.co.uk; car third-party line UNVERIFIED |
| esure / Sheilas' Wheels | Claims 0345 603 7872 (policy booklet); "option 3 for third parties" from a forum only | UNVERIFIED menu path |
| Hastings Direct | Policyholder claims 0333 321 9800; motorclaims@hastingsdirect.com | Policy document; third-party route UNVERIFIED. Beware copycat sites. |
| MIB | 01908 830001 (10am–4pm Mon–Fri for existing claims); contact@mibclaims.org.uk; MIB, Linford Wood House, 6-12 Capital Drive, Milton Keynes MK14 6XT; new claims via online portal | mib.org.uk; verified |
| Metropolitan Police | Collision report £215.10 (Form 518); third-party details £49.00 (Form 519); payment by BACS | met.police.uk 2026 fee schedule; verified |
| LV=/Allianz, AXA, Ageas, Zurich, Covéa, NFU Mutual, 1st Central, Markerstudy, Haven (Acorn), Somerset Bridge/GoSkippy, Advantage, Sabre, Tradex, Highway, Mulsanne, Accredited, Wakam, Collingwood, Marshmallow, Zego, Inshur, Cuvva, By Miles, Hiscox, Tesco Bank, Sainsbury's, Veygo, Elephant, Diamond, Qmetric, Zenith | Not verified | UNVERIFIED; load from the insurer's own "not our customer" page |

**Maintenance workflow:**
- Each record carries the source URL, "last verified" date and verifier.
- Records older than 90 days turn amber, and older than 180 days turn red.
- Any number used on a live call that fails is logged and the record goes red.
- Copycat claims-management domains (e.g. "admiral claims" sites using 0333 006 44xx numbers) are blacklisted.

### 9. Architecture, tech stack, security, costs and roadmap

- **Stack (recommended):**
  - Next.js/React PWA and a TypeScript API, with PostgreSQL (row-level security) hosted in the UK region (AWS eu-west-2 or Azure UK South).
  - S3 object storage with Object Lock for evidence.
  - Background jobs (queues) for lookups and clocks.
  - HTML-to-PDF with headless Chromium, using brand tokens (navy #0D1C50, accent #04347F, gold #B8901F, silver #8A8F9B, tint #F4F6FA; Calibri; A4; 17–20 mm margins).
  - A compact logo lockup top-left with the company details block alongside on invoices; continuation pages carry the reference and "Page X of Y"; Part 6 trading disclosures go in the footer.
  - The LDUK partner-mark slot stays disabled until a signed partnership record is uploaded.
- **E-signature:** use a provider with an audit certificate (e.g. DocuSign, Adobe Acrobat Sign, Dropbox Sign, Yousign), or build an in-house signature flow with a hash, OTP and certificate.
- **AI layer:** an LLM with retrieval over the cited knowledge base and file data. Every output carries citations and is held for human approval; nothing is sent automatically.
- **Security:** MFA; role-based access (handler, approver, admin); immutable audit log; Cyber Essentials (then Plus); encrypted backups; data processing agreements (UK GDPR art 28) with every vendor.
- **Costs (estimates, not quotes):**
  - hosting and storage £150–£400/month;
  - lookups £50–£150/month;
  - e-signature £30–£100/month;
  - LLM API £50–£200/month;
  - WhatsApp/VoIP £50–£150/month;
  - initial build by a small contractor team £40k–£120k over 6–9 months, or less if built incrementally.
- **Roadmap:**
  - Phase 1 (0–3 months): claims, parties, vehicles, ledger, hire/storage/recovery clocks, document engine, e-signature, evidence store, consistency and legacy checker, GTA payment pack.
  - Phase 2 (3–6 months): engineering and PAV module, estimate import, salvage, Companies House monitoring, fleet compliance and PCN.
  - Phase 3 (6–9 months): analytics, AI assistant, telephony transcription, total-loss predictor.

### 10. Risks, open questions and anything unverified

- **ICOBS 8.2 scope:** confirm ICOBS 8.2.1R on handbook.fca.org.uk before templates assert the three-month duty and base + 4% interest for domestic UK accidents.
- **GTA rates:** only S1, M and M1 for 2026–27 were confirmed. Download the full rate spreadsheet for every group (cars, PHV/taxi, LCV, motorcycles). The rates page showing commercial groups (CP1 £64.64, CP2 £73.34) was labelled 2025–26.
- **CCGUK is not a GTA subscriber.** Applicant audit costs £1,890 + VAT and needs 40 qualifying files, so subscription is a medium-term option only.
- **askMID fee:** resolved at £10.00 per one-off search per the MIB's askmid.com homepage; the £4.50 figure in secondary sources appears to be out of date.
- **Mediation after 21 May 2026:** status of PD 51ZE and the road traffic OCMC pilot is unconfirmed.
- **Court fees:** taken from secondary sources; confirm against EX50.
- **Several case citations** (notably Irani and Hussain) need checking against the full judgment; Bent is confirmed as conjoined with Pattni at [2011] EWCA Civ 1384.
- **Insurer directory:** most entries are UNVERIFIED.
- **Supplier risk:** CARFLEX's strike-off status is a supplier and evidence risk. Consider an alternative engineer and storage yard.
- **Fleet:** neither unit can be newly licensed as a London PHV; the PCO plan needs a zero-emission-capable vehicle.
- **Insurance:** Collingwood's refusal to cover credit hire and self-drive together needs a policy-per-use solution before self-drive hire starts.
- **Costs exposure:** Tescher-style non-party costs exposure means weak-liability files (e.g. File 3's lane-merge dispute) should not run on hire without strong evidence.

## Recommendations

1. Build Phase 1 now, with the position ledger, clocks and GTA payment pack as the first deliverables. They fix the live-file failures directly.
2. Register the DVLA VES, DVSA MOT and Companies House API keys this week (free), and open one pay-as-you-go gateway for valuation and provenance.
3. Rename and evidence the bank account to the exact registered name, and send a vendor-verification pack to esure, Acorn/Haven, Somerset Bridge and Aviva.
4. Redraft Agreement 03 for art 60F and the Consumer Contracts Regulations (cancellation information plus express request to start), and collect Statement of Means 07 with bank statements at sign-up.
5. Apply for a Find Case Law computational-analysis licence before ingesting judgments.
6. Put CARFLEX on a watch list and qualify a second engineer and storage yard.

## Caveats

This brief relies on primary sources where they could be fetched: the GTA wording, DVLA and DVSA developer documentation, the FCA Handbook, legislation.gov.uk and The National Archives. Elsewhere it relies on reputable secondary sources, labelled as such. Cost figures for the build are estimates. Directory entries marked UNVERIFIED must not be used on live files until checked on the insurer's own site.
