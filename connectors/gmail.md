---
name: gmail
enabled: true
source_id_scheme: "gmail:<thread-id>"
fetch:
  lookback_days: 7
  queries: []
  # queries: Gmail search strings to sweep, e.g.
  #   - "is:important"
  #   - "label:my-label"
  # Personalized queries belong in the private override
  # (memory/connectors/gmail.md), not here.
---

# What is memory-worthy in Gmail

Capture:

- **Decisions** and their rationale — org changes, project direction, budget,
  tooling choices — especially ones the user made or is accountable for.
- **Commitments** made to or by the user (deadlines, deliverables, promises).
- **Hiring signals** — offers, comp discussions, interview feedback, referrals.
- **Escalations** and their resolution.
- **Feedback** given to or received by the user (performance, praise, concerns).

Ignore: newsletters, marketing, automated notifications (CI, Jira, calendar
invites without discussion), FYI-only threads with no decision or commitment,
threads where the user is only CC'd and nothing above applies.

Writing the entry:

- One entry per thread (`source_id_scheme` above is the dedup anchor — a
  re-fetch of the same thread updates the entry in place).
- Body: what happened, who was involved, what was decided, follow-ups /
  action items. Concrete names, numbers, dates.
- `type` is usually `decision`, `feedback`, `hiring`, `event`, or `note`.
- Map senders/participants to **existing** people slugs (`memory list` first).
