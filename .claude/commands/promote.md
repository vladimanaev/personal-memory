---
description: Review private memories and promote shareable ones into a named graph (per-entry confirmation)
argument-hint: [--to <graph>] [window or scope, e.g. "since July"]
---

Use the `promote-public` skill (`skills/promote-public/SKILL.md`) to run a
promotion review into the named graph (default: public): gather candidates
with `memory promote candidates --to <graph>`, judge them against that
graph's eligibility criteria (GRAPH.md body; the routing prompt for public),
propose only entries that clearly qualify, and get my explicit per-entry
confirmation before any `memory copy <id> --to <graph>` (or `move` if I ask
for it). Record declines with `memory promote dismiss <id> --graph <graph>`.
Report copied / moved / dismissed / skipped.

Scope:

$ARGUMENTS
