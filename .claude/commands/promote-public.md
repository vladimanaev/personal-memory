---
description: Review private memories and promote shareable ones to the public graph (per-entry confirmation)
argument-hint: [window or scope, e.g. "since July" or "realize-mcp entries"]
---

Use the `promote-public` skill (`skills/promote-public/SKILL.md`) to run a
promotion review into the PUBLIC graph: gather candidates with
`memory promote candidates --to public`, judge them against the eligibility
prompt (override else template), propose only the entries that clearly
qualify, and get my explicit per-entry confirmation before any
`memory copy <id> --to public` (or `move` if I ask). Record declines with
`memory promote dismiss <id> --graph public`. Report copied / moved /
dismissed / skipped.

Scope:

$ARGUMENTS
