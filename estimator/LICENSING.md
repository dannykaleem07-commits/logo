# Data licences: application pack

These are the data licences Engineer Report Studio needs, in the order to apply for them. Each licence is a contract in your company's name, so you (or a director) must apply and accept the terms. This pack gives you the link, what to say, and what you get back.

Fill in these details once and reuse them in every enquiry:

| Field | Your answer |
|---|---|
| Legal company name | |
| Company number | |
| Registered address | |
| ICO registration number (data protection fee) | |
| Contact name and role | |
| Email / phone | |
| What you do | Independent motor engineers producing vehicle damage assessment and total-loss reports for credit hire, accident management and insurers |
| Expected volume | e.g. ___ reports a month, ___ registration lookups a month |
| Assessor credentials | IAEA / IMI membership numbers, AQP ID (needed for salvage categorisation) |

> **Before you sign anything:** check each contract allows use **inside your own software** and **printing the data in reports you send to third parties**. Some licences are per-user, view-only seats that do not allow this.

---

## Stage 1: free, self-serve (apply today)

### 1. DVLA Vehicle Enquiry Service (VES) API: free
- **Gives:** make, colour, fuel, engine size, first registration, tax and MOT status, Euro status, export marker, date of last V5C. It does **not** give model, derivative or VIN.
- **Apply:** search "DVLA Vehicle Enquiry Service API" on gov.uk, then register on the DVLA developer portal. You give an estimate of your monthly volume.
- **You receive:** an API key. Paste it into **Settings → Data connections → DVLA key** once that screen is built.

### 2. DVSA MOT History API: free
- **Gives:** make, model, colour, fuel, engine size, first-used date, and **every MOT test with its odometer reading**. This is the evidence for valuation mileage and spotting mileage discrepancies.
- **Apply:** search "MOT history API" on gov.uk, then register as an organisation. Approval takes about 5 working days. The old API was switched off on 1 Sep 2025, so even existing users must register again.
- **You receive:** client ID, client secret and API key. All three go into Settings.

### 3. Anthropic API key (AI assessor): already supported
- console.anthropic.com → API keys. Paste it into **Settings → AI assessor**.

---

## Stage 2: low-cost commercial (exact derivative, VIN, write-off history, guide values)

### 4. Vehicle identification to exact derivative: pick ONE
- **Check Car Details API** (self-serve, pay per call; published prices are about £0.02 per registration, £0.04 per spec and £0.10 per full vehicle data call), **or**
- **UK Vehicle Data** (ukvehicledata.co.uk; self-serve top-ups; up to 204 fields including derivative and trim), **or**
- **cap hpi vehicle lookup** (quote only). This is the industry reference: it returns the exact derivative, CAP ID/CAPcode (which drives CAP valuations) and the TecDoc K-type (which drives parts catalogues).

**Enquiry text (cap hpi):**
> We are an independent vehicle damage assessment business building our own estimating and engineer-report software. We would like API access to your VRM/VIN vehicle identification service, returning manufacturer derivative, VIN, CAP ID and technical data. Expected volume ___ lookups a month. Please send pricing and licence terms, including whether returned data may be displayed in reports supplied to our clients (insurers, credit hire companies, solicitors).

### 5. Write-off / finance / stolen history: HPI or Experian
Only HPI (cap hpi) and Experian AutoCheck have access to the insurers' write-off register (MIAFTR). Every other provider resells their data.
- Self-serve resellers: MotorCheck (trade checks from about £1.20–£3.30), Check Car Details (£1.82 history check).
- Direct API: quote from cap hpi or Experian AutoCheck.

### 6. Guide valuations (the ombudsman's four guides)
The Financial Ombudsman Service starts from the **highest retail guide**: CAP, Glass's, Autotrader and Percayso. Licence at least two.

