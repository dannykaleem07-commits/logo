# OEM parts catalogue data for a UK accident-damage estimating app: sources, access, licensing, cost and legal limits (as of Nov 2026)

Method note: 33 web searches were run. Every direct page fetch was blocked by the session network (legal.lexcom.de, legislation.gov.uk and miniwholesaleconnect.com all failed DNS). So every finding below comes from search-result snippets and summaries, not full-page reads. Treat exact wording as "per search summary" and check it against the primary page before relying on it. Undated pages are marked as such. Where no price was found it says "not published". No price has been estimated.

## 1. Which providers license OEM parts data (part numbers, descriptions, supersessions, prices) for third-party software, and how is it accessed?

### Takeaway
No public "all makes, VIN-level, OE part number + UK list price" API with redistribution rights turned up. The realistic licensed routes are:
- (a) Commercial aggregators that license OEM data directly from manufacturers and expose APIs: Infomedia (Microcat), Partly, Infopro Digital Automotive, and to some extent TecAlliance, which mainly covers aftermarket data with OE cross-references.
- (b) The estimating incumbents' own platforms (Audatex/Solera, GT Motive, DAT), which offer integration interfaces rather than resale of raw data.
- (c) The manufacturers' RMI portals (B2B Connect, erWin, BMW AOS, Ford Service Info/Microcat Market, Stellantis Service Box) and LexCom's partslink24. These are per-user web portals licensed for the subscriber's own use. They are not data feeds.

