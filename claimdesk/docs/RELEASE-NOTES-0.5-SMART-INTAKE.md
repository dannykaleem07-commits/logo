# ClaimDesk 0.5 — Smart Intake (case bundles)

You can now name a case ("Jane Doe – Corsa crash"), drop every file you have for it — PDFs, photos, scans, e-mails,
ZIPs — and ClaimDesk reads them **together**: it sorts them into cases, builds one draft claim with the source of every
detail, shows where documents disagree, lists what is still missing, proposes the chronology, flags things worth a
look, and registers the claim when you press Register. Design: `docs/SMART-INTAKE.md`.

## What changed

1. **Mixed uploads sorted** — files are grouped by what identifies them (registration, VIN, licence number, insurer
   reference, policy, name + date of birth, phone, CCG reference): this case, other new cases, existing claims, and
   "Not sure". Every group says why. Move or exclude any file; your choice always wins. A file with only a weak link
   (a phone number on a note) joins the one case that shares it and says it is a weak link.
2. **Best source wins, never silently** — the V5C outranks an estimate for the VIN, the licence outranks a claim form
   for the date of birth, the police report for the accident time. When two documents disagree you see both, with the
   preselected one and why; "Accept all preselected" settles them in one go.
3. **Provenance everywhere** — each detail shows the file, page and quoted line it came from.
4. **Missing documents** — a checklist per case kind (V5C, licence front and back, insurance certificate, photos with
   the plate, estimate, bank details, MOT when the car is over three years old …) and a prepared request to the client.
   It is never sent without you (the outbox always asks).
5. **Duplicates** — the same file, the same text, a resized photo or a re-saved letter is linked to the first copy and
   not filed twice ("File this copy too" if you want it).
6. **Packs and archives** — a multi-document PDF is split into its documents (by "Page 1 of …", headings and page
   size; scans by the AI); ZIPs are unpacked within limits; e-mail attachments join the bundle.
7. **Photos** — EXIF time and place, plates read by the AI and matched to the case's cars, damage zones recorded on
   the claim's damage model (`GET /claims/:id/damage-zones`).
8. **Chronology** — dated events from the documents are proposed and ticked by default (offers, settlements,
   payments, hire start/end and legal events are never written by intake — you record those).
9. **Things worth a look** — photos taken before the accident, PDFs re-saved by editing tools, contact details on
   another claim, insurance not in force … always with the innocent explanation, for your eyes only. They never block
   you and never reach an agent, a document or an e-mail; they only stop automatic registration.
10. **One-glance brief** after registering — summary, key facts with sources, liability guide (your decision), what is
    missing, the call to make first, the Autopilot's first steps.

Also: the AI reads the whole bundle together and code checks every value it gives (quotes that are not in the
document are capped and shown as unverified); folders dropped in `inbox\intake\<name>\` become bundles; your
corrections are recorded for the Knowledge Builder.

## Working with the AI paused

Everything except reading scans and photos works from the documents' text. The bundle shows "waiting for the AI"
with the reason (agents off, kill switch, usage limit, sign-in). You can still register; automatic registration waits.

## Settings > Intake

| Setting | Default |
|---|---|
| Register automatically when nothing needs you | **off** |
| …minimum confidence of every key detail | 90 % |
| Prepare the missing-documents request | on |
| Quiet period before reconciling a drop | 20 s |
| Folder bundles (`inbox\intake\<name>\`) | on |
| AI checks per bundle per day (your "Think again" is exempt) | 3 |
| Split packs of ≥ 2 pages | on |
| Near-duplicate photo distance / letter similarity | 6 / 0.9 |
| Photo time tolerance / GPS outlier | 2 h / 2 km |
| Archives: entries / size / depth / ratio | 200 / 2 GiB / 2 / 200:1 |

Automatic registration also needs the autonomy policy to allow it (kill switch or shadow mode → it asks you), the AI
check done, no signal, no conflict, no unplaced file and no other case in the upload. It is followed by a
"please look it over" card.

## Honest limits

Reading is not knowing: rules readings are pattern matches and AI readings can be wrong — every value shows its source
and confidence. Sorting needs identifiers; photos without a plate or a date land in "Not sure". Without the AI, scans
and photos are stored and grouped by EXIF and hashes but not read. Photo and PDF checks are hints. A document-led
claim still needs the FNOL call. An automatically registered claim cannot be un-created (it can be closed).
Photo GPS is now kept in each photo's evidence record too (it used to be dropped).
