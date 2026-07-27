---
name: graph-routing
enabled: true
default_graph: private
---

# Public-graph eligibility — what may leave the private store

Every capture is logged to the PRIVATE graph. An entry reaches the PUBLIC
graph (`memory-public/` — shareable with others) only through two doors, and
this prompt is the criteria for both:

1. **Promotion review** (`/promote-public`): candidates from
   `memory promote candidates` are judged against this prompt and moved with
   `memory move <id> --to public` only after the user confirms each one.
2. **Explicit capture**: the user literally says to log something as public —
   only then may `add --graph public` be used, and it must still satisfy the
   criteria below.

Never route to public automatically at capture time.

This is a generic template. Personal rules (specific people, projects, or
topics that must always stay private, or standing areas that are fine to
share) belong in the private override at `memory/routing/graph-routing.md`,
which fully replaces this file.

## NOT eligible — stays private (the default)

Anything involving:

- Personal feelings, reflections, frustrations, or private opinions about
  people or plans.
- 1:1s and coaching/mentoring conversations, whoever they are with.
- Any identifiable person's performance: feedback, reviews, promotion or
  growth discussions, concerns, improvement plans.
- Hiring: candidates, interview feedback, offers, referrals, compensation.
- Compensation, equity, or budgets tied to individuals.
- Health, family, or personal life — the user's or anyone else's.
- Conflicts or escalations involving named people, org politics, unannounced
  reorg or staffing plans.
- Anything shared in confidence or captured from a DM / private channel.
- Security incidents with sensitive detail, legal matters, unreleased
  business numbers.

## Eligible for public ONLY when ALL of these hold

- The user could paste the entry into a team channel unedited.
- It is about work artifacts, not about people's behavior or performance:
  announced decisions and their rationale, technical learnings, architecture
  notes, project facts and milestones, processes, tooling choices,
  retro-style lessons that attribute no fault to a person.
- Every named person appears only in a neutral factual role ("jane owns the
  rollout") and is never evaluated.
- The source was already visible to the team (public channel, team meeting,
  announcement) or it is the user's own technical note.

## Hard rules

- Any doubt → stays private. Mixed private+public content → stays private;
  never split one event into two entries to force part of it public.
- A public entry must NEVER `--follows` or otherwise reference a private
  entry id — the CLI enforces this at `add`, `link`, and `move` time, and
  `promote candidates` flags such entries as blocked. Move the referenced
  entries public first, or keep the chain private.
- Promotion is per-entry and user-confirmed — never move an entry the user
  has not explicitly approved. "No" answers are recorded with
  `memory promote dismiss <id>` so the entry isn't proposed again (until its
  content changes).
- A wrong placement is corrected with `memory move <id> --to <graph>`, never
  by hand-editing or moving files.
