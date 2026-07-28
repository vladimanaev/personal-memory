---
name: manage-graphs
description: Use when the user wants to create/list/inspect memory graphs, set up per-tag or per-type distribution rules (copy/move memories into named graphs), repair graph consistency, or understand where a memory lives — "create a graph for team-x", "add a rule for #architecture", "which graphs is this entry in", "sync my graphs".
---

# Managing memory graphs & distribution rules

The store is one DEFAULT graph (`memory/` — secret, local-only, home of every capture) plus any
number of named SHARED graphs (`memory-graphs/<slug>/` — each a separable
nested git repo with a `GRAPH.md` manifest). One memory can be a member of
several graphs: byte-identical synced copies, the default graph always the home.
Shared graphs are **self-contained** — members only reference fellow members.

## Locating the store

Everything in this skill is **store-relative** — not just the
`npx tsx src/cli.ts …` commands (the CLI resolves the store from its working
directory), but every path involved.

- Working inside the personal-memory repo already (`src/cli.ts` and
  `connectors/` present)? Run the commands and read the paths as written.
- Installed via the plugin marketplace and working in another project?
  `MEMORY_HOME` must point at the user's personal-memory clone. Run every
  command as `cd "$MEMORY_HOME" && npx tsx src/cli.ts …`, and resolve every
  store-relative path under it too — including git checks as
  `git -C "$MEMORY_HOME/memory" …` or `git -C "$MEMORY_HOME/memory-graphs/<name>" …`.
- Neither? Ask the user where their personal-memory clone lives and suggest
  exporting `MEMORY_HOME` in their shell profile.

## The commands

```bash
npx tsx src/cli.ts graphs list                 # registry + entry counts
npx tsx src/cli.ts graphs create <slug> [--display-name "…"] [--description "…"]
npx tsx src/cli.ts graphs sync [--dry-run]     # detect/repair drifted copies (the default copy wins)
npx tsx src/cli.ts copy <id> --to <graph>      # add membership (stays in default too)
npx tsx src/cli.ts move <id> --to <graph>      # REPLACE the whole membership set
npx tsx src/cli.ts rules list                  # standing distribution rules + match counts
npx tsx src/cli.ts rules apply [--dry-run]     # reconcile rules against existing entries
```

The web UI's `#/graphs` screen does the same visually: create graphs, edit
GRAPH.md manifests, and maintain the rules table with a backfill preview.

## Distribution rules

Rules live at `memory/graphs/rules.json` (private store; editable by hand or
via the UI): `{"version": 1, "rules": [{"match": {"tag": "…"} | {"type": "…"},
"graph": "<slug>", "mode": "copy" | "move"}]}`. Match keys AND together.
A saved rule is the user's **standing approval**: it auto-applies to every
fresh capture and can be backfilled with `rules apply`. Still:

- **Always dry-run first** when backfilling (`rules apply --dry-run`), show
  the user the plan (what would be copied/moved where), and get a go-ahead
  before the confirmed run — a rule can match more history than expected.
- Prefer `mode: copy` (the default-graph home is preserved). `move` rules
  relocate entries out of the default graph — make sure the user really wants that.
- Conflicting rules (two moves to different graphs, or move+copy on the same
  entry) are skipped with a warning; the user resolves by editing the rules.
- Entries blocked by containment (they reference non-members) are reported,
  never forced — copy the referenced entries first.

## Manifests & consistency

- `memory-graphs/<slug>/GRAPH.md` = the graph's identity: display name,
  description, and eligibility notes agents consult before placing anything
  there. It travels with the store when shared — write it for the recipient.
- `graphs sync --dry-run` is the consistency check (drifted copies, missing
  default-graph homes, containment violations); plain `graphs sync` repairs drift
  by rewriting copies from the default graph's version, checkpointed per store.
- Deleting a graph: `npx tsx src/cli.ts graphs delete <slug> --confirm` (or
  the UI's delete button, which shows a confirmation modal). It is PERMANENT
  — the store and its git history go — so only run it after the user
  explicitly approves THIS deletion. The CLI blocks it while any entry exists
  ONLY in that graph (move those out first: `move <id> --to default`);
  synced copies just lose the membership and live on in their other graphs;
  rules targeting the graph are removed with it.

## Principles

- Graph membership changes go ONLY through `copy` / `move` / `rules apply` —
  never by relocating files (MEMORY-GUARDRAILS.md applies to every store).
- Backfills and rule changes are shown to the user before a confirmed apply.
- A shared store handed to its audience must leak nothing: the CLI enforces
  self-containment; treat any `graphs sync` violation report as a to-fix,
  not noise.