| Guide | Route | Price found |
|---|---|---|
| **Autotrader** | Through MotorCheck (fastest), or an Autotrader Connect integration (needs "Retail Essentials") | £0.40 per valuation through MotorCheck |
| **CAP (cap hpi)** | Quote. Claims product: *Market Value Manager* | Not published |
| **Glass's (J.D. Power)** | Quote. Claims product: *Market Value Assessor* | Not published |
| **Percayso** (Cazana) | Quote. Insurer-focused, ask about engineer use | Not published |

**Enquiry text (valuations):**
> We prepare pre-accident valuations for total-loss and credit hire claims. We need retail valuations at a historic date (date of loss), adjusted for mileage and condition, by VRM or by your vehicle code, via API, for inclusion in engineer reports supplied to third parties. Expected volume ___ a month. Please send pricing, licence terms and API documentation.

---

## Stage 3: enterprise (full manufacturer parts and recognised labour times)

None of these publish prices. Expect sales calls, a contract and minimum terms.

### 7. Manufacturer part numbers and UK prices by VIN
- **Infomedia** (Microcat): VIN API plus Parts API returning VIN-specific part numbers, supersessions and country pricing. Third-party integrators must be approved.
- **Partly**: licenses OEM data directly from manufacturers and runs a UK collision-repair network.
- **Manufacturer portals (manual use only):** Mercedes-Benz B2B Connect, VW erWin, BMW AOS, Ford Ecat/Microcat Market (about £7–£8 a user a month), Stellantis Service Box, partslink24 (multi-brand). These are per-user web subscriptions. Use them to look up and check numbers by hand; they do not allow loading the data into your software.

**Enquiry text (Infomedia / Partly):**
> We are building collision estimating and engineer-report software for UK independent assessors. We need VIN-specific OE part numbers, descriptions, supersessions and UK retail prices for body and mechanical collision parts, via API, displayed within estimates sent to insurers and claimants. Please confirm which manufacturers you cover in the UK (in particular Mercedes-Benz, BMW, VW Group, Ford, Vauxhall/Stellantis, Nissan, Toyota, Kia/Hyundai), your integrator approval process, and pricing.

### 8. Recognised repair and paint times (replace, R&I, repair, blend, paint stages)
These are the times insurers' engineers accept.
- **Partner route (fastest):** connect the app to an estimating system you already pay for.
  - **Audatex / Solera:** ask about AudaConnect / AudaBridge / Qapter API.
  - **GT Motive:** ask about partner integration.
  - **J.D. Power Repair Estimate (Glass's):** its times come from data supplied by more than 40 OEMs, and its paint calculation uses AZT.

  You keep your estimating subscription and the app pulls the estimate into the report.
- **Direct route:** separate licences from **Thatcham Research** (repair methods; escribe), **AZT** (paint calculation) and each OEM (e.g. Mercedes XENTRY Operation Time). This is slow and expensive and only worth it at scale.

**Enquiry text (Audatex / GT Motive / Repair Estimate):**
> We hold / plan to hold ___ licence(s) for your estimating system. We have built our own engineer-report software and would like to import completed estimates (lines, part numbers, labour, paint, totals) through your API or an export, so they appear in our reports. Please send details of your integration / partner programme and costs.

---

## What happens when the keys arrive
Send the keys to the app's Settings screen, never by email or chat. Then ask for the connector to be built and tested:
1. DVLA + MOT History: registration lookup fills the Vehicle tab, and MOT mileages feed the valuation and the mileage-discrepancy check.
2. Derivative provider: exact-variant picker, VIN, CAP ID / K-type.
3. Valuation provider(s): guide figures fill the valuation table at the date of loss, and the AI valuation assistant writes the workings.
4. Parts / estimating partner: parts and times flow into the estimate, marked with their source.

## Legal notes
- Do not scrape EPC or parts websites (7zap, partsouq, Megazip and the like). It breaches UK database right and their terms.
- Registration numbers in a claim file are personal data. Make sure your ICO registration and privacy notice cover vehicle-data lookups and AI processing.
- The research behind this pack is in `reports/UK estimating data sources.md`. Confirm all prices directly with the providers, because some figures came from undated search results.
