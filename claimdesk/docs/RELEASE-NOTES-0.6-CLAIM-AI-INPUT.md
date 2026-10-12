# ClaimDesk 0.6 — AI input on every open claim

Every open claim now has an **AI input** tab. Use it in two ways:

- **Catch up a claim** — for a claim opened late, or letters and emails you sent and received outside ClaimDesk: drop
  the files and ClaimDesk sorts, dates, files and records them on the claim.
- **Tell ClaimDesk what happened** — type an update ("client called, car repaired, hire ended yesterday") or paste a
  call note, and the agents act on it.

Design: `docs/CLAIM-AI-INPUT.md`.

## Catch-up upload

1. **Sorted and dated** — each file is read (the same engine as Smart Intake, with this claim fixed): its kind, its real
   date (email header, then the letter's own date, never the upload date), whether **we sent it** or **received it**
   (letterhead, sign-off, "Our ref"/"Your ref", our mailbox) and what it is (New Claim Advice Form, handling-reference
   request, chaser, insurer acknowledgement, client email …).
2. **Filed and recorded** — every document is filed on the claim; letters and emails become chronology entries at
   their real date, marked **"recorded late, source: <file>"**, plus a record of the letter. A first insurer letter
   with their reference also records "handling reference received". Packs are split and filed page by page.
3. **Never twice** — a file already on the claim (same bytes or same text) is not filed again; a letter already in the
   chronology or sent from the Outbox is not recorded again; a letter about another claim is left for that claim.
4. **Clocks follow the real dates** — an NCAF recorded for 2 October meets the NCAF clock on 2 October; a late
   catch-up may show a deadline already missed — that is the file's truth, shown plainly.
5. **You stay in charge** — "Who sent it?" when a letter has no clues; correct the direction, date or kind of any file
   and the plan updates. **Apply automatically** (on by default) files and records the clear lines as the intake agent
   once the files are read; anything that needs your tick waits. Details found in the documents go through the usual
   intake check: empty details are proposed, different values always ask you (one card).
6. **The agents stop repeating you** — the Autopilot sees the letters you already sent (no second NCAF or
   handling-reference request), the Case Brief lists them for the drafter and reviewer, and the case sweep counts a
   letter you sent as the answer to an email.

## Updates and instructions

1. **Rules first** — common phrases are understood at once, without the AI: calls, repairs, hire ended (it ends the
   hire through the Hire tab's own route), liability admitted/denied, the insurer's reference, police reference, new
   phone/email/address, reminders ("remind me to call the insurer tomorrow" → a task at 09:00), "don't chase the client
   until Monday", "pause this claim until Friday", "send the engineer report to the insurer", money and offers. The rest
   goes to the AI (no tools, it only reads), and code checks every line it returns.
2. **Code decides who does what** — each line says **Will do**, **Needs your tick**, **Goes to Needs-you**, **Open the
   screen** or **Won't do**. Money, offers, settlement, legal steps and closing or declining a claim always go to
   Needs-you; overwriting a detail, liability and status changes need your tick. Nothing applies before **Do it**.
3. **Questions instead of guesses** — "Which hire?", "Until when?", "Which document?" are asked (also on Needs-you if
   you walk away); answering re-reads the update.
4. **Do it, then Undo** — each line is applied through the existing routes as you, audited as you, shown in **What
   changed** (with the clock changes and the Autopilot's next steps). Undo works per line with correcting entries; the
   original stays visible.
5. **Standing instructions** — "don't contact the client until Monday", "ask me before anything goes to the insurer"
   are kept on the claim, shown in the panel and removable. Code enforces them: Autopilot steps to a held contact wait,
   emails to them ask you (policy rule "You asked: …"), the case manager makes a task instead of a draft. Every
   agent's prompt for the claim carries them, with the list of letters already sent outside ClaimDesk.
6. **A suspicion stays private** — words like "lying" or "fraud" become a private note only: never an instruction, a
   chronology entry, an email or a prompt, and nothing is declined.
7. **Waiting for the AI** — with the AI paused (agents off, kill switch, usage limit, sign-in) the part ClaimDesk
   understood can be done now; the rest is read when the AI is back (opening the claim's AI input picks it up).

Everything is in the **daily log** (updates applied, catch-ups, instructions added, ended or removed, Needs-you lines).

## Emails: branded HTML footer

Every email ClaimDesk sends is now **plain text + HTML**. The HTML part shows your text as paragraphs above the branded
footer (logo attached inline, office and claims lines, email, web, "Please quote our reference CCG-…" on claim emails
only, the confidentiality and status lines and the registered details). The plain text keeps your signature and ends
with the company's registered details. Company details come from the brand and your Settings (company name, number,
registered office). **Settings > Email > HTML footer** (on by default) switches the HTML part off; the page shows a
preview.

## Honest limits

- Reading your words is not certainty: every line shows the words it came from and nothing applies without Do it.
- Who sent a letter is decided by rules; a letter with no letterhead, sign-off or reference asks you. A posted letter's
  recorded date is its own date unless you set another.
- With the AI off, details read by rules from the catch-up documents wait on one confirmation card (they are not
  applied automatically); the catch-up does not run the AI's whole-bundle reasoning (Think again on a catch-up bundle
  is refused) — each file is still read by the AI when agents are on.
- Undo is not time travel: entries whose effects changed other records (repair completed, payments …), filed documents
  and emails already sent cannot be undone from the panel — correct them in Chronology.
- Holds are enforced where ClaimDesk sends; calls and post outside ClaimDesk are yours.
- An update left waiting for the AI is picked up when you (or anyone) next open the claim's AI input once the AI is
  back; there is no separate background watcher.
- The Autopilot's virtual "sent outside ClaimDesk" rows exist for letters with an email kind (handling-reference
  request, client update …); an NCAF is recognised through its chronology entry.
