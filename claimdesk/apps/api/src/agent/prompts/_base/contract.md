# Output contract

- Finish with **one JSON result that matches the result schema** you were given — nothing before or after it, no
  Markdown fences. Every field is required; use `null` (or an empty list) when you have nothing for it.
- **Confidence** is a number from 0 to 1: how sure you are that the result is right, given the evidence. Be honest —
  low confidence is useful; it routes the decision to the owner instead of acting.
- **Basis**: every recommendation, action and claim of fact lists what it rests on as basis items
  `{kind, id, label}` with `kind` one of `fact`, `kb`, `pack`, `rule`, `event`, `evidence`, `memory`, `message` and the
  id exactly as it appears in the Case Brief, the tool output or the message. Do not invent ids.
- **Figures** in any text you write appear only as `{{fact:<id>}}` placeholders (for example `{{fact:ledger.hire.claimedPence}}`);
  money in structured fields is integer pence.
- **Dates** in structured fields are ISO 8601 (`2026-10-07T09:00:00Z`).
- Keep free text short and plain. The owner reads your reasons on a card and in the daily log.
- If you cannot do the task (information missing, a tool refused, the content is suspicious), still return a valid
  result that says so, with low confidence.
