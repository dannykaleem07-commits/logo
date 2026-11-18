# UK Pre-Accident Vehicle Valuation (PAV) for Motor Engineers and Total-Loss Claims — Data Sources and Evidence Standards (as of Nov 2026)

Method note: about 34 web searches were used. Direct page fetches were blocked by the session network (www.fca.org.uk, www.financial-ombudsman.org.uk and caselaw.nationalarchives.gov.uk all failed to resolve), so everything below comes from search-result snippets and summaries, not full-page reads. Quoted wording should be checked against the primary page before it goes into product copy or a report template. No prices have been guessed: where no price was found, the note says "not published".

## 1. Valuation data providers: what they give, access, cost, adjustments

### Takeaway
The four guides the Financial Ombudsman Service (FOS) names as its starting point are CAP (cap hpi / Solera), Glass's (J.D. Power / Autovista), Autotrader's valuation tool (its valuation, not its adverts) and Percayso (the former Cazana platform). These are the core sources a defensible PAV tool needs. All are licensed B2B. The only per-value price found was £0.40 for an Autotrader valuation resold through MotorCheck. Autotrader Connect is the best-documented API: trade, private, retail and part-exchange values, five condition grades, and historic and future trends.

### Cited Findings
**FOS-recognised guide set**
- FOS business guidance names its starting-point guides as "CAP, Glass's, Autotrader (the valuation guide, not sales adverts) and Percayso". — [FOS business page: vehicle valuations and write-offs](https://www.financial-ombudsman.org.uk/businesses/resolving-complaint/complaints-deal/insurance/motor-insurance/vehicle-valuations-write-offs) (snippet seen through search; not fetched)
- FOS decisions say it compares a valuation with "online motor valuation guides such as AutoTrader, CAP, Percayso and Glass's". — [FOS DRN-4240912](https://www.financial-ombudsman.org.uk/decision/DRN-4240912.pdf)
- Guides disagree because they use "different data and algorithms". In one case CAP gave £13,350, Cazoo/Cazana (now Percayso) £15,411 and Glass's £14,840 for the same car, and Auto Trader was also considered. — [FOS DRN-3788739](https://www.financial-ombudsman.org.uk/decision/DRN-3788739.pdf)
- Older context: in 2018 the FOS adopted Cazana valuations for assessing written-off vehicles. — [Motor Finance Online](https://www.motorfinanceonline.com/news/financial-ombudsman-adopts-cazana/); [AM Online, Oct 2018](https://am-online.com/news/supplier-news/2018/10/09/financial-ombudsman-turns-to-cazana-for-car-valuation-data)

**cap hpi (Solera): CAP Black Book and valuations**
- Solera bought HPI in 2008 and CAP in 2014, and the two combined in 2015. — [Solera/Audatex](https://audatex.co.uk/news/solera-audatex-in-the-uk)
- cap hpi trade values come in three conditions, Clean, Average and Below Average, indexed by manufacturer, model and derivative. — [cap hpi Trade Values (Raw Data)](https://www.cap-hpi.com/products-and-services/trade-values-raw-data)
- cap hpi valuations offer values adjusted for condition, mileage, optional extras and region, and integrate with DMS, CRM and appraisal tools. — [Solera dealer: cap hpi valuations](https://www.dealer.solera.com/products/cap-hpi/valuations)
- Claims product: "cap Vehicle Market Value Manager (MVM)" builds settlement valuations from external market data (observed transactions, auction results, dealer input, economic modelling) and produces "customer-friendly PDF reports" with a dedicated account manager. Audatex sells a "Market Value Manager" too. — [cap hpi MVM](https://cap-hpi.com/products-and-services/market-value-manager); [Audatex MVM](https://audatex.co.uk/solutions/market-value-manager/); [SoftwareOne listing](https://platform.softwareone.com/product/cap-vehicle-market-value-manager/PCP-1506-7936)
- An HPI check gives last-known mileage, MOT status, previous total-loss markers and stolen status. — [Solera claims: Total Loss Valuations](https://www.claims.solera.com/?p=364)
- Criticism (older, about 2010): Motorpoint said CAP values can be "10% adrift of the real market valuation on many models". — [AM Online 2010](https://www.am-online.com/news/2010/5/28/cap-criticised-for-driving-not-reflecting-the-market-/22269/)
- Pricing: not published.

**Glass's (J.D. Power Europe, formerly Autovista Group)**
- J.D. Power agreed to buy Autovista Group (owner of Glass's and Eurotax) in September 2023 and completed in about March 2024. Terms were not disclosed. — [AM Online](https://www.am-online.com/news/acquisitions-and-deals/2023/09/12/autovista-group-glass-s-owner-is-taken-over-by-jd-power); [J.D. Power press release](https://www.jdpower.com/business/press-releases/autovista-group-acquisition-announcement)
- Glass's "Market Value Assessor" is a claims tool. It has VRM lookup, a total-loss indicator with adjustable repair-cost and valuation-ratio settings, and a shared workspace for images and notes. Glass's says its data is "trusted by the Financial Ombudsman Service" and offers historic residual-value data. — [J.D. Power Market Value Assessor](https://www.jdpower.com/business/market-value-assessor/); [Glass's insurance sector](https://glass.co.uk/sector/insurance/)
- J.D. Power's "Web Services API" (REST) appears to be North American (VIN Precision+). An "Autovista API" exists for European market values and forecasts. No public UK insurance-valuation API documentation or pricing was found. — [J.D. Power Web Services API](https://www.jdpower.com/business/web-services-api/); [Autovista API](https://jdpower.com/business/autovista-api/)
- Glass's has published marketing on data for "a Financial Conduct Authority investigation", aimed at the FCA total-loss work. — [glass.co.uk](https://glass.co.uk/?p=15003)
- Pricing: not published.

**Autotrader (Autotrader Connect APIs)**
- Through the Vehicles, Stock and Valuations APIs, "Current Valuations" returns trade, private, retail and part-exchange values. Trade is "the value between dealers, excluding margin". The Valuations API can also return an expected price-indicator rating. — [Autotrader help: Current Valuations](https://help.autotrader.co.uk/hc/en-gb/articles/21923133513117-Introduction-to-Current-Valuations)
- Retail value is calculated from advertised prices of similar vehicles over the last 28 days. Trade compares actual trade transactions with live retail prices. Part-exchange is calibrated to sit below retail so the dealer keeps margin. — [Autotrader trade: Valuations](https://trade.autotrader.co.uk/partners/retailer/valuations)
- Trade and part-exchange values can be adjusted for condition: Excellent, Great, Good, Fair or Poor. — [Autotrader help: Current Valuations](https://help.autotrader.co.uk/hc/en-gb/articles/21923133513117-Introduction-to-Current-Valuations)
- Trended Valuations: a POST to the Valuations API returns historic, current and future values at a chosen frequency, which is useful for valuing at the accident date. Future Valuations run up to six years ahead and return null where no forecast exists. — [Trended](https://help.autotrader.co.uk/hc/en-gb/articles/21946125008029-Introduction-to-Trended-Valuations); [Future](https://help.autotrader.co.uk/hc/en-gb/articles/21945605916573-Introduction-to-Future-Valuations)
- Access is through a technology partner or direct integration. Vehicle-specific lookups first need an Autotrader Connect "Retail Essentials" integration, and there are "Go Live checks". — [Autotrader Connect](https://www.autotrader.co.uk/partners/retailer/auto-trader-connect); [Go Live checks](https://help.autotrader.co.uk/hc/en-gb/articles/22673314012573-Go-Live-checks-for-Current-Valuations)
- Insurer use: Aviva UK used Autotrader for instant total-loss settlement prices plus replacement listings (2017, older). Aviva Canada and AutoTrader.ca ran a real-time Guidewire integration in 2021 (non-UK). Autotrader valuations power Experian iCache at quote stage (2022). — [AM Online 2017](https://am-online.com/news/supplier-news/2017/11/27/auto-trader-power-aviva-s-accident-assessment-tool); [Insurance Canada 2021](https://www.insurance-canada.ca/2021/04/15/aviva-autotrader-icta-car-worth); [Auto Trader plc / Experian](https://plc.autotrader.co.uk/news-views/press-releases/auto-trader-and-experian-join-forces-in-first-of-its-kind-data-driven-partnership/)
- Price via reseller: an Autotrader valuation through MotorCheck costs £0.40 per value returned. — [MotorCheck help](https://help.motorcheck.co.uk/en/articles/4730661-auto-trader-valuations)
- Direct Autotrader Connect pricing: not published. It is also unclear whether Autotrader licenses Connect to non-retailers such as engineering firms; this was not confirmed.

**Percayso Vehicle Intelligence / Cazana**
- Percayso Inform bought the Cazana data platform from Cazoo on 22 Feb 2023 and renamed it Percayso Vehicle Intelligence (PVI). Terms were undisclosed. Cazoo had bought Cazana in 2021 for about £25m. — [MarketScreener](https://www.marketscreener.com/quote/stock/CAZOO-GROUP-LTD-126300451/news/Percayso-Inform-Limited-acquired-Cazana-Data-Platform-from-Cazoo-Group-Ltd-43064947); [Insurance Times](https://www.insurancetimes.co.uk/news/cazoo-sells-cazana-to-percayso-inform-for-undisclosed-sum/1443899.article); [Bdaily 2021](https://www.bdaily.co.uk/articles/2021/09/02/online-car-retailer-revs-up-data-services-with-25m-acquisition-of-insights-company)
- PVI has since been relaunched under the Cazana name, aimed at fleets and finance companies. The relaunch date is unclear: CB Insights shows a headline dated 23 Feb 2026, which should be treated with caution. — [Bodyshop Mag](https://www.bodyshopmag.com/?p=55172); [Business Motoring](https://businessmotoring.co.uk/percayso-to-rebrand-as-cazana-to-support-fleets-with-enhanced-data/); [CB Insights](https://www.cbinsights.com/company/cazana)
- Percayso "Companion" claims tool is described as "the only one in the market offering a live, retail-backed valuation" method. It can review a vehicle's past adverts, including photos, prices and mileages. It is distributed through e2e Total Loss Vehicle Management. — [BusinessCloud](https://businesscloud.co.uk/news/percayso-inks-deal-with-e2e-total-loss-vehicle-management/)
- Experian resells PVI valuation data. — [BIIA](https://www.biia.com/percayso-and-experian-partner-on-vehicle-intelligence/)
- Cazana (through MotorCheck) offers five valuation types, Trade, Retail, Supermarket, Independent and Franchise, at VRM or VIN level. Named insurer customers (vendor-sourced) are Somerset Bridge, Covea and Sabre. — [MotorCheck/Cazana](https://help.motorcheck.co.uk/en/articles/9533741-motorcheck-partners-with-cazana); [Insurance Times corporate insight](https://www.insurancetimes.co.uk/corporate-insight/improving-combined-operating-ratios-in-insurance-with-accurate-vehicle-data-cazana/1436327.article)
- Pricing: not published. No public API documentation was found.

**MotorCheck (an aggregator and reseller)**
- MotorCheck works with Auto Trader, Glass's Guide, Percayso and Brego for valuations. The Autotrader valuation costs £0.40 per value. Prices for the other providers' valuations are not published. — [MotorCheck/Percayso](https://help.motorcheck.co.uk/en/articles/9533741-motorcheck-partners-with-percayso); [MotorCheck Auto Trader valuations](https://help.motorcheck.co.uk/en/articles/4730661-auto-trader-valuations)
- Trade vehicle checks cost £3.30 per check pay-as-you-go, with monthly plans "from £1.20 per check" (ex-VAT). These prices are for history checks, not valuation-specific. — [MotorCheck partner pricing](https://partner.motorcheck.co.uk/pricing/)
- MarketCheck UK also offers a UK price API ("MarketCheck Price"). Its insurer claims-valuation workbench is stated as US-only, so UK claims valuation is not supported. — [MarketCheck UK](https://marketcheck.uk/products/marketcheck-price); [MarketCheck claims plugin](https://cowork.marketcheck.com/plugins/insurer/skills/claims-valuation)

**Parkers / Honest John (consumer guides)**
- Parkers valuations use cap hpi data. A third-party reviewer says Parkers then sets its own figures from monitoring a claimed 4,000-odd sales a day. Parkers gives private, franchised and independent dealer, and part-exchange figures. Its free valuation shows ranges, and the paid custom valuation is mileage-specific. — [Parkers pricing](https://parkers.co.uk/pricing); [The Car Expert](https://www.thecarexpert.co.uk/can-i-rely-on-used-car-price-guide-websites/)
- Honest John's consumer advice says insurers should follow the FOS process and refer to Glass's, CAP and Cazana. This is consumer advice, not a rule. — [Honest John](https://honestjohn.co.uk/askhj/answer/114810/how-can-i-challenge-the-insurer-s-valuation-of-my-written-off-car-)

**Motorway / WeBuyAnyCar (instant-buy and marketplace offers)**
- Motorway's instant figure is built from historic dealer bids on similar vehicles plus real-time market data. Motorway is a marketplace and does not buy cars itself. — [Motorway help](https://help.motorway.co.uk/hc/en-gb/articles/4410630966162-How-much-will-I-get); [Motorway WBAC alternatives](https://motorway.co.uk/guides/webuyanycar-alternatives)
- WeBuyAnyCar uses "live market data" and is an instant buyer that adjusts its offer after inspection. — [WeBuyAnyCar](https://www.webuyanycar.com/value-my-car/)
- No B2B or API data product was found for either company.

### Inferences
- A defensible engine should query at least two, ideally all four, of the FOS-named guides (CAP, Glass's, Autotrader valuation, Percayso/Cazana) at the accident date, using the retail figure for the right mileage and spec. It should store the raw responses, timestamps and condition inputs as an audit trail.
- Autotrader's Trended Valuations fit retrospective PAV work, such as a report written weeks after the loss, because they give historic values by date.
- Motorway and WBAC offers, and Parkers part-exchange figures, are trade or disposal-side numbers. They sit below retail replacement cost and should not be the PAV basis for a claimant or policyholder. At most they can be shown as context.
- Commercially, an engineering-report application is more likely to get guide data through resellers or aggregators (MotorCheck, Experian) or enterprise contracts than through self-serve APIs.

### Gaps
- No published prices for CAP, Glass's, Percayso/Cazana or direct Autotrader Connect. The only published unit price is £0.40 per Autotrader value through MotorCheck.
- Whether Autotrader Connect, CAP or Glass's will license to independent engineers or assessor software, and on what terms, was not found.
- Exact API schemas (mileage and options parameters) for CAP, Glass's and Percayso were not found publicly.
- Honest John's own valuation data source was not established.

## 2. The "market value" standard in UK motor total loss: FOS, FCA and Consumer Duty

### Takeaway
FOS treats market value as the retail price at a reputable dealer immediately before the loss. Its starting point is the highest retail figure from the main trade guides. An insurer can go lower only with persuasive like-for-like evidence. Averaging the guides is routinely overturned, and blanket deductions are not accepted. The FCA's March 2024 multi-firm review led to about £200m of redress for about 270,000 motorists (reported September 2025; page last updated 3–5 December 2025). It singled out flat 20% previous-write-off deductions and lowball first offers, and framed claims value under the Consumer Duty.

### Cited Findings
**FOS standard**
- Market value is "the price the vehicle would have sold for at a reputable dealership just before it was damaged or stolen". The technical note is old, about 2,900 days per the search index, and may predate later refinements. — [FOS technical note: motor valuations](https://www.financial-ombudsman.org.uk/publications/technical_notes/motor-valuation.html)
- FOS expects insurers to use retail figures from trade guides, not trade figures. A trade-based figure was rejected where retail values were substantially higher. — [FOS DRN-5655696](https://www.financial-ombudsman.org.uk/decision/DRN-5655696.pdf)
- The "starting point for any settlement should be the highest valuation returned by the trade guides". An insurer that averaged the guides (Tradex) was told to pay the highest guide figure of £3,139. — [FOS DRN-6207635 / DRN-5649754 per search summary](https://www.financial-ombudsman.org.uk/decision/DRN-6207635.pdf)
- If an insurer cannot show its valuation would buy a like-for-like replacement, the usual direction is the highest guide value. — [FOS DRN-5710536](https://www.financial-ombudsman.org.uk/decision/DRN-5710536.pdf)
- Recent decisions expect payment close to the highest guide unless the insurer has evidence for a lower value. Earlier decisions accepted a figure "within the range" of the guides. — [FOS DRN-5912415](https://www.financial-ombudsman.org.uk/decision/DRN-5912415.pdf); [DRN-5457156](https://www.financial-ombudsman.org.uk/decision/DRN-5457156.pdf); older range approach: [DRN-4006669](https://www.financial-ombudsman.org.uk/decision/DRN-4006669.pdf)
- Outliers: in one case the ombudsman directed the average of the two guides that looked most accurate rather than all guides. — [FOS DRN-3892812 (per search summary)](https://www.financial-ombudsman.org.uk/decision/DRN-3892812.pdf)
- Adverts can justify departing from the guides if persuasive, or can stand in where the guides cannot value an older car. A higher-mileage advert was not persuasive. Adverts must be like-for-like, because sellers set their own asking prices. — [FOS DRN-4750573](https://www.financial-ombudsman.org.uk/decision/DRN-4750573.pdf); [DRN-5364690](https://www.financial-ombudsman.org.uk/decision/DRN-5364690.pdf); [DRN-4947277](https://financial-ombudsman.org.uk/decision/DRN-4947277.pdf); [DRN-5786024](https://www.financial-ombudsman.org.uk/decision/DRN-5786024.pdf); [DRN-4996564](https://www.financial-ombudsman.org.uk/decision/DRN-4996564.pdf)
- The FOS technical note says cars increasingly sell at or near advertised prices, so adverts carry more weight than they used to. — [FOS technical note](https://www.financial-ombudsman.org.uk/publications/technical_notes/motor-valuation.html)
- An engineer's valuation is not automatically persuasive where it is unclear that real expertise was applied. — [FOS DRN-4719022](https://financial-ombudsman.org.uk/decision/DRN-4719022.pdf)
- Insurers have argued that following the FOS approach is not a regulatory requirement. FOS decides on what is "fair and reasonable in all the circumstances". — [FOS DRN-5538684](https://www.financial-ombudsman.org.uk/decision/DRN-5538684.pdf)

**FCA work (dates matter)**
- Dec 2022: the FCA first warned insurers about undervaluing total-loss claims. — [FCA press release Sep 2025](https://www.fca.org.uk/news/press-releases/over-270000-motorists-receive-motor-insurance-compensation-insurers)
- June 2023: a Voluntary Requirement on Direct Line Group to review total-loss claims settled 1 Sep 2017 to 17 Aug 2022 and pay redress. One outlet reported a £30m bill, which is single-source. The requirement was later removed after the programme concluded. — [Post Magazine](https://www.postonline.co.uk/news/7953704/direct-line-ordered-by-fca-to-reassess-historical-total-loss-claims); [Insurance Business](https://insurancebusinessmag.com/uk/news/auto-motor/direct-line-responds-to-fcas-notice-to-reassess-claims-450965.aspx); [Insurance Business 2025](https://www.insurancebusinessmag.com/uk/news/auto-motor/motorists-set-to-receive-200-million-in-compensation-as-insurers-overhaul-claims-practices-550282.aspx)
- 27 Mar 2024: the multi-firm review covered 12 firms (about 70% of the market), and 6 more firms were later engaged (about 90%). Findings: some average settlements were below guide prices. Most firms deducted 20% for any previous total-loss category "without considering individual circumstances". Some first offers were below market value and only raised on challenge. Most firms collected no basic MI on uplifts to offers, and outsourced oversight was weak. All firms used trade valuation guides "in line with the FOS approach", and some aligned closely to retail guide prices. — [FCA multi-firm review](https://www.fca.org.uk/publications/multi-firm-reviews/findings-multi-firm-review-insurers-valuation-vehicles); [Insurance Times](https://www.insurancetimes.co.uk/news/fca-identifies-areas-for-improvement-in-insurers-valuation-of-vehicles/1451509.article); [Grant Thornton](https://www.grantthornton.co.uk/insights/fca-finds-issues-in-insurers-valuation-of-total-loss-motor-claims/)
- Consumer Duty: the Duty was not in force for the period reviewed, but the FCA flagged practices that "may have fallen short". The review applies to all insurers and third parties involved in valuing vehicles, which takes in outsourced valuers and engineers. — [FCA multi-firm review](https://www.fca.org.uk/publications/multi-firm-reviews/findings-multi-firm-review-insurers-valuation-vehicles)
- Sep 2025: about 270,000 motorists are owed about £200m. By then £129m had been paid to almost 150,000 customers. The FCA also found automatic deductions for assumed pre-existing damage. Firms "overhauled claims processes in line with the Consumer Duty". The press release was last updated 5 Dec 2025. — [FCA press release](https://www.fca.org.uk/news/press-releases/over-270000-motorists-receive-motor-insurance-compensation-insurers)
- The same figures appear in the FCA's response to the Which? super-complaint and in Enforcement Watch. — [FCA response to Which?](https://www.fca.org.uk/publication/corporate/fca-response-which-super-complaint.pdf); [Enforcement Watch 2](https://www.fca.org.uk/publications/newsletters/enforcement-watch-2)
- Admiral reportedly provisioned £50m. This is single-source and unverified. — [search summary citing trade press; see Insurance Age](https://www.insuranceage.co.uk/insight/7954687/fca-warns-insurers-again-on-undervaluing-total-loss-motor-claims)

### Inferences
- For the AI assistant, a defensible default is: retail value; the highest of the FOS-named guides, or a reasoned departure from it; correct mileage and spec at the loss date; any deduction justified by vehicle-specific evidence; and a record of the guides consulted. That matches both the FOS benchmark and the FCA's MI and fair-value expectations.
- Under the Consumer Duty, an engineer's PAV that feeds an insurer's first offer is part of the "fair value" outcome. Undocumented averaging or blanket deductions create regulatory risk for the instructing insurer.

### Gaps
- No 2026 FCA publication on total-loss valuations surfaced. The latest is the December 2025 update; what changed in it is unknown because the page could not be fetched.
- The current FOS consumer and business pages could not be fetched, so the exact present wording and date of the four-guide statement are unconfirmed.

## 3. What UK courts accept for PAV (credit hire and total-loss litigation)

### Takeaway
In tort, the measure for a write-off is the cost of a reasonable replacement, that is market (replacement) value, net of salvage if the claimant keeps the vehicle. Darbishire v Warran [1963] 1 WLR 1067 (CA) is the root authority. In practice, county courts take PAV from the engineer's report, usually built on Glass's or CAP, and it is often agreed. No recent appellate authority settling guides versus adverts was found.

### Cited Findings
- Darbishire v Warran (CA 1963): the claimant spent £192 repairing a car worth about £80–85 on trade-guide and market evidence. He recovered only replacement market value, because mitigation limits recovery where repair is uneconomic. — [LawCare Nigeria summary](https://lawcarenigeria.com/darbishire-v-warran-1963-ewca-civ-2-30-july-1963/); [Stokes v McAuley (NI)](https://www.judiciaryni.uk/files/judiciaryni/decisions/Stokes%20%28Gemma%29%20v%20McAuley%20%28Robert%20James%29.pdf); [i-law](https://www.i-law.com/ilaw/doc/view.htm?id=146364)
- PAV is the money equivalent of pre-accident value and "can be assessed on the basis of tables and guides to the second-hand value of vehicles" (legal-text summary). Northern Ireland cases show parties arguing over a guide "mid book" figure versus retail. — [Stokes v McAuley](https://www.judiciaryni.uk/files/judiciaryni/decisions/Stokes%20%28Gemma%29%20v%20McAuley%20%28Robert%20James%29.pdf); [McAteer v Kirkpatrick (NI)](https://www.judiciaryni.uk/files/judiciaryni/decisions/McAteer%20%28William%29%20v%20Kirkpatrick%20%28Stuart%29.pdf)
- EUI Ltd (t/a Admiral) v Vaughn Smith [2024] EWHC 2803 (KB), an appeal from the Central London County Court: the engineer's report gave PAV £615 "based on Glass's Guide and took account of three incidents of 'Total Loss'". The court's reasoning on value was not retrieved. — [vLex](https://vlex.co.uk/vid/eui-ltd-t-admiral-1058338417)
- Weightmans case note: an engineer's declaration gave a PAV (less salvage) of £2,394 for a Mercedes said to be an undriveable write-off, and the expert evidence was challenged as "not what it seems". This shows courts and defendants scrutinise engineer independence and method. — [Weightmans](https://www.weightmans.com/media-centre/news/when-expert-engineering-evidence-in-a-vehicle-damage-and-credit-hire-claim-is-not-what-it-seems/)
- Commentary notes there "appears to be a lot less argument where pre-accident values are concerned" than over hire. — [Keoghs: Loss of use](https://keoghs.co.uk/keoghs-insight/loss-of-use)
- Credit hire framework (context): Lagden v O'Connor (HL) on recovering credit hire rates; Copley v Lawn and Maden v Haller (CA 2009) on mitigation, citing Darbishire. — [EWCA Civ 2014/357](https://caselaw.nationalarchives.gov.uk/ewca/civ/2014/357); [SWARB](https://swarb.co.uk/?p=102713)
- Recent county court decisions that may touch PAV, found but not read: Piercy v Kangethe [2025] EWCC 11 and Wiltshire v Aioi Nissay Dowa [2025] EWCC 13. — [EWCC 2025/11](https://caselaw.nationalarchives.gov.uk/ewcc/2025/11); [EWCC 2025/13](https://caselaw.nationalarchives.gov.uk/ewcc/2025/13)

### Inferences
- Courts and FOS converge on replacement (retail) value. A court is less mechanical than FOS's "highest guide" rule and will weigh expert evidence. The engineer's report must therefore show its method: which guides, which retail figure, adjustments, like-for-like adverts, and salvage, consistent with CPR Part 35 expert duties.
- An AI assistant should produce a transparent workings table rather than a single number, because courts scrutinise unexplained engineer PAVs.

### Gaps
- No full judgment text was retrieved; the national archives site was blocked. The holdings of [2025] EWCC 11 and 13 on PAV are unknown.
- No modern appellate authority was found specifically choosing trade-guide retail over adverts, or the reverse.

## 4. Adjustments: mileage, condition, history, previous write-off category, extras, private plate

### Takeaway
The guides adjust for mileage, spec and options, and condition: Autotrader uses five grades and CAP three trade grades. FOS penalises valuations that assume excellent condition without basis. A previous Cat S or N deduction is allowed only if evidenced for the specific vehicle; a blanket 20% is not. Private plates do not change PAV and are handled as a retention or administrative issue.

### Cited Findings
- Guide valuations account for specification, extras and mileage. — [FOS DRN-3414585](https://www.financial-ombudsman.org.uk/decision/DRN-3414585.pdf)
- FOS rejected a valuation that assumed excellent condition for a high-mileage car with no service history (case study 22/15). — [Ombudsman news issue 22 (older)](https://www.financial-ombudsman.org.uk/files/2809/22.pdf)
- Autotrader: condition grades Excellent, Great, Good, Fair and Poor on trade and part-exchange values. CAP: trade grades Clean, Average and Below Average. cap hpi offers mileage, options and regional adjustments. — [Autotrader help](https://help.autotrader.co.uk/hc/en-gb/articles/21923133513117-Introduction-to-Current-Valuations); [cap hpi trade values](https://www.cap-hpi.com/products-and-services/trade-values-raw-data); [Solera cap hpi valuations](https://www.dealer.solera.com/products/cap-hpi/valuations)
- Previous total loss: FOS "may decide it's fair" to deduct for the difference in market value, but the insurer must show the impact on market value. Evidence examples: a 20% deduction upheld because comparable adverts showed the marker's effect, and a 17.6% deduction against research claiming 32.30% across 27 Cat N cars. A deduction may not apply where the consumer bought unknowingly after reasonable checks. — [FOS FAQ](https://www.financial-ombudsman.org.uk/faqs/all/sort-complaints-car-write-offs-valuations); [FOS DRN-4060961 and related, per search summary](https://www.financial-ombudsman.org.uk/decision/DRN-4060961.pdf); [DRN-5206901](https://www.financial-ombudsman.org.uk/decision/DRN-5206901.pdf)
- The FCA criticised a flat 20% deduction "in any category" without individual consideration. — [FCA multi-firm review](https://www.fca.org.uk/publications/multi-firm-reviews/findings-multi-firm-review-insurers-valuation-vehicles)
- Retail market discount ranges for Cat cars, from commercial blogs (low reliability): Cat N about 20–40% below market and Cat S about 30–50% below. — [Raw2K](https://www.raw2k.co.uk/news/category-s-vs-category-n-which-salvage-car-offers-better-value)
- Private plates: one ombudsman said an original versus a cherished plate "wouldn't change the valuation". Plate disputes turn on retention handling. One provisional view was that the plate was not an insurable interest; one case awarded £100 distress where the insurer failed to remove the plate; one made the insurer cover a replacement plate after its failure. — [FOS DRN-4107118 / DRN-6002876 and others, per search summary](https://www.financial-ombudsman.org.uk/decision/DRN-4107118.pdf)

### Inferences
- The assistant should record mileage at loss (from MOT history), spec and options, a condition grade with photo justification, service history and the write-off marker. Any category deduction must come from a vehicle-specific comparable evidence set, never a fixed percentage.

### Gaps
- No authoritative guidance was found on service-history adjustment percentages.
- FOS's current position on Cat S versus Cat N deduction levels, if it distinguishes them, was not found.

## 5. Salvage value conventions and categories

### Takeaway
Since 1 October 2017 the ABI Salvage Code uses Cat A (scrap), B (break), S (structural, repairable) and N (non-structural, repairable). The ABI published an updated Code dated 28 May 2025 that covers EVs and hybrids. Salvage is measured as the sale price as a percentage of PAV ("gross returns"). No published UK SYNETIQ, Copart UK or e2e return percentages were found. Rule-of-thumb figures of about 20–40% are low-reliability.

### Cited Findings
- Categories A, B, S and N replaced C and D from 1 Oct 2017. S is structural-frame or chassis damage, repairable; N is non-structural, repairable. — [Copart UK 2017](https://www.copart.co.uk/Content/UK/EN/Member-News/Categories-replacement-S&N); [Fleet News 2017](https://www.fleetnews.co.uk/news/fleet-industry-news/2017/08/03/self-insured-fleets-should-heed-changes-to-motor-salvage-code)
- Current ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage, dated 28.05.2025, covering electric and hybrid vehicles. — [ABI PDF](https://www.abi.org.uk/globalassets/files/publications/public/motor/2019/codepracticecategorisationmotorisedvehiclesalvagemay2025.pdf)
- Copart describes "gross returns" as salvage sale price divided by pre-accident value (ACV). Its US returns have risen substantially since 2022 (US data). — [Insurance Times interview with Copart UK MD](https://www.insurancetimes.co.uk/analysis/insurers-could-be-on-the-hook-for-future-liability-says-copart-uks-md/1432555.article); [Repairer Driven News Nov 2025](https://www.repairerdrivennews.com/2025/11/24/copart-reports-all-time-high-average-selling-prices-as-total-loss-frequency-remains-up/)
- Copart's UK MD said US cars tend to be salvaged at about 50% PAV repair cost, while the UK threshold is "much higher". Commercial blogs put typical economic thresholds at 50–70% of PAV. — [Insurance Times](https://www.insurancetimes.co.uk/analysis/insurers-could-be-on-the-hook-for-future-liability-says-copart-uks-md/1432555.article); [Raw2K](https://www.raw2k.co.uk/news/the-repairable-vs-non-repairable-salvage-categories-explained)
- "Most salvage vehicles retain 20–40% of their original worth" comes from a consumer source with low reliability. Salvage buyback reduces the settlement by the salvage value. — [car.co.uk](https://www.car.co.uk/media/blogs/scrapping-your-car/what-is-the-salvage-value-of-my-car-expert-insights)
- Market structure: the CMA reviewed Copart/Hills Salvage, and IAA/SYNETIQ and e2e are the other major UK players. The filing excerpt had no return data. — [CMA document](https://assets.publishing.service.gov.uk/media/641c357e5155a200136ad504/Proposed_redacted_Response_to_P1_Decision_for_publication_-_clean_-_amended.pdf)

### Inferences
- Rather than hard-coding a percentage, the assistant should estimate salvage from actual auction results (Copart, SYNETIQ, e2e sold-lot data, if licensable) or from a salvage agent's bid. It should flag that S, N and B returns differ, and show PAV less salvage when the claimant retains the vehicle, as engineers' declarations commonly do.

### Gaps
- No published UK salvage-return percentages by category. Copart UK, SYNETIQ and e2e sold-price data access and costs were not found.
- The 2025 ABI Code's changes beyond EV and hybrid coverage were not confirmed; the PDF was not read.
