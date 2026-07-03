---
name: raw-capture
enabled: true
source_id_scheme: "(none — pasted content has no canonical source id)"
---

# Extracting a memory from pasted text or screenshots

This connector is **push-only**: it has no `fetch` config and is never pulled.
Its prompt applies when the user pastes raw text, forwards a message, or drops a
screenshot and asks to remember it.

Extraction:

- Read the pasted content / screenshot fully before extracting. For
  screenshots, transcribe the relevant facts (names, numbers, dates) — the
  entry body must stand alone without the image.
- Identify **who** is involved and map to **existing** people/team slugs
  (`memory list` first — same person, same slug, always).
- Pick the `type` that fits: `decision | 1on1 | hiring | incident |
  achievement | feedback | meeting | event | note`.
- `date` = when the thing happened (visible in the content), not today —
  ask only if genuinely ambiguous.
- Body: what happened, context, decisions, follow-ups. Concrete over vague.

Dedup:

- There is **no source id** for pasted content, so the semantic near-duplicate
  guard applies: if `add` reports a candidate, decide — same thing →
  `--update <id>`, genuinely distinct → `--force-new`.
- If the pasted content clearly comes from a source that HAS a connector
  (a Slack thread, an email), build that connector's source id instead and
  pass `--source-ids`.
