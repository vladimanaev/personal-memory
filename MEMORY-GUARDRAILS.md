# MEMORY-GUARDRAILS.md — the write contract for agents

**Audience: any agent working in this repo (Claude Code, Codex, …). This is a
hard contract, not a style preference.**

## ⛔ The rule

**Never create, edit, move, or delete files under `memory/entries/` yourself** —
not with Write/Edit tools, not with shell redirection, not "just this once".

- **Capture** goes ONLY through the CLI:
  `npx tsx src/cli.ts add --title … --type … [--people …] [--source-ids …] --body "…"`
  (via the `log-memory` / `pull-memories` skills, or `/remember` / `/pull-memories`).
- **Update** an existing entry the same way: re-run `add` with the same
  `--source-ids` (updates in place), or `add --update <id>` for manual notes.
- **Delete** ONLY through `npx tsx src/cli.ts remove <id>` — it syncs the index
  and checkpoints the nested `memory/.git` repo so the content stays recoverable.
- **Recall** goes ONLY through `cli.ts query | person | list` (see CLAUDE.md /
  AGENTS.md rule #1) — never Grep/Glob/Read to discover entries.

## Why (do not rationalize around this)

A hand-written entry file *looks* fine and is silently broken. `cli.ts add` does
four things a manual write skips:

1. **Index sync** — updates the LanceDB vector table + BM25 lexical index. A
   hand-written file is invisible to all recall until someone happens to reindex.
2. **Dedup** — matches `--source-ids` against existing entries and updates in
   place instead of duplicating.
3. **Near-duplicate guard** — semantic check for manual notes without source ids.
4. **Auto-commit** — the PostToolUse hook only fires on `cli.ts add`, so a manual
   write leaves the nested `memory/.git` repo uncommitted.

## Who may write what under `memory/`

| Path | Agent may write? | How |
|---|---|---|
| `memory/entries/**` | ❌ never | `cli.ts add` / `add --update <id>` / `cli.ts remove <id>` only |
| `memory/summaries/**` | ✏️ only the `## Synthesis` section of a scaffold `digest` created — then run `cli.ts index` | Edit tool |
| `memory/connectors/**` | ✅ private connector overrides | Edit tool or web UI |
| `.index/**` | ❌ never | rebuildable derivative; `cli.ts index` regenerates |

## Enforcement

- **Claude Code**: a PreToolUse hook (`.claude/hooks/guard-memory-write.sh`)
  denies Write/Edit/Bash calls that would touch `memory/entries/` or `.index/`.
  A denial is not an obstacle to work around — it means: use `cli.ts add`.
- **Codex / other agents**: no hook layer — this file IS the enforcement.
  AGENTS.md requires reading it before any write under `memory/`.
