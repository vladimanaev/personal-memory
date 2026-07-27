---
name: gchat
enabled: true
source_id_scheme: "gchat:<space-id>:<thread-id>"
fetch:
  lookback_days: 3
  spaces: []
  # spaces: Google Chat space resource ids to sweep, e.g.
  #   - "spaces/AAAA0000000"
  # Personalized lists belong in the private override
  # (memory/connectors/gchat.md), not here.
---

# What is memory-worthy in Google Chat

Capture:

- **Decisions** made in a space — direction changes, priority calls — with who
  decided and why.
- **Commitments** — who promised what by when.
- **People signals** — onboarding, role changes, kudos, hiring/retention
  context.
- **Incidents** and their resolution.

Ignore: social chatter, scheduling back-and-forth with no durable outcome,
bot notifications, threads already fully captured (the dedup anchor handles
re-fetches).

Writing the entry:

- Anchor to the **thread**: `gchat:<space-id>:<thread-id>`. One entry per
  thread — new replies update the entry in place.
- Body: what happened, who was involved, what was decided, follow-ups.
  Concrete names, numbers, dates.
- `type` is usually `decision`, `event`, `feedback`, or `note`.
- Map participants to **existing** people slugs (`memory list` first).
