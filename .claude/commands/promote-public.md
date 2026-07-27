---
description: Review private memories and promote shareable ones to the public graph (per-entry confirmation)
argument-hint: [window or scope, e.g. "since July" or "realize-mcp entries"]
---

Use the `promote-public` skill (`skills/promote-public/SKILL.md`) to run a
public-promotion review: gather candidates with `memory promote candidates`,
judge them against the eligibility prompt (override else template), propose
only the entries that clearly qualify, and get my explicit per-entry
confirmation before any `memory move <id> --to public`. Record declines with
`memory promote dismiss`. Report moved / dismissed / skipped.

Scope:

$ARGUMENTS
