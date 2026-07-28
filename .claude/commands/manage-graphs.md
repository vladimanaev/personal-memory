---
description: Create/list memory graphs, manage per-tag/per-type distribution rules, repair consistency
argument-hint: [what to do, e.g. "create a graph for team-x" or "add a rule: #architecture → public"]
---

Use the `manage-graphs` skill (`skills/manage-graphs/SKILL.md`) for the
following graph-management request: registry via `memory graphs list`,
creation via `memory graphs create`, membership via `memory copy|move`,
standing rules via `memory rules list|apply` (ALWAYS dry-run and show me the
plan before a confirmed backfill), consistency via `memory graphs sync`.

Request:

$ARGUMENTS
