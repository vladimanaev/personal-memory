# MEMORY-GUARDRAILS.md — the write contract for agents

**Audience: any agent working in this repo (Claude Code, Codex, …). This is a
hard contract, not a style preference.**

## ⛔ The rule

**Never create, edit, move, or delete files under `memory/entries/` or any
`memory-graphs/<name>/entries/` yourself** — not with Write/Edit tools, not
with shell redirection, not "just this once". The store is one DEFAULT graph
(`memory/` — secret, local-only) plus N named shared graphs (`memory-graphs/<slug>/`), each its
own nested git repo — and the contract covers every store equally. One entry
can be a member of several graphs (byte-identical synced copies, unless a
shared copy declares `variant_of_hash` — a user-approved redaction published
through the review queue, which diverges in BODY only); ONLY the CLI keeps
them in sync.

- **Capture** goes ONLY through the CLI and ALWAYS lands in the default graph:
  `npx tsx src/cli.ts add --title … --type … [--people …] [--source-ids …] --body "…"`
  (via the `log-memory` / `pull-memories` skills, or `/remember` / `/pull-memories`).
  `--graph <name>` is reserved for an explicit user request that satisfies
  that graph's eligibility criteria — never an agent's own judgment. It no
  longer writes into that graph: the entry homes in the default graph and a
  review candidate is queued for the named one.
- **Membership** changes ONLY through
  `cli.ts queue approve <id> --graph <name>` (the reviewed path — what every
  proposal ends at),
  `cli.ts copy <id> --to <graph>` (add a synced copy; the entry stays in the default graph too) and
  `cli.ts move <id> --to <graph>` (replace the WHOLE membership) — never by
  relocating files. Both validate containment, re-index, and checkpoint every
  affected repo. A shared graph is self-contained: its members never reference
  non-members (`follows`/`sources`) — enforced at `add`, `link`, `copy`,
  `move`, and `rules apply` time.
- **Distribution** into shared graphs is PROPOSE-then-approve. Standing rules
  (`memory/graphs/rules.json`), an explicit `--graph` at capture, and sweep
  routines all end in the same place: a per-graph **review queue**. Nothing
  reaches a shared graph until the user approves that specific entry, one at
  a time, in the UI or via `cli.ts queue approve <id> --graph <g>`; declines
  go to `queue dismiss` and are remembered until the entry's content changes.
  A saved rule is **not** standing approval — it only decides what is worth
  putting in front of the user. An agent proposes with
  `cli.ts queue add <id> --to <g> --reason "…"`, optionally offering redacted
  wording via `--summary-file`; it never approves on the user's behalf.
- **Consistency**: drifted copies are repaired ONLY by `cli.ts graphs sync`
  (the default copy wins, checkpointed) — never by hand-editing a copy. A copy
  declaring `variant_of_hash` is NOT drift and is NEVER overwritten: rewriting
  an approved redaction from the home would publish the private wording it was
  written to keep out. When the home's body changes, the variant is reported
  stale and re-proposed for review; the published copy stays as approved.
- **Graph deletion** ONLY through `cli.ts graphs delete <slug> --confirm` (or
  the UI's confirm modal) and ONLY after the user explicitly approves — it is
  permanent (store + git history). Blocked while any entry exists only in
  that graph. Never `rm -rf` a store by hand.
- **Update** an existing entry the same way: re-run `add` with the same
  `--source-ids` (updates in place), or `add --update <id>` for manual notes.
- **Timeline links** ONLY through `add --follows <id,…>` at capture time or
  `npx tsx src/cli.ts link <id> --follows <earlier-id,…>` for existing entries
  — both validate targets (exist, not newer, no cycles), sync the index, and
  commit `memory/.git`.
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
| `memory-graphs/*/summaries/**` Synthesis | ⚠️ prose only | and written from that graph's OWN copies — never from recall, which returns the private body of a redacted member |
| `memory/graphs/queue.json` | ❌ never by hand | `cli.ts queue add|approve|dismiss|sweep` only — rows carry content hashes that must match the store |
| `memory/summaries/**`, `memory-graphs/*/summaries/**` | ✏️ only the `## Synthesis` section of a scaffold `digest` created — then run `cli.ts index` | Edit tool |
| `memory/connectors/**` | ✅ private connector overrides | Edit tool or web UI |
| `memory/graphs/rules.json` | ✅ distribution-rules config | Edit tool or web UI (`#/graphs`) |
| `memory/people/<slug>.md` | ✅ people profiles (display name, nicknames; frontmatter only, private store) | `cli.ts people alias` (preferred — validates, checkpoints) or Edit tool |
| `memory/eval/**` | ❌ never by hand | `cli.ts eval add-golden` / `eval remove-golden` / `eval run --save-baseline` only (validates ids, checkpoints `memory/.git`) |
| `memory/sources/**` | ✅ private reference-source overrides | Edit tool |
| `memory-graphs/*/GRAPH.md` | ✅ graph manifests | Edit tool or web UI |
| `.index/**` | ❌ never | rebuildable derivative; `cli.ts index` regenerates; slots are managed only by `cli.ts index --build`/`--activate`/`--prune` |

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
  A heredoc body is stripped before matching only when the ENTIRE command is
  exactly one of three shapes: `python <script>.py <plain args> <<'WORD'` (quoted
  delimiter only — an unquoted body is shell-expanded), a
  `git commit … -m "$(cat <<'WORD' … )"` (or `gh … --body`) message, or
  `cat > <file> <<'WORD'`, with nothing after the terminator and no body line
  starting with WORD. Any other command (pipes, `;`, redirects, `bash <<EOF`,
  `xargs`, …) is matched whole, body included. Paths are plain text, checked
  lexically (symlinks are not followed), and `..` is rejected everywhere:
  - A repo-relative script or file (no leading `/`, `~`, `-` or `$`, no hidden
    segment such as `.git`, `.claude` or `.venv`, no `site-packages` or
    `node_modules`) counts only when the hook payload's `cwd` is the repo top
    level. From another directory, or with no `cwd` in the payload, the body is
    matched as before. Under Codex, the payload's `workdir` (resolved against
    `cwd` when relative) counts as the `cwd`, because that is where the command
    runs.
  - The script of the first shape may also be an absolute path that equals,
    exactly, an entry of `MEMORY_GUARD_STDIN_SCRIPTS`: a colon-separated list in
    the hook's environment, with a leading `~/` meaning `$HOME`, for example
    `MEMORY_GUARD_STDIN_SCRIPTS=~/tools/board.py:/opt/tools/notify.py`. Set it in
    your user-level settings (`env` in `~/.claude/settings.json`); the hook reads
    its own environment, so an agent's command cannot change it. Every listed
    script must read stdin as data: the guard cannot check that, and a script
    that executes its stdin defeats it (the same holds for a repo-relative one).
  - The file of the third shape must be a data file (`.md`, `.txt`, `.csv`,
    `.log`), never a script, hook or startup file. It may be repo-relative, or
    under `/tmp/`, `/private/tmp/` or `/var/folders/` (the rest of the path
    follows the same rules, and `cwd` does not matter).
  - Out of scope: a two-step write-then-run (`bash notes.md`,
    `exec(open("notes.md").read())`). The second command names no store, and the
    Write tool can create the same file anyway.
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
