---
name: slack
enabled: true
source_id_scheme: "slack:<channel-id>:<message-ts>"
fetch:
  lookback_days: 3
  channels: []
  # channels: list of channel names or IDs to sweep, e.g.
  #   - "#team-updates"
  #   - "C0123ABCD"
  # DMs/threads the user was mentioned in are also fair game via search.
---

# What is memory-worthy in Slack

Capture:

- **Decisions** made in-channel — direction changes, priority calls,
  "let's go with X" moments — with who decided and why.
- **Commitments** — who promised what by when, especially involving the user
  or their teams.
- **Incidents** — outages, escalations, postmortem takeaways.
- **People signals** — kudos/achievements, friction, hiring/retention chatter,
  1:1-worthy context about someone the user works with.

Ignore: routine standups, bot noise, social chatter, threads that are pure
status with no decision, anything already fully captured in an existing entry
(the dedup anchor handles re-fetches of the same thread).

Writing the entry:

- Anchor to the **thread root** message: `slack:<channel-id>:<message-ts>`.
  One entry per thread — new replies update the entry in place.
- Body: what happened, context, decision/outcome, follow-ups. Quote sparingly;
  summarize concretely (names, numbers, dates).
- `type` is usually `decision`, `incident`, `event`, `feedback`, or `note`.
- Map Slack handles to **existing** people slugs (`memory list` first).