### Cited Findings
**partslink24 (LexCom Informationssysteme GmbH)**
- partslink24 provides OEM manufacturers' information about genuine spare parts. Its terms say it sells no parts and offers no information beyond its database contents. [partslink24 GTC (LexCom)](https://legal.lexcom.de/legaldocs/partslink24-tos/-/10/en/tos-prev.html)
- Its intended users are aftermarket participants: authorised dealers, parts dealers and independent garages. [partslink24 GTC](https://legal.lexcom.de/legaldocs/partslink24-tos/-/9/en/tos-prev.html)
- Access is a user contract, concluded by clicking "Pay now". Prices are shown in a country-specific "Subscription" field on the site, not in the terms. Users other than dealers can install it as a Progressive Web App within their subscription. LexCom may invite users to try it free for a period. [partslink24 GTC v10](https://legal.lexcom.de/legaldocs/partslink24-tos/-/10/en/tos-prev.html)
- A version of the terms with marked amendments, dated July 2026, exists (per search summary). Its scraping and redistribution clauses could not be read because the fetch was blocked. [partslink24 GTC](https://legal.lexcom.de/legaldocs/partslink24-tos/-/10/en/tos-prev.html)
- Škoda's page describes a flat subscription covering all functions for one price, with no amount given. [Škoda Norway partslink24 page](https://www.skoda-auto.no/ekstern/partslink24)
- BMW's own 2026 "order correct parts" flyer points independents to AOS ETK or partslink24 to find correct part numbers. [BMW Partners in Quality flyer 2026](https://partnersinquality.bmwgroup.com/media/ywzkzc1h/bmw_at_order-correct-parts-flyer_2026.pdf)
- partslink24 joined CIECA, the collision-industry data-standards body, as a corporate member. A 2020 release called it a subsidiary of the family-owned LexCom with about 350 staff. [FenderBender](https://www.fenderbender.com/running-a-shop/tools/article/55043588/partslink24-joins-cieca-as-corporate-member)
- No public partslink24 developer API, data-feed or OEM-data sublicensing programme was found in two targeted searches, one of them in German. [search results incl. partslink24 GTC](https://legal.lexcom.de/legaldocs/partslink24-tos/-/6/en/tos-prev.html)

**Infomedia (Microcat EPC; Australian listed company)**
- Its VIN API returns vehicle details from a VIN, or from a licence plate plus country code where supported. [Infomedia VIN API](https://www.infomedia.com.au/apis/vin-api/)
- Its Parts API takes the vehicle ID from the VIN API and returns the correct parts for that vehicle, with updated part numbers (supersessions), quantities and pricing based on country. It is aimed at OEMs, dealers and authorised partners. [Infomedia Parts API](https://www.infomedia.com.au/apis/parts-api/)
- A separate "VIN Parts eCommerce API" returns specification data and applicable parts, including supersessions. [Infomedia VIN Parts eCommerce API](https://www.infomedia.com.au/apis/vin-parts-ecommerce-api/)
- Microcat PRO offers "punch out" APIs to approved third parties such as DMS or workshop solutions, so access is approval-based. [Infomedia Microcat PRO](https://www.infomedia.com.au/microcatpro/)
- Infomedia runs Ford's UK independent-trade catalogue, "Ford Microcat Market". See section 3 for the price. [Infomedia FordMarket UK order form](https://www.infomedia.com.au/files/training/market/ford/FordMarket-Order-Form-United-Kingdom_EN.pdf)
- No list of UK brands covered by the Parts API, and no UK onboarding terms, were found. [Infomedia APIs](https://www.infomedia.com.au/apis/)

**Partly (New Zealand; UK collision network)**
- Partly says it licenses OEM data directly from vehicle manufacturers and also uses government databases, production-line and port changes, and local content. [Partly – How it works](https://partly.com/how-it-works)
- Where OEM data is unavailable, it builds manufacturer catalogues using its "Vehicle Definition Standard". It offers data licensed for specific projects. [Partly – How it works](https://partly.com/how-it-works); [Partly OEM use case](https://www.partly.com/use-case/oems)
- Its UK Collision Repair Network makes VIN-based parts recommendations from collision area and severity, with real-time purchase from participating suppliers. [Partly UKCRN](https://www.partly.com/sales-channels/ukcrn)
- The Partly API exposes a parts catalogue (GAPC) and a vehicle database (UVDB). A third-party listing quotes a starting price of "$0.04 per month". This is an aggregator listing and not reliable. [TrustRadius – Partly API](https://www.trustradius.com/products/partly-api/reviews)
- Partly lists a GT Motive integration covering parts databases, labour times and graphics. [Partly – GT Motive integration](https://www.partly.com/integrations/gt-motive)

**TecAlliance / TecDoc**
- TecDoc is the independent-aftermarket (IAM) parts data standard. Its data carries OE numbers as reference and cross-reference numbers so equivalent aftermarket parts can be found. [Prodexa – What is TecDoc](https://prodexa.com/en/kb/tecdoc/)
- Delivery channels are the TecDoc Catalogue, TecDoc Web Service, data packages and the TecDoc IDP APIs. [Prodexa](https://prodexa.com/en/kb/tecdoc/)
- One guide says TecDoc is not the right fit for single-brand OEM-only sellers, because each OEM runs its own catalogue with its own structure. [dev-opla](https://dev-opla.com/resources/what-is-tecdoc-auto-parts-ecommerce-guide)
- TecRMI supplies OE-compliant repair, maintenance and diagnostic data for common makes. [AutoMARKET – TecRMI](https://www.AutoMARKET.rs/en/Product/TecRMI)
- A truck VIN catalogue launched in 2020 to identify vehicles by VIN without needing an OEM EPC. No passenger-car equivalent was found. [Tyrepress 2020](https://tyrepress.com/2020/06/tecalliance-introduces-tecdoc-vin-catalogue-truck)
- No TecAlliance licence terms or prices for OE data were found.

**Infopro Digital Automotive (owns HaynesPro and, since 2025, Eucon and GiPA)**
- OnePro Shop is a B2B catalogue claiming 98% aftermarket parts coverage of the European car parc and more than 860 brands, with comparison of prices and OE/IAM references. [Infopro Digital Automotive – OnePro Shop](https://www.infopro-digital-automotive.com/onepro-shop-spare-parts-ecommerce/)
- HaynesPro data is delivered via web services and APIs. An "OE Parts Dataset" is offered to parts manufacturers. [Infopro Digital Automotive UK – OEM parts & diagnostic tool manufacturers](https://www.infopro-digital-automotive.com/uk/work-together/oem-parts-and-diagnostic-tool-manufacturers/)
- Infopro Digital acquired Eucon Automotive, a pricing and data provider, in 2025. [Webull/press, AAPEX 2026](https://www.webull.com/news/15861015353793536)
- In September 2026 it signed an exclusive HaynesPro–TEXA AI agreement (per search summary).
- Nothing was found on whether Infopro sells OE list prices by VIN via API. Sidexa, its French estimating product, did not appear in the results.

**DAT (Deutsche Automobil Treuhand) / SilverDAT**
- SilverDAT calculatePro builds estimates on original spare parts, country-specific spare part prices and manufacturer/importer labour values. [DAT – calculatePro product description](https://dynamic-www.dat.de/fileadmin/de/download/rechtliches/produktbeschreibung-silverdat-calculatepro-english-version.pdf)
- DAT disclaims any warranty of the currency, completeness or accuracy of supplier-sourced data. [DAT T&Cs](https://www.dat.de/unternehmen/rechtliches/termsandconditions/251001-en-de)
- It has a "SilverDAT Interface Partnership" and "Special Terms and Conditions for Developer Access for DAT Interfaces", so customers can integrate individual SilverDAT functions into their own applications. [DAT Interface Partnership](https://www.datgroup.com/products/interface-partnership); [DAT T&Cs PDF](https://www.dat.de/fileadmin/media/download/terms-and-conditions/251001-en-de.pdf)
- No fees were found, and no confirmation of a UK parts-price dataset.

**Solera / Audatex UK**
- AudaConnect is an encrypted API platform. Data is released only after Audatex grants permission to the customer. [Audatex – AudaConnect](https://audatex.co.uk/solutions/audaconnect)
- AudaBridge is a hosted integration service offering web-service and IBM WebSphere MQ interfaces. [Audatex – AudaBridge](https://audatex.co.uk/solutions/audabridge/)
- No standalone parts-data licence was found.

**GT Motive**
- GT Motive Estimate is a cloud graphical estimating system for the UK. [FF News](https://ffnews.com/companies/gt-motive-uk)
- Its campaign terms restrict use to UK retail repairers working on UK-registered vehicles, with single-user credentials. [GT Motive campaign T&Cs](https://marketing.gtmotive.com/external/files/EN/terms-and-conditions-campaign.pdf)
- No public API or data licence was found.

**OEConnection (OEC)**
- In the UK and Ireland OEC sells "VISION" (CollisionLink Broker in other international markets). Parts are validated using manufacturers' EPCs, and it integrates with "leading estimating systems". [OEC UK](https://oeconnection.com/en_GB/?p=10425); [OEC CollisionLink Broker – OEMs](https://oeconnection.com/en_GB/products/collisionlink-broker-oems/)
- OEC has acquired PartsTech. [Ratchet+Wrench](https://www.ratchetandwrench.com/site-placement/latest-news/article/55265852/oec-acquires-partstech-to-enhance-service-offerings)
- PartsTech's API terms limit use to integrating with its platform and bar sharing API keys with third parties. [PartsTech API terms](https://partstech.com/api-agreement-terms/)

**Manufacturer portals**
- Mercedes-Benz B2B Connect (UK, run by Mercedes-Benz UK Ltd): parts research by model or VIN. The platform builds vehicle data from the VIN to match parts. It shows "full transparency of parts prices, specific to your business", and orders go through an authorised partner. [B2B Connect UK](https://b2bconnect.mercedes-benz.com/gb/campaign/uk-home); [B2B Connect UK terms](https://b2bconnect.mercedes-benz.com/gb/legal/terms-of-use)
- VW Group erWin: a paid portal for independents covering RMI for eight VW Group brands. Licences run by the hour, day, week, month or year. It states compliance with 2018/858 Art. 61. Whether ETKA parts data sits inside erWin was not confirmed. [erWin info](https://drivesomethinggreater.com/erwininfo); [VW Ireland](https://www.volkswagen.ie/en/owners-and-users.html/__layer/layers/ownersandusers/inspectionandrepair/inspectionandrepair/volkswagen-service/master.layer)
- BMW AOS (Aftersales Online System): subscription portal built for independent workshops. The ETK parts catalogue is reached through AOS. Fees follow an in-portal price list in euros. [AOS terms of use](https://aos.bmwgroup.com/terms-of-use); [BMW flyer 2026](https://partnersinquality.bmwgroup.com/media/ywzkzc1h/bmw_at_order-correct-parts-flyer_2026.pdf)
- Ford: ETIS has been decommissioned. The free "Ford Service Info" site (Ford Account login) offers similar features. The independent parts catalogue is Ford Ecat or Microcat Market, enrolled via a Ford Parts Plus dealer. [Ford UK – independent operators](https://www.ford.co.uk/experience-ford/news/independent-operators); [Ford UK service info](https://ford.co.uk/support/how-tos/owner-resources/vehicle-specifications/ford-service-info-resources)
- Stellantis: Service Box and ePER portals are used by UK repairers. Opel's Service Box conditions (DOCTECH CGV) cover access by independent operators. [Opel Service Box CGV](https://public-servicebox.opel.com/cgv/OV/DOCTECH_cgv_en.pdf); [Stellantis/B-Parts UK](https://www.media.stellantis.com/em-en/parts-services/press/stellantis-and-b-parts-expand-original-used-parts-offer-to-the-repairer-network-in-uk-market)

**Public EPC mirrors and VIN-to-OEM APIs**
- 7zap advertises catalogues for 70 brands and states it is independent and not affiliated with any manufacturer. [7zap](https://7zap.com/en/3)
- Eitserv sells a "VIN → OEM Parts API" that checks decoded VINs against manufacturers' EPCs. Its own comparison notes that official OEM EPCs require an authorised dealer account. [Eitserv](https://eitserv.tech/en/vin-to-oem-parts-api)
- Nothing was found on Catcar, Levam, ilcats or Laximo licensing.

### Inferences
- Infomedia and Partly are the closest match to a VIN → OE part number → country price API that an approved third party can license. Both describe direct OEM licensing. Neither publishes UK brand coverage, and both run approval gates.
- partslink24, B2B Connect, erWin and AOS are per-user portals. Nothing found suggests they license bulk data or an API to software vendors, so embedding them would need a bespoke agreement with LexCom or each OEM.
- TecDoc gives OE numbers only as cross-references attached to aftermarket articles. It is not a full OEM EPC with UK list prices.
- Eitserv-type "VIN → OEM" APIs that sit on top of OEM EPCs raise provenance and licensing questions. See section 4.

### Gaps
- partslink24's clauses on automated access and redistribution, and any B2B or data-licence offer, could not be read because the fetch was blocked.
- Neither TecAlliance nor Infopro states whether OE UK list prices are licensable for redistribution.
- Infomedia's and Partly's UK brand coverage for Parts API, and whether Mercedes-Benz is included, were not found.
- No primary documentation was found for Catcar, Levam, Laximo or Megazip.

## 2. What do EU Reg 2018/858 (Art. 61 / Annex X), UK retained law and the UK MVBEO give independent operators, and do they allow redistribution in commercial software?

### Takeaway
EU 2018/858 Art. 61 and Annex X 6.1 require manufacturers to give independent operators a VIN-searchable parts database with OE part numbers, OE part names, validity dates and fitting attributes. The CJEU (C-319/22, Scania, 9 Nov 2023) confirmed this must be in machine-readable, electronically processable form. "Reasonable and proportionate" fees are allowed under Art. 63. List prices are not named in the excerpts found.

In GB the text survives as assimilated law, but later EU amendments do not apply. A 2022 GB SI removed some RMI references, and its effect on parts data is unclear. Nothing found gives a right to redistribute RMI data inside a commercial product. Access rights are not a licence to republish.

### Cited Findings
- Art. 61(2) requires manufacturers to provide OBD information and RMI on their own websites. [Reg (EU) 2021/1244 recitals, EUR-Lex](https://eur-lex.europa.eu/eli/reg_del/2021/1244/oj)
- Annex X point 6.1 requires "information on all parts of the vehicle, with which the vehicle, as identified by the VIN and any additional criteria such as wheelbase, engine output, trim level or options, is equipped ... and that can be replaced by spare parts". This must be "in a database that is easily accessible to independent operators". The database must include VIN, OE parts numbers, OE naming of parts, validity attributes (valid-from and valid-to dates), fitting attributes and, where applicable, structuring characteristics. [legislation.gov.uk – Annex X (retained)](https://legislation.gov.uk/eur/2018/858/annex/X/2022-12-31/data.htm) (per search summary)
- CJEU C-319/22 (Gesamtverband Autoteile-Handel v Scania, 9 Nov 2023) interpreted Art. 61(1)–(2) and Annex X 6.1 on whether data must be easily accessible as machine-readable, electronically processable datasets. Trade bodies welcomed the guidance. [BAILII](https://www.bailii.org/eu/cases/EUECJ/2023/C31922.html); [CLEPA](https://clepa.eu/mediaroom/clepa-welcomes-the-ecjs-guidance-on-interpreting-existing-rmi-legislation/); [Pinsent Masons Out-Law](https://www.pinsentmasons.com/en-gb/out-law/news/eu-secondary-market-for-automotive-repair-receives-clarity-on-access-to-vehicle-data)
- The Advocate General's opinion in that case said manufacturers must disclose the VIN and rejected data-protection objections. [IAAF](https://iaaf.co.uk/news/court-says-vms-are-obliged-to-disclose-vin-to-independent-operators/)
- Art. 63(1) allows reasonable and proportionate fees for RMI other than the Art. 61(10) records. [legislation.gov.uk Art. 63](https://legislation.gov.uk/eur/2018/858/article/63/2020-01-31)
- Until a common standard applies, information must be presented so independent operators can process it with reasonable effort. The standard referenced is EN ISO 18541 parts 1–5. [legislation.gov.uk Art. 61](https://legislation.gov.uk/eur/2018/858/article/61/2022-12-31?view=plain)
- Commission Delegated Regulation (EU) 2026/699 of 23 March 2026 amends Annex X on standardised and secure access. Its rationale says manufacturers may not impose conditions beyond those in the Regulation (EU only). [EUR-Lex 2026/699](https://eur-lex.europa.eu/eli/reg_del/2026/699/oj/eng)
- "Independent operator" (Art. 3(45)) means a person other than an authorised dealer or repairer who is directly or indirectly involved in repair and maintenance. The predecessor Reg 595/2009 expressly lists "publishers of technical information". The full 2018/858 list could not be confirmed. [BAILII C-319/22](https://www.bailii.org/eu/cases/EUECJ/2023/C31922.html); [legislation.gov.uk 595/2009 Art 3](https://legislation.gov.uk/eur/2009/595/article/3/adopted/data.xht)
- GB position: 2018/858 is assimilated (retained) law. Later EU amendments such as 2021/1244 do not apply in GB unless DfT copies them. [Pinsent Masons](https://pinsentmasons.com/out-law/news/eu-vehicle-law-divergence-great-britain-northern-ireland)
- SI 2022/1273 (EU Exit type-approval amendments) replaced "EU type-approval" with "GB type-approval" and, in some provisions, omitted "and vehicle repair and maintenance information". [legislation.gov.uk SI 2022/1273 Part 4](https://legislation.gov.uk/uksi/2022/1273/part/4/made?view=plain)
- The VCA says the GB scheme operates under assimilated 2018/858 as amended. [VCA GB Type Approval](https://vehicle-certification-agency.gov.uk/?p=18837)
- UK competition law: the Competition Act 1998 (Motor Vehicle Agreements Block Exemption) Order 2023 (SI 2023/586) has been in force since 1 June 2023, expiring 2029. [Freeths](https://www.freeths.co.uk/insights-events/legal-articles/2023/automotive-industry-a-new-motor-vehicles-competition-law-block-exemption-is-now-in-force/); [AutoRepairFocus](https://autorepairfocus.com/uk-motor-vehicle-block-exemption-regulations-look-set-to-be-adopted-until-2029)
- In the draft CMA guidance, restricting independent operators' access to technical or vehicle information falls outside the exemption. The final Order uses defined terms "repair and maintenance information" and "vehicle information" (Art. 6(3), 6(6)). [CMA draft guidance Apr 2023](https://assets.publishing.service.gov.uk/media/643e809f6dda69000d11df63/A._2023_Apr_MVBEO_Guidance_Consultation_Document.pdf); [SMMT response](https://assets.publishing.service.gov.uk/media/6479dc22b32b9e000ca960c1/SMMT.pdf); [Government response](https://gov.uk/government/consultations/draft-order-the-competition-act-1998-motor-vehicle-agreements-block-exemption-order-2023-mvbeo/outcome/motor-vehicle-agreements-block-exemption-order-government-response)
- erWin describes itself as an "MVBER product" compliant with 2018/858 Art. 61. [erWin info](https://drivesomethinggreater.com/erwininfo)
- A 2017 ICDP/ACEA report lists missing VIN-format standards, data-usage restrictions and licence costs as barriers to linking VINs to OE numbers in the IAM. [ICDP/ACEA 2017](https://aftersalesmagazine.nl/wp-content/uploads/2017/10/icdp_acea_finalreport_oct17.pdf)

### Inferences
- RMI law gives a developer a right to buy access to the parts database (VIN, OE number, name, validity) on reasonable terms. It does not appear to grant a licence to extract the database and re-sell it inside an estimating product. The portals' own terms then govern, and Art. 63 lets manufacturers charge.
- Price data is not among the required Annex X 6.1 fields in the excerpts found. UK list prices therefore probably have to come from a commercial licence (OEM, Infomedia, Partly, Audatex/Autosoft and the like) rather than an RMI right.
- The MVBEO is competition law. It removes block-exemption cover from supply agreements that restrict independents' information access, but it gives a software company no direct data right.

### Gaps
- The full text of Art. 61(1) and Annex X 6.1 as they stand in GB law now could not be fetched.
- Whether SI 2022/1273's omissions affect the parts-database duty in GB was not established. Specialist GB legal advice or DfT/VCA guidance is needed.
- No source states whether RMI-obtained data may be redistributed. The final CMA MVBEO guidance text was not retrieved.

## 3. Indicative prices (per-user subscriptions, API fees, per-VIN fees)

### Takeaway
Almost nothing is published. The only UK figures found are old, undated Ford ones: Ecat at £7/user/month and Microcat Market at £8/user/month. partslink24, B2B Connect, erWin, AOS, DAT, Audatex, GT Motive, Infomedia, Partly and TecAlliance prices are all "not published" in the sources found.

### Cited Findings
- Ford Ecat for independents costs "just £7 per month, per user-name and password" via a Ford Parts Plus dealer. The page is undated and may be outdated. [Ford UK – independent operators](https://www.ford.co.uk/experience-ford/news/independent-operators)
- Ford Microcat Market (UK) costs £8.00 per month per named user, billed via the dealer. The form is undated. [Infomedia FordMarket UK order form](https://www.infomedia.com.au/files/training/market/ford/FordMarket-Order-Form-United-Kingdom_EN.pdf)
- partslink24: prices are country-specific in the "Subscription" field. Not published in any source found. [partslink24 GTC](https://legal.lexcom.de/legaldocs/partslink24-tos/-/10/en/tos-prev.html)
- BMW AOS: information is free or paid according to the in-portal price list, in euros. Not published externally. A dated Castrol guide lists the EPC/ETK app as free and AIR as paid. [AOS terms](https://aos.bmwgroup.com/terms-of-use); [Castrol pass-thru BMW](https://www.castrol.com/en_za/south-africa/home/learn/castrol-fastscan/pass-thru-bmw-mini.html)
- erWin: hourly, daily, weekly, monthly or yearly licences. Amounts not published in the sources found. [erWin info](https://drivesomethinggreater.com/erwininfo)
- Mercedes-Benz B2B Connect UK: prices are "specific to your business". No access-fee figure published. [B2B Connect UK](https://b2bconnect.mercedes-benz.com/gb/campaign/uk-home)
- Partly API: "$0.04 per month" starting price, per a third-party listing only and not credible as a real price. [TrustRadius](https://www.trustradius.com/products/partly-api/reviews)
- Comparators (not OEM parts data): Autodata Service & Maintenance from €94/month plus VAT; ALLDATA Repair at USD 209/month. [ki-syndikat – Autodata](https://www.ki-syndikat.de/tools/autodata/); [ki-syndikat – ALLDATA](https://www.ki-syndikat.de/tools/alldata/)

### Inferences
- An embedded multi-brand OEM parts-and-price licence will be a negotiated enterprise contract, likely priced per user, per transaction or by revenue share. No public rate card exists.

### Gaps
- No prices were found for any of these: partslink24 UK, erWin UK, AOS, B2B Connect access, Infomedia/Partly API, TecAlliance OE data, DAT interfaces, AudaConnect/AudaBridge.
- No per-VIN query fees were found for any provider.

## 4. Is scraping public EPC mirrors (7zap, PartSouq, Megazip, Amayama) or OEM portals legal for UK commercial use?

### Takeaway
High risk. UK sui generis database right (CRDR 1997, reg 16) is infringed by extracting or re-utilising a substantial part of a database, or by repeated systematic extraction of insubstantial parts. 7zap's terms (UK-governed) expressly ban automated extraction and building databases. Under *Ryanair v PR Aviation* (C-30/14), website terms can contractually bar scraping even where database right does not apply. The mirrors also hold OEM-derived data whose own licensing is unclear, which adds a further layer of third-party (OEM) rights risk.

### Cited Findings
- Database right is infringed by extracting or re-utilising all or a substantial part of a database's contents without consent (reg 16(1)). "Extraction" (reg 12) is permanent or temporary transfer to another medium by any means. [legislation.gov.uk SI 1997/3032 reg 16](https://legislation.gov.uk/uksi/1997/3032/regulation/16); [SI 1997/3032](https://www.legislation.gov.uk/uksi/1997/3032/made)
- The right subsists where there was substantial investment in obtaining, verifying or presenting the contents. [SEQ Legal](https://seqlegal.com/blog/database-right-how-it-may-protect-your-website)
- *British Horseracing Board v William Hill* (C-203/02) covers substantial part assessed qualitatively, and repeated and systematic extraction of insubstantial parts. [5RB](https://www.5rb.com/?p=5151); [SCL](https://scl.org/?p=530)
- Commentary says data mining and scraping often infringe. Bird & Bird discusses a Land Registry scraping matter (about 3.5m addresses) that also breached terms. [Bird & Bird](https://twobirds.com/en/insights/2020/global/finding-the-plot-for-database-rights); [Sprintlaw](https://www.sprintlaw.co.uk/articles/understanding-the-copyright-and-rights-in-databases-regulations-1997-what-uk-businesses-need-to-know)
- *Ryanair v PR Aviation* (C-30/14, 15 Jan 2015) held that where the Database Directive does not protect a database, the operator may still restrict screen-scraping contractually through its terms. [Portolano](https://portolano.it/news/ecj-clarifies-database-directive-scope-in-screen-scraping-case); [Kluwer Copyright Blog](https://legalblogs.wolterskluwer.com/copyright-blog/ryanair-ltd-v-pr-aviation-bv-contracts-rights-and-users-in-a-low-cost-database-law/); [Law Gazette](https://lawgazette.co.uk/legal-updates/protection-for-unprotected-databases/5046552.article)
- **7zap terms** (STANOK LLP, England and Wales; governed by UK law):
  - Prohibited: reproducing or displaying catalogue content, and extracting data by manual, automated or semi-automated means. Data may not be accumulated for independent use.
  - Free accounts are for personal use on the user's own vehicle. Paid plans grant no API access, bulk-data rights or database rights.
  - Enforcement includes IP blocking and legal remedies.
  - The Japanese version claims copyright and database right in catalogue structure, part numbers and organisation.
  [7zap Terms of Service (EN)](https://7zap.com/en/pages/terms-of-service/); [7zap ToS (JA)](https://7zap.com/ja/pages/terms-of-service/)
- Comparable parts-catalogue site terms bar "systematic retrieval of data" without written permission. [PartsHub terms](https://partshub-23839.groovehq.com/help/website-terms-of-use-1)
- 7zap disclaims any affiliation with manufacturers, so its source licensing is unknown. [7zap](https://7zap.com/en/3)

### Inferences
- Scraping 7zap, PartSouq, Megazip or Amayama at the scale an estimating product needs (all makes, all VINs, ongoing) would very likely be a "substantial part" or "repeated systematic" extraction. It would also breach the sites' terms. Commercial use in the UK is not a safe basis.
- Scraping OEM portals (partslink24, B2B Connect, AOS, erWin) would almost certainly breach their subscriber terms, which are licensed per user. It could also infringe OEM database right, and RMI access rights do not authorise it (section 2).
- UK database right still applies to UK and EEA makers after Brexit. The extra-territorial and non-UK maker position needs specialist advice.

### Gaps
- PartSouq, Megazip and Amayama terms were not found.
- No UK judgment on EPC or parts-catalogue scraping specifically was found.
- partslink24's anti-scraping clause wording could not be read because the fetch was blocked.

## 5. What do UK estimating platforms use for parts data, and can a new entrant license the same feeds?

### Takeaway
The UK incumbents (Solera Audatex/Qapter, GT Motive, plus DAT in Europe) hold their own OEM-sourced parts and price databases, augmented by:
- dealer and bodyshop-system price feeds (Autosoft → Audatex);
- OEM parts-marketplace links (OEC VISION with GT Motive; Partly);
- in Solera's case, Stellantis' Eurorepar data.

They expose integration APIs (AudaConnect, AudaBridge, the DAT interface programme) for workflow, not resale of raw parts data. A new entrant would most plausibly license from Infomedia or Partly, or from OEMs directly, rather than from the incumbents.

### Cited Findings
- Solera added Stellantis-owned Eurorepar parts data to Qapter across Europe, and to AudaSource and AEG in the UK (2025). [Audatex UK – Eurorepar](https://audatex.co.uk/solera-integrates-stellantis-owned-eurorepar-parts-data-to-improve-efficiency-in-the-european-automotive-industry/)
- Qapter is Solera Audatex's AI estimating system. [NHTSA TSB MC-10200472](https://static.nhtsa.gov/odi/tsbs/2021/MC-10200472-0001.pdf)
- Audatex repair data covers 98% of UK vehicles (WTW collaboration). [CollisionWeek 2022](https://collisionweek.com/2022/06/27/wtw-collaborates-solera-audatex-uk-develop-inflation-predictions-tool/)
- Autosoft (UK bodyshop system) automatically updates Solera Audatex parts prices "with the latest Autosoft data". [Bodyshop Magazine](https://www.bodyshopmag.com/?p=56765)
- Audatex and AutoFlow run a two-way data feed. [Audatex UK – AutoFlow](https://audatex.co.uk/solera-audatex-and-autoflow-strengthen-long-term-collaboration-to-further-improve-repair-estimating-efficiency)
- Audatex integrates with Bodynet for images. [Audatex UK – Bodynet](https://audatex.co.uk/audatex-and-bodynet-extend-existing-integration-with-automated-two-way-image-data-flow/)
- AudaConnect (permissioned API) and AudaBridge (web services/MQ) are the third-party connection routes. [AudaConnect](https://audatex.co.uk/solutions/audaconnect); [AudaBridge](https://audatex.co.uk/solutions/audabridge/)
- GT Motive partnered with OEC (2023) to give UK customers OEM parts from OEC's VISION platform, supporting insurer total-loss avoidance. [CollisionWeek 2023](https://collisionweek.com/2023/09/08/gt-motive-partners-oec-connect-uk-customers-competitive-oem-parts/); [International Fleet World](https://internationalfleetworld.com/oec-partners-with-gt-motive-to-connect-customers-with-competitive-oe-partsa/)
- OEC VISION validates parts against manufacturers' EPCs and lists "Correct RRP" as a repairer benefit. [OEC UK](https://oeconnection.com/en_GB/?p=10425); [AM-online VISION](https://www.am-online.com/r/zkevo7d3)
- DAT calculatePro uses original parts, country-specific prices and OEM labour values. [DAT](https://dynamic-www.dat.de/fileadmin/de/download/rechtliches/produktbeschreibung-silverdat-calculatepro-english-version.pdf)
- Partly's UK Collision Repair Network provides VIN, collision-area and severity-based parts recommendations, with a GT Motive integration. [Partly UKCRN](https://www.partly.com/sales-channels/ukcrn); [Partly – GT Motive](https://www.partly.com/integrations/gt-motive)

### Inferences
- The incumbents' parts databases come from decades of OEM agreements, which GT Motive markets as about 50 years of data. Nothing suggests they wholesale this data to competitors. A new estimating entrant would be a competitor, so licensing from Audatex, GT Motive or DAT is unlikely beyond end-customer integration.
- The most promising neutral suppliers are:
  - Infomedia: VIN API plus Parts API with country pricing and supersessions; runs Ford UK's Microcat Market.
  - Partly: OEM-licensed data, already active in UK collision.
  - OEC VISION: genuine-parts ordering and RRP, but brand coverage is unconfirmed.
  - OEMs directly, under RMI-based access plus a commercial redistribution licence.

### Gaps
- Thatcham's role in parts data was not researched within budget; no source was found.
- OEC VISION's UK manufacturer list was not shown in the results.
- No source confirms the actual origin of Audatex UK OE list prices (OEM direct vs dealer files).

## 6. Worked example: VIN-level lookup for a Mercedes-Benz E220d AMG Line Premium Plus 9G-Tronic (W213 2016–2023 / W214 2023-on)

### Takeaway
For Mercedes, an exact derivative such as "AMG Line Premium Plus" is a trim and option-package distinction. It cannot be resolved from the model code alone. It needs the VIN-linked datacard (SA option codes), which only Mercedes' own systems (B2B Connect, EPC/datacard) or an OEM-licensed aggregator holds. That is exactly the "VIN and any additional criteria such as ... trim level or options" that Annex X 6.1 requires manufacturers to make available.

### Cited Findings
- W213 E 220 d is model code 213.004 with the OM654 engine. Variants include 163 PS and 194 PS, plus a 200 PS version from February 2022. [B-Parts UK](https://www.b-parts.co.uk/auto-parts/vehicle/mercedes-benz-e-class-w213-e-220-d-213004-2016-996915); [Masuma catalogue](https://en.masuma.com/index/goods_detail/Suspension_Steering/STABILIZER_LINK/ML_E4005L/10971)
- European W213 E 220 d VINs appear as WDD2130042A… (model code in positions 4–9). Later cars carry the W1K213… prefix, which some third-party decoders failed to recognise. These are forum sources and unverified. [MBWorld datacard example](https://mbworld.org/forums/attachments/e-class-w213/421535d1563804058-wheel-lock-nuts-wdd2130042a510376.pdf); [MBWorld VIN decode thread](https://mbworld.org/forums/e-class-w213/820464-e-class-vin-decode.html)
- Mercedes B2B Connect UK builds vehicle data from the VIN so parts match the specific car. It can check uploaded parts lists against the VIN. [B2B Connect UK terms](https://b2bconnect.mercedes-benz.com/gb/legal/terms-of-use); [B2B Connect UK](https://b2bconnect.mercedes-benz.com/gb/campaign/uk-home)
- Annex X 6.1 requires parts identification by VIN plus criteria such as trim level and options. [legislation.gov.uk Annex X](https://legislation.gov.uk/eur/2018/858/annex/X/2022-12-31/data.htm)
- Infomedia's VIN API → Parts API pattern returns VIN-specific part numbers, supersessions and country pricing, if Mercedes is covered (unconfirmed). [Infomedia Parts API](https://www.infomedia.com.au/apis/parts-api/)

### Inferences
- Illustrative flow for the app:
  1. Decode the VIN (WDD213… or W1K213… for W213; presumably W1K214… for W214, unverified).
  2. Pull the datacard (SA codes such as the AMG Line exterior and Premium Plus package) from an OEM-licensed source.
  3. Filter the EPC parts for the damaged zone (e.g. front bumper, which differs between AMG Line and non-AMG Line).
  4. Return OE part number, latest superseded number and UK list price.

  Only a licensed source can perform step 2 reliably. Public mirrors offer it, but scraping them breaches their terms (section 4).
- B2B Connect UK appears to show business-specific prices rather than a public RRP feed. A UK list price for an estimating product therefore needs a separate commercial agreement with Mercedes-Benz UK or an aggregator.

### Gaps
- W214 VIN prefix and model code (e.g. 214.0xx for E 220 d) were not verified in the sources found.
- No source confirmed that Infomedia, Partly or partslink24 expose Mercedes UK list prices to third-party software.
