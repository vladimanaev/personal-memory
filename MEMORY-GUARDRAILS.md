# MEMORY-GUARDRAILS.md — the write contract for agents

**Audience: any agent working in this repo (Claude Code, Codex, …). This is a
hard contract, not a style preference.**

## ⛔ The rule

**Never create, edit, move, or delete files under `memory/entries/` or any
`memory-graphs/<name>/entries/` yourself** — not with Write/Edit tools, not
with shell redirection, not "just this once". The store is one DEFAULT graph
(`memory/` — secret, local-only) plus N named shared graphs (`memory-graphs/<slug>/`), each its
own nested git repo — and the contract covers every store equally. One entry
can be a member of several graphs (byte-identical synced copies); ONLY the
CLI keeps them in sync.

- **Capture** goes ONLY through the CLI and ALWAYS lands in the default graph:
  `npx tsx src/cli.ts add --title … --type … [--people …] [--source-ids …] --body "…"`
  (via the `log-memory` / `pull-memories` skills, or `/remember` / `/pull-memories`).
  `--graph <name>` is reserved for an explicit user request that satisfies
  that graph's eligibility criteria — never an agent's own judgment.
- **Membership** changes ONLY through
  `cli.ts copy <id> --to <graph>` (add a synced copy; the entry stays in the default graph too) and
  `cli.ts move <id> --to <graph>` (replace the WHOLE membership) — never by
  relocating files. Both validate containment, re-index, and checkpoint every
  affected repo. A shared graph is self-contained: its members never reference
  non-members (`follows`/`sources`) — enforced at `add`, `link`, `copy`,
  `move`, and `rules apply` time.
- **Distribution** into shared graphs happens through (a) the user's standing
  rules (`memory/graphs/rules.json`, editable config; `cli.ts rules apply` —
  ALWAYS dry-run + show the plan before a confirmed backfill) or (b) the
  user-confirmed promotion review (`/promote`): `cli.ts promote candidates
  --to <graph>` → eligibility judgment → **per-entry user confirmation** →
  `copy`/`move`; declines recorded with `promote dismiss <id> --graph <g>`.
  Never place an entry in a shared graph the user hasn't approved (a saved
  rule IS standing approval).
- **Consistency**: drifted copies are repaired ONLY by `cli.ts graphs sync`
  (the default copy wins, checkpointed) — never by hand-editing a copy.
- **Graph deletion** ONLY through `cli.ts graphs delete <slug> --confirm` (or
  the UI's confirm modal) and ONLY after the user explicitly approves — it is
  permanent (store + git history). Blocked while any entry exists only in
  that graph. Never `rm -rf` a store by hand.
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
  AGENTS.md rule #1) — never Grep/Glob/Read to discover entries, and never a shell
  search either (`grep`, `rg`, `find`, `cat`, `ls`, `awk` over a store). Hand-search
  misses semantic matches and returns files stripped of the `⤷ superseded by` /
  `status: resolved by` annotations, so a settled matter reads as still open.

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
| `memory/entries/**` | ❌ never by hand | `cli.ts add` / `add --update <id>` / `link` / `remove` / `copy` / `move` / `slugs merge` / `rules apply` only |
| `memory-graphs/*/entries/**` | ❌ never by hand | same CLI paths |
| `memory/summaries/**`, `memory-graphs/*/summaries/**` | ✏️ only the `## Synthesis` section of a scaffold `digest` created — then run `cli.ts index` | Edit tool |
| `memory/connectors/**` | ✅ private connector overrides | Edit tool or web UI |
| `memory/graphs/rules.json` | ✅ distribution-rules config | Edit tool or web UI (`#/graphs`) |
| `memory-graphs/*/GRAPH.md` | ✅ graph manifests | Edit tool or web UI |
| `.index/**` | ❌ never | rebuildable derivative; `cli.ts index` regenerates |

## Enforcement

- **Claude Code — writes**: a PreToolUse hook (`.claude/hooks/guard-memory-write.sh`)
  denies Write/Edit/Bash calls that would touch `memory/entries/`, any
  `memory-graphs/<name>/entries/`, or `.index/`.
  A denial is not an obstacle to work around — it means: use `cli.ts add`.
- **Claude Code — reads**: a second PreToolUse hook
  (`.claude/hooks/guard-memory-search.sh`) denies hand-*discovery* in three
  shapes: Grep/Glob calls that would touch a store; Bash searches/bulk reads
  that **name** one (`grep`, `rg`, `find`, `cat`, `ls`, `head`, `awk`,
  `git grep`, …); and **unscoped recursive sweeps that don't name it but walk
  into it anyway** (`grep -rli "jane doe" .`, `rg jane`, `find . -name …`).
  That last shape is the one hand-search actually takes — searching from the
  repo root is not "scoped to code". Shelling out is not a loophole.
  Any `cli.ts` invocation passes untouched, as do plain store git checks
  (`git -C memory log|status`), stdin filtering (`git log | grep …`), and
  searches scoped to a real non-store path (`src/`, `skills/`, `scripts/`).
  The `Read` tool is deliberately never blocked — opening the specific paths a
  recall cited is the sanctioned last step.
- The `.claude` guards are covered by `scripts/memory-guards.test.sh` (runs under
  `npm test`). Change a pattern, add a case.
- **Codex**: the same two guards exist, wired through `.codex/hooks.json`
  (`.codex/hooks/guard-memory-search.sh`, `guard-memory-write.sh`) — plus an
  `apply_patch` branch, since that is how Codex edits files. They are kept
  behaviourally in sync with the `.claude` pair by hand.
  ⚠️ **The two sets are separate copies and have drifted before** (Codex once
  guarded Bash while Claude Code did not, and vice-versa for whole-tree sweeps).
  Only the `.claude` pair is under test. **Change one, change both**, and re-read
  the other before assuming it covers a case.
- **Other agents** (no hook layer): this file IS the enforcement. AGENTS.md
  requires reading it before any write under `memory/`, and rule #1 there carries
  the same read-side rule.
