# MEMORY-GUARDRAILS.md — the write contract for agents

**Audience: any agent working in this repo (Claude Code, Codex, …). This is a
hard contract, not a style preference.**

## ⛔ The rule

**Never create, edit, move, or delete files under `memory/entries/` or
`memory-public/entries/` yourself** — not with Write/Edit tools, not with
shell redirection, not "just this once". The store is TWO graphs — private
(`memory/`) and public/shareable (`memory-public/`), each its own nested git
repo — and the contract covers both equally.

- **Capture** goes ONLY through the CLI:
  `npx tsx src/cli.ts add --title … --type … [--graph public|private] [--people …] [--source-ids …] --body "…"`
  (via the `log-memory` / `pull-memories` skills, or `/remember` / `/pull-memories`).
  The graph verdict comes from the routing prompt (`cli.ts routing` shows which
  file resolves); default private on any doubt.
- **Reclassify** an entry between graphs ONLY through
  `npx tsx src/cli.ts move <id> --to public|private` — never by moving files.
  It validates link direction, relocates the file, re-indexes, and checkpoints
  both repos. A public entry must never reference a private id (`follows` or
  `sources`) — the CLI enforces this at `add`, `link`, and `move` time.
- **Update** an existing entry the same way: re-run `add` with the same
  `--source-ids` (updates in place), or `add --update <id>` for manual notes.
- **Timeline links** ONLY through `add --follows <id,…>` at capture time,
  `npx tsx src/cli.ts link <id> --follows <earlier-id,…>` for existing entries,
  or the web UI maintenance screen's **link** button (same code path) — all
  validate targets (exist, not newer, no cycles), sync the index, and commit
  `memory/.git`.
- **Delete** ONLY through `npx tsx src/cli.ts remove <id>` — it syncs the index
  and checkpoints the nested `memory/.git` repo so the content stays recoverable.
- **Slug merges** ONLY through
  `npx tsx src/cli.ts slugs merge --kind person|team|tag --from <slug> --to <slug>`
  — it rewrites just the affected frontmatter arrays, syncs the index, and
  checkpoints `memory/.git` before and after.
- **Recall** goes ONLY through `cli.ts recall | query | person | list` (see CLAUDE.md /
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

## Who may write what under the stores

| Path | Agent may write? | How |
|---|---|---|
| `memory/entries/**` | ❌ never by hand | `cli.ts add` / `add --update <id>` / `cli.ts link <id> --follows …` / `cli.ts remove <id>` / `cli.ts move <id> --to …` / `cli.ts slugs merge` only |
| `memory-public/entries/**` | ❌ never by hand | same CLI paths (with `--graph public` on `add`) |
| `memory/summaries/**`, `memory-public/summaries/**` | ✏️ only the `## Synthesis` section of a scaffold `digest` created — then run `cli.ts index` | Edit tool |
| `memory/connectors/**` | ✅ private connector overrides | Edit tool or web UI |
| `memory/routing/**` | ✅ the private graph-routing override | Edit tool or web UI (`#/routing`) |
| `.index/**` | ❌ never | rebuildable derivative; `cli.ts index` regenerates |

## Enforcement

- **Claude Code**: a PreToolUse hook (`.claude/hooks/guard-memory-write.sh`)
  denies Write/Edit/Bash calls that would touch `memory/entries/`,
  `memory-public/entries/`, or `.index/`.
  A denial is not an obstacle to work around — it means: use `cli.ts add`.
- **Codex / other agents**: no hook layer — this file IS the enforcement.
  AGENTS.md requires reading it before any write under `memory/`.
