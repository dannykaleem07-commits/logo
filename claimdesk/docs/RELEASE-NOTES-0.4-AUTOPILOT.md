# ClaimDesk 0.4 — the Autopilot

**For:** Courtesy Cars Group UK Ltd. This is part of ClaimDesk 0.4 (see `RELEASE-NOTES-0.4.md` for installing). Your
claims, documents and settings are kept.

## What the Autopilot does

Every claim now has an **Autopilot** that knows the whole life of a credit hire claim — from the first call to closing
the file — as a list of steps (46 of them, in 14 stages: Enquiry, Intake, Qualify, Sign-up, Vehicle, Find a car, Offer,
Booked, Handover, On hire, Off hire, Billing, Recovery, Closure).

Every few minutes, and straight away when something happens on a claim (an email arrives, a booking changes, you
answer a Needs-you card), it looks at the claim and works out what is due next. Then it follows your rules:

- **Routine work is done for you** and written in the daily log: acknowledging a new claim, asking the client for
  missing details, cross-file checks, the acceptance and driver checks, holding the best car, sending the hire offer,
  reading a clear "yes" or "no", confirming the booking, booking the delivery slot, keeping the claim status up to date.
- **Anything that needs paperwork or your judgement is prepared and then shown to you to confirm**: hire agreements and
  forms, letters to the insurer, anything going to the legal team.
- **Offers, settlements, money and legal decisions are always yours.** The Autopilot never accepts, rejects or
  counters an insurer's offer, never agrees money and never decides anything legal. Insurer settlement offers go to the
  settlement offers register as before and wait for you.

Everything it sends goes out as **"Claims Team, Courtesy Cars Group UK Ltd"**, passes the same email checks as every
other agent email, and is held for 10 minutes so you can press **Undo**.

## Finding a car and offering it (the booking path)

1. When a client needs a car, the Autopilot searches the fleet for cars that are free, legal, insured and suitable for
   the whole expected hire, and ranks them (like for like with the client's own car, the client's needs, how ready the
   car is, insurance cover, cost and distance). Cars the driver cannot drive (for example a manual car for an
   automatic-only licence) are left out, with the reason shown.
2. If one car is a **clear winner**, it is held for 24 hours. If the top cars are close, the Autopilot asks you on a
   **Choose the car** card (it holds the top car meanwhile so nobody else takes it). You can pick a car, search again,
   or say no hire is needed.
3. The **hire offer email** is written from the booking itself (car, dates, delivery window, how long the offer is
   held), never with a daily rate, and always with the neutral sentence about the insurer's own car offer. ClaimDesk
   checks the email still matches the booking before it goes.
4. The client's reply is read: a plain "yes" or "no" is understood straight away; anything else (a question, a reply
   from a different address) comes to you as a card with **Treat it as a yes / Treat it as a no / Keep waiting**.
5. On a "yes" the booking is confirmed with an agreement number (`CCG-H-…`), a delivery slot is booked within business
   hours, and a booking update with the delivery window goes to the client. The hire-start paperwork is prepared for
   you to approve.
6. If the client says no, the car is released and the hire steps are marked as not needed.
7. If nobody answers, a reminder is sent; when the hold runs out you get a **"call them?"** card and a call task.
   If the client says yes later, the car is held again if it is still free and the booking is confirmed.

## Where to see it

- **Claim → Autopilot tab**: the stage bar, whether the Autopilot is On / Paused for this claim, the **Next** step,
  who we are waiting on (client, insurer, engineer…) and since when, any clashes, the hire offers (with an
  **Accepted by phone** button), and every step grouped by track. Each step shows its mode (**Auto**, **Ask me**,
  **I do it**) and why. From the step menu you can **Run now**, **Always ask me**, **Skip**, **Mark done** or
  **Snooze**; skip and mark done ask for a short reason, which is kept.
- **Pause / Resume** on the tab stops or restarts the Autopilot for that one claim. Only a person can do this.
- **Needs you** now has two new cards: **Choose the car** and **Autopilot step** (a step that needs you, an expired
  offer, an unclear reply).
- **Daily log**: new sections for the Autopilot (what it did, what it is waiting for, what it asked you), the fleet
  (holds, confirmations, deliveries, collections) and clashes.
- **Case brief**: the agents now see the booking facts (car, dates, delivery window, agreement number, offer expiry,
  off-hire deadline, paperwork list) so their letters use the real details.

## Settings → Autopilot

- Turn the Autopilot on or off for the whole office, and choose whether **new claims** start with it on or paused.
- Choose a mode for each step. Steps that always need you (agreements and forms, offers, money, legal) cannot be set
  below their minimum — the lower choices are greyed out with the reason.
- Booking rules: how long a car is held (24 hours), the reminder (after 4 hours), delivery lead time and window
  (2 hours), turnaround between hires, business hours and bank holidays.
- "Green" rules for doing things on its own: the minimum like-for-like match, how clear the winner must be, and the most
  automatic offers per day (10).
- Ranking weights (shown as percentages that add up to 100).
- A hint appears if **Automatic sends per claim per day** is below 6, because the booking path sends several emails in
  one day.

## Safety

- **Existing claims start paused.** The first time 0.4 runs, the Autopilot is installed paused on every claim you
  already have, so nothing happens on them until you press **Resume**. New claims follow your setting.
- It stops on a claim when: the office kill switch is on, the Autopilot is switched off, the claim is paused or
  declined, closed or settled, or the agents / AI are switched off.
- It will not repeat the same step over and over: after 3 tries in 24 hours it stops and asks you.
- In **shadow mode** every action waits for you: even holding a car becomes a **Choose the car** card, and emails wait
  for your approval before they go.
- Everything it does is written to the claim's Autopilot log and the audit trail, which can only be added to, never
  changed. It never changes a verification status, and money figures (such as the hire charge on the invoices) are only proposed for you to approve.
- Tests use a pretend AI and pretend email only — no real model, no internet.

## Known limits in this version

- Billing and payment packs, handover and return at the kiosk are prepared and tracked, but are not yet driven end to
  end by the Autopilot in one go; you finish them from the Documents and Bookings screens as before.
- Letters that the Autopilot asks the drafting agent to write still depend on the drafting agent being switched on.
