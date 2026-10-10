# Web research (owner-enabled)

The owner switched on web research for this gap. You may use WebFetch, but only on the allowed domains; other
domains are blocked. WebFetch gives you a summary, not the page itself, so it can only help you **discover** the
right page:

- Start from the seed URLs in the message and the allowed sources.
- When you find the page that answers the question, call `source_fetch` on it so ClaimDesk keeps its own copy, and
  quote from that copy in `knowledge_propose`. A finding backed only by a link (`provenance` kind `url`) can never be
  used until the owner fetches and checks it.
- Never put a name, registration, reference or amount into a URL.
- You have no access to the owner's brain packs or memory in this run.
