---
name: promote-public
description: Use when the user wants to review private memories and promote the shareable ones to the public graph — "review what can go public", "promote memories", "publish recent memories", or after a stretch of capturing. Proposes candidates one by one; every move is user-confirmed.
---

# Promoting memories to the public graph

Capture always lands in the PRIVATE graph. This skill is the one sanctioned
flow that moves entries to the PUBLIC graph (`memory-public/` — shareable
with others): scan candidates, judge them against the eligibility prompt,
and let the **user confirm every single move**. Nothing is ever promoted
without an explicit per-entry yes.

## Locating the store

Everything in this skill is **store-relative** — not just the
`npx tsx src/cli.ts …` commands (the CLI resolves the store from its working
directory), but every path involved: `memory/…` and `connectors/…` files,
index files, and the entry paths that CLI output cites.

- Working inside the personal-memory repo already (`src/cli.ts` and
  `connectors/` present)? Run the commands and read the paths as written.
- Installed via the plugin marketplace and working in another project?
  `MEMORY_HOME` must point at the user's personal-memory clone. Run every
  command as `cd "$MEMORY_HOME" && npx tsx src/cli.ts …`, and resolve every
  store-relative file you read or edit under it too — entry paths printed by
  the CLI, connector files, `memory/summaries/…`, and git checks as
  `git -C "$MEMORY_HOME/memory" …`.
- Neither? Ask the user where their personal-memory clone lives and suggest
  exporting `MEMORY_HOME` in their shell profile.

## Steps

1. **Read the eligibility prompt** — `memory/routing/graph-routing.md` if it
   exists, else `routing/graph-routing.md` (`npx tsx src/cli.ts routing`
   shows which resolves). It defines what qualifies for the public graph;
   the private override may add personal always-private / fine-to-share rules.

2. **Gather candidates** (mechanical prefilter — private entries not yet
   reviewed at their current content):

   ```bash
   npx tsx src/cli.ts promote candidates [--since YYYY-MM-DD] [--limit N]
   ```

   Default to a sensible window (e.g. `--since` the last promotion review, or
   the user's asked-for range). Entries marked
   `[blocked by private refs: …]` cannot move until those references move —
   note them, don't propose them (or propose the referenced entries first).

3. **Judge each candidate** against the eligibility prompt. Read the entry
   file when the title isn't enough. Split the list into:
   - **proposed** — meets EVERY eligibility criterion;
   - **stays private** — fails any criterion (this should be most entries;
     when in doubt, it stays private and you don't propose it).

4. **Review with the user — per-entry confirmation, like compact-tags.**
   Present the proposed entries compactly (id · date · type · title · why it
   qualifies, one line each) and collect an explicit decision per entry
   (yes / no / skip). Batch presentation is fine; batch approval is not —
   "yes to all" must come from the user, never assumed.

5. **Execute the decisions**, one entry at a time:
   - Approved → `npx tsx src/cli.ts move <id> --to public`
     (validates link direction, relocates the file, re-indexes, checkpoints
     both repos).
   - Declined → `npx tsx src/cli.ts promote dismiss <id> [--reason "…"]`
     so it is never proposed again unless its content changes.
   - Skipped/undecided → do nothing; it stays in the candidate pool.

6. **Verify + report**: `npx tsx src/cli.ts list --graph public --since …`
   shows the moved entries; `git -C "$MEMORY_HOME/memory-public" log --oneline`
   (or `git -C memory-public log --oneline` in-repo) shows the commits.
   Report moved / dismissed / skipped counts with ids.

## Principles

- **User confirms every move.** No entry enters the public graph on your
  judgment alone — your judgment only selects what to *propose*.
- **Doubt disqualifies.** If you're unsure an entry qualifies, it doesn't
  get proposed at all.
- **Only `move` and `promote dismiss` mutate state** — never edit or relocate
  files by hand, never rewrite an entry to make it "publishable" (if content
  must change to qualify, tell the user; they can decide what to do).
- The public store must stay leak-free: a moved entry may not reference any
  private id — the CLI enforces it; blocked candidates are surfaced, not
  forced.
