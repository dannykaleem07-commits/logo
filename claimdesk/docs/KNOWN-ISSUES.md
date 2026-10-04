# Known issues and limits (4 October 2026)

Everything below is either a deliberate limit of this first build or a residual risk found during adversarial review. None blocks using the system on test data. Items marked **before live use** must be dealt with before real claimant data goes in.

## Before live use

- **Password login only; no MFA yet.** Signing in is now required: usernames and passwords, with passwords stored only as salted scrypt hashes and a 12-hour session in an HttpOnly cookie (the database keeps only a SHA-256 digest of the session token). Every `/api` route except health and sign-in refuses a request without a session. Ten wrong passwords for one username from one address lock it for 15 minutes, and every sign-in, failed attempt, sign-out and password change is in the audit log. Still to do: MFA, a screen to add and remove staff accounts, and a server-side store for the rate limiter, which is held in memory and resets when the API restarts.
- **The default password is public.** The owner's account (`courtesycars` / `CourtesyCars123!`) is written in this public repository, and the sign-in screen fills it in for anyone who can open the app. Both stop when the password is changed in Settings → Change password; `LOGIN_PREFILL=false` also stops the username being filled in. The API still listens on `127.0.0.1` only by default. Change the password before setting `HOST` to expose it, and before real data goes in.
- **Nothing in the knowledge base is verified.** The build environment had no internet access, so every case, statute, GTA rate, court fee and insurer number is `unverified` with its source URL recorded. Work through `RESEARCH-CORRECTIONS.md` and the Directory screen's "Mark verified today" button.
- **Bank, VAT and ICO details are not set.** The company details are real (Courtesy Cars Group UK Ltd, No. 17430389, registered office 44 Syon Lane, Isleworth, London TW7 5NQ, case handler 07425 475922, office 020 7052 5403, claims@courtesycars.net) and print on every document. Enter the bank account, VAT and ICO numbers in Settings; the payment direction (CCGUK-05) and invoices need the bank details.
- **E-signature secret.** Set `ESIGN_SECRET` (alias `SIGNING_SECRET`). The development fallback is refused in production.
- **Storage is local.** SQLite and a local write-once evidence folder suit a single machine. The blueprint's production target is PostgreSQL in a UK region and object-locked storage; the repository layer is the only place that changes.
- **Bank holidays 2024–2030** are encoded and cross-checked against an independent list, but are `unverified` until checked against gov.uk.

## Legal and rule interpretations to confirm

- **ICOBS 8.2 scope.** Research suggests 8.2.1R(1) applies the three-month duty to any motor liability insurer, so it would cover domestic third-party claims. Letters still say "we understand" until a person reads the rule.
- **GTA 6.8.6 day numbering.** The pack date is day 0, so day 31 is the pack date plus 31. If the GTA counts the pack date as day 1, every tier moves a day earlier. It is one shared constant (`latePaymentTierStart`).
- **GTA 4.11 monitoring cadence** runs from the last monitoring contact. A rigid five-working-day grid from repair start is the other possible reading.
- **GTA 4.14** off-hire after a total-loss payment: 5 working days per the brief; older wording said 7 calendar days.
- **Litigation clocks** (limitation, Part 36, default judgment) ignore deemed service and clear-day rules. They err early, never late.
- **Tescher v DAML** may be on appeal to the Supreme Court (UKSC 2025/0116). The acceptance score uses the Court of Appeal test.
- **Representing clients against their own insurer** for a fee may be FCA-regulated claims management (RAO art 89I). Take advice before offering it.

## Engine heuristics

- **Consistency engine** reads letters as text. It now reads payees only from labelled fields, ignores rule descriptions ("settled within one calendar month") and unit figures ("× £45"), and the API clears warnings on figures it computed itself, with a logged reason. A handler's typed figure is never cleared automatically. Expect occasional warnings on unusual layouts; each one is cleared with a reason, which is logged.
- **FORUM_NOT_OPEN** blocks any mention of the Financial Ombudsman in a letter to the at-fault insurer, including a true negative ("the FOS is not open to you").
- **Liability score** is keyword triage. Recorded Highway Code rules are assumed to be breaches by the third party, so record only those.
- **Estimate import** parses text lines heuristically and marks every line unconfirmed. A bare figure of 60 or less on a labour line is read as hours.
- **Total-loss predictor and PAV fallbacks** (per-mile 5p/7.5p/10p, weights, 21 days to payment, 10% borderline band) are CCGUK assumptions, flagged `calibrated: false` until 100 outcomes exist.
- **Registration format check** is a hint, not proof of a real plate.

## Document builders

- **Part 36 relevant period** is counted from the draft date. If the claimant serves it later, the stated end date is early; the text also says "from the date this offer is served".
- **DSAR one month** is counted from the letter date, not receipt, so a posted request states a date a day or two early.
- **Complaint chronology** prints event summaries as typed on the file. Write chronology entries as you would want the insurer to read them.
- **Warn-only misreads remain** on some fixed wording ("Your references", VAT-inclusive totals in a letter of claim against net figures in an earlier pack). They need clearing with a reason.
- **Letter before claim** gives a business claimant 30 days and an individual 14. A longer period does no harm.
- **Bundle index and witness statement** need a logged "proceedings issued" event for the court and claim number; until then the API asks for the court name.

## Product gaps

- Hire agreement needs the hirer's date of birth and licence number on the party record; the API names any missing field.
- PCN liability transfer needs the licence expiry date, which the party record does not hold; it is supplied per request.
- The analytics screen shows all-time figures; date ranges are not implemented.
- Insurer de-duplication at intake is by exact name.
- The web bundle is one 800 kB file; route-level code splitting is a simple follow-up.
- Not built yet (roadmap phase 3): AI drafting assistant, WhatsApp and telephony integration, transcription.
