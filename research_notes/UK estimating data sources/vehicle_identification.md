# UK Vehicle Identification Data Sources (VRM/VIN to full derivative), as of Nov 2026

Method note: Fetching pages directly failed. DNS was blocked for developer-portal.driver-vehicle-licensing.api.gov.uk, documentation.history.mot.api.gov.uk, ukvehicledata.co.uk, api.checkcardetails.co.uk and cap-hpi.com. Every finding below therefore comes from search-result snippets and summaries (33 searches), not from full pages. Field names and prices should be re-checked against the live pages before anything is built on them. Where a figure came only from a summarised snippet, the note says so.

## 1. DVLA Vehicle Enquiry Service (VES) API: fields, eligibility, cost and limits

### Takeaway
VES is free with registration and keyed on the VRM only. It returns DVLA register attributes: make, colour, fuel, cc, CO2, tax and MOT status, first registration month, year of manufacture, wheelplan, type approval, revenue weight, export marker, Euro status and date of last V5C. It does **not** return a VIN, and it is generally reported **not** to return model or derivative. On its own it cannot identify an exact derivative.

### Cited Findings
- The operation is `getVehicleDetailsByRegistrationNumber`, called as `POST /v1/vehicles`. Input is the registration number only, and errors come back as 400/404/500/503. The current spec version is v1.2.0. — [DVLA VES API v1.2.0 spec](https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/v1.2.0-vehicle-enquiry-service.html); [VES description](https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/vehicle-enquiry-service-description.html)
- Fields in the spec include `monthOfFirstRegistration` (e.g. "2004-12") and a separate `monthOfFirstDvlaRegistration` (for imports). They also include `engineCapacity` (integer cc, e.g. 1796; reportedly undefined for EVs), `markedForExport` (boolean; true only if an export marker is set, and it does not mean the vehicle was actually exported), `typeApproval` (string category), `wheelplan` (string, e.g. "2 AXLE RIGID BODY" / "2 AXLE + ARTIC"), `revenueWeight` (integer kg) and `dateOfLastV5CIssued`. — [DVLA VES spec](https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/v1.2.0-vehicle-enquiry-service.html); [UK::Vehicle::Status Perl docs](https://metacpan.org/pod/UK::Vehicle::Status); [Microsoft connector docs](https://learn.microsoft.com/en-gb/connectors/dvlavehicleenquiryse)
- Other returned fields reported by secondary sources: make, colour, fuel type, CO2 emissions, MOT status and expiry, tax status and due date, year of manufacture, euroStatus and realDrivingEmissions. — [Jentic](https://jentic.com/apis/gov.uk/gov-uk); [jampez77 Home Assistant integration](https://github.com/jampez77/DVLA-Vehicle-Enquiry-Service)
- No model: one integration guide says the response gives "make, year, fuel, engine, colour, CO₂, current tax + MOT status. No model name — only make". Jentic claims make *and* model, so the sources conflict. The DVLA schema field list seen in snippets has no model field. — [lifefile vehicle lookup setup](https://lifefile-docs.pages.dev/developers/vehicle-lookup-setup/); contra [Jentic](https://jentic.com/apis/gov-uk)
- Access: you register at register-for-ves.driver-vehicle-licensing.api.gov.uk, and the form asks for estimated monthly volumes. The rate limit is set from that answer. DVLA's terms say it "will limit the rate of requests" and may amend rate plans. One developer note says the daily quota appears in the portal after approval, and another describes the APIs as "free with registration". — [VES T&Cs](https://register-for-ves.driver-vehicle-licensing.api.gov.uk/terms-and-conditions); [jampez77](https://github.com/jampez77/DVLA-Vehicle-Enquiry-Service); [lifefile](https://lifefile-docs.pages.dev/developers/vehicle-lookup-setup/)
- Technical contact: dvlaapiaccess@dvla.gov.uk. There is a UAT test endpoint. — [VES description](https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/vehicle-enquiry-service-description.html)

### Inferences
- VES works as a free sanity check (make, colour, cc, fuel, first-reg month) and for cross-checking a commercial derivative match. An estimating app still needs a commercial provider for model, derivative, VIN and codes.
- "Plate changed" detection is partly possible through `dateOfLastV5CIssued` and the first-registration fields. No VIN is returned to anchor identity.

### Gaps
- I could not read the full success schema or the default rate-limit numbers because the portal fetch was blocked. It is unconfirmed whether VES is formally stated to be free of charge, though secondary sources say it is.

## 2. DVSA MOT History API: fields, access and cost

### Takeaway
The new MOT History API replaced the legacy API, which was deprecated on 1 Sep 2025. It uses OAuth2 client credentials (Microsoft Entra) plus an API key. It covers all vehicle types including Northern Ireland, and it returns make, model (DVSA free text), colour, fuel, engine size, first-used, registration and manufacture dates, plus per-test odometer readings. It is the main free source of **mileage history**, but it has no derivative and no VIN.

### Cited Findings
- The legacy API was deprecated on 1 September 2025, and existing users must re-register for the new one. The new API "combines all vehicle types into a single API" and covers NI. — [DVSA legacy docs](https://dvsa.github.io/mot-history-api-documentation); [new API docs](https://documentation.history.mot.api.gov.uk/)
- Registration is open to an organisation, business or individual. You supply a name, contact email and postal address. Review takes up to 5 working days, and DVSA then sends an API key, client ID, client secret and a token URL with your tenant ID. — [MOT API register](https://documentation.history.mot.api.gov.uk/mot-history-api/register); [authentication](https://documentation.history.mot.api.gov.uk/mot-history-api/authentication)
- Access tokens are valid for 60 minutes, and caching is recommended (MSAL). Client secrets expire every 2 years, with warnings at 30 and 14 days, and can be renewed through the `/credentials` endpoint. Requests carry `Authorization: Bearer …`. — [authentication](https://documentation.history.mot.api.gov.uk/mot-history-api/authentication)
- Rate limits: one snippet gives a quota of 500,000 requests/day, a burst of 10 and an average of 15 requests/second. An earlier snippet said the page text was garbled, so it was unclear which of 10 and 15 is the burst. My query had suggested the 500k figure, so treat it as needing a check. — [MOT API rate limits](https://documentation.history.mot.api.gov.uk/mot-history-api/rate-limits)
- Cost: I found no explicit DVSA statement on fees. The DfT data catalogue lists the dataset as free under the Open Government Licence (OGL). — [DfT find transport data](https://findtransportdata.dft.gov.uk/dataset/mot-history-api)
- Fields: the legacy and bulk formats have vehicle-level `make`, `model`, `firstUsedDate`, `primaryColour`, `fuelType` and `engineSize` (cc as string), and per-test `odometerValue`, `odometerUnit` and `odometerResultType`. The legacy API also had `registrationDate` and `manufactureDate`. A community Go SDK for the new API lists `registrationDate`, `manufactureDate`, `engineSize` and `hasOutstandingRecall`, and a third-party wrapper says the recall flag is Yes/No/Unknown/Unavailable. — [legacy docs](https://dvsa.github.io/mot-history-api-documentation); [bulk file formats](https://documentation.history.mot.api.gov.uk/mot-history-api/download-vehicle-mot-history-data/bulk-file-formats); [0xnu/mothistory Go SDK](https://pkg.go.dev/github.com/0xnu/mothistory); [Apify wrapper](https://apify.com/onibaku/uk-mot-history)
- Bulk download of MOT history data is also offered. — [download vehicle MOT history data](https://documentation.history.mot.api.gov.uk/mot-history-api/download-vehicle-mot-history-data)

### Inferences
- Odometer readings from successive MOTs let an app estimate current mileage, which valuation needs, and flag discrepancies for free. Vehicles under 3 years old (GB) have no MOT records, so there is no free mileage history for them.
- The DVSA `model` value is coarse (e.g. "E 220"), so it is not a derivative.

### Gaps
- The exact field names in the new v1 schema were not seen directly. The Go SDK is unofficial.

## 3. Commercial vehicle-data APIs: fields, codes, access and pricing

### Takeaway
Only commercial, DVLA-licensed "VRM lookup" providers return a derivative description together with VIN, engine code and industry codes. **cap hpi** is the reference source. It returns the CAP ID/CAPcode and links to TecDoc K-type/N-type, Glass's, ABI, MVRIS and others, and it claims to be the only TecDoc-approved UK VRM lookup that includes the K-type. Write-off (MIAFTR) data reaches the market only through **HPI (cap hpi)** and **Experian AutoCheck**, so every reseller's write-off flags derive from those two. Published prices exist only for small resellers such as Check Car Details and CarAnalytics. cap hpi, Experian, Glass's/Autovista, Percayso, MotorCheck and Infopro are sold by quote.

### Cited Findings

**cap hpi (Solera): VRM Lookup / Vehicle Identity / HPI Check**
- VRM Lookup is "licensed directly from DVLA" and links to MVRIS, CAP ID, ABI, TVI, TecDoc (Ktype and Ntype), Glass's and FleetNet. It comes as an *enhanced* API (more than 150 data points, chosen by the customer) or a *basic* API. — [cap hpi VRM lookup](https://www.cap-hpi.com/?p=760)
- "hpi vehicle identity is the only TecDoc approved VRM lookup in the UK which includes the TecDoc Ktype number" (reseller listing quoting the vendor). — [SoftwareOne – cap vehicle identity check](https://platform.softwareone.com/product/cap-vehicle-identity-check/PCP-2932-4570)
- The data identifies the exact make, model and derivative. The cap Code is described as "vehicle derivative identification linking specifications and valuation data". The CAP ID is cap hpi's unique ID for a specific car or LCV and is used by third parties, for example image services, in place of make and model. — [cap hpi search summary](https://www.cap-hpi.com/?p=760); [Imagin.studio cap hpi field mapping](https://docs.imagin.studio/guides/getting-images/i.-core-data-and-setup/cap-hpi-field-mapping.md)
- cap hpi Identification works from the registration or a full VIN. Provenance (HPI Check) returns outstanding finance (lender and agreement), write-off category A/B/S/N with damage history, theft and mileage checks. — [Solera dealer – cap hpi provenance](https://www.dealer.solera.com/products/cap-hpi/provenance/)
- Access requires a commercial relationship. cap hpi support issues a subscriberId and password. Community wrappers exist, such as a Laravel package with by-VRM derivative-details and vehicle-details methods. No public pricing. — [cap hpi support attachment](https://support.cap-hpi.com/hc/en-us/article_attachments/360004442277); [totov/laravel-cap-hpi](https://packagist.org/packages/totov/laravel-cap-hpi)

**Experian AutoCheck**
- MIB confirmed that HPI and Experian are the only two provenance companies with access to MIAFTR (the insurers' write-off register, now referred to as VS&TD). Other history checkers use data from these two. Auto Express reported a gap of about 168,000 vehicles between MIAFTR and DVLA write-off records over 2016/17–2017/18 (older information). — [Auto Express](https://www.autoexpress.co.uk/car-news/106336/exclusive-the-great-british-car-insurance-write-off-scandal-insurers-work-with-dvla)
- The AutoCheck data guarantee covers write-offs recorded by an insurer but missing from or wrong in AutoCheck (MIAFTR/salvage data). — [Experian data guarantee T&Cs](https://www.experian.co.uk/content/dam/marketing/uki/uk/en/assets/legal/data-guarantee-terms-and-conditions.pdf); [Experian AutoCheck](https://www.experian.co.uk/business-products/autocheck/)
- No public API field list or pricing was found.

**UK Vehicle Data Ltd (ukvehicledata.co.uk)**
- Describes itself as a "top level licenced DVLA" company. It offers a RESTful API searchable by VRM, VIN or MOT test number, covering cars, vans, motorcycles, HGVs and LCVs, with "up to 204 individual data fields". Its sample response includes an `SmmtDetails` block (range, fuel, engine capacity, market sector code, country of origin, model code, `ModelVariant`). — [UKVD DVLA data API](https://ukvehicledata.co.uk/dvla-data-api)
- Sample code for its VRM lookup returns a `Derivative` (e.g. "S4"), a trim code and engine size. — [Chilkat example](https://www.example-code.com/cpp/rest_uk_vehicle_data_vrm_lookup.asp)
- The VDI Check (history) API returns Written Off, Written Off Category, Written Off Date, Stolen, Outstanding Finance, Finance House and VIN Last 5. VDI Check data must be a fresh call every time, while other lookup data may be cached. Valuation data is also offered. — [UKVD VDI Check](https://UkVehicleData.co.uk/VDI-Check); [UKVD website terms](https://ukvehicledata.co.uk/policies/WebsiteTerms)
- Further packages cover tyre, battery, EV, images, MOT and a monthly "drop-down" make/model/derivative/series/gearbox/cc/fuel/body/doors/BHP dataset (CSV/MSSQL/MySQL). — [UKVD drop-down data](https://ukvehicledata.co.uk/dropDown-Data); [UKVD tyre data](https://www.ukvehicledata.co.uk/tyre-data)
- Pricing comes as PAYGO pre-pay, where the per-lookup price depends on the top-up amount, or 12/24/36-month contracts with savings above 250,000 lookups/month. The per-lookup figures on the pricing page could not be read reliably from snippets, so the API rate is treated here as not confirmed. Test accounts are offered. The consumer VDI Valuation app charges £0.79 per premium valuation. — [UKVD pricing](https://ukvehicledata.co.uk/pricing); [UKVD self-service](https://selfservice.ukvehicledata.co.uk/mobile/)

**Check Car Details API (api.checkcardetails.co.uk)**
- Published per-request prices: Vehicle Registration £0.02, Vehicle Spec Data £0.04, UK Vehicle Data £0.10, Car History Check £1.82. No membership fees, and only successful searches are charged. The snippet was undated. — [Check Car Details API](https://api.checkcardetails.co.uk)
- Field-level documentation, including whether derivative, VIN or engine code is returned, was not found.

**CarAnalytics**
- Lists a "UK Vehicle Data" call at £0.08 (search snippet only). — [CarAnalytics vehicle data API](https://www.caranalytics.co.uk/vehicle-data-api)

**MotorCheck (UK/IE) and MotorSpecs**
- The API offers technical specs, running costs, private/part-exchange/auction/trade valuations, "full vehicle table data and version configuration data" for new models in 57 countries, and OAuth2 access. — [MotorCheck API](https://www.motorcheck.co.uk/api/)
- MotorSpecs is priced "cost per click" on a sliding scale by volume. No published rate (sales@motorcheck.ie). Trade (non-API) checks cost £3.30 PAYG ex-VAT, or from £1.20/check on plans with a 1,000/month minimum. — [MotorSpecs pricing](https://help.motorcheck.co.uk/en/articles/3684452-motorspecs-pricing); [MotorCheck trade](https://trade.motorcheck.ie/api)
- MotorCheck partners with Percayso/Cazana for valuations at VRM and VIN level. — [MotorCheck help](https://help.motorcheck.co.uk/en/articles/9533741-motorcheck-partners-with-percayso)

**Percayso Inform / Percayso Vehicle Intelligence (formerly Cazana)**
- Cazoo sold Cazana to Percayso Inform in Feb 2023, and it was renamed Percayso Vehicle Intelligence. — [Insurance Times](https://www.insurancetimes.co.uk/news/cazoo-sells-cazana-to-percayso-inform-for-undisclosed-sum/1443899.article); [Motorfinance Online](https://www.motorfinanceonline.com/?p=93928)
- It is an insurance-focused enrichment hub combining historic vehicle data, retail sales data and DVLA/DVSA/MOT data, and it identifies undeclared modifications. Clients include Aviva (multi-year, covering pricing, underwriting and claims), AA Underwriting (Companion claims tool) and Zixty. In Sep 2026 it partnered with Driverly. — [Insurance Times – Aviva](https://www.insurancetimes.co.uk/news/aviva-secures-multiyear-motor-deal-with-data-enrichment-provider/1457302.article); [FinTech Global – AA](https://fintech.global/2024/08/09/aa-underwriting-ltd-extends-partnership-with-percayso-inform-to-enhance-motor-insurance-data-capabilities/); [Insurance Edge – Driverly](https://insurance-edge.net/2026/09/16/percayso-inform-teams-up-with-driverly/)
- The Financial Ombudsman Service has adopted Cazana's valuation engine (reported). — [search summary, MotorCheck/press](https://help.motorcheck.co.uk/en/articles/9533741-motorcheck-partners-with-cazana)
- No public API documentation, field list or pricing.

**Glass's / Autovista (J.D. Power)**
- Glass's offers technical details "with nothing more than a registration", NatCode for valuations, and Market Value Assessor using Glass's plate lookup. Autovista API terms say transactions may only refer to individual vehicles, and fees for VIN/VRM/WLTP services may rise if supplier costs rise. Sales enquiry only, with no public pricing. — [Glass's Autovista API](https://glass.co.uk/autovista-api/); [Glass's UK T&Cs](https://www.jdpower.com/business/glass-uk-terms-conditions/); [Market Value Assessor](https://www.jdpower.com/business/market-value-assessor/)

**Infopro Digital Automotive (VRM Vehicle Identification Service)**
- VRM and VIN lookup for the UK, Ireland and the Netherlands, claiming 99% UK parc coverage. Its fitment data integrates with KType, ACES and MVRIS. Whether the VRM service itself returns K-type is unconfirmed. — [Infopro UK VRM](https://www.infopro-digital-automotive.com/uk/vrm-vehicle-identification-service/); [DriveRightData fitment](https://www.infopro-digital-automotive.com/driverightdata/vehicle-fitment-database/)

**TecAlliance / TecDoc**
- The TecDoc catalogue has a VRM search, updated to display chassis number and engine code (trade press). I found no authoritative statement of who supplies TecAlliance's UK VRM-to-K-type mapping. The cap hpi claim above suggests cap hpi does. — [CAT Magazine](https://catmag.co.uk/news/tecdoc-catalogue-update-speeds-up-parts-id)
- ALLDATA (May 2024) added VRM search for UK and IE repair customers. — [ALLDATA EU](https://www.alldata.com/eu/en/BLG-EU-ALLDATA-VRM-LOOKUP-PRODUCT-UPDATE-UK-IRELAND)

**Total Car Check**
- Vehicle Check API that is "completely free to join" and returns Gold or Silver Check data. API rates not published. The consumer Silver check costs £3.99. — [Total Car Check API](https://totalcarcheck.co.uk/VehicleCheckAPI)

**Others**
- **CarweB:** an npm client exists for its registration database, but no public field documentation was found. — [npm carweb](https://www.npmjs.com/package/carweb)
- **MarketCheck UK:** 1,000 free calls, then Growth at £249/month plus data fees. — [MarketCheck UK pricing](https://marketcheck.uk/pricing)
- **RegCheck (matricula / regcheck.org.uk family):** a multi-country SOAP plate lookup on credits. — [RegCheck API](https://www.matricula.co.pt/data/api-docs.aspx)
- **Autotrader valuations API:** needs Autotrader's own derivative ID, first registration date and mileage. — [Autotrader help](https://help.autotrader.co.uk/hc/en-gb/articles/21923133513117-Introduction-to-Current-Valuations)
- **Regit, Vehicle Data Global/VDGL:** searches returned nothing usable.

### Inferences
- For an estimating app, a practical stack is a commercial VRM lookup (for derivative, VIN, engine code and CAP ID or K-type) plus the free MOT API (for mileage) plus a provenance check from HPI or Experian (for write-off category). Write-off data from any reseller ultimately comes from HPI or Experian (MIAFTR).
- The CAP ID/CAPcode is the key for valuation (cap hpi Black Book) and is widely accepted downstream. TecDoc K-type drives aftermarket parts catalogues. OEM parts and labour for estimating (Audatex, a Solera stablemate of cap hpi, or GT Motive) typically need VIN-level identification, which favours providers that return the full VIN.
- Cheap resellers (Check Car Details, CarAnalytics, UKVD) give derivative text at pence per call. Whether their derivative strings come from SMMT/MVRIS or from cap hpi data was not established.
- Kerb weight, body type and transmission are typically in SMMT/MVRIS-based technical blocks (UKVD says it has up to 204 fields), but no source snippet confirmed kerb weight specifically.

### Gaps
- No published pricing for cap hpi, Experian, Glass's, Percayso, Infopro, MotorCheck API, Total Car Check API or CarweB. Each says to contact sales.
- I could not confirm which providers return Glass's code or ABI code apart from cap hpi's linkage claim.
- I could not confirm whether the Check Car Details "Vehicle Spec Data" endpoint returns derivative or VIN.
- Whether resellers return the full VIN or only partial VIN: UKVD VDI Check returns "VIN Last 5", and full-VIN availability for other packages is unconfirmed.

## 4. Free VIN decoders and manufacturer VIN data (NHTSA vPIC, Mercedes datacard, BMW)

### Takeaway
NHTSA vPIC is free and unlimited but built from US-market manufacturer filings under 49 CFR 565. It adds little for UK and EU-market VINs: often only the WMI and manufacturer, sometimes with error code 8. EU VINs are not required to encode year or attributes. Exact equipment and trim from a VIN (Mercedes datacard, BMW SA option codes) comes from OEM build data. Commercial access to that data runs through OEM RMI portals under the EU type-approval RMI rules (2018/858 Art. 61, retained in UK law), which name damage assessors as eligible. I found no OEM terms permitting scraping of public datacard sites.

### Cited Findings
- vPIC decodes using data that manufacturers submit to NHTSA (49 CFR Part 565). It is for model year 1981 onwards and has no daily limit. — [NHTSA vPIC About](https://vpic.nhtsa.dot.gov/About); [NHTSA vPIC presentation](https://www.nhtsa.gov/sites/nhtsa.dot.gov/files/frenchik-vin-vpic.pdf); [vPIC FAQ](https://vpic.nhtsa.dot.gov/api/home/index/faq)
- Third-party guide: error code 8 ("model year or other encoded data couldn't be resolved") is common on European-market VINs. vPIC returns HTTP 200 for invalid VINs. — [Carwhere vPIC guide](https://www.carwhere.com/guides/nhtsa-vin-decoder-api)
- "European VINs are not required to include year, factory, or vehicle attribute data" (vendor commentary). — [CarsXE US vs EU VIN](https://carsxe.com/blog/us-vs-eu-vin-decoding-standards)
- The VIN does not encode factory options. BMW options are SA codes (S###A) on the vehicle order sheet, and dealers can retrieve them by VIN. — [Carwhere BMW options](https://www.carwhere.com/guides/how-to-find-bmw-options-by-vin); [FCP Euro](https://www.fcpeuro.com/blog/deciphering-european-car-option-codes)
- The Mercedes-Benz RMI licence is open to businesses eligible under Art. 61 of Reg. (EU) 2018/858, "workshops, damage assessors, and other businesses". The vendor says the licence allows enrichment and redistribution (SaaS/DaaS) to eligible customers in the EEA, CH and UK. — [Mercedes-Benz RMI](https://drivesomethinggreater.com/products/Repair-Maintenance-Information)
- Art. 61 requires RMI to be made available electronically at reasonable, non-deterrent fees. Delegated Regulation (EU) 2026/699 (23 Mar 2026) amends Annex X on OBD and RMI access. — [Taylor Wessing FAQ](https://www.taylorwessing.com/de/insights-and-events/insights/2026/01/faq-access-to-vehicle-data-and-data-governance); [EUR-Lex 2026/699](https://eur-lex.europa.eu/eli/reg_del/2026/699/oj/eng/pdf)
- Anecdotal: Mercedes datacards were publicly searchable online for vehicles up to about 2018, and dealers can provide newer ones. — [MBWorld forum](https://mbworld.org/forums/e-class-w211/197184-free-vehicle-datacard-7.html)

### Inferences
- For UK VINs, vPIC is useful only for check-digit and WMI sanity checks. Derivative identification needs a UK commercial provider or OEM RMI access.
- How EU 2018/858 RMI rules (and the 2026 amendments) apply in Great Britain after Brexit depends on GB retained or assimilated type-approval law. This needs legal confirmation and was not researched here.

### Gaps
- No official Mercedes or BMW terms specifically covering commercial use of datacard or VIN-option data were found. The GB legal status of the RMI obligations was not confirmed.

## 5. Data protection: VRMs under UK GDPR; DVLA KADOE vs VES

### Takeaway
The ICO treats a VRM as personal data where it can be linked to an identifiable person, for example through DVLA keeper records, CCTV or a claims file. In a claims or estimating context, where the VRM sits next to a claimant's details, it should be treated as personal data. VES returns no keeper data and is open to anyone. KADOE returns keeper-at-date-of-event details and needs a DVLA contract plus "reasonable cause", which in practice is mostly parking and enforcement. A damage-assessment app does not need it for identification.

### Cited Findings
- ICO guidance lists a car registration number as information that can indirectly identify an owner when linked with other information, e.g. DVLA records. — [ICO – indirect identification](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/what-is-personal-data/can-we-identify-an-individual-indirectly/)
- The ICO's ANPR guidance discusses VRMs as personal data. Its full answer text was not retrieved. — [ICO ANPR](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/cctv-and-video-surveillance/guidance-on-video-surveillance-including-cctv/additional-considerations-for-technologies-other-than-cctv/automatic-number-plate-recognition-anpr)
- In ICO decision notice FS50787725 ("Is a VRM number personal data in its own right?"), the DVLA's stated position is quoted. The conclusion was cut off in the snippet. — [ICO FS50787725](https://ico.org.uk/media2/migrated/decision-notices/2614510/fs50787725.pdf)
- KADOE: organisations must be contracted with DVLA and meet "reasonable cause", which relates to motoring incidents with driver or keeper liability. Parking firms must be in an approved operator scheme (BPA/IPC). The API takes a VRM or chassis number, a reason code and an event date, and returns keeper details as at that date. Data may be used only for the stated purpose. — [KADOE API description](https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/kadoe/kadoe-description.html); [KADOE contract](https://www.gov.uk/government/publications/kadoe-keeper-of-a-vehicle-at-the-date-of-an-event-contract); [INF266 release of information](https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/861052/inf266-release-of-information-from-dvlas-registers.pdf); [TransportXtra](https://www.transportxtra.com/publications/transit/news/64735/dvla-defends-sharing-vehicle-keeper-data-with-private-parking-companies)
- The MOT History API has its own DVSA privacy notice. — [MOT history API privacy notice](https://www.gov.uk/government/publications/dvsa-privacy-notices/mot-history-api-privacy-notice)

### Inferences
- Vehicle attributes looked up by VRM (spec, MOT, write-off) are not keeper data. Once stored against a claim, though, they form part of the claimant's personal data, so they need a lawful basis (likely contract or legitimate interests), retention rules, and inclusion in DSAR responses.
- Provider terms affect how data is stored: UKVD, for example, says VDI Check results must be fetched fresh each time and cached only within its terms. Licence terms should be checked before building a local vehicle cache.

### Gaps
- I did not obtain the ICO's definitive conclusion in FS50787725 or the full ANPR guidance text.
