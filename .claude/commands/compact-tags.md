---
description: Merge similar/duplicate tags with per-merge confirmation
argument-hint: [tag pair to merge, or leave empty to scan for candidates]
---

Use the `compact-tags` skill (`skills/compact-tags/SKILL.md`) to consolidate
similar tags. Gather candidates from `memory maintenance` plus the full tag
vocabulary (`npx tsx src/cli.ts slugs list --kind tag`) with your own semantic
judgment, dry-run each pair, ask the user to confirm each merge in one batch
review (merge now, defer to the maintenance screen via `slugs propose`, skip,
or dismiss), execute approved merges via `npx tsx src/cli.ts slugs merge`,
then verify the old tag has 0 entries and recap.

Tags to merge (empty = scan for candidates):

$ARGUMENTS
