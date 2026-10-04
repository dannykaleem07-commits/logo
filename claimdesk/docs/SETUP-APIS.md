# Setting up the free and paid data sources

ClaimDesk works with no keys at all: every lookup falls back to **manual entry** (the handler keys in what the V5C, MOT certificate or a paid check shows, and the record is marked `unverified` until a document backs it). Keys turn on live lookups. Register the free ones first; they cost nothing and cover most of what a file needs.

| Source | Cost | What you get | Where to register | Env vars |
|---|---|---|---|---|
| DVLA Vehicle Enquiry Service (VES) | Free | Tax status/due date, MOT status/expiry, make, year, first registration month, engine size, CO2, fuel, colour, export marker, type approval, wheelplan, last V5C issue date, Euro status, revenue weight | https://developer-portal.driver-vehicle-licensing.api.gov.uk/ (one key per company; support dvlaapiaccess@dvla.gov.uk) | `DVLA_VES_API_KEY` |
| DVSA MOT History API | Free | Every MOT test, result, odometer reading, defects and advisories, expiry | https://documentation.history.mot.api.gov.uk/ — OAuth 2.0 client credentials **plus** an API key. The client secret expires every 2 years; a key unused for 90 days is revoked | `DVSA_MOT_CLIENT_ID`, `DVSA_MOT_CLIENT_SECRET`, `DVSA_MOT_API_KEY`, `DVSA_MOT_TOKEN_URL`, `DVSA_MOT_SCOPE_URL` |
| Companies House API | Free | Company profile, status, filing history, officers, charges, insolvency, Gazette strike-off notices (used by the counterparty watch list, e.g. CARFLEX LTD 12640635) | https://developer.company-information.service.gov.uk/ | `COMPANIES_HOUSE_API_KEY` |
| Commercial vehicle gateway (optional) | Pence to a few pounds per call | Spec/VIN decode, valuation (~£0.10–£0.25), provenance: write-off, finance, stolen (~£1.25–£4.99) | CarAnalytics, Vehicle Smart, DealerPricing or similar pay-as-you-go gateways. **Read the licence** for "internal use only" / "no resale" clauses before using the output in a report | `VEHICLE_GATEWAY_PROVIDER`, `VEHICLE_GATEWAY_API_KEY` |
| askMID Other Vehicle Look-up | £10.00 per one-off search (annual subscription available) | The third-party vehicle's insurer and policy number at the accident date | https://www.askmid.com/ (only for a party involved in the accident) | manual |
| DVLA keeper enquiry (form V888) | £2.50 (Option A) | Registered keeper name and address at a date ("reasonable cause": e.g. RTA with uninsured/untraced party) | https://www.gov.uk/government/publications/v888-request-for-information-about-a-vehicle-or-its-registered-keeper | manual |
| MIAFTR | No direct access | Write-off and theft register | Reached only via the commercial provenance checks above | — |
| Metropolitan Police collision report | £215.10 (Form 518); third-party details £49.00 (Form 519) | Collision report / third-party details | https://www.met.police.uk/ | manual |
| LLM drafting assistant (optional) | Per token | Retrieval-based drafting over the knowledge base; every output carries citations and is held for human approval | https://console.anthropic.com/ | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |

## Things never to do

- **Do not scrape advert sites** (Auto Trader etc.) for comparables. It breaches their terms and risks database-right infringement (Copyright and Rights in Databases Regulations 1997 reg 16). Capture adverts manually: the handler saves the advert as PDF/screenshot with its URL and time; ClaimDesk stores the file, its SHA-256 and the keyed figures.
- **Do not bulk-download judgments.** Find Case Law's Open Justice Licence excludes computational analysis; apply for the free transactional licence from The National Archives before programmatic ingestion. BAILII: link only.
- **Do not copy Thatcham/Audatex repair times.** Build the in-house labour library from CCGUK's own approved estimates only.

## Keeping keys alive

- DVSA: diarise the client-secret expiry (2 years) and make at least one call every 90 days.
- DVLA: one key per company; keep it in `.env`, never in the repo.
- Companies House: rate-limited; the nightly watch-list poll is designed to stay well inside the limit.
