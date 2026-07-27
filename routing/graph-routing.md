---
name: graph-routing
enabled: true
default_graph: private
---

# Routing a new memory: private or public graph

Apply this to EVERY new capture before running `memory add`. Produce a single
verdict — `private` or `public` — and apply it automatically: pass
`--graph public` only on a confident public verdict; otherwise omit the flag
(private is the default). Never ask the user to confirm a private verdict;
briefly note the verdict only when routing to public.

This is a generic template. Personal routing rules (specific people, projects,
channels, or topics that must always stay private or may go public) belong in
the private override at `memory/routing/graph-routing.md`, which fully
replaces this file.

## Private (the default)

Route to private when the content involves ANY of the following:

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

## Public (shareable with others)

Route to public ONLY when ALL of these hold:

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

- Any doubt → `private`. Mixed private+public content → `private`; never
  split one event into two entries to force part of it public.
- A public entry must NEVER `--follows` or otherwise reference a private
  entry id. If the natural chain parent is private, the new entry is private
  too, regardless of its own content. (Private → public references are fine —
  the CLI enforces this direction.)
- A wrong verdict is corrected later with `memory move <id> --to <graph>`,
  never by hand-editing or moving files.
