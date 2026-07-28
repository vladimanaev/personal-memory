---
description: Review private memories and promote shareable ones into a named graph (per-entry confirmation)
argument-hint: [--to <graph>] [window or scope, e.g. "since July"]
---

Use the `promote-graph` skill (`skills/promote-graph/SKILL.md`) to run a
promotion review into the named graph (REQUIRED — ask me if missing; `memory graphs list` shows the registry): gather candidates
with `memory promote candidates --to <graph>`, judge them against that
graph's eligibility criteria (the body of its GRAPH.md manifest),
propose only entries that clearly qualify, and get my explicit per-entry
confirmation before any `memory copy <id> --to <graph>` (or `move` if I ask
for it). Record declines with `memory promote dismiss <id> --graph <graph>`.
Report copied / moved / dismissed / skipped.

Scope:

$ARGUMENTS
